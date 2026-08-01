import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createFeatureBits,
  createHomeRecordReference,
  createPhysicalRecordReference,
  createUnlockSequence,
  createUInt64,
  decodeCommonPageHeader,
  decodeDirectoryPage,
  decodeFileDataPayload,
  decodeFileExtentPage,
  decodeFileSystemCommitPayload,
  decodeInodeBranchPage,
  decodeInodeLeafPage,
  decodeNestedSubvolumeBranchPage,
  decodeNestedSubvolumeLeafPage,
  decodeRelocationIndexPage,
  encodeBase64UrlUnpadded,
  parseSegmentIdLowercaseHex,
  segmentIdToLowercaseHex,
  type DirectoryPage,
  type FeatureBits,
  type FileExtentPage,
  type FileSystemCommitPayload,
  type HomeRecordReference,
  type InodeBranchPage,
  type InodeLeafPage,
  type NestedSubvolumeBranchPage,
  type NestedSubvolumeLeafPage,
  type PhysicalRecordReference,
  type RelocationIndexPage,
  type UInt64,
} from "@/00-storage/service/hizofs/00-format";
import type { AuthenticatedHizoFSInspectionPort } from "@/00-storage/service/hizofs/authenticated-store/inspection-port";

export type HizoFSPhysicalRecordInspectionRequest = Readonly<{
  frameLength: number;
  homeOffset?: string;
  homeSegmentId?: string;
  physicalOffset: string;
  pageIsRoot?: boolean;
  physicalSegmentId: string;
  recordKind: number;
}>;
export type HizoFSHomeRecordInspectionRequest = Readonly<{
  frameLength: number;
  homeOffset: string;
  homeSegmentId: string;
  pageIsRoot?: boolean;
  recordKind: number;
}>;

export type HizoFSRecordNavigationRole =
  | "directory_child_page"
  | "directory_tree_root"
  | "file_data"
  | "file_extent_child_page"
  | "file_extent_tree_root"
  | "inode_table_child_page"
  | "nested_subvolume_child_page"
  | "nested_subvolume_table_root"
  | "relocated_record"
  | "relocation_child_page"
  | "root_inode_table_root"
  | "subvolume_inode_table_root";

export type HizoFSHomeRecordReferenceInspection = Readonly<{
  frameLength: number;
  homeOffset: string;
  homeSegmentId: string;
  pageIsRoot?: boolean;
  recordKind: number;
  role: HizoFSRecordNavigationRole;
  targetType: "home_record";
}>;

export type HizoFSPhysicalRecordReferenceInspection = Readonly<{
  frameLength: number;
  homeOffset?: string;
  homeSegmentId?: string;
  pageIsRoot?: boolean;
  physicalOffset: string;
  physicalSegmentId: string;
  recordKind: number;
  role: HizoFSRecordNavigationRole;
  targetType: "physical_record";
}>;

export type HizoFSRecordNavigationReferenceInspection =
  | HizoFSHomeRecordReferenceInspection
  | HizoFSPhysicalRecordReferenceInspection;

type HizoFSDecodedPagePayloadInspection =
  | Readonly<{
      decodedPayload: DirectoryPage;
      family: "directory";
      isRoot: boolean;
      itemCount: number;
      level: number;
      navigationReferences: readonly HizoFSRecordNavigationReferenceInspection[];
      pageType: "branch" | "leaf";
      state: "decoded";
    }>
  | Readonly<{
      decodedPayload: FileExtentPage;
      family: "file_extent";
      isRoot: boolean;
      itemCount: number;
      level: number;
      navigationReferences: readonly HizoFSRecordNavigationReferenceInspection[];
      pageType: "branch" | "leaf";
      state: "decoded";
    }>
  | Readonly<{
      decodedPayload: InodeBranchPage | InodeLeafPage;
      family: "inode_table";
      isRoot: boolean;
      itemCount: number;
      level: number;
      navigationReferences: readonly HizoFSRecordNavigationReferenceInspection[];
      pageType: "branch" | "leaf";
      state: "decoded";
    }>
  | Readonly<{
      decodedPayload: NestedSubvolumeBranchPage | NestedSubvolumeLeafPage;
      family: "nested_subvolume";
      isRoot: boolean;
      itemCount: number;
      level: number;
      navigationReferences: readonly HizoFSRecordNavigationReferenceInspection[];
      pageType: "branch" | "leaf";
      state: "decoded";
    }>
  | Readonly<{
      decodedPayload: RelocationIndexPage;
      family: "relocation_index";
      isRoot: boolean;
      itemCount: number;
      level: number;
      navigationReferences: readonly HizoFSRecordNavigationReferenceInspection[];
      pageType: "branch" | "leaf";
      state: "decoded";
    }>;

export type HizoFSRecordPayloadInspection =
  | Readonly<{
      byteLength: number;
      kind: "file_data";
      state: "decoded";
    }>
  | Readonly<{
      commitSequence: string;
      decodedPayload: FileSystemCommitPayload;
      navigationReferences: readonly HizoFSRecordNavigationReferenceInspection[];
      kind: "file_system_commit";
      nextInodeNumber: string;
      nextSubvolumeId: string;
      rootDirectoryInodeNumber: string;
      state: "decoded";
    }>
  | HizoFSDecodedPagePayloadInspection
  | Readonly<{
      family: "directory" | "file_extent" | "inode_table" | "nested_subvolume" | "relocation_index";
      state: "page_role_required";
    }>
  | Readonly<{
      reason: string;
      state: "invalid";
    }>;

export type HizoFSPhysicalRecordInspection = Readonly<{
  frameLength: number;
  headerFlags: number;
  homeOffset: string;
  homeSegmentId: string;
  physicalOffset: string;
  physicalSegmentId: string;
  plaintextByteLength: number;
  plaintextPreviewBase64Url: string;
  plaintextPreviewByteLength: number;
  plaintextPreviewTruncated: boolean;
  payload: HizoFSRecordPayloadInspection;
  recordKind: number;
  recordKindName: keyof typeof HIZOFS_V1_FORMAT_CONSTANTS.recordKinds;
  sealedLength: number;
}>;

function parseOffset({ label, value }: { label: string; value: string }): UInt64 {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) throw new TypeError(`${label} must be canonical unsigned decimal`);
  return createUInt64({ value: BigInt(value) });
}

function recordKindName({ recordKind }: {
  recordKind: number;
}): keyof typeof HIZOFS_V1_FORMAT_CONSTANTS.recordKinds {
  const kinds = HIZOFS_V1_FORMAT_CONSTANTS.recordKinds;
  switch (recordKind) {
  case kinds.directory_page: return "directory_page";
  case kinds.file_data: return "file_data";
  case kinds.file_extent_page: return "file_extent_page";
  case kinds.file_system_commit: return "file_system_commit";
  case kinds.inode_table_page: return "inode_table_page";
  case kinds.nested_subvolume_table_page: return "nested_subvolume_table_page";
  case kinds.relocation_index_page: return "relocation_index_page";
  default: throw new TypeError("Record kind is unknown");
  }
}

type PageFamilyInspection = Exclude<
  Extract<HizoFSRecordPayloadInspection, { state: "decoded" }>,
  { kind: "file_data" | "file_system_commit" }
>["family"];

function pageFamily({ recordKind }: { recordKind: number }): PageFamilyInspection | undefined {
  const kinds = HIZOFS_V1_FORMAT_CONSTANTS.recordKinds;
  switch (recordKind) {
  case kinds.directory_page: return "directory";
  case kinds.file_extent_page: return "file_extent";
  case kinds.inode_table_page: return "inode_table";
  case kinds.nested_subvolume_table_page: return "nested_subvolume";
  case kinds.relocation_index_page: return "relocation_index";
  case kinds.file_data:
  case kinds.file_system_commit:
    return undefined;
  default: throw new TypeError("Record kind is unknown");
  }
}

function inspectHomeReference({ pageIsRoot, reference, role }: {
  pageIsRoot?: boolean;
  reference: HomeRecordReference;
  role: HizoFSRecordNavigationRole;
}): HizoFSHomeRecordReferenceInspection {
  return {
    frameLength: reference.frameLength,
    homeOffset: String(reference.byteOffset),
    homeSegmentId: segmentIdToLowercaseHex({ id: reference.segmentId }),
    ...(pageIsRoot === undefined ? {} : { pageIsRoot }),
    recordKind: reference.recordKind,
    role,
    targetType: "home_record",
  };
}

function inspectPhysicalReference({ homeOffset, homeSegmentId, pageIsRoot, reference, role }: {
  homeOffset?: UInt64;
  homeSegmentId?: HomeRecordReference["segmentId"];
  pageIsRoot?: boolean;
  reference: PhysicalRecordReference;
  role: HizoFSRecordNavigationRole;
}): HizoFSPhysicalRecordReferenceInspection {
  return {
    frameLength: reference.frameLength,
    ...(homeOffset === undefined ? {} : { homeOffset: String(homeOffset) }),
    ...(homeSegmentId === undefined ? {} : { homeSegmentId: segmentIdToLowercaseHex({ id: homeSegmentId }) }),
    ...(pageIsRoot === undefined ? {} : { pageIsRoot }),
    physicalOffset: String(reference.byteOffset),
    physicalSegmentId: segmentIdToLowercaseHex({ id: reference.segmentId }),
    recordKind: reference.recordKind,
    role,
    targetType: "physical_record",
  };
}

function directoryNavigationReferences({ page }: {
  page: DirectoryPage;
}): readonly HizoFSRecordNavigationReferenceInspection[] {
  switch (page.type) {
  case "leaf": return [];
  case "branch": return page.entries.map(entry => inspectHomeReference({
    pageIsRoot: false,
    reference: entry.childPageHomeRef,
    role: "directory_child_page",
  }));
  default: {
    const _ex: never = page;
    throw new Error(`Unhandled Directory page type: ${((_ex satisfies never) as { readonly type: string }).type}`);
  }
  }
}

function fileExtentNavigationReferences({ page }: {
  page: FileExtentPage;
}): readonly HizoFSRecordNavigationReferenceInspection[] {
  switch (page.type) {
  case "branch": return page.entries.map(entry => inspectHomeReference({
    pageIsRoot: false,
    reference: entry.childPageHomeRef,
    role: "file_extent_child_page",
  }));
  case "leaf": return page.entries.map(entry => inspectHomeReference({
    reference: entry.fileDataHomeRef,
    role: "file_data",
  }));
  default: {
    const _ex: never = page;
    throw new Error(`Unhandled File Extent page type: ${((_ex satisfies never) as { readonly type: string }).type}`);
  }
  }
}

function inodeNavigationReferences({ page }: {
  page: InodeBranchPage | InodeLeafPage;
}): readonly HizoFSRecordNavigationReferenceInspection[] {
  if (!("type" in page)) {
    return page.entries.map(entry => inspectHomeReference({
      pageIsRoot: false,
      reference: entry.childPageHomeRef,
      role: "inode_table_child_page",
    }));
  }
  return page.entries.flatMap(entry => {
    switch (entry.inodeKind) {
    case "directory": {
      switch (entry.content.type) {
      case "inline": return [];
      case "tree": return [inspectHomeReference({
        pageIsRoot: true,
        reference: entry.content.directoryTreeRootHomeRef,
        role: "directory_tree_root",
      })];
      default: {
        const _ex: never = entry.content;
        throw new Error(`Unhandled Directory content type: ${((_ex satisfies never) as { readonly type: string }).type}`);
      }
      }
    }
    case "file": {
      switch (entry.content.type) {
      case "inline": return [];
      case "tree": return [inspectHomeReference({
        pageIsRoot: true,
        reference: entry.content.extentTreeRootHomeRef,
        role: "file_extent_tree_root",
      })];
      default: {
        const _ex: never = entry.content;
        throw new Error(`Unhandled File content type: ${((_ex satisfies never) as { readonly type: string }).type}`);
      }
      }
    }
    case "symlink": return [];
    default: return entry satisfies never;
    }
  });
}

function nestedSubvolumeNavigationReferences({ page }: {
  page: NestedSubvolumeBranchPage | NestedSubvolumeLeafPage;
}): readonly HizoFSRecordNavigationReferenceInspection[] {
  if (!("type" in page)) {
    return page.entries.map(entry => inspectHomeReference({
      pageIsRoot: false,
      reference: entry.childPageHomeRef,
      role: "nested_subvolume_child_page",
    }));
  }
  return page.entries.map(entry => inspectHomeReference({
    pageIsRoot: true,
    reference: entry.inodeTableRootHomeRef,
    role: "subvolume_inode_table_root",
  }));
}

function relocationNavigationReferences({ page }: {
  page: RelocationIndexPage;
}): readonly HizoFSRecordNavigationReferenceInspection[] {
  switch (page.type) {
  case "branch": return page.entries.map(entry => inspectPhysicalReference({
    pageIsRoot: false,
    reference: entry.childPagePhysicalRef,
    role: "relocation_child_page",
  }));
  case "leaf": return page.entries.map(entry => inspectPhysicalReference({
    homeOffset: entry.homeOffset,
    homeSegmentId: entry.homeSegmentId,
    reference: entry.currentPhysicalRecordRef,
    role: "relocated_record",
  }));
  default: {
    const _ex: never = page;
    throw new Error(`Unhandled Relocation page type: ${((_ex satisfies never) as { readonly type: string }).type}`);
  }
  }
}

function decodePagePayload({ bytes, family, isRoot, recordKind }: {
  bytes: Uint8Array;
  family: PageFamilyInspection;
  isRoot: boolean;
  recordKind: number;
}): HizoFSDecodedPagePayloadInspection {
  const formatFamily = (() => {
    switch (family) {
    case "directory": return "directory" as const;
    case "file_extent": return "fileExtent" as const;
    case "inode_table": return "inode" as const;
    case "nested_subvolume": return "nestedSubvolume" as const;
    case "relocation_index": return "relocation" as const;
    default: return family satisfies never;
    }
  })();
  const header = decodeCommonPageHeader({ bytes, family: formatFamily, isRoot });
  const kinds = HIZOFS_V1_FORMAT_CONSTANTS.recordKinds;
  switch (recordKind) {
  case kinds.directory_page: {
    const decodedPayload = decodeDirectoryPage({ bytes, isRoot });
    return {
      decodedPayload,
      family: "directory",
      isRoot,
      itemCount: decodedPayload.entries.length,
      level: decodedPayload.level,
      navigationReferences: directoryNavigationReferences({ page: decodedPayload }),
      pageType: decodedPayload.type,
      state: "decoded",
    };
  }
  case kinds.file_extent_page: {
    const decodedPayload = decodeFileExtentPage({ bytes, isRoot });
    return {
      decodedPayload,
      family: "file_extent",
      isRoot,
      itemCount: decodedPayload.entries.length,
      level: decodedPayload.level,
      navigationReferences: fileExtentNavigationReferences({ page: decodedPayload }),
      pageType: decodedPayload.type,
      state: "decoded",
    };
  }
  case kinds.inode_table_page: {
    const decodedPayload = header.level === 0
      ? decodeInodeLeafPage({ bytes, isRoot })
      : decodeInodeBranchPage({ bytes, isRoot });
    return {
      decodedPayload,
      family: "inode_table",
      isRoot,
      itemCount: decodedPayload.entries.length,
      level: decodedPayload.level,
      navigationReferences: inodeNavigationReferences({ page: decodedPayload }),
      pageType: header.level === 0 ? "leaf" : "branch",
      state: "decoded",
    };
  }
  case kinds.nested_subvolume_table_page: {
    const decodedPayload = header.level === 0
      ? decodeNestedSubvolumeLeafPage({ bytes, isRoot })
      : decodeNestedSubvolumeBranchPage({ bytes, isRoot });
    return {
      decodedPayload,
      family: "nested_subvolume",
      isRoot,
      itemCount: decodedPayload.entries.length,
      level: decodedPayload.level,
      navigationReferences: nestedSubvolumeNavigationReferences({ page: decodedPayload }),
      pageType: header.level === 0 ? "leaf" : "branch",
      state: "decoded",
    };
  }
  case kinds.relocation_index_page: {
    const decodedPayload = decodeRelocationIndexPage({ bytes, isRoot });
    return {
      decodedPayload,
      family: "relocation_index",
      isRoot,
      itemCount: decodedPayload.entries.length,
      level: decodedPayload.level,
      navigationReferences: relocationNavigationReferences({ page: decodedPayload }),
      pageType: decodedPayload.type,
      state: "decoded",
    };
  }
  case kinds.file_data:
  case kinds.file_system_commit:
    throw new TypeError("record kind is not a page");
  default:
    throw new TypeError("Record kind is unknown");
  }
}

function inspectPayload({ bytes, pageIsRoot, recordKind }: {
  bytes: Uint8Array;
  pageIsRoot: boolean | undefined;
  recordKind: number;
}): HizoFSRecordPayloadInspection {
  try {
    const kinds = HIZOFS_V1_FORMAT_CONSTANTS.recordKinds;
    switch (recordKind) {
    case kinds.file_data: {
      const payload = decodeFileDataPayload({ bytes });
      return { byteLength: payload.bytes.byteLength, kind: "file_data", state: "decoded" };
    }
    case kinds.file_system_commit: {
      const payload = decodeFileSystemCommitPayload({ bytes });
      return {
        commitSequence: String(payload.commitSequence),
        decodedPayload: payload,
        navigationReferences: [
          inspectHomeReference({
            pageIsRoot: true,
            reference: payload.rootInodeTableRootHomeRef,
            role: "root_inode_table_root",
          }),
          ...(payload.nestedSubvolumeTableRootHomeRef === null
            ? []
            : [inspectHomeReference({
              pageIsRoot: true,
              reference: payload.nestedSubvolumeTableRootHomeRef,
              role: "nested_subvolume_table_root",
            })]),
        ],
        kind: "file_system_commit",
        nextInodeNumber: String(payload.nextInodeNumber),
        nextSubvolumeId: String(payload.nextSubvolumeId),
        rootDirectoryInodeNumber: String(payload.rootDirectoryInodeNumber),
        state: "decoded",
      };
    }
    case kinds.directory_page:
    case kinds.file_extent_page:
    case kinds.inode_table_page:
    case kinds.nested_subvolume_table_page:
    case kinds.relocation_index_page: {
      const family = pageFamily({ recordKind });
      if (family === undefined) throw new Error("page family invariant failed");
      return pageIsRoot === undefined
        ? { family, state: "page_role_required" }
        : decodePagePayload({ bytes, family, isRoot: pageIsRoot, recordKind });
    }
    default:
      throw new TypeError("Record kind is unknown");
    }
  } catch (cause: unknown) {
    return { reason: cause instanceof Error ? cause.message : String(cause), state: "invalid" };
  }
}

type InspectedAuthenticatedRecord = Awaited<ReturnType<AuthenticatedHizoFSInspectionPort["readPhysicalRecord"]>>;

function recordInspection({ maximumPreviewBytes, pageIsRoot, record }: {
  maximumPreviewBytes: number;
  pageIsRoot: boolean | undefined;
  record: InspectedAuthenticatedRecord;
}): HizoFSPhysicalRecordInspection {
  const preview = record.plaintext.slice(0, maximumPreviewBytes);
  return {
    frameLength: record.header.frameLength,
    headerFlags: record.header.flags,
    homeOffset: String(record.header.homeOffset),
    homeSegmentId: segmentIdToLowercaseHex({ id: record.header.homeSegmentId }),
    physicalOffset: String(record.physicalReference.byteOffset),
    physicalSegmentId: segmentIdToLowercaseHex({ id: record.physicalReference.segmentId }),
    plaintextByteLength: record.plaintext.byteLength,
    plaintextPreviewBase64Url: encodeBase64UrlUnpadded({ bytes: preview }),
    plaintextPreviewByteLength: preview.byteLength,
    plaintextPreviewTruncated: preview.byteLength < record.plaintext.byteLength,
    payload: inspectPayload({
      bytes: record.plaintext,
      pageIsRoot,
      recordKind: record.header.recordKind,
    }),
    recordKind: record.header.recordKind,
    recordKindName: recordKindName({ recordKind: record.header.recordKind }),
    sealedLength: record.header.sealedLength,
  };
}

function validateMaximumPreviewBytes({ maximumPreviewBytes }: {
  maximumPreviewBytes: number;
}): void {
  if (!Number.isSafeInteger(maximumPreviewBytes)
    || maximumPreviewBytes < 0
    || maximumPreviewBytes > HIZOFS_V1_FORMAT_CONSTANTS.limits.metadataPlaintextBytes) {
    throw new RangeError("maximumPreviewBytes is outside the Inspector bound");
  }
}

export async function inspectHizoFSPhysicalRecord({
  maximumPreviewBytes = 256,
  passphrase,
  physical,
  request,
  supportedFeatureBits = createFeatureBits({ value: 0n }),
}: {
  maximumPreviewBytes?: number;
  passphrase: string;
  physical: AuthenticatedHizoFSInspectionPort;
  request: HizoFSPhysicalRecordInspectionRequest;
  supportedFeatureBits?: FeatureBits;
}): Promise<HizoFSPhysicalRecordInspection> {
  validateMaximumPreviewBytes({ maximumPreviewBytes });
  const physicalSegmentId = parseSegmentIdLowercaseHex({ value: request.physicalSegmentId });
  const physicalReference = createPhysicalRecordReference({ fields: {
    byteOffset: parseOffset({ label: "physicalOffset", value: request.physicalOffset }),
    frameLength: request.frameLength,
    recordKind: request.recordKind,
    segmentId: physicalSegmentId,
  } });
  const homeReference = request.recordKind === HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.relocation_index_page
    ? undefined
    : (() => {
      if (request.homeOffset === undefined || request.homeSegmentId === undefined) {
        throw new TypeError("non-relocation physical inspection requires a home reference");
      }
      return createHomeRecordReference({ fields: {
        byteOffset: parseOffset({ label: "homeOffset", value: request.homeOffset }),
        frameLength: request.frameLength,
        recordKind: request.recordKind,
        segmentId: parseSegmentIdLowercaseHex({ value: request.homeSegmentId }),
      } });
    })();

  const openedUnlock = await physical.openUnlockCopies({
    minimumUnlockSequence: createUnlockSequence({ value: 1n }),
    passphrase,
  });
  const rootKey = openedUnlock.rootKey;
  try {
    const openedSuperblock = await physical.openSuperblockCopies({
      fileSystemId: openedUnlock.fileSystemId,
      rootKey,
      supportedFeatureBits,
    });
    await physical.openUnlockAuthority({
      fileSystemId: openedUnlock.fileSystemId,
      minimumUnlockSequence: openedSuperblock.logicalState.minimumUnlockSequence,
      rootKey,
    });
    const record = await physical.readPhysicalRecord({
      fileSystemId: openedUnlock.fileSystemId,
      homeReference,
      physicalReference,
      rootKey,
    });
    try {
      return recordInspection({
        maximumPreviewBytes,
        pageIsRoot: request.pageIsRoot,
        record,
      });
    } finally {
      record.plaintext.fill(0);
    }
  } finally {
    rootKey.destroy();
  }
}

export async function inspectHizoFSHomeRecord({
  maximumPreviewBytes = 256,
  passphrase,
  physical,
  request,
  supportedFeatureBits = createFeatureBits({ value: 0n }),
}: {
  maximumPreviewBytes?: number;
  passphrase: string;
  physical: AuthenticatedHizoFSInspectionPort;
  request: HizoFSHomeRecordInspectionRequest;
  supportedFeatureBits?: FeatureBits;
}): Promise<HizoFSPhysicalRecordInspection> {
  validateMaximumPreviewBytes({ maximumPreviewBytes });
  const homeReference = createHomeRecordReference({ fields: {
    byteOffset: parseOffset({ label: "homeOffset", value: request.homeOffset }),
    frameLength: request.frameLength,
    recordKind: request.recordKind,
    segmentId: parseSegmentIdLowercaseHex({ value: request.homeSegmentId }),
  } });
  const openedUnlock = await physical.openUnlockCopies({
    minimumUnlockSequence: createUnlockSequence({ value: 1n }),
    passphrase,
  });
  const rootKey = openedUnlock.rootKey;
  try {
    const openedSuperblock = await physical.openSuperblockCopies({
      fileSystemId: openedUnlock.fileSystemId,
      rootKey,
      supportedFeatureBits,
    });
    await physical.openUnlockAuthority({
      fileSystemId: openedUnlock.fileSystemId,
      minimumUnlockSequence: openedSuperblock.logicalState.minimumUnlockSequence,
      rootKey,
    });
    const record = await physical.readHomeRecord({
      fileSystemId: openedUnlock.fileSystemId,
      homeReference,
      relocationIndexRootPhysicalRef: openedSuperblock.logicalState.relocationIndexRootPhysicalRef,
      rootKey,
    });
    try {
      return recordInspection({
        maximumPreviewBytes,
        pageIsRoot: request.pageIsRoot,
        record,
      });
    } finally {
      record.plaintext.fill(0);
    }
  } finally {
    rootKey.destroy();
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  inspectPayload,
};
