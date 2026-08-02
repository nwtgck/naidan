import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  assertRecordFrameReaderValidity,
  decodeRecordFrameHeader,
  decodeSegmentHeader,
  segmentFileSizeIsReaderValid,
  segmentFramePaddingIsZero,
  segmentHeaderMatchesPhysicalIdentity,
  segmentHeaderAuthenticatedPrefix,
  segmentPrefixHasTruncatedFrameHeader,
  segmentPrefixStartsWithFooterMagic,
  type FileSystemId,
  type RecordFrameHeaderV1,
  type SegmentClass,
  type SegmentFrameDescriptor,
  type SegmentId,
} from "@/00-storage/service/hizofs/00-format";
import {
  authenticatedRecordBytes,
  authenticatedSegmentHeaderBytes,
  decryptAuthenticatedRecord,
  decryptAuthenticatedSegmentHeader,
  recordNonce,
  type FileSystemRootKey,
} from "@/00-storage/service/hizofs/01-crypto";
import type { HizoFSReadableBackend } from "@/00-storage/service/hizofs/physical-store/backend";
import type { CanonicalContainerPath } from "@/00-storage/service/hizofs/physical-store/paths";
import {
  measureAuthenticatedCryptoOperation,
  type AuthenticatedStoreDiagnosticsPort,
} from "./runtime-diagnostics-port";
import { authenticatedStoreError } from "./errors";
import { authenticatedSegmentPath } from "./segment-location";

export type AuthenticatedSegmentFrame = SegmentFrameDescriptor;

export type AuthenticatedSegmentDescriptor = Readonly<{
  fileSize: bigint;
  path: CanonicalContainerPath;
}>;

export type ScannedSegmentPrefix = Readonly<{
  frames: readonly AuthenticatedSegmentFrame[];
  nextOffset: bigint;
  state: "abandoned_unsealed" | "complete_unsealed" | "footer_candidate";
}>;

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
  if (!segmentFileSizeIsReaderValid({ fileSize, segmentClass })) {
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
    if (!segmentHeaderMatchesPhysicalIdentity({ header, physicalSegmentId, segmentClass })) {
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
  let offset = headerSize;
  while (offset < fileSize) {
    const remaining = fileSize - offset;
    if (segmentPrefixHasTruncatedFrameHeader({ remainingBytes: remaining })) {
      return { frames, nextOffset: offset, state: "abandoned_unsealed" };
    }
    const headerBytes = await backend.readExact({ length: frameHeaderSize, offset, path });
    if (segmentPrefixStartsWithFooterMagic({ bytes: headerBytes })) {
      return { frames, nextOffset: offset, state: "footer_candidate" };
    }

    let header: RecordFrameHeaderV1;
    try {
      header = decodeRecordFrameHeader({ bytes: headerBytes });
      assertRecordFrameReaderValidity({
        frameCount: frames.length,
        header,
        physicalOffset: offset,
        physicalSegmentId,
        remainingBytes: remaining,
        segmentClass,
      });
    } catch {
      return { frames, nextOffset: offset, state: "abandoned_unsealed" };
    }

    const body = await backend.readExact({
      length: header.frameLength - frameHeaderSize,
      offset: offset + BigInt(frameHeaderSize),
      path,
    });
    const ciphertext = body.subarray(0, header.sealedLength);
    if (!segmentFramePaddingIsZero({ body, sealedLength: header.sealedLength })) {
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
