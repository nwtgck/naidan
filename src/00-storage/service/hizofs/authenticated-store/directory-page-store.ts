import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  decodeDirectoryPage,
  encodeDirectoryPage,
  type DirectoryPage,
  type FileSystemId,
  type HomeRecordReference,
  type PhysicalRecordReference,
} from "@/00-storage/service/hizofs/00-format";
import type { FileSystemRootKey } from "@/00-storage/service/hizofs/01-crypto";
import type { HizoFSWritableBackend } from "@/00-storage/service/hizofs/physical-store/backend";
import { authenticatedStoreError } from "./errors";
import type { AuthenticatedHizoFSPhysicalBytes } from "./physical-bytes";
import type { AuthenticatedMetadataRecordCache } from "./metadata-record-cache";
import { readAuthenticatedNamespaceHomeRecord } from "./namespace-record-source";
import { measureAuthenticatedCodecOperation, type AuthenticatedStoreDiagnosticsPort } from "@/00-storage/service/hizofs/authenticated-store/diagnostics-hooks";
import type { AuthenticatedSegmentAppendTarget } from "./record-appender";

export type ValidatedAuthenticatedDirectoryPage = Readonly<{
  encodedByteLength: number;
  localStructureValidated: true;
  page: DirectoryPage;
}>;

export type AuthenticatedDirectoryPageCacheAdmission = Readonly<{
  commit: () => void;
  discard: () => void;
}>;

export type AuthenticatedDirectoryPageCache = Readonly<{
  getPageForUpdate: ({ isRoot, reference }: {
    isRoot: boolean;
    reference: HomeRecordReference;
  }) => ValidatedAuthenticatedDirectoryPage | undefined;
  preparePageAdmission: ({ encodedByteLength, isRoot, page, reference }: {
    encodedByteLength: number;
    isRoot: boolean;
    page: DirectoryPage;
    reference: HomeRecordReference;
  }) => AuthenticatedDirectoryPageCacheAdmission;
  setPage: ({ encodedByteLength, isRoot, page, reference }: {
    encodedByteLength: number;
    isRoot: boolean;
    page: DirectoryPage;
    reference: HomeRecordReference;
  }) => void;
}>;

export async function readAuthenticatedDirectoryPageForUpdate({
  backend,
  decodedPageCache,
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
  decodedPageCache?: AuthenticatedDirectoryPageCache;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSystemId: FileSystemId;
  homeReference: HomeRecordReference;
  isRoot: boolean;
  metadataRecordCache?: AuthenticatedMetadataRecordCache;
  sharedMetadataRecordCache?: AuthenticatedMetadataRecordCache;
  relocationIndexRootPhysicalRef: PhysicalRecordReference | null;
  rootKey: FileSystemRootKey;
}): Promise<Readonly<{ encodedByteLength: number; localStructureValidated: true; page: DirectoryPage }>> {
  if (homeReference.recordKind !== HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.directory_page) {
    throw new TypeError("Directory page reference has the wrong record kind");
  }
  const cached = decodedPageCache?.getPageForUpdate({ isRoot, reference: homeReference });
  if (cached !== undefined) return cached;
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
    const page = measureAuthenticatedCodecOperation({
      diagnostics,
      format: "record",
      operation: "decode",
      run: () => decodeDirectoryPage({ bytes: record.plaintext, isRoot }),
    });
    decodedPageCache?.setPage({ encodedByteLength, isRoot, page, reference: homeReference });
    return Object.freeze({ encodedByteLength, localStructureValidated: true, page });
  } catch (cause: unknown) {
    throw authenticatedStoreError({
      cause,
      code: "control_plane_corrupt",
      message: "Directory page decode failed",
    });
  } finally {
    record.plaintext.fill(0);
  }
}

export async function readAuthenticatedDirectoryPage({
  backend,
  decodedPageCache,
  diagnostics,
  fileSystemId,
  homeReference,
  isRoot,
  metadataRecordCache,
  relocationIndexRootPhysicalRef,
  rootKey,
  sharedMetadataRecordCache,
}: Parameters<typeof readAuthenticatedDirectoryPageForUpdate>[0]): Promise<DirectoryPage> {
  return (await readAuthenticatedDirectoryPageForUpdate({
    backend, decodedPageCache, diagnostics, fileSystemId, homeReference, isRoot, metadataRecordCache,
    relocationIndexRootPhysicalRef, rootKey, sharedMetadataRecordCache,
  })).page;
}

export async function appendAuthenticatedDirectoryPage({ isRoot, page, sharedMetadataRecordCache, writer }: {
  isRoot: boolean;
  page: DirectoryPage;
  sharedMetadataRecordCache?: AuthenticatedMetadataRecordCache;
  writer: AuthenticatedSegmentAppendTarget;
}): Promise<Readonly<{ encodedByteLength: number; homeReference: HomeRecordReference }>> {
  switch (writer.segmentClass) {
  case "metadata": break;
  case "data": throw new TypeError("Directory pages require a metadata Segment writer");
  default: return writer.segmentClass satisfies never;
  }
  const recordKind = HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.directory_page;
  const plaintext = writer.encodeOwnedRecordPayload({ encode: () => encodeDirectoryPage({ isRoot, page }) });
  const encodedByteLength = plaintext.byteLength;
  if (sharedMetadataRecordCache === undefined) {
    const appended = await writer.appendOwnedRecord({ plaintext, recordKind });
    switch (appended.type) {
    case "home": return Object.freeze({ encodedByteLength, homeReference: appended.homeReference });
    case "physical_only": throw new Error("Directory page cannot be a physical-only record");
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
      return Object.freeze({ encodedByteLength, homeReference: appended.homeReference });
    case "physical_only": throw new Error("Directory page cannot be a physical-only record");
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
