import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  decodeCommonPageHeader,
  decodeInodeBranchPage,
  decodeInodeLeafPage,
  encodeInodeBranchPage,
  encodeInodeLeafPage,
  type FileSystemId,
  type HomeRecordReference,
  type InodeBranchPage,
  type InodeLeafPage,
  type PhysicalRecordReference,
} from "@/00-storage/service/hizofs/00-format";
import type { FileSystemRootKey } from "@/00-storage/service/hizofs/01-crypto";
import type { HizoFSReadableBackend } from "@/00-storage/service/hizofs/physical-store/backend";
import { authenticatedStoreError } from "./errors";
import type { AuthenticatedMetadataRecordCache } from "./metadata-record-cache";
import { readAuthenticatedNamespaceHomeRecord } from "./namespace-record-source";
import { measureAuthenticatedCodecOperation, type AuthenticatedStoreDiagnosticsPort } from "@/00-storage/service/hizofs/authenticated-store/diagnostics-hooks";
import type { AuthenticatedSegmentAppendTarget } from "./record-appender";

export type AuthenticatedInodeTablePage =
  | InodeLeafPage
  | Readonly<{
    entries: InodeBranchPage["entries"];
    level: number;
    type: "branch";
  }>;

export type AuthenticatedInodeBranchPageCache = Readonly<{
  getBranchPage: ({ isRoot, reference }: {
    isRoot: boolean;
    reference: HomeRecordReference;
  }) => InodeBranchPage | undefined;
  setBranchPage: ({ isRoot, page, reference }: {
    isRoot: boolean;
    page: InodeBranchPage;
    reference: HomeRecordReference;
  }) => void;
}>;

export async function readAuthenticatedInodeTablePageForUpdate({
  backend,
  diagnostics,
  decodedBranchPageCache,
  fileSystemId,
  homeReference,
  isRoot,
  metadataRecordCache,
  sharedMetadataRecordCache,
  relocationIndexRootPhysicalRef,
  rootKey,
}: {
  backend: HizoFSReadableBackend;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  decodedBranchPageCache?: AuthenticatedInodeBranchPageCache;
  fileSystemId: FileSystemId;
  homeReference: HomeRecordReference;
  isRoot: boolean;
  metadataRecordCache?: AuthenticatedMetadataRecordCache;
  sharedMetadataRecordCache?: AuthenticatedMetadataRecordCache;
  relocationIndexRootPhysicalRef: PhysicalRecordReference | null;
  rootKey: FileSystemRootKey;
}): Promise<Readonly<{ encodedByteLength: number; localStructureValidated: true; page: AuthenticatedInodeTablePage }>> {
  if (homeReference.recordKind !== HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page) {
    throw new TypeError("Inode Table page reference has the wrong record kind");
  }
  const record = await readAuthenticatedNamespaceHomeRecord({
    backend,
    diagnostics,
    fileSystemId,
    metadataRecordCache,
    sharedMetadataRecordCache,
    reference: homeReference,
    relocationIndexRootPhysicalRef,
    rootKey,
  });
  try {
    const encodedByteLength = record.plaintext.byteLength;
    // WHY: Reuse decoded branch routing only after the immutable Record has
    // traversed authenticated resolution. Returning cached decoded state earlier
    // could hide an authentication or storage failure that this mutation must
    // observe, while reuse here still avoids repeated branch decode/allocation.
    const cachedBranch = decodedBranchPageCache?.getBranchPage({ isRoot, reference: homeReference });
    if (cachedBranch !== undefined) {
      return Object.freeze({
        encodedByteLength,
        localStructureValidated: true,
        page: { ...cachedBranch, type: "branch" as const },
      });
    }
    const page = measureAuthenticatedCodecOperation({
      diagnostics,
      format: "record",
      operation: "decode",
      run: () => {
        const header = decodeCommonPageHeader({ bytes: record.plaintext, family: "inode", isRoot });
        if (header.level === 0) return decodeInodeLeafPage({ bytes: record.plaintext, isRoot });
        const decoded = decodeInodeBranchPage({ bytes: record.plaintext, isRoot });
        return { ...decoded, type: "branch" } as const;
      },
    });
    return Object.freeze({ encodedByteLength, localStructureValidated: true, page });
  } catch (cause: unknown) {
    throw authenticatedStoreError({
      cause,
      code: "control_plane_corrupt",
      message: "Inode Table page decode failed",
    });
  } finally {
    record.plaintext.fill(0);
  }
}

export async function readAuthenticatedInodeTablePage({
  backend,
  decodedBranchPageCache,
  diagnostics,
  fileSystemId,
  homeReference,
  isRoot,
  metadataRecordCache,
  relocationIndexRootPhysicalRef,
  rootKey,
  sharedMetadataRecordCache,
}: Parameters<typeof readAuthenticatedInodeTablePageForUpdate>[0]): Promise<AuthenticatedInodeTablePage> {
  return (await readAuthenticatedInodeTablePageForUpdate({
    backend, decodedBranchPageCache, diagnostics, fileSystemId, homeReference, isRoot, metadataRecordCache,
    relocationIndexRootPhysicalRef, rootKey, sharedMetadataRecordCache,
  })).page;
}

export async function appendAuthenticatedInodeTablePage({
  isRoot,
  page,
  sharedMetadataRecordCache,
  writer,
}: {
  isRoot: boolean;
  page: AuthenticatedInodeTablePage;
  sharedMetadataRecordCache?: AuthenticatedMetadataRecordCache;
  writer: AuthenticatedSegmentAppendTarget;
}): Promise<HomeRecordReference> {
  switch (writer.segmentClass) {
  case "metadata": break;
  case "data": throw new TypeError("Inode Table pages require a metadata Segment writer");
  default: return writer.segmentClass satisfies never;
  }
  const plaintext = writer.encodeOwnedRecordPayload({ encode: () => {
    switch (page.type) {
    case "leaf": return encodeInodeLeafPage({ entries: page.entries, isRoot });
    case "branch": return encodeInodeBranchPage({ page: { entries: page.entries, level: page.level }, isRoot });
    default: return page satisfies never;
    }
  } });
  const recordKind = HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page;
  if (sharedMetadataRecordCache === undefined) {
    const appended = await writer.appendOwnedRecord({ plaintext, recordKind });
    switch (appended.type) {
    case "home": return appended.homeReference;
    case "physical_only": throw new Error("Inode Table page cannot be a physical-only record");
    default: return appended satisfies never;
    }
  }
  try {
    const appended = await writer.appendCallerOwnedRecord({ plaintext, recordKind });
    switch (appended.type) {
    case "home":
      sharedMetadataRecordCache?.admitAuthenticatedWrite({
        plaintext,
        recordKind,
        reference: appended.homeReference,
      });
      return appended.homeReference;
    case "physical_only": throw new Error("Inode Table page cannot be a physical-only record");
    default: return appended satisfies never;
    }
  } finally {
    plaintext.fill(0);
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
