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
  formatBytesEqual,
  segmentClassForRecordKind,
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
  isHizoFSCryptoAuthenticationError,
  plaintextSegmentFooterBytes,
  segmentFooterNonce,
  type FileSystemRootKey,
  type RandomByteSource,
} from "@/00-storage/service/hizofs/01-crypto";
import type { HizoFSWritableBackend, HizoFSReadableBackend } from "@/00-storage/service/hizofs/physical-store/backend";
import type { ActiveSegmentWriterCapability } from "./record-appender";
import { authenticatedStoreError } from "./errors";
import { authenticatedSegmentPath } from "./segment-location";
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
  getFileSizeWithAuthenticatedReason,
  measureAuthenticatedCryptoOperation,
  readExactWithAuthenticatedReason,
  type AuthenticatedStoreDiagnosticsPort,
} from "@/00-storage/service/hizofs/authenticated-store/diagnostics-hooks";

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
    if (isHizoFSCryptoAuthenticationError({ cause })) return undefined;
    throw cause;
  }
  try {
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
  } finally {
    plaintextIndex.fill(0);
  }
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

function bytesEqual({ left, right }: { left: Uint8Array; right: Uint8Array }): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

async function createSegmentFooterPublication({
  diagnostics,
  fileSystemId,
  entryCount,
  footerOffset,
  physicalSegmentId,
  plaintextIndex,
  randomSource,
  rootKey,
  segmentClass,
}: {
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSystemId: FileSystemId;
  entryCount: number;
  footerOffset: bigint;
  physicalSegmentId: SegmentId;
  plaintextIndex: Uint8Array;
  randomSource?: RandomByteSource;
  rootKey: FileSystemRootKey;
  segmentClass: SegmentClass;
}): Promise<Readonly<{ footer: AuthenticatedSegmentFooter; footerBytes: Uint8Array }>> {
  const headerSize = HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.segmentHeader;
  const nonce = generateSegmentFooterNonce({ randomSource });
  const header = createSegmentFooterHeader({
    entryCount,
    nonce,
    physicalSegmentId,
    segmentClass,
    segmentDataLength: createUInt64({ value: footerOffset - BigInt(headerSize) }),
  });
  const footerHeaderBytes = encodeSegmentFooterHeader({ header });
  const totalLength = calculateSegmentFooterTotalLength({ entryCount });
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
  return Object.freeze({
    footer: Object.freeze({ header, physicalOffset: footerOffset, totalLength }),
    footerBytes: concatenate({
      chunks: [footerHeaderBytes, sealedIndex, footerTrailerBytes],
      totalLength,
    }),
  });
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

  const entryBytes = current.frames.map(frame => encodeSegmentFooterIndexEntry({
    entry: segmentFooterIndexEntryFromFrame({ frame }),
  }));
  const plaintextIndexLength = entryBytes.reduce((total, bytes) => total + bytes.byteLength, 0);
  const { footerBytes } = await createSegmentFooterPublication({
    diagnostics,
    entryCount: current.frames.length,
    fileSystemId,
    footerOffset,
    physicalSegmentId,
    plaintextIndex: concatenate({ chunks: entryBytes, totalLength: plaintextIndexLength }),
    randomSource,
    rootKey,
    segmentClass,
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

async function sealAuthenticatedSegmentFromWriterProof({
  backend,
  diagnostics,
  expectedFileSize,
  fileSystemId,
  footerIndexBytes,
  frameCount,
  physicalSegmentId,
  randomSource,
  rootKey,
  segmentClass,
}: ActiveSegmentWriterCapability): Promise<void> {
  if (frameCount === 0) {
    throw authenticatedStoreError({
      code: "control_plane_corrupt",
      message: "active Segment writer cannot seal an empty durable Footer index",
    });
  }

  // A fresh writer authenticated the Segment Header when it was created, and
  // every entry represented here was derived from a Record Frame that was
  // written, synced, explicitly closed, and byte-for-byte read back by that
  // same exclusive writer. Re-reading every Record Frame here would repeat an
  // already-established proof at O(frame count) physical I/O cost. Keep the
  // restart/reader path strict; only the fresh-writer construction path may
  // publish from this compact durable Footer index.
  const entrySize = HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.segmentFooterIndexEntry;
  if (footerIndexBytes.byteLength !== frameCount * entrySize) {
    throw authenticatedStoreError({
      code: "control_plane_corrupt",
      message: "active Segment durable Footer index length is inconsistent",
    });
  }
  let expectedOffset = BigInt(HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.segmentHeader);
  for (let index = 0; index < frameCount; index += 1) {
    const entry = decodeSegmentFooterIndexEntry({
      bytes: footerIndexBytes.subarray(index * entrySize, (index + 1) * entrySize),
    });
    const physicalOnly = entry.recordKind === HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.relocation_index_page;
    const expectedFlags = physicalOnly ? HIZOFS_V1_FORMAT_CONSTANTS.flags.recordPhysicalOnly : 0;
    if (entry.physicalOffset !== expectedOffset
      || entry.homeOffset !== expectedOffset
      || !formatBytesEqual({ left: entry.homeSegmentId, right: physicalSegmentId })
      || entry.flags !== expectedFlags
      || segmentClassForRecordKind({ recordKind: entry.recordKind }) !== segmentClass) {
      throw authenticatedStoreError({
        code: "control_plane_corrupt",
        message: "active Segment durable Footer index violates Segment identity",
      });
    }
    expectedOffset += BigInt(entry.frameLength);
  }
  if (expectedOffset !== expectedFileSize) {
    throw authenticatedStoreError({
      code: "control_plane_corrupt",
      message: "active Segment durable Footer index does not match its trusted tail",
    });
  }

  const path = authenticatedSegmentPath({ segmentClass, segmentId: physicalSegmentId });
  const observedFileSize = await getFileSizeWithAuthenticatedReason({
    backend,
    diagnostics,
    path,
    reason: "trusted_tail",
  });
  if (observedFileSize !== expectedFileSize) {
    throw authenticatedStoreError({
      code: "control_plane_corrupt",
      message: "active Segment changed while preparing its footer",
    });
  }

  const { footerBytes } = await createSegmentFooterPublication({
    diagnostics,
    entryCount: frameCount,
    fileSystemId,
    footerOffset: expectedFileSize,
    physicalSegmentId,
    plaintextIndex: footerIndexBytes,
    randomSource,
    rootKey,
    segmentClass,
  });
  const file = await backend.openFileForUpdate({ path });
  await runAndCloseAuthenticatedFile({
    backend,
    file,
    operation: async () => {
      await backend.writeAt({
        bytes: authenticatedHizoFSPhysicalBytes({ bytes: footerBytes }),
        file,
        offset: expectedFileSize,
      });
      await backend.syncFileData({ file });
    },
    operationLabel: "active Segment Footer publication",
  });

  const readBack = await readExactWithAuthenticatedReason({
    backend,
    diagnostics,
    length: footerBytes.byteLength,
    offset: expectedFileSize,
    path,
    reason: "segment_footer_read_back",
  });
  if (!bytesEqual({ left: readBack, right: footerBytes })) {
    throw authenticatedStoreError({
      code: "control_plane_corrupt",
      message: "active Segment Footer durable read-back differs",
    });
  }
}

export async function sealAuthenticatedSegment({ writerCapability }: {
  writerCapability: ActiveSegmentWriterCapability;
}): Promise<void> {
  // The capability is created only by a fresh runtime writer. A Segment
  // discovered after restart therefore cannot use the writer-owned fast seal.
  await sealAuthenticatedSegmentFromWriterProof(writerCapability);
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  sealAuthenticatedSegmentForTesting: sealAuthenticatedSegmentInternal,
};
