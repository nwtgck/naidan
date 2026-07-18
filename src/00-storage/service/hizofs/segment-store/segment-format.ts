import { decodeBase64Url } from '@/00-storage/service/hizofs/base64-url';
import {
  bytesEqual,
  concatenateBytes,
} from '@/00-storage/service/hizofs/bytes';
import {
  HizoFSCorruptionError,
  HizoFSUnsupportedFormatError,
} from '@/00-storage/service/hizofs/errors';
import {
  decodeHizoFSRecord,
  decodeHizoFSRecordKind,
  encodeHizoFSRecordKind,
  type DecodedHizoFSRecord,
} from '@/00-storage/service/hizofs/format/record';
import {
  HIZOFS_AES_GCM_NONCE_BYTE_LENGTH,
  HIZOFS_AES_GCM_TAG_BYTE_LENGTH,
  createHizoFSNonce,
  decryptHizoFSAesGcm,
  deriveHizoFSHeadKey,
  deriveHizoFSSegmentHeaderKey,
  deriveHizoFSSegmentRecordKey,
  encryptHizoFSAesGcm,
} from '@/00-storage/service/hizofs/segment-store/segment-crypto';
import {
  assertHizoFSSegmentId,
  objectReferencesEqual,
  type HizoFSObjectReference,
} from '@/00-storage/service/hizofs/segment-store/object-reference';

export const HIZOFS_SEGMENT_HEADER_BYTE_LENGTH = 64;
export const HIZOFS_RECORD_FRAME_HEADER_BYTE_LENGTH = 72;
export const HIZOFS_RECORD_ALIGNMENT = 8;
export const HIZOFS_HEAD_ENVELOPE_HEADER_BYTE_LENGTH = 32;
export const HIZOFS_HEAD_PLAINTEXT_PREFIX_BYTE_LENGTH = 48;

const HIZOFS_FORMAT_VERSION = 1;
const SEGMENT_MAGIC = new TextEncoder().encode('HZSEG001');
const RECORD_MAGIC = new TextEncoder().encode('HZREC001');
const HEAD_MAGIC = new TextEncoder().encode('HZHED001');
const RECORD_AAD_DOMAIN = new TextEncoder().encode('HizoFS/v1/segmented-record/');
const HEAD_AAD_DOMAIN = new TextEncoder().encode('HizoFS/v1/segmented-head/');
const EMPTY = new Uint8Array();

export type HizoFSSegmentType = 'metadata' | 'data' | 'relocation';

export type HizoFSSegmentHeader = {
  readonly segmentType: HizoFSSegmentType;
  readonly fileSystemIdBytes: Uint8Array;
  readonly segmentId: Uint8Array;
};

export type HizoFSEncodedRecordFrame = {
  readonly reference: HizoFSObjectReference;
  readonly bytes: Uint8Array;
  readonly plaintextByteLength: number;
};

export type HizoFSDecodedHead = {
  readonly activeMetadataSegmentId: Uint8Array;
  readonly activeMetadataDurableTail: number;
  readonly recordBytes: Uint8Array;
  readonly record: DecodedHizoFSRecord;
};

function decodeFileSystemIdBytes({ fileSystemId }: {
  fileSystemId: string;
}): Uint8Array {
  const bytes = decodeBase64Url({ value: fileSystemId });
  if (bytes.byteLength !== 16) {
    throw new Error('HizoFS file-system ID must decode to exactly 16 bytes');
  }
  return bytes;
}

function alignUp({ value, alignment }: {
  value: number;
  alignment: number;
}): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('HizoFS aligned value must be a non-negative safe integer');
  }
  const remainder = value % alignment;
  return remainder === 0 ? value : value + alignment - remainder;
}

function segmentTypeToId({ segmentType }: {
  segmentType: HizoFSSegmentType;
}): number {
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

function segmentTypeFromId({ id }: { id: number }): HizoFSSegmentType {
  switch (id) {
  case 1: return 'metadata';
  case 2: return 'data';
  case 3: return 'relocation';
  default:
    throw new HizoFSUnsupportedFormatError({
      message: `HizoFS segment type is unsupported: ${String(id)}`,
    });
  }
}

function assertMagic({ bytes, expected, message }: {
  bytes: Uint8Array;
  expected: Uint8Array;
  message: string;
}): void {
  if (!bytesEqual({ left: bytes, right: expected })) {
    throw new HizoFSCorruptionError({ message, cause: undefined });
  }
}

function readSafeUint64({ view, offset, fieldName }: {
  view: DataView;
  offset: number;
  fieldName: string;
}): number {
  const value = view.getBigUint64(offset, false);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new HizoFSCorruptionError({
      message: `${fieldName} exceeds the safe integer range`,
      cause: undefined,
    });
  }
  return Number(value);
}

export function getHizoFSRecordFrameByteLength({ plaintextByteLength }: {
  plaintextByteLength: number;
}): number {
  if (!Number.isSafeInteger(plaintextByteLength) || plaintextByteLength < 0) {
    throw new Error('HizoFS record plaintext length must be a non-negative safe integer');
  }
  const unaligned = HIZOFS_RECORD_FRAME_HEADER_BYTE_LENGTH
    + plaintextByteLength
    + HIZOFS_AES_GCM_TAG_BYTE_LENGTH;
  const aligned = alignUp({ value: unaligned, alignment: HIZOFS_RECORD_ALIGNMENT });
  if (aligned > 0xffff_ffff) {
    throw new Error('HizoFS record frame exceeds the unsigned 32-bit length range');
  }
  return aligned;
}

export async function encodeHizoFSSegmentHeader({
  rootKey,
  fileSystemId,
  segmentType,
  segmentId,
}: {
  rootKey: CryptoKey;
  fileSystemId: string;
  segmentType: HizoFSSegmentType;
  segmentId: Uint8Array;
}): Promise<Uint8Array> {
  assertHizoFSSegmentId({ segmentId });
  const fileSystemIdBytes = decodeFileSystemIdBytes({ fileSystemId });
  const prefix = new Uint8Array(48);
  const view = new DataView(prefix.buffer);
  prefix.set(SEGMENT_MAGIC, 0);
  view.setUint16(8, HIZOFS_FORMAT_VERSION, false);
  view.setUint16(10, HIZOFS_SEGMENT_HEADER_BYTE_LENGTH, false);
  view.setUint8(12, segmentTypeToId({ segmentType }));
  view.setUint8(13, 0);
  view.setUint16(14, 0, false);
  prefix.set(fileSystemIdBytes, 16);
  prefix.set(segmentId, 32);
  const key = await deriveHizoFSSegmentHeaderKey({ rootKey, fileSystemId, segmentId });
  const tag = await encryptHizoFSAesGcm({
    key,
    nonce: new Uint8Array(HIZOFS_AES_GCM_NONCE_BYTE_LENGTH),
    plaintext: EMPTY,
    additionalData: prefix,
  });
  if (tag.byteLength !== HIZOFS_AES_GCM_TAG_BYTE_LENGTH) {
    throw new Error('HizoFS segment-header authentication tag has an unexpected length');
  }
  return concatenateBytes({ parts: [prefix, tag] });
}

export async function decodeHizoFSSegmentHeader({
  rootKey,
  fileSystemId,
  expectedSegmentId,
  bytes,
}: {
  rootKey: CryptoKey;
  fileSystemId: string;
  expectedSegmentId: Uint8Array;
  bytes: Uint8Array;
}): Promise<HizoFSSegmentHeader> {
  if (bytes.byteLength !== HIZOFS_SEGMENT_HEADER_BYTE_LENGTH) {
    throw new HizoFSCorruptionError({
      message: 'HizoFS segment header has an invalid length',
      cause: undefined,
    });
  }
  assertMagic({
    bytes: bytes.subarray(0, 8),
    expected: SEGMENT_MAGIC,
    message: 'HizoFS segment magic is invalid',
  });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(8, false) !== HIZOFS_FORMAT_VERSION) {
    throw new HizoFSUnsupportedFormatError({
      message: `HizoFS segment version is unsupported: ${String(view.getUint16(8, false))}`,
    });
  }
  if (view.getUint16(10, false) !== HIZOFS_SEGMENT_HEADER_BYTE_LENGTH) {
    throw new HizoFSCorruptionError({
      message: 'HizoFS segment header length field is invalid',
      cause: undefined,
    });
  }
  if (view.getUint8(13) !== 0 || view.getUint16(14, false) !== 0) {
    throw new HizoFSCorruptionError({
      message: 'HizoFS segment reserved header bytes must be zero',
      cause: undefined,
    });
  }
  const expectedFileSystemIdBytes = decodeFileSystemIdBytes({ fileSystemId });
  if (!bytesEqual({ left: bytes.subarray(16, 32), right: expectedFileSystemIdBytes })) {
    throw new HizoFSCorruptionError({
      message: 'HizoFS segment file-system ID does not match the open filesystem',
      cause: undefined,
    });
  }
  assertHizoFSSegmentId({ segmentId: expectedSegmentId });
  if (!bytesEqual({ left: bytes.subarray(32, 48), right: expectedSegmentId })) {
    throw new HizoFSCorruptionError({
      message: 'HizoFS segment ID does not match its physical path',
      cause: undefined,
    });
  }
  const key = await deriveHizoFSSegmentHeaderKey({
    rootKey,
    fileSystemId,
    segmentId: expectedSegmentId,
  });
  try {
    await decryptHizoFSAesGcm({
      key,
      nonce: new Uint8Array(HIZOFS_AES_GCM_NONCE_BYTE_LENGTH),
      ciphertext: bytes.subarray(48),
      additionalData: bytes.subarray(0, 48),
    });
  } catch (error) {
    throw new HizoFSCorruptionError({
      message: 'HizoFS segment header authentication failed',
      cause: error,
    });
  }
  return {
    segmentType: segmentTypeFromId({ id: view.getUint8(12) }),
    fileSystemIdBytes: bytes.slice(16, 32),
    segmentId: bytes.slice(32, 48),
  };
}

function createRecordFrameHeader({
  reference,
  plaintextByteLength,
  nonce,
}: {
  reference: HizoFSObjectReference;
  plaintextByteLength: number;
  nonce: Uint8Array;
}): Uint8Array {
  const expectedLength = getHizoFSRecordFrameByteLength({ plaintextByteLength });
  if (reference.storedLength !== expectedLength) {
    throw new Error('HizoFS object reference stored length does not match its plaintext');
  }
  if (nonce.byteLength !== HIZOFS_AES_GCM_NONCE_BYTE_LENGTH) {
    throw new Error('HizoFS record nonce has an invalid length');
  }
  const header = new Uint8Array(HIZOFS_RECORD_FRAME_HEADER_BYTE_LENGTH);
  const view = new DataView(header.buffer);
  header.set(RECORD_MAGIC, 0);
  view.setUint16(8, HIZOFS_FORMAT_VERSION, false);
  view.setUint16(10, HIZOFS_RECORD_FRAME_HEADER_BYTE_LENGTH, false);
  view.setUint32(12, 0, false);
  view.setBigUint64(16, BigInt(reference.storedLength), false);
  view.setBigUint64(24, BigInt(plaintextByteLength), false);
  header.set(reference.homeSegmentId, 32);
  view.setBigUint64(48, BigInt(reference.homeOffset), false);
  header.set(nonce, 56);
  view.setUint8(68, encodeHizoFSRecordKind({ kind: reference.kind }));
  view.setUint8(69, 0);
  view.setUint16(70, 0, false);
  return header;
}

export async function encodeHizoFSRecordFrame({
  rootKey,
  fileSystemId,
  reference,
  plaintext,
  recordKey,
}: {
  rootKey: CryptoKey;
  fileSystemId: string;
  reference: HizoFSObjectReference;
  plaintext: Uint8Array;
  recordKey?: CryptoKey;
}): Promise<HizoFSEncodedRecordFrame> {
  const nonce = createHizoFSNonce();
  const header = createRecordFrameHeader({
    reference,
    plaintextByteLength: plaintext.byteLength,
    nonce,
  });
  const key = recordKey ?? await deriveHizoFSSegmentRecordKey({
    rootKey,
    fileSystemId,
    homeSegmentId: reference.homeSegmentId,
  });
  const ciphertext = await encryptHizoFSAesGcm({
    key,
    nonce,
    plaintext,
    additionalData: concatenateBytes({
      parts: [RECORD_AAD_DOMAIN, decodeFileSystemIdBytes({ fileSystemId }), header],
    }),
  });
  const bytes = new Uint8Array(reference.storedLength);
  bytes.set(header, 0);
  bytes.set(ciphertext, HIZOFS_RECORD_FRAME_HEADER_BYTE_LENGTH);
  return {
    reference,
    bytes,
    plaintextByteLength: plaintext.byteLength,
  };
}


export function decodeHizoFSRecordFrameReference({ headerBytes }: {
  headerBytes: Uint8Array;
}): HizoFSObjectReference {
  if (headerBytes.byteLength !== HIZOFS_RECORD_FRAME_HEADER_BYTE_LENGTH) {
    throw new HizoFSCorruptionError({
      message: 'HizoFS record frame header has an invalid length',
      cause: undefined,
    });
  }
  assertMagic({
    bytes: headerBytes.subarray(0, 8),
    expected: RECORD_MAGIC,
    message: 'HizoFS record frame magic is invalid',
  });
  const view = new DataView(
    headerBytes.buffer,
    headerBytes.byteOffset,
    headerBytes.byteLength,
  );
  if (view.getUint16(8, false) !== HIZOFS_FORMAT_VERSION) {
    throw new HizoFSUnsupportedFormatError({
      message: `HizoFS record-frame version is unsupported: ${String(view.getUint16(8, false))}`,
    });
  }
  if (
    view.getUint16(10, false) !== HIZOFS_RECORD_FRAME_HEADER_BYTE_LENGTH
    || view.getUint32(12, false) !== 0
    || view.getUint8(69) !== 0
    || view.getUint16(70, false) !== 0
  ) {
    throw new HizoFSCorruptionError({
      message: 'HizoFS record frame header is invalid',
      cause: undefined,
    });
  }
  const storedLength = readSafeUint64({
    view,
    offset: 16,
    fieldName: 'HizoFS record frame length',
  });
  if (storedLength > 0xffff_ffff) {
    throw new HizoFSCorruptionError({
      message: 'HizoFS record frame length exceeds the object-reference range',
      cause: undefined,
    });
  }
  const reference: HizoFSObjectReference = {
    homeSegmentId: headerBytes.slice(32, 48),
    homeOffset: readSafeUint64({
      view,
      offset: 48,
      fieldName: 'HizoFS record home offset',
    }),
    storedLength,
    kind: decodeHizoFSRecordKind({ id: view.getUint8(68) }),
  };
  const plaintextByteLength = readSafeUint64({
    view,
    offset: 24,
    fieldName: 'HizoFS record plaintext length',
  });
  if (getHizoFSRecordFrameByteLength({ plaintextByteLength }) !== storedLength) {
    throw new HizoFSCorruptionError({
      message: 'HizoFS record frame lengths are inconsistent',
      cause: undefined,
    });
  }
  return reference;
}

export async function decodeHizoFSRecordFrame({
  rootKey,
  fileSystemId,
  expectedReference,
  bytes,
  recordKey,
}: {
  rootKey: CryptoKey;
  fileSystemId: string;
  expectedReference: HizoFSObjectReference;
  bytes: Uint8Array;
  recordKey?: CryptoKey;
}): Promise<Uint8Array> {
  if (bytes.byteLength !== expectedReference.storedLength) {
    throw new HizoFSCorruptionError({
      message: 'HizoFS record frame length does not match its object reference',
      cause: undefined,
    });
  }
  if (bytes.byteLength < HIZOFS_RECORD_FRAME_HEADER_BYTE_LENGTH) {
    throw new HizoFSCorruptionError({ message: 'HizoFS record frame is truncated', cause: undefined });
  }
  assertMagic({
    bytes: bytes.subarray(0, 8),
    expected: RECORD_MAGIC,
    message: 'HizoFS record frame magic is invalid',
  });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(8, false) !== HIZOFS_FORMAT_VERSION) {
    throw new HizoFSUnsupportedFormatError({
      message: `HizoFS record-frame version is unsupported: ${String(view.getUint16(8, false))}`,
    });
  }
  if (view.getUint16(10, false) !== HIZOFS_RECORD_FRAME_HEADER_BYTE_LENGTH) {
    throw new HizoFSCorruptionError({
      message: 'HizoFS record frame header length is invalid',
      cause: undefined,
    });
  }
  if (view.getUint32(12, false) !== 0 || view.getUint8(69) !== 0 || view.getUint16(70, false) !== 0) {
    throw new HizoFSCorruptionError({
      message: 'HizoFS record frame reserved bytes must be zero',
      cause: undefined,
    });
  }
  const frameLength = readSafeUint64({ view, offset: 16, fieldName: 'HizoFS record frame length' });
  const plaintextByteLength = readSafeUint64({
    view,
    offset: 24,
    fieldName: 'HizoFS record plaintext length',
  });
  const actualReference: HizoFSObjectReference = {
    homeSegmentId: bytes.slice(32, 48),
    homeOffset: readSafeUint64({ view, offset: 48, fieldName: 'HizoFS record home offset' }),
    storedLength: frameLength,
    kind: expectedReference.kind,
  };
  if (view.getUint8(68) !== encodeHizoFSRecordKind({ kind: expectedReference.kind })) {
    throw new HizoFSCorruptionError({
      message: 'HizoFS record kind does not match its object reference',
      cause: undefined,
    });
  }
  if (!objectReferencesEqual({ left: actualReference, right: expectedReference })) {
    throw new HizoFSCorruptionError({
      message: 'HizoFS record logical reference does not match its caller reference',
      cause: undefined,
    });
  }
  if (getHizoFSRecordFrameByteLength({ plaintextByteLength }) !== frameLength) {
    throw new HizoFSCorruptionError({
      message: 'HizoFS record frame lengths are inconsistent',
      cause: undefined,
    });
  }
  const ciphertextEnd = HIZOFS_RECORD_FRAME_HEADER_BYTE_LENGTH
    + plaintextByteLength
    + HIZOFS_AES_GCM_TAG_BYTE_LENGTH;
  if (ciphertextEnd > bytes.byteLength) {
    throw new HizoFSCorruptionError({ message: 'HizoFS record ciphertext is truncated', cause: undefined });
  }
  for (const paddingByte of bytes.subarray(ciphertextEnd)) {
    if (paddingByte !== 0) {
      throw new HizoFSCorruptionError({
        message: 'HizoFS record alignment padding must be zero',
        cause: undefined,
      });
    }
  }
  const header = bytes.subarray(0, HIZOFS_RECORD_FRAME_HEADER_BYTE_LENGTH);
  const nonce = bytes.subarray(56, 56 + HIZOFS_AES_GCM_NONCE_BYTE_LENGTH);
  const key = recordKey ?? await deriveHizoFSSegmentRecordKey({
    rootKey,
    fileSystemId,
    homeSegmentId: expectedReference.homeSegmentId,
  });
  try {
    return await decryptHizoFSAesGcm({
      key,
      nonce,
      ciphertext: bytes.subarray(HIZOFS_RECORD_FRAME_HEADER_BYTE_LENGTH, ciphertextEnd),
      additionalData: concatenateBytes({
        parts: [RECORD_AAD_DOMAIN, decodeFileSystemIdBytes({ fileSystemId }), header],
      }),
    });
  } catch (error) {
    throw new HizoFSCorruptionError({
      message: 'HizoFS record frame authentication failed',
      cause: error,
    });
  }
}

function createHeadEnvelopeHeader({ nonce, ciphertextByteLength }: {
  nonce: Uint8Array;
  ciphertextByteLength: number;
}): Uint8Array {
  if (nonce.byteLength !== HIZOFS_AES_GCM_NONCE_BYTE_LENGTH) {
    throw new Error('HizoFS head nonce has an invalid length');
  }
  if (!Number.isSafeInteger(ciphertextByteLength) || ciphertextByteLength < HIZOFS_AES_GCM_TAG_BYTE_LENGTH || ciphertextByteLength > 0xffff_ffff) {
    throw new Error('HizoFS head ciphertext length is invalid');
  }
  const header = new Uint8Array(HIZOFS_HEAD_ENVELOPE_HEADER_BYTE_LENGTH);
  const view = new DataView(header.buffer);
  header.set(HEAD_MAGIC, 0);
  view.setUint16(8, HIZOFS_FORMAT_VERSION, false);
  view.setUint16(10, HIZOFS_HEAD_ENVELOPE_HEADER_BYTE_LENGTH, false);
  header.set(nonce, 12);
  view.setUint32(24, ciphertextByteLength, false);
  view.setUint32(28, 0, false);
  return header;
}

export async function encodeHizoFSHead({
  rootKey,
  fileSystemId,
  slot,
  activeMetadataSegmentId,
  activeMetadataDurableTail,
  recordBytes,
}: {
  rootKey: CryptoKey;
  fileSystemId: string;
  slot: 0 | 1;
  activeMetadataSegmentId: Uint8Array;
  activeMetadataDurableTail: number;
  recordBytes: Uint8Array;
}): Promise<Uint8Array> {
  assertHizoFSSegmentId({ segmentId: activeMetadataSegmentId });
  if (!Number.isSafeInteger(activeMetadataDurableTail) || activeMetadataDurableTail < HIZOFS_SEGMENT_HEADER_BYTE_LENGTH) {
    throw new Error('HizoFS active metadata durable tail is invalid');
  }
  if (recordBytes.byteLength > 0xffff_ffff) {
    throw new Error('HizoFS head record is too large');
  }
  const plaintext = new Uint8Array(HIZOFS_HEAD_PLAINTEXT_PREFIX_BYTE_LENGTH + recordBytes.byteLength);
  const view = new DataView(plaintext.buffer);
  plaintext.set(decodeFileSystemIdBytes({ fileSystemId }), 0);
  plaintext.set(activeMetadataSegmentId, 16);
  view.setBigUint64(32, BigInt(activeMetadataDurableTail), false);
  view.setUint32(40, recordBytes.byteLength, false);
  view.setUint32(44, 0, false);
  plaintext.set(recordBytes, HIZOFS_HEAD_PLAINTEXT_PREFIX_BYTE_LENGTH);

  const nonce = createHizoFSNonce();
  const envelopeHeader = createHeadEnvelopeHeader({
    nonce,
    ciphertextByteLength: plaintext.byteLength + HIZOFS_AES_GCM_TAG_BYTE_LENGTH,
  });
  const key = await deriveHizoFSHeadKey({ rootKey, fileSystemId, slot });
  const ciphertext = await encryptHizoFSAesGcm({
    key,
    nonce,
    plaintext,
    additionalData: concatenateBytes({
      parts: [HEAD_AAD_DOMAIN, decodeFileSystemIdBytes({ fileSystemId }), Uint8Array.of(slot), envelopeHeader],
    }),
  });
  plaintext.fill(0);
  return concatenateBytes({ parts: [envelopeHeader, ciphertext] });
}

export async function decodeHizoFSHead({
  rootKey,
  fileSystemId,
  slot,
  bytes,
}: {
  rootKey: CryptoKey;
  fileSystemId: string;
  slot: 0 | 1;
  bytes: Uint8Array;
}): Promise<HizoFSDecodedHead> {
  if (bytes.byteLength < HIZOFS_HEAD_ENVELOPE_HEADER_BYTE_LENGTH + HIZOFS_AES_GCM_TAG_BYTE_LENGTH) {
    throw new HizoFSCorruptionError({ message: 'HizoFS head file is truncated', cause: undefined });
  }
  const header = bytes.subarray(0, HIZOFS_HEAD_ENVELOPE_HEADER_BYTE_LENGTH);
  assertMagic({ bytes: header.subarray(0, 8), expected: HEAD_MAGIC, message: 'HizoFS head magic is invalid' });
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (view.getUint16(8, false) !== HIZOFS_FORMAT_VERSION) {
    throw new HizoFSUnsupportedFormatError({
      message: `HizoFS head version is unsupported: ${String(view.getUint16(8, false))}`,
    });
  }
  if (view.getUint16(10, false) !== HIZOFS_HEAD_ENVELOPE_HEADER_BYTE_LENGTH || view.getUint32(28, false) !== 0) {
    throw new HizoFSCorruptionError({ message: 'HizoFS head envelope header is invalid', cause: undefined });
  }
  const ciphertextByteLength = view.getUint32(24, false);
  if (bytes.byteLength !== HIZOFS_HEAD_ENVELOPE_HEADER_BYTE_LENGTH + ciphertextByteLength) {
    throw new HizoFSCorruptionError({ message: 'HizoFS head ciphertext length is invalid', cause: undefined });
  }
  const nonce = header.subarray(12, 24);
  const key = await deriveHizoFSHeadKey({ rootKey, fileSystemId, slot });
  let plaintext: Uint8Array;
  try {
    plaintext = await decryptHizoFSAesGcm({
      key,
      nonce,
      ciphertext: bytes.subarray(HIZOFS_HEAD_ENVELOPE_HEADER_BYTE_LENGTH),
      additionalData: concatenateBytes({
        parts: [HEAD_AAD_DOMAIN, decodeFileSystemIdBytes({ fileSystemId }), Uint8Array.of(slot), header],
      }),
    });
  } catch (error) {
    throw new HizoFSCorruptionError({ message: 'HizoFS head authentication failed', cause: error });
  }
  try {
    if (plaintext.byteLength < HIZOFS_HEAD_PLAINTEXT_PREFIX_BYTE_LENGTH) {
      throw new HizoFSCorruptionError({ message: 'HizoFS head plaintext is truncated', cause: undefined });
    }
    const plaintextView = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength);
    if (!bytesEqual({ left: plaintext.subarray(0, 16), right: decodeFileSystemIdBytes({ fileSystemId }) })) {
      throw new HizoFSCorruptionError({
        message: 'HizoFS head file-system ID does not match the open filesystem',
        cause: undefined,
      });
    }
    if (plaintextView.getUint32(44, false) !== 0) {
      throw new HizoFSCorruptionError({ message: 'HizoFS head reserved bytes must be zero', cause: undefined });
    }
    const recordByteLength = plaintextView.getUint32(40, false);
    if (plaintext.byteLength !== HIZOFS_HEAD_PLAINTEXT_PREFIX_BYTE_LENGTH + recordByteLength) {
      throw new HizoFSCorruptionError({ message: 'HizoFS head record length is invalid', cause: undefined });
    }
    const recordBytes = plaintext.slice(HIZOFS_HEAD_PLAINTEXT_PREFIX_BYTE_LENGTH);
    const record = decodeHizoFSRecord({ plaintext: recordBytes });
    return {
      activeMetadataSegmentId: plaintext.slice(16, 32),
      activeMetadataDurableTail: readSafeUint64({
        view: plaintextView,
        offset: 32,
        fieldName: 'HizoFS active metadata durable tail',
      }),
      recordBytes,
      record,
    };
  } finally {
    plaintext.fill(0);
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  HIZOFS_FORMAT_VERSION,
  SEGMENT_MAGIC,
  RECORD_MAGIC,
  HEAD_MAGIC,
};
