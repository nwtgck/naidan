import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  decodeRecordFrameHeader,
  decodeSegmentHeader,
  segmentClassForRecordKind,
  segmentHeaderAuthenticatedPrefix,
  validatePhysicalOnlyRecordIdentity,
  type FileSystemId,
  type RecordFrameHeaderV1,
  type SegmentClass,
  type SegmentId,
} from "@/00-storage/service/hizofs/00-format";
import {
  authenticatedRecordBytes,
  authenticatedSegmentHeaderBytes,
  decryptAuthenticatedRecord,
  decryptAuthenticatedSegmentHeader,
  recordNonce,
  type FileSystemRootKey,
} from "@/00-storage/service/hizofs/crypto";
import type { HizoFSReadableBackend } from "@/00-storage/service/hizofs/physical-store/backend";
import type { CanonicalContainerPath } from "@/00-storage/service/hizofs/physical-store/paths";
import {
  measureAuthenticatedCryptoOperation,
  type AuthenticatedStoreDiagnosticsPort,
} from "./runtime-diagnostics-port";
import { authenticatedStoreError } from "./errors";
import { authenticatedSegmentPath } from "./segment-location";

export type AuthenticatedSegmentFrame = Readonly<{
  header: RecordFrameHeaderV1;
  physicalOffset: bigint;
}>;

export type AuthenticatedSegmentDescriptor = Readonly<{
  fileSize: bigint;
  path: CanonicalContainerPath;
}>;

export type ScannedSegmentPrefix = Readonly<{
  frames: readonly AuthenticatedSegmentFrame[];
  nextOffset: bigint;
  state: "abandoned_unsealed" | "complete_unsealed" | "footer_candidate";
}>;

function bytesEqual({ left, right }: { left: Uint8Array; right: Uint8Array }): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}

function segmentMaximumBytes({ segmentClass }: { segmentClass: SegmentClass }): number {
  switch (segmentClass) {
  case "data": return HIZOFS_V1_FORMAT_CONSTANTS.limits.dataSegmentFileMaximumBytes;
  case "metadata": return HIZOFS_V1_FORMAT_CONSTANTS.limits.metadataSegmentFileMaximumBytes;
  default: return segmentClass satisfies never;
  }
}

function frameMaximumCount({ segmentClass }: { segmentClass: SegmentClass }): number {
  switch (segmentClass) {
  case "data": return HIZOFS_V1_FORMAT_CONSTANTS.limits.dataFramesPerSegment;
  case "metadata": return HIZOFS_V1_FORMAT_CONSTANTS.limits.metadataFramesPerSegment;
  default: return segmentClass satisfies never;
  }
}

function plaintextMaximumBytes({ recordKind }: { recordKind: number }): number {
  return recordKind === HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_data
    ? HIZOFS_V1_FORMAT_CONSTANTS.limits.fileDataPlaintextBytes
    : HIZOFS_V1_FORMAT_CONSTANTS.limits.metadataPlaintextBytes;
}

export async function readAuthenticatedSegmentDescriptor({ backend, diagnostics, fileSystemId, physicalSegmentId, rootKey, segmentClass }: {
  backend: HizoFSReadableBackend;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSystemId: FileSystemId;
  physicalSegmentId: SegmentId;
  rootKey: FileSystemRootKey;
  segmentClass: SegmentClass;
}): Promise<AuthenticatedSegmentDescriptor> {
  const path = authenticatedSegmentPath({ segmentClass, segmentId: physicalSegmentId });
  const fileSize = await backend.getFileSize({ path });
  if (fileSize === undefined) {
    throw authenticatedStoreError({ code: "control_plane_corrupt", message: "referenced segment file is missing" });
  }
  const headerSize = BigInt(HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.segmentHeader);
  if (fileSize < headerSize || fileSize > BigInt(segmentMaximumBytes({ segmentClass }))) {
    throw authenticatedStoreError({ code: "control_plane_corrupt", message: "Segment file size is outside the V1 bound" });
  }
  const bytes = await backend.readExact({
    length: HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.segmentHeader,
    offset: 0n,
    path,
  });
  let header: ReturnType<typeof decodeSegmentHeader>;
  try {
    header = decodeSegmentHeader({ bytes });
    if (header.segmentClass !== segmentClass || !bytesEqual({ left: header.physicalSegmentId, right: physicalSegmentId })) {
      throw new TypeError("Segment Header does not match its path binding");
    }
  } catch (cause: unknown) {
    throw authenticatedStoreError({
      cause,
      code: "control_plane_corrupt",
      message: "Segment Header structure or path binding is invalid",
    });
  }
  try {
    const plaintext = await measureAuthenticatedCryptoOperation({
      diagnostics,
      operation: "decrypt",
      run: async () => await decryptAuthenticatedSegmentHeader({
        ciphertext: authenticatedSegmentHeaderBytes({ bytes: header.authenticationTag }),
        fileSystemId,
        physicalSegmentId,
        rootKey,
        segmentClass: HIZOFS_V1_FORMAT_CONSTANTS.container.segmentClasses[segmentClass],
        segmentHeaderPrefix: segmentHeaderAuthenticatedPrefix({ bytes }),
      }),
    });
    if (plaintext.byteLength !== 0) throw new TypeError("Segment Header plaintext must be empty");
  } catch (cause: unknown) {
    if (rootKey.isDestroyed()) throw cause;
    throw authenticatedStoreError({ cause, code: "control_plane_corrupt", message: "Segment Header authentication failed" });
  }
  return { fileSize, path };
}

export async function scanAuthenticatedSegmentPrefix({ backend, diagnostics, fileSystemId, physicalSegmentId, rootKey, segmentClass }: {
  backend: HizoFSReadableBackend;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSystemId: FileSystemId;
  physicalSegmentId: SegmentId;
  rootKey: FileSystemRootKey;
  segmentClass: SegmentClass;
}): Promise<ScannedSegmentPrefix> {
  const { fileSize, path } = await readAuthenticatedSegmentDescriptor({
    backend,
    diagnostics,
    fileSystemId,
    physicalSegmentId,
    rootKey,
    segmentClass,
  });
  const headerSize = BigInt(HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.segmentHeader);
  const frames: AuthenticatedSegmentFrame[] = [];
  const frameHeaderSize = HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.recordFrameHeader;
  const footerMagic = new TextEncoder().encode(HIZOFS_V1_FORMAT_CONSTANTS.magic.segmentFooter);
  let offset = headerSize;
  while (offset < fileSize) {
    const remaining = fileSize - offset;
    if (remaining < BigInt(frameHeaderSize)) return { frames, nextOffset: offset, state: "abandoned_unsealed" };
    const headerBytes = await backend.readExact({ length: frameHeaderSize, offset, path });
    if (bytesEqual({ left: headerBytes.subarray(0, footerMagic.byteLength), right: footerMagic })) {
      return { frames, nextOffset: offset, state: "footer_candidate" };
    }

    let header: RecordFrameHeaderV1;
    try {
      header = decodeRecordFrameHeader({ bytes: headerBytes });
      if (segmentClassForRecordKind({ recordKind: header.recordKind }) !== segmentClass
        || header.plaintextLength > plaintextMaximumBytes({ recordKind: header.recordKind })
        || frames.length >= frameMaximumCount({ segmentClass })
        || BigInt(header.frameLength) > remaining) {
        throw new TypeError("Record Frame violates its segment bounds");
      }
      if (header.recordKind === HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.relocation_index_page) {
        validatePhysicalOnlyRecordIdentity({
          authenticatedHeader: header,
          physicalOffset: offset,
          physicalSegmentId,
        });
      }
    } catch {
      return { frames, nextOffset: offset, state: "abandoned_unsealed" };
    }

    const body = await backend.readExact({
      length: header.frameLength - frameHeaderSize,
      offset: offset + BigInt(frameHeaderSize),
      path,
    });
    const ciphertext = body.subarray(0, header.sealedLength);
    if (body.subarray(header.sealedLength).some(byte => byte !== 0)) {
      return { frames, nextOffset: offset, state: "abandoned_unsealed" };
    }
    try {
      await measureAuthenticatedCryptoOperation({
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
      if (rootKey.isDestroyed()) throw cause;
      return { frames, nextOffset: offset, state: "abandoned_unsealed" };
    }
    frames.push({ header, physicalOffset: offset });
    offset += BigInt(header.frameLength);
  }
  return { frames, nextOffset: offset, state: "complete_unsealed" };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
