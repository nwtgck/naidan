import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  calculateSegmentFooterTotalLength,
  createSegmentFooterHeader,
  createUInt64,
  decodeRecordFrameHeader,
  decodeSegmentFooterHeader,
  decodeSegmentFooterIndexEntry,
  decodeSegmentFooterTrailer,
  encodeSegmentFooterHeader,
  encodeSegmentFooterIndexEntry,
  encodeSegmentFooterTrailer,
  segmentFooterCandidateStructureIsValid,
  segmentFooterIndexEntryFromFrame,
  segmentFooterIndexEntryMatchesFrame,
  segmentFooterTrailerIsReaderCandidate,
  type FileSystemId,
  type SegmentClass,
  type SegmentFooterHeaderV1,
  type SegmentFooterIndexEntryV1,
  type SegmentId,
} from "@/00-storage/service/hizofs/00-format";
import {
  authenticatedSegmentFooterBytes,
  decryptAuthenticatedSegmentFooter,
  encryptSegmentFooter,
  generateSegmentFooterNonce,
  plaintextSegmentFooterBytes,
  segmentFooterNonce,
  type FileSystemRootKey,
  type RandomByteSource,
} from "@/00-storage/service/hizofs/crypto";
import type { HizoFSWritableBackend, HizoFSReadableBackend } from "@/00-storage/service/hizofs/physical-store/backend";
import type { ActiveSegmentWriterCapability } from "./record-appender";
import { authenticatedStoreError } from "./errors";
import { runAndCloseAuthenticatedFile } from "./file-operation";
import {
  authenticatedHizoFSPhysicalBytes,
  type AuthenticatedHizoFSPhysicalBytes,
} from "./physical-bytes";
import {
  readAuthenticatedSegmentDescriptor,
  scanAuthenticatedSegmentPrefix,
  type AuthenticatedSegmentFrame,
} from "./segment-prefix-reader";
import {
  measureAuthenticatedCryptoOperation,
  type AuthenticatedStoreDiagnosticsPort,
} from "./runtime-diagnostics-port";

export type AuthenticatedSegmentFooter = Readonly<{
  header: SegmentFooterHeaderV1;
  physicalOffset: bigint;
  totalLength: number;
}>;

export type AuthenticatedSegmentIndex = Readonly<{
  footer: AuthenticatedSegmentFooter | undefined;
  frames: readonly AuthenticatedSegmentFrame[];
  state: "abandoned_unsealed" | "complete_unsealed" | "footer_unusable" | "sealed";
}>;

function concatenate({ chunks, totalLength }: {
  chunks: readonly Uint8Array[];
  totalLength: number;
}): Uint8Array {
  const bytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (offset !== totalLength) throw new Error("Segment Footer concatenation length invariant failed");
  return bytes;
}

async function tryReadAuthenticatedFooter({
  backend,
  diagnostics,
  fileSize,
  fileSystemId,
  path,
  physicalSegmentId,
  rootKey,
  segmentClass,
}: {
  backend: HizoFSReadableBackend;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSize: bigint;
  fileSystemId: FileSystemId;
  path: Awaited<ReturnType<typeof readAuthenticatedSegmentDescriptor>>["path"];
  physicalSegmentId: SegmentId;
  rootKey: FileSystemRootKey;
  segmentClass: SegmentClass;
}): Promise<{ footer: AuthenticatedSegmentFooter; frames: readonly AuthenticatedSegmentFrame[] } | undefined> {
  const headerSize = HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.segmentHeader;
  const footerHeaderSize = HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.segmentFooterHeader;
  const footerTrailerSize = HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.segmentFooterTrailer;
  const tagSize = HIZOFS_V1_FORMAT_CONSTANTS.crypto.tagBytes;
  const minimumFooterSize = footerHeaderSize
    + HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.segmentFooterIndexEntry
    + tagSize
    + footerTrailerSize;
  if (fileSize < BigInt(headerSize + minimumFooterSize)) return undefined;

  const trailerOffset = fileSize - BigInt(footerTrailerSize);
  const trailerBytes = await backend.readExact({ length: footerTrailerSize, offset: trailerOffset, path });
  let trailer: ReturnType<typeof decodeSegmentFooterTrailer>;
  try {
    trailer = decodeSegmentFooterTrailer({ bytes: trailerBytes });
  } catch {
    return undefined;
  }
  if (!segmentFooterTrailerIsReaderCandidate({ fileSize, physicalSegmentId, segmentClass, trailer })) {
    return undefined;
  }

  const footerOffset = fileSize - BigInt(trailer.footerTotalLength);
  const candidate = await backend.readExact({ length: trailer.footerTotalLength, offset: footerOffset, path });
  const footerHeaderBytes = candidate.subarray(0, footerHeaderSize);
  const candidateTrailerBytes = candidate.subarray(candidate.byteLength - footerTrailerSize);
  let header: SegmentFooterHeaderV1;
  let decodedTrailer: ReturnType<typeof decodeSegmentFooterTrailer>;
  try {
    header = decodeSegmentFooterHeader({ bytes: footerHeaderBytes });
    decodedTrailer = decodeSegmentFooterTrailer({ bytes: candidateTrailerBytes });
  } catch {
    return undefined;
  }
  if (!segmentFooterCandidateStructureIsValid({
    candidateByteLength: candidate.byteLength,
    fileSize,
    footerOffset,
    header,
    observedFooterTotalLength: trailer.footerTotalLength,
    physicalSegmentId,
    segmentClass,
    trailer: decodedTrailer,
  })) {
    return undefined;
  }

  const sealedIndex = candidate.subarray(footerHeaderSize, candidate.byteLength - footerTrailerSize);
  let plaintextIndex: Uint8Array;
  try {
    plaintextIndex = await measureAuthenticatedCryptoOperation({
      diagnostics,
      operation: "decrypt",
      run: async () => await decryptAuthenticatedSegmentFooter({
        ciphertext: authenticatedSegmentFooterBytes({ bytes: sealedIndex }),
        fileSystemId,
        footerHeader: footerHeaderBytes,
        footerTrailer: candidateTrailerBytes,
        nonce: segmentFooterNonce({ bytes: header.nonce }),
        physicalSegmentId,
        rootKey,
      }),
    });
  } catch (cause: unknown) {
    if (rootKey.isDestroyed()) throw cause;
    return undefined;
  }
  if (plaintextIndex.byteLength !== header.plaintextIndexLength) return undefined;

  const entrySize = HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.segmentFooterIndexEntry;
  const frameHeaderSize = HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.recordFrameHeader;
  const frames: AuthenticatedSegmentFrame[] = [];
  let expectedPhysicalOffset = BigInt(headerSize);
  for (let index = 0; index < header.entryCount; index += 1) {
    const entryBytes = plaintextIndex.subarray(index * entrySize, (index + 1) * entrySize);
    let entry: SegmentFooterIndexEntryV1;
    try {
      entry = decodeSegmentFooterIndexEntry({ bytes: entryBytes });
    } catch {
      return undefined;
    }
    if (entry.physicalOffset !== expectedPhysicalOffset) return undefined;
    const frameHeaderBytes = await backend.readExact({
      length: frameHeaderSize,
      offset: entry.physicalOffset,
      path,
    });
    let frameHeader: ReturnType<typeof decodeRecordFrameHeader>;
    try {
      frameHeader = decodeRecordFrameHeader({ bytes: frameHeaderBytes });
      if (!segmentFooterIndexEntryMatchesFrame({
        entry,
        frameHeader,
        physicalOffset: expectedPhysicalOffset,
        physicalSegmentId,
        segmentClass,
      })) return undefined;
    } catch {
      return undefined;
    }
    frames.push({ header: frameHeader, physicalOffset: expectedPhysicalOffset });
    expectedPhysicalOffset += BigInt(entry.frameLength);
  }
  if (expectedPhysicalOffset !== footerOffset) return undefined;
  return {
    footer: { header, physicalOffset: footerOffset, totalLength: trailer.footerTotalLength },
    frames,
  };
}

export async function readAuthenticatedSegmentIndex({ backend, diagnostics, fileSystemId, physicalSegmentId, rootKey, segmentClass }: {
  backend: HizoFSReadableBackend;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSystemId: FileSystemId;
  physicalSegmentId: SegmentId;
  rootKey: FileSystemRootKey;
  segmentClass: SegmentClass;
}): Promise<AuthenticatedSegmentIndex> {
  const descriptor = await readAuthenticatedSegmentDescriptor({
    backend,
    diagnostics,
    fileSystemId,
    physicalSegmentId,
    rootKey,
    segmentClass,
  });
  const footer = await tryReadAuthenticatedFooter({
    backend,
    diagnostics,
    fileSize: descriptor.fileSize,
    fileSystemId,
    path: descriptor.path,
    physicalSegmentId,
    rootKey,
    segmentClass,
  });
  if (footer !== undefined) return { ...footer, state: "sealed" };

  const prefix = await scanAuthenticatedSegmentPrefix({
    backend,
    diagnostics,
    fileSystemId,
    physicalSegmentId,
    rootKey,
    segmentClass,
  });
  switch (prefix.state) {
  case "abandoned_unsealed":
    return { footer: undefined, frames: prefix.frames, state: "abandoned_unsealed" };
  case "complete_unsealed":
    return { footer: undefined, frames: prefix.frames, state: "complete_unsealed" };
  case "footer_candidate":
    return { footer: undefined, frames: prefix.frames, state: "footer_unusable" };
  default:
    return prefix.state satisfies never;
  }
}

type SegmentSealInput = Readonly<{
  backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSystemId: FileSystemId;
  physicalSegmentId: SegmentId;
  randomSource?: RandomByteSource;
  rootKey: FileSystemRootKey;
  segmentClass: SegmentClass;
}>;

async function sealAuthenticatedSegmentInternal({
  backend,
  diagnostics,
  fileSystemId,
  physicalSegmentId,
  randomSource,
  rootKey,
  segmentClass,
}: SegmentSealInput): Promise<AuthenticatedSegmentIndex> {
  const current = await readAuthenticatedSegmentIndex({
    backend,
    diagnostics,
    fileSystemId,
    physicalSegmentId,
    rootKey,
    segmentClass,
  });
  switch (current.state) {
  case "sealed": {
    const descriptor = await readAuthenticatedSegmentDescriptor({
      backend,
      fileSystemId,
      physicalSegmentId,
      rootKey,
      segmentClass,
    });
    const file = await backend.openFileForUpdate({ path: descriptor.path });
    await runAndCloseAuthenticatedFile({
      backend,
      file,
      operation: async () => await backend.syncFileData({ file }),
      operationLabel: "existing Segment Footer durability confirmation",
    });
    const verified = await readAuthenticatedSegmentIndex({
      backend,
      fileSystemId,
      physicalSegmentId,
      rootKey,
      segmentClass,
    });
    switch (verified.state) {
    case "sealed":
      return verified;
    case "abandoned_unsealed":
    case "complete_unsealed":
    case "footer_unusable":
      throw authenticatedStoreError({ code: "control_plane_corrupt", message: "existing Segment Footer read-back verification failed" });
    default:
      return verified.state satisfies never;
    }
  }
  case "complete_unsealed":
    break;
  case "abandoned_unsealed":
  case "footer_unusable":
    throw authenticatedStoreError({
      code: "control_plane_corrupt",
      message: "only a complete non-empty unsealed Segment can be sealed",
    });
  default:
    return current.state satisfies never;
  }
  if (current.frames.length === 0) {
    throw authenticatedStoreError({
      code: "control_plane_corrupt",
      message: "only a complete non-empty unsealed Segment can be sealed",
    });
  }

  const headerSize = HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.segmentHeader;
  const footerOffset = current.frames.reduce(
    (offset, frame) => frame.physicalOffset + BigInt(frame.header.frameLength) > offset
      ? frame.physicalOffset + BigInt(frame.header.frameLength)
      : offset,
    BigInt(headerSize),
  );
  const descriptor = await readAuthenticatedSegmentDescriptor({
    backend,
    diagnostics,
    fileSystemId,
    physicalSegmentId,
    rootKey,
    segmentClass,
  });
  if (descriptor.fileSize !== footerOffset) {
    throw authenticatedStoreError({ code: "control_plane_corrupt", message: "Segment changed while preparing its footer" });
  }

  const entries = current.frames.map(frame => segmentFooterIndexEntryFromFrame({ frame }));
  const entryBytes = entries.map(entry => encodeSegmentFooterIndexEntry({ entry }));
  const plaintextIndexLength = entryBytes.reduce((total, bytes) => total + bytes.byteLength, 0);
  const plaintextIndex = concatenate({ chunks: entryBytes, totalLength: plaintextIndexLength });
  const nonce = generateSegmentFooterNonce({ randomSource });
  const header = createSegmentFooterHeader({
    entryCount: entries.length,
    nonce,
    physicalSegmentId,
    segmentClass,
    segmentDataLength: createUInt64({ value: footerOffset - BigInt(headerSize) }),
  });
  const footerHeaderBytes = encodeSegmentFooterHeader({ header });
  const totalLength = calculateSegmentFooterTotalLength({ entryCount: entries.length });
  const footerTrailerBytes = encodeSegmentFooterTrailer({ trailer: { footerTotalLength: totalLength, physicalSegmentId } });
  const sealedIndex = await measureAuthenticatedCryptoOperation({
    diagnostics,
    operation: "encrypt",
    run: async () => await encryptSegmentFooter({
      fileSystemId,
      footerHeader: footerHeaderBytes,
      footerTrailer: footerTrailerBytes,
      nonce,
      physicalSegmentId,
      plaintext: plaintextSegmentFooterBytes({ bytes: plaintextIndex }),
      rootKey,
    }),
  });
  const footerBytes = concatenate({
    chunks: [footerHeaderBytes, sealedIndex, footerTrailerBytes],
    totalLength,
  });

  const file = await backend.openFileForUpdate({ path: descriptor.path });
  await runAndCloseAuthenticatedFile({
    backend,
    file,
    operation: async () => {
      await backend.writeAt({
        bytes: authenticatedHizoFSPhysicalBytes({ bytes: footerBytes }),
        file,
        offset: footerOffset,
      });
      await backend.syncFileData({ file });
    },
    operationLabel: "Segment Footer publication",
  });

  const sealed = await readAuthenticatedSegmentIndex({
    backend,
    diagnostics,
    fileSystemId,
    physicalSegmentId,
    rootKey,
    segmentClass,
  });
  switch (sealed.state) {
  case "sealed":
    return sealed;
  case "abandoned_unsealed":
  case "complete_unsealed":
  case "footer_unusable":
    throw authenticatedStoreError({ code: "control_plane_corrupt", message: "Segment Footer read-back verification failed" });
  default:
    return sealed.state satisfies never;
  }
}

export async function sealAuthenticatedSegment({ writerCapability }: {
  writerCapability: ActiveSegmentWriterCapability;
}): Promise<AuthenticatedSegmentIndex> {
  // The brand is created only with a fresh runtime writer. A segment discovered
  // after restart therefore cannot accidentally be promoted from unsealed to sealed.
  return await sealAuthenticatedSegmentInternal(writerCapability);
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  sealAuthenticatedSegmentForTesting: sealAuthenticatedSegmentInternal,
};
