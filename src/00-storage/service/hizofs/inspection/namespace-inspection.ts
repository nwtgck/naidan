import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  decodeCommonPageHeader,
  decodeDirectoryPage,
  decodeInodeBranchPage,
  decodeInodeLeafPage,
  encodeFilenameComponent,
  segmentIdToLowercaseHex,
  type DirectoryLeafEntry,
  type DirectoryPage,
  type HomeRecordReference,
  type InodeBranchPage,
  type InodeLeafEntry,
  type InodeLeafPage,
  type InodeNumber,
} from "@/00-storage/service/hizofs/00-format";
import type { AuthenticatedHizoFSInspectionPort } from "@/00-storage/service/hizofs/authenticated-store/inspection-port";
import {
  readHizoFSNamespacePathForInspection,
  type HizoFSNamespaceInspectionPageSource,
} from "@/00-storage/service/hizofs/api/namespace-inspection-read";
import {
  withHizoFSInspectionAuthority,
  type HizoFSInspectionAuthorityMode,
  type HizoFSOpenedInspectionAuthority,
} from "@/00-storage/service/hizofs/inspection/inspection-authority";

const MAXIMUM_INSPECTION_DIRECTORY_ENTRIES = 10_000;
const MAXIMUM_INSPECTION_PAGES = 100_000;
const MAXIMUM_INSPECTION_PATH_COMPONENTS = 1_024;
const MAXIMUM_REPORTED_PAGE_READS = 512;

export type HizoFSNamespaceEntryInspection = Readonly<
  | {
      inodeKind: "directory" | "file" | "symlink";
      inodeNumber: string;
      name: string;
      targetType: "inode";
    }
  | {
      name: string;
      subvolumeId: string;
      targetType: "subvolume";
    }
>;

export type HizoFSNamespaceInodeInspection = Readonly<{
  createdAt: string | undefined;
  fileSize: string | undefined;
  inodeKind: "directory" | "file" | "symlink";
  inodeNumber: string;
  inodeRevision: string;
  modifiedAt: string | undefined;
  symlinkTarget: string | undefined;
}>;

export type HizoFSNamespacePageReadInspection = Readonly<{
  request: Readonly<{
    frameLength: number;
    homeOffset: string;
    homeSegmentId: string;
    pageIsRoot: boolean;
    recordKind: number;
  }>;
  role: "directory" | "inode_table";
}>;

export type HizoFSNamespacePathInspection = Readonly<{
  authorityMode: HizoFSInspectionAuthorityMode;
  commitSequence: string;
  directory: Readonly<{
    entries: readonly HizoFSNamespaceEntryInspection[];
    truncated: boolean;
  }> | undefined;
  inode: HizoFSNamespaceInodeInspection;
  nestedSubvolumeTableRoot: HizoFSNamespacePageReadInspection["request"] | undefined;
  pageReads: readonly HizoFSNamespacePageReadInspection[];
  pageReadsTruncated: boolean;
  pagesRead: number;
  pathComponents: readonly string[];
  selectedInodeEvidence: Readonly<{
    containingInodeTablePage: HizoFSNamespacePageReadInspection["request"];
    entry: InodeLeafEntry;
  }>;
}>;

export type HizoFSNamespaceInspectionErrorCode =
  | "page_budget_exceeded"
  | "record_kind_mismatch";

export class HizoFSNamespaceInspectionError extends Error {
  readonly code: HizoFSNamespaceInspectionErrorCode;

  constructor({ code, message }: { code: HizoFSNamespaceInspectionErrorCode; message: string }) {
    super(message);
    this.name = "HizoFSNamespaceInspectionError";
    this.code = code;
  }
}

function validateBound({ label, maximum, minimum, value }: {
  label: string;
  maximum: number;
  minimum: number;
  value: number;
}): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be a safe integer from ${minimum} through ${maximum}`);
  }
}

function projectEntry({ entry }: { entry: DirectoryLeafEntry }): HizoFSNamespaceEntryInspection {
  switch (entry.targetType) {
  case "inode":
    return {
      inodeKind: entry.inodeKind,
      inodeNumber: String(entry.inodeNumber),
      name: entry.name,
      targetType: "inode",
    };
  case "subvolume":
    return {
      name: entry.name,
      subvolumeId: String(entry.subvolumeId),
      targetType: "subvolume",
    };
  default: return entry satisfies never;
  }
}

function createPageSource({ authority, maximumPages, physical }: {
  authority: HizoFSOpenedInspectionAuthority;
  maximumPages: number;
  physical: AuthenticatedHizoFSInspectionPort;
}): Readonly<{
  pageReads: () => readonly HizoFSNamespacePageReadInspection[];
  pageReadsTruncated: () => boolean;
  pagesRead: () => number;
  selectedInodeLookup: ({ inodeNumber }: { inodeNumber: InodeNumber }) => Readonly<{
    containingInodeTablePage: HizoFSNamespacePageReadInspection["request"];
    entry: InodeLeafEntry;
  }> | undefined;
  source: HizoFSNamespaceInspectionPageSource;
}> {
  let count = 0;
  const pageReads: HizoFSNamespacePageReadInspection[] = [];
  const selectedInodeLookups = new Map<InodeNumber, Readonly<{
    containingInodeTablePage: HizoFSNamespacePageReadInspection["request"];
    entry: InodeLeafEntry;
  }>>();
  const pageRequest = ({ isRoot, reference }: {
    isRoot: boolean;
    reference: HomeRecordReference;
  }): HizoFSNamespacePageReadInspection["request"] => ({
    frameLength: reference.frameLength,
    homeOffset: String(reference.byteOffset),
    homeSegmentId: segmentIdToLowercaseHex({ id: reference.segmentId }),
    pageIsRoot: isRoot,
    recordKind: reference.recordKind,
  });
  const readPagePlaintext = async ({ expectedRecordKind, isRoot, reference, role }: {
    expectedRecordKind: number;
    isRoot: boolean;
    reference: HomeRecordReference;
    role: HizoFSNamespacePageReadInspection["role"];
  }): Promise<Uint8Array> => {
    if (count === maximumPages) {
      throw new HizoFSNamespaceInspectionError({
        code: "page_budget_exceeded",
        message: "namespace inspection page budget was exhausted",
      });
    }
    count += 1;
    if (reference.recordKind !== expectedRecordKind) {
      throw new HizoFSNamespaceInspectionError({
        code: "record_kind_mismatch",
        message: "namespace page reference has the wrong record kind",
      });
    }
    const record = await physical.readHomeRecord({
      fileSystemId: authority.fileSystemId,
      homeReference: reference,
      relocationIndexRootPhysicalRef: authority.relocationIndexRootPhysicalRef,
      rootKey: authority.rootKey,
    });
    if (pageReads.length < MAXIMUM_REPORTED_PAGE_READS) {
      pageReads.push({
        request: pageRequest({ isRoot, reference }),
        role,
      });
    }
    return record.plaintext;
  };

  return {
    pageReads: () => [...pageReads],
    pageReadsTruncated: () => count > pageReads.length,
    pagesRead: () => count,
    selectedInodeLookup: ({ inodeNumber }) => selectedInodeLookups.get(inodeNumber),
    source: {
      readDirectoryPage: async ({ isRoot, reference }): Promise<DirectoryPage> => {
        const bytes = await readPagePlaintext({
          expectedRecordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.directory_page,
          isRoot,
          reference,
          role: "directory",
        });
        try {
          return decodeDirectoryPage({ bytes, isRoot });
        } finally {
          bytes.fill(0);
        }
      },
      readExtentFile: async () => {
        throw new Error("namespace Inspector does not expose file content reads");
      },
      readInodePage: async ({ isRoot, reference }): Promise<InodeBranchPage | InodeLeafPage> => {
        const bytes = await readPagePlaintext({
          expectedRecordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
          isRoot,
          reference,
          role: "inode_table",
        });
        try {
          const header = decodeCommonPageHeader({ bytes, family: "inode", isRoot });
          return header.level === 0
            ? decodeInodeLeafPage({ bytes, isRoot })
            : decodeInodeBranchPage({ bytes, isRoot });
        } finally {
          bytes.fill(0);
        }
      },
      readInodePointPage: async ({ inodeNumber, isRoot, reference }) => {
        const bytes = await readPagePlaintext({
          expectedRecordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
          isRoot,
          reference,
          role: "inode_table",
        });
        try {
          const header = decodeCommonPageHeader({ bytes, family: "inode", isRoot });
          if (header.level !== 0) {
            return {
              page: decodeInodeBranchPage({ bytes, isRoot }),
              type: "branch" as const,
            };
          }
          const page = decodeInodeLeafPage({ bytes, isRoot });
          const entry = page.entries.find(candidate => candidate.inodeNumber === inodeNumber);
          if (entry !== undefined) {
            selectedInodeLookups.set(inodeNumber, {
              containingInodeTablePage: pageRequest({ isRoot, reference }),
              entry,
            });
          }
          return { entry, type: "leaf" as const };
        } finally {
          bytes.fill(0);
        }
      },
    },
  };
}

export async function inspectHizoFSNamespacePath({
  maximumDirectoryEntries = 256,
  maximumPages = 4_096,
  passphrase,
  pathComponents,
  physical,
}: {
  maximumDirectoryEntries?: number;
  maximumPages?: number;
  passphrase: string;
  pathComponents: readonly string[];
  physical: AuthenticatedHizoFSInspectionPort;
}): Promise<HizoFSNamespacePathInspection> {
  return await withHizoFSInspectionAuthority({
    passphrase,
    physical,
    operation: async ({ authority }) => await inspectHizoFSNamespacePathWithAuthority({
      authority,
      maximumDirectoryEntries,
      maximumPages,
      pathComponents,
      physical,
    }),
  });
}

export async function inspectHizoFSNamespacePathWithAuthority({
  authority,
  maximumDirectoryEntries = 256,
  maximumPages = 4_096,
  pathComponents,
  physical,
}: {
  authority: HizoFSOpenedInspectionAuthority;
  maximumDirectoryEntries?: number;
  maximumPages?: number;
  pathComponents: readonly string[];
  physical: AuthenticatedHizoFSInspectionPort;
}): Promise<HizoFSNamespacePathInspection> {
  validateBound({
    label: "maximumDirectoryEntries",
    maximum: MAXIMUM_INSPECTION_DIRECTORY_ENTRIES,
    minimum: 0,
    value: maximumDirectoryEntries,
  });
  validateBound({
    label: "maximumPages",
    maximum: MAXIMUM_INSPECTION_PAGES,
    minimum: 1,
    value: maximumPages,
  });
  if (pathComponents.length > MAXIMUM_INSPECTION_PATH_COMPONENTS) {
    throw new RangeError("pathComponents exceeds the Inspector bound");
  }
  const capturedPath = pathComponents.map(component => {
    encodeFilenameComponent({ value: component });
    return component;
  });
  const pageSource = createPageSource({ authority, maximumPages, physical });
  const { directory, inode, symlinkTarget } = await readHizoFSNamespacePathForInspection({
    inodeTableRootHomeRef: authority.commit.rootInodeTableRootHomeRef,
    maximumDirectoryEntries,
    pathComponents: capturedPath,
    rootDirectoryInodeNumber: authority.commit.rootDirectoryInodeNumber,
    source: pageSource.source,
  });
  const selectedInodeEvidence = pageSource.selectedInodeLookup({ inodeNumber: inode.inodeNumber });
  if (selectedInodeEvidence === undefined || selectedInodeEvidence.entry.inodeRevision !== inode.inodeRevision) {
    throw new Error("selected Inode point lookup did not retain its authenticated containing page evidence");
  }
  const fileSize = (() => {
    switch (inode.inodeKind) {
    case "file": return String(inode.fileSize);
    case "directory":
    case "symlink": return undefined;
    default: return inode satisfies never;
    }
  })();
  return {
    authorityMode: authority.mode,
    commitSequence: String(authority.commit.commitSequence),
    directory: directory === undefined
      ? undefined
      : {
        entries: directory.entries.map(entry => projectEntry({ entry })),
        truncated: directory.truncated,
      },
    inode: {
      createdAt: inode.timestamps.createdAt === null ? undefined : String(inode.timestamps.createdAt),
      fileSize,
      inodeKind: inode.inodeKind,
      inodeNumber: String(inode.inodeNumber),
      inodeRevision: String(inode.inodeRevision),
      modifiedAt: inode.timestamps.modifiedAt === null ? undefined : String(inode.timestamps.modifiedAt),
      symlinkTarget,
    },
    nestedSubvolumeTableRoot: authority.commit.nestedSubvolumeTableRootHomeRef === null
      ? undefined
      : {
        frameLength: authority.commit.nestedSubvolumeTableRootHomeRef.frameLength,
        homeOffset: String(authority.commit.nestedSubvolumeTableRootHomeRef.byteOffset),
        homeSegmentId: segmentIdToLowercaseHex({ id: authority.commit.nestedSubvolumeTableRootHomeRef.segmentId }),
        pageIsRoot: true,
        recordKind: authority.commit.nestedSubvolumeTableRootHomeRef.recordKind,
      },
    pageReads: pageSource.pageReads(),
    pageReadsTruncated: pageSource.pageReadsTruncated(),
    pagesRead: pageSource.pagesRead(),
    pathComponents: capturedPath,
    selectedInodeEvidence,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
