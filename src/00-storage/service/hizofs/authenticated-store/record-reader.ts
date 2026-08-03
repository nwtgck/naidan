import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createPhysicalRecordReference,
  decodeRecordFrameHeader,
  segmentClassForRecordKind,
  validatePhysicalOnlyRecordIdentity,
  validateRelocationMapping,
  type FileSystemId,
  type HomeRecordReference,
  type PhysicalRecordReference,
  type RecordFrameHeaderV1,
} from "@/00-storage/service/hizofs/00-format";
import {
  authenticatedRecordBytes,
  decryptAuthenticatedRecord,
  isHizoFSCryptoAuthenticationError,
  recordNonce,
  type FileSystemRootKey,
} from "@/00-storage/service/hizofs/01-crypto";
import type { HizoFSReadableBackend } from "@/00-storage/service/hizofs/physical-store/backend";
import { authenticatedStoreError } from "./errors";
import {
  measureAuthenticatedCryptoOperation,
  readExactWithAuthenticatedReason,
  type AuthenticatedStoreDiagnosticsPort,
} from "./runtime-diagnostics-port";
import { readAuthenticatedSegmentDescriptor } from "./segment-prefix-reader";

export type AuthenticatedRecordRead = Readonly<{
  header: RecordFrameHeaderV1;
  physicalReference: PhysicalRecordReference;
  plaintext: Uint8Array;
}>;

export type ExpectedRecordIdentity =
  | Readonly<{
    homeReference: HomeRecordReference;
    type: "logical";
  }>
  | Readonly<{
    type: "physical_only";
  }>;

function plaintextMaximumBytes({ recordKind }: { recordKind: number }): number {
  return recordKind === HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_data
    ? HIZOFS_V1_FORMAT_CONSTANTS.limits.fileDataPlaintextBytes
    : HIZOFS_V1_FORMAT_CONSTANTS.limits.metadataPlaintextBytes;
}

function validateReferenceAndHeader({ expectedIdentity, header, physicalReference }: {
  expectedIdentity: ExpectedRecordIdentity;
  header: RecordFrameHeaderV1;
  physicalReference: PhysicalRecordReference;
}): void {
  if (header.frameLength !== physicalReference.frameLength
    || header.recordKind !== physicalReference.recordKind) {
    throw new TypeError("Record Frame does not match its Physical Record Reference");
  }
  switch (expectedIdentity.type) {
  case "logical":
    validateRelocationMapping({
      authenticatedHeader: header,
      homeReference: expectedIdentity.homeReference,
      mappedPhysicalReference: physicalReference,
    });
    return;
  case "physical_only":
    validatePhysicalOnlyRecordIdentity({
      authenticatedHeader: header,
      physicalOffset: physicalReference.byteOffset,
      physicalSegmentId: physicalReference.segmentId,
    });
    return;
  default:
    return expectedIdentity satisfies never;
  }
}

export function physicalReferenceAtHome({ homeReference }: {
  homeReference: HomeRecordReference;
}): PhysicalRecordReference {
  return createPhysicalRecordReference({ fields: {
    byteOffset: homeReference.byteOffset,
    frameLength: homeReference.frameLength,
    recordKind: homeReference.recordKind,
    segmentId: homeReference.segmentId,
  } });
}

export async function readAuthenticatedPhysicalRecord({
  backend,
  diagnostics,
  expectedIdentity,
  fileSystemId,
  physicalReference,
  rootKey,
}: {
  backend: HizoFSReadableBackend;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  expectedIdentity: ExpectedRecordIdentity;
  fileSystemId: FileSystemId;
  physicalReference: PhysicalRecordReference;
  rootKey: FileSystemRootKey;
}): Promise<AuthenticatedRecordRead> {
  const segmentClass = segmentClassForRecordKind({ recordKind: physicalReference.recordKind });
  const descriptor = await readAuthenticatedSegmentDescriptor({
    backend,
    diagnostics,
    fileSystemId,
    physicalSegmentId: physicalReference.segmentId,
    rootKey,
    segmentClass,
  });
  const recordEnd = physicalReference.byteOffset + BigInt(physicalReference.frameLength);
  if (recordEnd > descriptor.fileSize) {
    throw authenticatedStoreError({
      code: "control_plane_corrupt",
      message: "Physical Record Reference exceeds its segment file",
    });
  }
  const frameHeaderSize = HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.recordFrameHeader;
  // The authenticated Physical Record Reference already fixes the complete
  // frame length. Reading the frame once avoids a second OPFS snapshot and
  // await boundary without weakening header validation, canonical padding,
  // or authenticated decryption.
  const frameBytes = await readExactWithAuthenticatedReason({
    backend,
    diagnostics,
    length: physicalReference.frameLength,
    offset: physicalReference.byteOffset,
    path: descriptor.path,
    reason: "authenticated_record_resolution",
  });
  const headerBytes = frameBytes.subarray(0, frameHeaderSize);
  let header: RecordFrameHeaderV1;
  try {
    header = decodeRecordFrameHeader({ bytes: headerBytes });
    validateReferenceAndHeader({ expectedIdentity, header, physicalReference });
    if (header.plaintextLength > plaintextMaximumBytes({ recordKind: header.recordKind })) {
      throw new RangeError("Record Frame plaintext exceeds its V1 bound");
    }
  } catch (cause: unknown) {
    throw authenticatedStoreError({
      cause,
      code: "control_plane_corrupt",
      message: "Record Frame header validation failed",
    });
  }

  const body = frameBytes.subarray(frameHeaderSize);
  const ciphertext = body.subarray(0, header.sealedLength);
  if (body.subarray(header.sealedLength).some(byte => byte !== 0)) {
    throw authenticatedStoreError({
      cause: new TypeError("Record Frame padding must be canonical zero"),
      code: "control_plane_corrupt",
      message: "Record Frame authentication failed",
    });
  }
  let plaintext: Uint8Array;
  try {
    plaintext = await measureAuthenticatedCryptoOperation({
      diagnostics,
      operation: "decrypt",
      run: async () => await decryptAuthenticatedRecord({
        ciphertext: authenticatedRecordBytes({ bytes: ciphertext }),
        completeFrameHeader: headerBytes,
        fileSystemId,
        homeSegmentId: header.homeSegmentId,
        nonce: recordNonce({ bytes: header.nonce }),
        rootKey,
      }),
    });
  } catch (cause: unknown) {
    if (!isHizoFSCryptoAuthenticationError({ cause })) throw cause;
    throw authenticatedStoreError({
      cause,
      code: "control_plane_corrupt",
      message: "Record Frame authentication failed",
    });
  }
  diagnostics?.recordPersistedRecord({
    operation: "read",
    physicalBytes: header.frameLength,
    plaintextBytes: plaintext.byteLength,
    recordKind: header.recordKind,
  });
  return { header, physicalReference, plaintext };
}

export async function readAuthenticatedHomeRecord({
  backend,
  diagnostics,
  fileSystemId,
  homeReference,
  rootKey,
}: {
  backend: HizoFSReadableBackend;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSystemId: FileSystemId;
  homeReference: HomeRecordReference;
  rootKey: FileSystemRootKey;
}): Promise<AuthenticatedRecordRead> {
  return await readAuthenticatedPhysicalRecord({
    backend,
    diagnostics,
    expectedIdentity: { homeReference, type: "logical" },
    fileSystemId,
    physicalReference: physicalReferenceAtHome({ homeReference }),
    rootKey,
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
