import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  decodeFileExtentPage,
  encodeFileExtentPage,
  type FileExtentPage,
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

export async function readAuthenticatedFileExtentPageForUpdate({
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
}): Promise<Readonly<{ encodedByteLength: number; localStructureValidated: true; page: FileExtentPage }>> {
  if (homeReference.recordKind !== HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_extent_page) {
    throw new TypeError("File Extent page reference has the wrong record kind");
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
    const page = measureAuthenticatedCodecOperation({
      diagnostics,
      format: "record",
      operation: "decode",
      run: () => decodeFileExtentPage({ bytes: record.plaintext, isRoot }),
    });
    return Object.freeze({ encodedByteLength, localStructureValidated: true, page });
  } catch (cause: unknown) {
    throw authenticatedStoreError({
      cause,
      code: "control_plane_corrupt",
      message: "File Extent page decode failed",
    });
  } finally {
    record.plaintext.fill(0);
  }
}

export async function readAuthenticatedFileExtentPage({
  backend,
  diagnostics,
  fileSystemId,
  homeReference,
  isRoot,
  metadataRecordCache,
  relocationIndexRootPhysicalRef,
  rootKey,
  sharedMetadataRecordCache,
}: Parameters<typeof readAuthenticatedFileExtentPageForUpdate>[0]): Promise<FileExtentPage> {
  return (await readAuthenticatedFileExtentPageForUpdate({
    backend, diagnostics, fileSystemId, homeReference, isRoot, metadataRecordCache,
    relocationIndexRootPhysicalRef, rootKey, sharedMetadataRecordCache,
  })).page;
}

export async function appendAuthenticatedFileExtentPage({ isRoot, page, sharedMetadataRecordCache, writer }: {
  isRoot: boolean;
  page: FileExtentPage;
  sharedMetadataRecordCache?: AuthenticatedMetadataRecordCache;
  writer: AuthenticatedSegmentAppendTarget;
}): Promise<HomeRecordReference> {
  switch (writer.segmentClass) {
  case "metadata": break;
  case "data": throw new TypeError("File Extent pages require a metadata Segment writer");
  default: return writer.segmentClass satisfies never;
  }
  const recordKind = HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_extent_page;
  const plaintext = writer.encodeOwnedRecordPayload({ encode: () => encodeFileExtentPage({ isRoot, page }) });
  if (sharedMetadataRecordCache === undefined) {
    const appended = await writer.appendOwnedRecord({ plaintext, recordKind });
    switch (appended.type) {
    case "home": return appended.homeReference;
    case "physical_only": throw new Error("File Extent page cannot be a physical-only record");
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
    case "physical_only": throw new Error("File Extent page cannot be a physical-only record");
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
