import { HizoFSCorruptionError, HizoFSUnsupportedFormatError } from '@/00-storage/service/hizofs/errors';
import { concatenateBytes } from '@/00-storage/service/hizofs/bytes';

const HEADER_BYTE_LENGTH = 16;
const PAYLOAD_ENCODING_IDENTITY = 0;

export type HizoFSRecordKind =
  | 'subvolume_descriptor'
  | 'commit'
  | 'inode_index_page'
  | 'file_inode'
  | 'directory_inode'
  | 'symlink_inode'
  | 'directory_index_page'
  | 'subvolume_mount_index_page'
  | 'file_extent_page'
  | 'file_chunk'
  | 'superblock';

export const HIZOFS_RECORD_KIND_TO_ID = {
  subvolume_descriptor: 10,
  commit: 1,
  inode_index_page: 2,
  file_inode: 3,
  directory_inode: 4,
  symlink_inode: 5,
  directory_index_page: 6,
  subvolume_mount_index_page: 11,
  file_extent_page: 7,
  file_chunk: 8,
  superblock: 9,
} as const satisfies Record<HizoFSRecordKind, number>;

function decodeRecordKind({ id }: {
  id: number;
}): HizoFSRecordKind {
  for (const [kind, candidateId] of Object.entries(HIZOFS_RECORD_KIND_TO_ID)) {
    if (candidateId === id) {
      return kind as HizoFSRecordKind;
    }
  }
  throw new HizoFSUnsupportedFormatError({ message: `HizoFS record kind is unsupported: ${String(id)}` });
}


export function encodeHizoFSRecordKind({ kind }: {
  kind: HizoFSRecordKind;
}): number {
  return HIZOFS_RECORD_KIND_TO_ID[kind];
}

export function decodeHizoFSRecordKind({ id }: {
  id: number;
}): HizoFSRecordKind {
  return decodeRecordKind({ id });
}

export type DecodedHizoFSRecord = {
  readonly kind: HizoFSRecordKind;
  readonly recordVersion: number;
  readonly metadata: unknown;
  readonly binaryPayload: Uint8Array;
};

export function getHizoFSRecordByteLength({
  metadata,
  binaryPayloadByteLength,
}: {
  metadata: unknown;
  binaryPayloadByteLength: number;
}): number {
  if (!Number.isSafeInteger(binaryPayloadByteLength) || binaryPayloadByteLength < 0) {
    throw new Error('HizoFS record binary payload length must be a non-negative safe integer');
  }
  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
  if (metadataBytes.byteLength > 0xffff_ffff) {
    throw new Error('HizoFS record metadata is too large');
  }
  const totalByteLength = HEADER_BYTE_LENGTH
    + metadataBytes.byteLength
    + binaryPayloadByteLength;
  if (!Number.isSafeInteger(totalByteLength)) {
    throw new Error('HizoFS record plaintext length exceeds the safe integer range');
  }
  return totalByteLength;
}

// TODO(hizofs): Replace hot metadata JSON and string-encoded identifiers with
// bounded per-record binary codecs after the segmented physical layer and its
// recovery tooling stabilize. The conversion must preserve exhaustive versioned
// decoding, deterministic inspection output, corruption bounds, and independent
// offline reconstruction; do not introduce an opaque generic serializer.
export function encodeHizoFSRecord({ kind, recordVersion, metadata, binaryPayload }: {
  kind: HizoFSRecordKind;
  recordVersion: number;
  metadata: unknown;
  binaryPayload: Uint8Array;
}): Uint8Array {
  if (!Number.isSafeInteger(recordVersion) || recordVersion < 1 || recordVersion > 0xffff) {
    throw new Error('HizoFS record version must be an unsigned 16-bit positive integer');
  }

  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
  if (metadataBytes.byteLength > 0xffff_ffff) {
    throw new Error('HizoFS record metadata is too large');
  }

  const header = new Uint8Array(HEADER_BYTE_LENGTH);
  const view = new DataView(header.buffer);
  header[0] = HIZOFS_RECORD_KIND_TO_ID[kind];
  header[1] = PAYLOAD_ENCODING_IDENTITY;
  view.setUint16(2, recordVersion, false);
  view.setUint32(4, metadataBytes.byteLength, false);
  view.setBigUint64(8, BigInt(binaryPayload.byteLength), false);
  return concatenateBytes({ parts: [header, metadataBytes, binaryPayload] });
}

type DecodedHizoFSRecordLayout = {
  readonly kind: HizoFSRecordKind;
  readonly recordVersion: number;
  readonly metadata: unknown;
  readonly binaryPayloadOffset: number;
  readonly binaryPayloadByteLength: number;
};

function decodeHizoFSRecordLayout({ plaintext }: {
  plaintext: Uint8Array;
}): DecodedHizoFSRecordLayout {
  if (plaintext.byteLength < HEADER_BYTE_LENGTH) {
    throw new HizoFSCorruptionError({ message: 'HizoFS record is truncated', cause: undefined });
  }

  const view = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength);
  const kind = decodeRecordKind({ id: plaintext[0] ?? -1 });
  const payloadEncoding = plaintext[1];
  if (payloadEncoding !== PAYLOAD_ENCODING_IDENTITY) {
    throw new HizoFSUnsupportedFormatError({ message: `HizoFS record payload encoding is unsupported: ${String(payloadEncoding)}` });
  }
  const recordVersion = view.getUint16(2, false);
  const metadataByteLength = view.getUint32(4, false);
  const binaryByteLengthBigInt = view.getBigUint64(8, false);
  if (binaryByteLengthBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new HizoFSCorruptionError({ message: 'HizoFS record binary payload exceeds the safe integer range', cause: undefined });
  }
  const binaryPayloadByteLength = Number(binaryByteLengthBigInt);
  const binaryPayloadOffset = HEADER_BYTE_LENGTH + metadataByteLength;
  const expectedByteLength = binaryPayloadOffset + binaryPayloadByteLength;
  if (plaintext.byteLength !== expectedByteLength) {
    throw new HizoFSCorruptionError({ message: 'HizoFS record lengths do not match the plaintext', cause: undefined });
  }

  const metadataBytes = plaintext.subarray(HEADER_BYTE_LENGTH, binaryPayloadOffset);
  let metadata: unknown;
  try {
    metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(metadataBytes));
  } catch (error) {
    throw new HizoFSCorruptionError({ message: 'HizoFS record metadata is invalid UTF-8 JSON', cause: error });
  }

  return {
    kind,
    recordVersion,
    metadata,
    binaryPayloadOffset,
    binaryPayloadByteLength,
  };
}

export function decodeHizoFSRecord({ plaintext }: {
  plaintext: Uint8Array;
}): DecodedHizoFSRecord {
  const layout = decodeHizoFSRecordLayout({ plaintext });
  return {
    kind: layout.kind,
    recordVersion: layout.recordVersion,
    metadata: layout.metadata,
    binaryPayload: plaintext.slice(layout.binaryPayloadOffset),
  };
}

export function decodeHizoFSRecordBinaryPayloadRange({
  plaintext,
  offset,
  length,
}: {
  plaintext: Uint8Array;
  offset: number;
  length: number;
}): DecodedHizoFSRecord & {
  readonly binaryPayloadByteLength: number;
} {
  for (const [fieldName, value] of [
    ['offset', offset],
    ['length', length],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(
        `HizoFS record binary range ${fieldName} must be a non-negative safe integer`,
      );
    }
  }
  const layout = decodeHizoFSRecordLayout({ plaintext });
  const rangeStart = Math.min(offset, layout.binaryPayloadByteLength);
  const copiedByteLength = Math.min(
    layout.binaryPayloadByteLength - rangeStart,
    length,
  );
  const rangeEnd = rangeStart + copiedByteLength;
  return {
    kind: layout.kind,
    recordVersion: layout.recordVersion,
    metadata: layout.metadata,
    binaryPayload: plaintext.slice(
      layout.binaryPayloadOffset + rangeStart,
      layout.binaryPayloadOffset + rangeEnd,
    ),
    binaryPayloadByteLength: layout.binaryPayloadByteLength,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
