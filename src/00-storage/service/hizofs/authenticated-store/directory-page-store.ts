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
import {
  encodedHizoFSRecord,
  type AuthenticatedSegmentWriter,
} from "./record-appender";

export async function readAuthenticatedDirectoryPage({
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
}): Promise<DirectoryPage> {
  if (homeReference.recordKind !== HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.directory_page) {
    throw new TypeError("Directory page reference has the wrong record kind");
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
    return measureAuthenticatedCodecOperation({ diagnostics, format: "record", operation: "decode", run: () => decodeDirectoryPage({ bytes: record.plaintext, isRoot }) });
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

export async function appendAuthenticatedDirectoryPage({ isRoot, page, sharedMetadataRecordCache, writer }: {
  isRoot: boolean;
  page: DirectoryPage;
  sharedMetadataRecordCache?: AuthenticatedMetadataRecordCache;
  writer: AuthenticatedSegmentWriter;
}): Promise<HomeRecordReference> {
  switch (writer.segmentClass) {
  case "metadata": break;
  case "data": throw new TypeError("Directory pages require a metadata Segment writer");
  default: return writer.segmentClass satisfies never;
  }
  const encoded = encodedHizoFSRecord({
    plaintext: writer.encodeRecordPayload({ encode: () => encodeDirectoryPage({ isRoot, page }) }),
    recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.directory_page,
  });
  try {
    const [appended] = await writer.append({ records: [encoded] });
    if (appended === undefined) throw new Error("Directory page append result is missing");
    switch (appended.type) {
    case "home":
      sharedMetadataRecordCache?.admitAuthenticatedWrite({
        plaintext: encoded.plaintext,
        recordKind: encoded.recordKind,
        reference: appended.homeReference,
      });
      return appended.homeReference;
    case "physical_only": throw new Error("Directory page cannot be a physical-only record");
    default: return appended satisfies never;
    }
  } finally {
    encoded.plaintext.fill(0);
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
