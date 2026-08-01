import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  decodeFileExtentPage,
  encodeFileExtentPage,
  type FileExtentPage,
  type FileSystemId,
  type HomeRecordReference,
  type PhysicalRecordReference,
} from "@/00-storage/service/hizofs/00-format";
import type { FileSystemRootKey } from "@/00-storage/service/hizofs/crypto";
import type { HizoFSWritableBackend } from "@/00-storage/service/hizofs/physical-store/backend";
import { authenticatedStoreError } from "./errors";
import type { AuthenticatedHizoFSPhysicalBytes } from "./physical-bytes";
import { measureAuthenticatedCodecOperation, type AuthenticatedStoreDiagnosticsPort } from "./runtime-diagnostics-port";
import {
  encodedHizoFSRecord,
  type AuthenticatedSegmentWriter,
} from "./record-appender";
import { resolveAuthenticatedHomeRecord } from "./relocation-index-reader";

export async function readAuthenticatedFileExtentPage({
  backend,
  diagnostics,
  fileSystemId,
  homeReference,
  isRoot,
  relocationIndexRootPhysicalRef,
  rootKey,
}: {
  backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSystemId: FileSystemId;
  homeReference: HomeRecordReference;
  isRoot: boolean;
  relocationIndexRootPhysicalRef: PhysicalRecordReference | null;
  rootKey: FileSystemRootKey;
}): Promise<FileExtentPage> {
  if (homeReference.recordKind !== HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_extent_page) {
    throw new TypeError("File Extent page reference has the wrong record kind");
  }
  const record = await resolveAuthenticatedHomeRecord({
    backend,
    diagnostics,
    fileSystemId,
    homeReference,
    relocationIndexRootPhysicalRef,
    rootKey,
  });
  try {
    return measureAuthenticatedCodecOperation({ diagnostics, format: "record", operation: "decode", run: () => decodeFileExtentPage({ bytes: record.plaintext, isRoot }) });
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

export async function appendAuthenticatedFileExtentPage({ isRoot, page, writer }: {
  isRoot: boolean;
  page: FileExtentPage;
  writer: AuthenticatedSegmentWriter;
}): Promise<HomeRecordReference> {
  switch (writer.segmentClass) {
  case "metadata": break;
  case "data": throw new TypeError("File Extent pages require a metadata Segment writer");
  default: return writer.segmentClass satisfies never;
  }
  const [appended] = await writer.append({ records: [encodedHizoFSRecord({
    plaintext: writer.encodeRecordPayload({ encode: () => encodeFileExtentPage({ isRoot, page }) }),
    recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_extent_page,
  })] });
  if (appended === undefined) throw new Error("File Extent page append result is missing");
  switch (appended.type) {
  case "home": return appended.homeReference;
  case "physical_only": throw new Error("File Extent page cannot be a physical-only record");
  default: return appended satisfies never;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
