import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createPhysicalRecordReference,
  decodeRecordFrameHeader,
  recordFrameLayoutForPlaintextLength,
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
} from "@/00-storage/service/hizofs/authenticated-store/diagnostics-hooks";
import {
  authenticateSegmentDescriptorSnapshot,
  readAuthenticatedSegmentDescriptor,
  rethrowAuthenticatedSegmentDescriptorReadError,
} from "./segment-prefix-reader";
import { authenticatedSegmentPath } from "./segment-location";

export type AuthenticatedRecordRead = Readonly<{
  header: RecordFrameHeaderV1;
  physicalReference: PhysicalRecordReference;
  plaintext: Uint8Array;
}>;

export type AuthenticatedRecordReadWithFrame = AuthenticatedRecordRead & Readonly<{
  frameBytes: Uint8Array;
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

function validatePhysicalReferenceFrameBound({ physicalReference }: {
  physicalReference: PhysicalRecordReference;
}): void {
  const maximumFrameLength = recordFrameLayoutForPlaintextLength({
    plaintextLength: plaintextMaximumBytes({ recordKind: physicalReference.recordKind }),
  }).frameLength;
  if (physicalReference.frameLength > maximumFrameLength) {
    throw authenticatedStoreError({
      code: "control_plane_corrupt",
      message: "Physical Record Reference frame length exceeds its V1 bound",
    });
  }
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

async function readDescriptorAndFrameFromSingleSnapshot({
  backend,
  diagnostics,
  fileSystemId,
  physicalReference,
  rootKey,
}: {
  backend: HizoFSReadableBackend;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSystemId: FileSystemId;
  physicalReference: PhysicalRecordReference;
  rootKey: FileSystemRootKey;
}): Promise<Readonly<{
  descriptor: Awaited<ReturnType<typeof readAuthenticatedSegmentDescriptor>>;
  frameBytes: Uint8Array;
}> | undefined> {
  const readPair = backend.readExactPairWithFileSize;
  if (readPair === undefined) return undefined;
  const segmentClass = segmentClassForRecordKind({ recordKind: physicalReference.recordKind });
  const path = authenticatedSegmentPath({
    segmentClass,
    segmentId: physicalReference.segmentId,
  });
  diagnostics?.recordPhysicalAccessReason?.({
    identity: `${String(path)}\u00000\u0000${HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.segmentHeader.toString()}`,
    operation: "read_exact",
    reason: "segment_descriptor",
  });
  diagnostics?.recordPhysicalAccessReason?.({
    identity: `${String(path)}\u0000${physicalReference.byteOffset.toString()}\u0000${physicalReference.frameLength.toString()}`,
    operation: "read_exact",
    reason: "authenticated_record_resolution",
  });
  let pair: Awaited<ReturnType<NonNullable<HizoFSReadableBackend["readExactPairWithFileSize"]>>>;
  try {
    pair = await readPair.call(backend, {
      first: {
        length: HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.segmentHeader,
        offset: 0n,
      },
      path,
      second: {
        length: physicalReference.frameLength,
        offset: physicalReference.byteOffset,
      },
    });
  } catch (cause: unknown) {
    rethrowAuthenticatedSegmentDescriptorReadError({ cause });
  }
  const descriptor = await authenticateSegmentDescriptorSnapshot({
    bytes: pair.first,
    diagnostics,
    fileSize: pair.fileSize,
    fileSystemId,
    path,
    physicalSegmentId: physicalReference.segmentId,
    rootKey,
    segmentClass,
  });
  const recordEnd = physicalReference.byteOffset + BigInt(physicalReference.frameLength);
  if (recordEnd > descriptor.fileSize || pair.second === undefined) {
    throw authenticatedStoreError({
      code: "control_plane_corrupt",
      message: "Physical Record Reference exceeds its segment file",
    });
  }
  return { descriptor, frameBytes: pair.second };
}

export async function readAuthenticatedPhysicalRecordWithFrame({
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
}): Promise<AuthenticatedRecordReadWithFrame> {
  validatePhysicalReferenceFrameBound({ physicalReference });
  const pairedRead = await readDescriptorAndFrameFromSingleSnapshot({
    backend,
    diagnostics,
    fileSystemId,
    physicalReference,
    rootKey,
  });
  let descriptor: Awaited<ReturnType<typeof readAuthenticatedSegmentDescriptor>>;
  let frameBytes: Uint8Array;
  if (pairedRead === undefined) {
    const segmentClass = segmentClassForRecordKind({ recordKind: physicalReference.recordKind });
    descriptor = await readAuthenticatedSegmentDescriptor({
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
    frameBytes = await readExactWithAuthenticatedReason({
      backend,
      diagnostics,
      length: physicalReference.frameLength,
      offset: physicalReference.byteOffset,
      path: descriptor.path,
      reason: "authenticated_record_resolution",
    });
  } else {
    ({ descriptor, frameBytes } = pairedRead);
  }
  const frameHeaderSize = HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.recordFrameHeader;
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
  return { frameBytes, header, physicalReference, plaintext };
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
  const { frameBytes: _frameBytes, ...record } = await readAuthenticatedPhysicalRecordWithFrame({
    backend,
    diagnostics,
    expectedIdentity,
    fileSystemId,
    physicalReference,
    rootKey,
  });
  return record;
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
