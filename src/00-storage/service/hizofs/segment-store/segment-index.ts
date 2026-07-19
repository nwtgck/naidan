import { decodeBase64Url } from '@/00-storage/service/hizofs/base64-url';
import { bytesEqual, concatenateBytes } from '@/00-storage/service/hizofs/bytes';
import { HizoFSCorruptionError, HizoFSUnsupportedFormatError } from '@/00-storage/service/hizofs/errors';
import {
  decodeHizoFSRecordKind,
  encodeHizoFSRecordKind,
  type HizoFSRecordKind,
} from '@/00-storage/service/hizofs/format/record';
import {
  createHizoFSNonce,
  decryptHizoFSAesGcm,
  deriveHizoFSSegmentIndexKey,
  encryptHizoFSAesGcm,
  HIZOFS_AES_GCM_NONCE_BYTE_LENGTH,
  HIZOFS_AES_GCM_TAG_BYTE_LENGTH,
} from '@/00-storage/service/hizofs/segment-store/segment-crypto';
import {
  HIZOFS_SEGMENT_HEADER_BYTE_LENGTH,
  type HizoFSSegmentType,
} from '@/00-storage/service/hizofs/segment-store/segment-format';
import { assertHizoFSSegmentId } from '@/00-storage/service/hizofs/segment-store/object-reference';

const MAGIC = new TextEncoder().encode('HZIDX001');
const FORMAT_VERSION = 1;
const HEADER_BYTE_LENGTH = 72;
const ENTRY_BYTE_LENGTH = 16;

export type HizoFSSegmentIndexEntry = {
  readonly kind: HizoFSRecordKind;
  readonly homeOffset: number;
  readonly storedLength: number;
};

export type HizoFSSegmentIndex = {
  readonly segmentType: HizoFSSegmentType;
  readonly segmentId: Uint8Array;
  readonly segmentByteLength: number;
  readonly entries: readonly HizoFSSegmentIndexEntry[];
};

function typeId({ segmentType }: { segmentType: HizoFSSegmentType }): number {
  switch (segmentType) {
  case 'metadata': return 1;
  case 'data': return 2;
  case 'relocation': return 3;
  default: {
    const _ex: never = segmentType;
    throw new Error(`Unhandled HizoFS segment type: ${String(_ex)}`);
  }
  }
}

function typeFromId({ value }: { value: number }): HizoFSSegmentType {
  switch (value) {
  case 1: return 'metadata';
  case 2: return 'data';
  case 3: return 'relocation';
  default:
    throw new HizoFSUnsupportedFormatError({
      message: `HizoFS segment-index segment type is unsupported: ${String(value)}`,
    });
  }
}

function decodeFileSystemId({ fileSystemId }: { fileSystemId: string }): Uint8Array {
  const bytes = decodeBase64Url({ value: fileSystemId });
  if (bytes.byteLength !== 16) {
    throw new Error('HizoFS file-system ID must decode to exactly 16 bytes');
  }
  return bytes;
}

function assertSafeLength({ value, field }: { value: number; field: string }): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
}

function setUint64({ view, offset, value }: { view: DataView; offset: number; value: number }): void {
  assertSafeLength({ value, field: 'HizoFS segment-index integer' });
  view.setBigUint64(offset, BigInt(value), false);
}

function getUint64({ view, offset, field }: { view: DataView; offset: number; field: string }): number {
  const value = view.getBigUint64(offset, false);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new HizoFSCorruptionError({ message: `${field} exceeds the safe integer range`, cause: undefined });
  }
  return Number(value);
}

function validateEntries({ entries, segmentByteLength }: {
  entries: readonly HizoFSSegmentIndexEntry[];
  segmentByteLength: number;
}): void {
  let previousEnd = HIZOFS_SEGMENT_HEADER_BYTE_LENGTH;
  for (const entry of entries) {
    assertSafeLength({ value: entry.homeOffset, field: 'HizoFS segment-index record offset' });
    assertSafeLength({ value: entry.storedLength, field: 'HizoFS segment-index record length' });
    if (entry.storedLength > 0xffff_ffff) {
      throw new HizoFSCorruptionError({
        message: 'HizoFS segment-index record length exceeds its encoded range',
        cause: undefined,
      });
    }
    if (entry.storedLength === 0 || entry.homeOffset < previousEnd) {
      throw new HizoFSCorruptionError({
        message: 'HizoFS segment-index record ranges are not strictly ordered',
        cause: undefined,
      });
    }
    const end = entry.homeOffset + entry.storedLength;
    if (!Number.isSafeInteger(end) || end > segmentByteLength) {
      throw new HizoFSCorruptionError({
        message: 'HizoFS segment-index record range exceeds the physical segment',
        cause: undefined,
      });
    }
    previousEnd = end;
  }
  if (entries.length === 0 && segmentByteLength !== HIZOFS_SEGMENT_HEADER_BYTE_LENGTH) {
    throw new HizoFSCorruptionError({
      message: 'HizoFS empty segment-index length does not equal the segment header length',
      cause: undefined,
    });
  }
  if (entries.length > 0 && previousEnd !== segmentByteLength) {
    throw new HizoFSCorruptionError({
      message: 'HizoFS segment-index final record does not end at the physical segment tail',
      cause: undefined,
    });
  }
}

export async function encodeHizoFSSegmentIndex({
  rootKey,
  fileSystemId,
  index,
}: {
  rootKey: CryptoKey;
  fileSystemId: string;
  index: HizoFSSegmentIndex;
}): Promise<Uint8Array> {
  assertHizoFSSegmentId({ segmentId: index.segmentId });
  assertSafeLength({ value: index.segmentByteLength, field: 'HizoFS segment-index segment length' });
  if (index.entries.length > 0xffff_ffff) throw new Error('HizoFS segment index contains too many entries');
  validateEntries({ entries: index.entries, segmentByteLength: index.segmentByteLength });

  const header = new Uint8Array(HEADER_BYTE_LENGTH);
  const headerView = new DataView(header.buffer);
  header.set(MAGIC, 0);
  headerView.setUint16(8, FORMAT_VERSION, false);
  headerView.setUint16(10, HEADER_BYTE_LENGTH, false);
  headerView.setUint8(12, typeId({ segmentType: index.segmentType }));
  header.set(decodeFileSystemId({ fileSystemId }), 16);
  header.set(index.segmentId, 32);
  setUint64({ view: headerView, offset: 48, value: index.segmentByteLength });
  headerView.setUint32(56, index.entries.length, false);
  const nonce = createHizoFSNonce();
  header.set(nonce, 60);

  const plaintext = new Uint8Array(index.entries.length * ENTRY_BYTE_LENGTH);
  const view = new DataView(plaintext.buffer);
  index.entries.forEach((entry, indexEntry) => {
    const offset = indexEntry * ENTRY_BYTE_LENGTH;
    setUint64({ view, offset, value: entry.homeOffset });
    view.setUint32(offset + 8, entry.storedLength, false);
    view.setUint8(offset + 12, encodeHizoFSRecordKind({ kind: entry.kind }));
  });
  const key = await deriveHizoFSSegmentIndexKey({ rootKey, fileSystemId, segmentId: index.segmentId });
  const ciphertext = await encryptHizoFSAesGcm({ key, nonce, plaintext, additionalData: header });
  return concatenateBytes({ parts: [header, ciphertext] });
}

export async function decodeHizoFSSegmentIndex({
  rootKey,
  fileSystemId,
  expectedSegmentType,
  expectedSegmentId,
  expectedSegmentByteLength,
  bytes,
}: {
  rootKey: CryptoKey;
  fileSystemId: string;
  expectedSegmentType: HizoFSSegmentType;
  expectedSegmentId: Uint8Array;
  expectedSegmentByteLength: number;
  bytes: Uint8Array;
}): Promise<HizoFSSegmentIndex> {
  if (bytes.byteLength < HEADER_BYTE_LENGTH + HIZOFS_AES_GCM_TAG_BYTE_LENGTH) {
    throw new HizoFSCorruptionError({ message: 'HizoFS segment index is truncated', cause: undefined });
  }
  if (!bytesEqual({ left: bytes.subarray(0, 8), right: MAGIC })) {
    throw new HizoFSCorruptionError({ message: 'HizoFS segment-index magic is invalid', cause: undefined });
  }
  const header = bytes.subarray(0, HEADER_BYTE_LENGTH);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (view.getUint16(8, false) !== FORMAT_VERSION) {
    throw new HizoFSUnsupportedFormatError({
      message: `HizoFS segment-index version is unsupported: ${String(view.getUint16(8, false))}`,
    });
  }
  if (view.getUint16(10, false) !== HEADER_BYTE_LENGTH) {
    throw new HizoFSCorruptionError({ message: 'HizoFS segment-index header length is invalid', cause: undefined });
  }
  const segmentType = typeFromId({ value: view.getUint8(12) });
  if (segmentType !== expectedSegmentType || view.getUint8(13) !== 0 || view.getUint16(14, false) !== 0) {
    throw new HizoFSCorruptionError({ message: 'HizoFS segment-index type or reserved bytes are invalid', cause: undefined });
  }
  if (!bytesEqual({ left: header.subarray(16, 32), right: decodeFileSystemId({ fileSystemId }) })) {
    throw new HizoFSCorruptionError({ message: 'HizoFS segment-index file-system ID is invalid', cause: undefined });
  }
  assertHizoFSSegmentId({ segmentId: expectedSegmentId });
  if (!bytesEqual({ left: header.subarray(32, 48), right: expectedSegmentId })) {
    throw new HizoFSCorruptionError({ message: 'HizoFS segment-index segment ID is invalid', cause: undefined });
  }
  const segmentByteLength = getUint64({ view, offset: 48, field: 'HizoFS segment-index segment length' });
  if (segmentByteLength !== expectedSegmentByteLength) {
    throw new HizoFSCorruptionError({ message: 'HizoFS segment-index physical length is stale', cause: undefined });
  }
  const entryCount = view.getUint32(56, false);
  const expectedCiphertextLength = entryCount * ENTRY_BYTE_LENGTH + HIZOFS_AES_GCM_TAG_BYTE_LENGTH;
  if (bytes.byteLength !== HEADER_BYTE_LENGTH + expectedCiphertextLength) {
    throw new HizoFSCorruptionError({ message: 'HizoFS segment-index entry count does not match its length', cause: undefined });
  }
  const nonce = header.subarray(60, 60 + HIZOFS_AES_GCM_NONCE_BYTE_LENGTH);
  const key = await deriveHizoFSSegmentIndexKey({ rootKey, fileSystemId, segmentId: expectedSegmentId });
  let plaintext: Uint8Array;
  try {
    plaintext = await decryptHizoFSAesGcm({
      key,
      nonce,
      ciphertext: bytes.subarray(HEADER_BYTE_LENGTH),
      additionalData: header,
    });
  } catch (error) {
    throw new HizoFSCorruptionError({ message: 'HizoFS segment-index authentication failed', cause: error });
  }
  const entries: HizoFSSegmentIndexEntry[] = [];
  const plaintextView = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength);
  for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
    const offset = entryIndex * ENTRY_BYTE_LENGTH;
    if (plaintextView.getUint8(offset + 13) !== 0
      || plaintextView.getUint8(offset + 14) !== 0
      || plaintextView.getUint8(offset + 15) !== 0) {
      throw new HizoFSCorruptionError({ message: 'HizoFS segment-index entry reserved bytes must be zero', cause: undefined });
    }
    entries.push({
      homeOffset: getUint64({ view: plaintextView, offset, field: 'HizoFS segment-index record offset' }),
      storedLength: plaintextView.getUint32(offset + 8, false),
      kind: decodeHizoFSRecordKind({ id: plaintextView.getUint8(offset + 12) }),
    });
  }
  validateEntries({ entries, segmentByteLength });
  return { segmentType, segmentId: expectedSegmentId.slice(), segmentByteLength, entries };
}

export const TEST_ONLY = {
  HEADER_BYTE_LENGTH,
  ENTRY_BYTE_LENGTH,
  validateEntries,
};
