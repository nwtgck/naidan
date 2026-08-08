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
import type { HizoFSWritableBackend } from "@/00-storage/service/hizofs/physical-store/backend";
import { authenticatedStoreError } from "./errors";
import type { AuthenticatedHizoFSPhysicalBytes } from "./physical-bytes";
import type { AuthenticatedMetadataRecordCache } from "./metadata-record-cache";
import { readAuthenticatedNamespaceHomeRecord } from "./namespace-record-source";
import { measureAuthenticatedCodecOperation, type AuthenticatedStoreDiagnosticsPort } from "@/00-storage/service/hizofs/authenticated-store/diagnostics-hooks";
import {
  encodedHizoFSRecord,
  type AuthenticatedSegmentAppendTarget,
} from "./record-appender";

export type AuthenticatedInodeTablePage =
  | InodeLeafPage
  | Readonly<{
    entries: InodeBranchPage["entries"];
    level: number;
    type: "branch";
  }>;

export async function readAuthenticatedInodeTablePage({
  backend,
  diagnostics,
  fileSystemId,
  homeReference,
  isRoot,
  metadataRecordCache,
  sharedMetadataRecordCache,
  relocationIndexRootPhysicalRef,
  rootKey,
}: {
  backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSystemId: FileSystemId;
  homeReference: HomeRecordReference;
  isRoot: boolean;
  metadataRecordCache?: AuthenticatedMetadataRecordCache;
  sharedMetadataRecordCache?: AuthenticatedMetadataRecordCache;
  relocationIndexRootPhysicalRef: PhysicalRecordReference | null;
  rootKey: FileSystemRootKey;
}): Promise<AuthenticatedInodeTablePage> {
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
    return measureAuthenticatedCodecOperation({
      diagnostics,
      format: "record",
      operation: "decode",
      run: () => {
        const header = decodeCommonPageHeader({ bytes: record.plaintext, family: "inode", isRoot });
        if (header.level === 0) return decodeInodeLeafPage({ bytes: record.plaintext, isRoot });
        const page = decodeInodeBranchPage({ bytes: record.plaintext, isRoot });
        return { ...page, type: "branch" };
      },
    });
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
  const plaintext = writer.encodeRecordPayload({ encode: () => {
    switch (page.type) {
    case "leaf": return encodeInodeLeafPage({ entries: page.entries, isRoot });
    case "branch": return encodeInodeBranchPage({ page: { entries: page.entries, level: page.level }, isRoot });
    default: return page satisfies never;
    }
  } });
  const encoded = encodedHizoFSRecord({
    plaintext,
    recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
  });
  try {
    const [appended] = await writer.append({ records: [encoded] });
    if (appended === undefined) throw new Error("Inode Table page append result is missing");
    switch (appended.type) {
    case "home":
      sharedMetadataRecordCache?.admitAuthenticatedWrite({
        plaintext: encoded.plaintext,
        recordKind: encoded.recordKind,
        reference: appended.homeReference,
      });
      return appended.homeReference;
    case "physical_only": throw new Error("Inode Table page cannot be a physical-only record");
    default: return appended satisfies never;
    }
  } finally {
    plaintext.fill(0);
    encoded.plaintext.fill(0);
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
