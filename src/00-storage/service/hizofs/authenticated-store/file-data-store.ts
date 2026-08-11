import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  decodeFileDataPayload,
  encodeFileDataPayload,
  type FileSystemId,
  type HomeRecordReference,
  type PhysicalRecordReference,
} from "@/00-storage/service/hizofs/00-format";
import type { FileSystemRootKey } from "@/00-storage/service/hizofs/01-crypto";
import type { HizoFSWritableBackend } from "@/00-storage/service/hizofs/physical-store/backend";
import { authenticatedStoreError } from "./errors";
import type { AuthenticatedHizoFSPhysicalBytes } from "./physical-bytes";
import { measureAuthenticatedCodecOperation, type AuthenticatedStoreDiagnosticsPort } from "@/00-storage/service/hizofs/authenticated-store/diagnostics-hooks";
import type { AuthenticatedSegmentWriter } from "./record-appender";
import { resolveAuthenticatedHomeRecord } from "./relocation-index-reader";

export async function readAuthenticatedFileData({
  backend,
  diagnostics,
  fileSystemId,
  homeReference,
  relocationIndexRootPhysicalRef,
  rootKey,
}: {
  backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSystemId: FileSystemId;
  homeReference: HomeRecordReference;
  relocationIndexRootPhysicalRef: PhysicalRecordReference | null;
  rootKey: FileSystemRootKey;
}): Promise<Uint8Array> {
  if (homeReference.recordKind !== HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_data) {
    throw new TypeError("File Data reference has the wrong record kind");
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
    const payload = measureAuthenticatedCodecOperation({ diagnostics, format: "record", operation: "decode", run: () => decodeFileDataPayload({ bytes: record.plaintext }) });
    try {
      return Uint8Array.from(payload.bytes);
    } finally {
      payload.bytes.fill(0);
    }
  } catch (cause: unknown) {
    throw authenticatedStoreError({
      cause,
      code: "control_plane_corrupt",
      message: "File Data decode failed",
    });
  } finally {
    record.plaintext.fill(0);
  }
}

export async function appendAuthenticatedFileData({ bytes, writer }: {
  bytes: Uint8Array;
  writer: AuthenticatedSegmentWriter;
}): Promise<HomeRecordReference> {
  switch (writer.segmentClass) {
  case "data": break;
  case "metadata": throw new TypeError("File Data requires a data Segment writer");
  default: return writer.segmentClass satisfies never;
  }
  const appended = await writer.appendCallerOwnedRecord({
    plaintext: writer.encodeRecordPayload({ encode: () => encodeFileDataPayload({ payload: { bytes } }) }),
    recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_data,
  });
  switch (appended.type) {
  case "home": return appended.homeReference;
  case "physical_only": throw new Error("File Data cannot be a physical-only record");
  default: return appended satisfies never;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
