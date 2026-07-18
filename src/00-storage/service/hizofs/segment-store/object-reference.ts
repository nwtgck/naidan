import {
  decodeBase64Url,
  encodeBase64Url,
} from '@/00-storage/service/hizofs/base64-url';
import {
  decodeHizoFSRecordKind,
  encodeHizoFSRecordKind,
  type HizoFSRecordKind,
} from '@/00-storage/service/hizofs/format/record';

export const HIZOFS_SEGMENT_ID_BYTE_LENGTH = 16;
export const HIZOFS_OBJECT_REFERENCE_BYTE_LENGTH = 32;
const HIZOFS_OBJECT_REFERENCE_ENCODED_LENGTH = 43;

export type HizoFSObjectReference = {
  readonly homeSegmentId: Uint8Array;
  readonly homeOffset: number;
  readonly storedLength: number;
  readonly kind: HizoFSRecordKind;
};

function assertSafeUint64({ value, fieldName }: {
  value: number;
  fieldName: string;
}): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative safe integer`);
  }
}

function assertUint32({ value, fieldName }: {
  value: number;
  fieldName: string;
}): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error(`${fieldName} must be an unsigned 32-bit integer`);
  }
}

export function assertHizoFSSegmentId({ segmentId }: {
  segmentId: Uint8Array;
}): void {
  if (segmentId.byteLength !== HIZOFS_SEGMENT_ID_BYTE_LENGTH) {
    throw new Error('HizoFS segment ID must contain exactly 16 bytes');
  }
}

export function createHizoFSSegmentId(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(HIZOFS_SEGMENT_ID_BYTE_LENGTH));
}

export function encodeHizoFSSegmentId({ segmentId }: {
  segmentId: Uint8Array;
}): string {
  assertHizoFSSegmentId({ segmentId });
  return encodeBase64Url({ bytes: segmentId });
}

export function decodeHizoFSSegmentId({ value }: {
  value: string;
}): Uint8Array {
  const bytes = decodeBase64Url({ value });
  assertHizoFSSegmentId({ segmentId: bytes });
  return bytes;
}

export function encodeHizoFSObjectReference({ reference }: {
  reference: HizoFSObjectReference;
}): string {
  assertHizoFSSegmentId({ segmentId: reference.homeSegmentId });
  assertSafeUint64({ value: reference.homeOffset, fieldName: 'HizoFS object home offset' });
  assertUint32({ value: reference.storedLength, fieldName: 'HizoFS object stored length' });
  if (reference.storedLength === 0) {
    throw new Error('HizoFS object stored length must be positive');
  }

  const bytes = new Uint8Array(HIZOFS_OBJECT_REFERENCE_BYTE_LENGTH);
  const view = new DataView(bytes.buffer);
  bytes.set(reference.homeSegmentId, 0);
  view.setBigUint64(16, BigInt(reference.homeOffset), false);
  view.setUint32(24, reference.storedLength, false);
  view.setUint8(28, encodeHizoFSRecordKind({ kind: reference.kind }));
  view.setUint8(29, 0);
  view.setUint16(30, 0, false);
  return encodeBase64Url({ bytes });
}

export function decodeHizoFSObjectReference({ value }: {
  value: string;
}): HizoFSObjectReference {
  if (value.length !== HIZOFS_OBJECT_REFERENCE_ENCODED_LENGTH) {
    throw new Error(
      `HizoFS object reference must contain exactly ${String(HIZOFS_OBJECT_REFERENCE_ENCODED_LENGTH)} Base64URL characters`,
    );
  }
  const bytes = decodeBase64Url({ value });
  if (bytes.byteLength !== HIZOFS_OBJECT_REFERENCE_BYTE_LENGTH) {
    throw new Error('HizoFS object reference has an invalid decoded length');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offsetBigInt = view.getBigUint64(16, false);
  if (offsetBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('HizoFS object reference offset exceeds the safe integer range');
  }
  const storedLength = view.getUint32(24, false);
  if (storedLength === 0) {
    throw new Error('HizoFS object reference stored length must be positive');
  }
  if (view.getUint8(29) !== 0 || view.getUint16(30, false) !== 0) {
    throw new Error('HizoFS object reference reserved bytes must be zero');
  }
  return {
    homeSegmentId: bytes.slice(0, HIZOFS_SEGMENT_ID_BYTE_LENGTH),
    homeOffset: Number(offsetBigInt),
    storedLength,
    kind: decodeHizoFSRecordKind({ id: view.getUint8(28) }),
  };
}

export function getHizoFSSegmentShard({ segmentId }: {
  segmentId: Uint8Array;
}): string {
  assertHizoFSSegmentId({ segmentId });
  return (segmentId[0] ?? 0).toString(16).padStart(2, '0');
}

export function getHizoFSObjectReferenceShard({ objectId }: {
  objectId: string;
}): string {
  return getHizoFSSegmentShard({
    segmentId: decodeHizoFSObjectReference({ value: objectId }).homeSegmentId,
  });
}

export function objectReferencesEqual({ left, right }: {
  left: HizoFSObjectReference;
  right: HizoFSObjectReference;
}): boolean {
  if (
    left.homeOffset !== right.homeOffset
    || left.storedLength !== right.storedLength
    || left.kind !== right.kind
    || left.homeSegmentId.byteLength !== right.homeSegmentId.byteLength
  ) {
    return false;
  }
  for (let index = 0; index < left.homeSegmentId.byteLength; index += 1) {
    if (left.homeSegmentId[index] !== right.homeSegmentId[index]) return false;
  }
  return true;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  HIZOFS_OBJECT_REFERENCE_ENCODED_LENGTH,
};
