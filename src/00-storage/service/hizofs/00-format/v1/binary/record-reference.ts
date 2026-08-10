import { HIZOFS_V1_FORMAT_CONSTANTS } from '@/00-storage/service/hizofs/00-format/v1/format-constants';
import { assertSegmentId, parseSegmentId, type SegmentId } from '@/00-storage/service/hizofs/00-format/v1/identifiers';
import { createUInt64, UINT64_MAXIMUM, type UInt64 } from '@/00-storage/service/hizofs/00-format/v1/scalars';
import { readU32Be, readU64Be, writeU32Be, writeU64Be } from './scalars';

const SIZE = HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.recordReference;
const KNOWN_RECORD_KINDS = new Set<number>(Object.values(HIZOFS_V1_FORMAT_CONSTANTS.recordKinds));

declare const homeRecordReferenceBrand: unique symbol;
declare const physicalRecordReferenceBrand: unique symbol;

export type RecordReferenceFields = Readonly<{
  byteOffset: UInt64;
  frameLength: number;
  recordKind: number;
  segmentId: SegmentId;
}>;

export type HomeRecordReference = RecordReferenceFields & { readonly [homeRecordReferenceBrand]: true };
export type PhysicalRecordReference = RecordReferenceFields & { readonly [physicalRecordReferenceBrand]: true };

function validateFields({ fields }: { fields: RecordReferenceFields }): void {
  assertSegmentId({ id: fields.segmentId });
  if (fields.byteOffset < 64n || fields.byteOffset % 8n !== 0n) {
    throw new RangeError('Record Reference byte offset must be aligned and after the Segment Header');
  }
  if (!Number.isInteger(fields.frameLength) || fields.frameLength < 88 || fields.frameLength % 8 !== 0) {
    throw new RangeError('Record Reference frame length must be aligned and at least 88 bytes');
  }
  if (fields.byteOffset + BigInt(fields.frameLength) > UINT64_MAXIMUM) {
    throw new RangeError('Record Reference range exceeds u64');
  }
  if (!KNOWN_RECORD_KINDS.has(fields.recordKind)) throw new TypeError('Record Reference kind is unknown');
}

function bytesAreAllZero({ bytes }: { bytes: Uint8Array }): boolean {
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] !== 0) return false;
  }
  return true;
}

function encodeReference({ fields }: { fields: RecordReferenceFields }): Uint8Array {
  validateFields({ fields });
  const bytes = new Uint8Array(SIZE);
  bytes.set(fields.segmentId, 0);
  writeU64Be({ bytes, offset: 16, value: fields.byteOffset });
  writeU32Be({ bytes, offset: 24, value: fields.frameLength });
  bytes[28] = fields.recordKind;
  return bytes;
}

function decodeReference({ bytes }: { bytes: Uint8Array }): RecordReferenceFields {
  if (bytes.byteLength !== SIZE) throw new RangeError(`Record Reference must be exactly ${SIZE} bytes`);
  if (bytesAreAllZero({ bytes })) throw new TypeError('required Record Reference must not be all-zero');
  if (bytes[29] !== 0 || bytes[30] !== 0 || bytes[31] !== 0) {
    throw new TypeError('Record Reference flags and reserved bytes must be zero');
  }
  const recordKind = bytes[28];
  if (recordKind === undefined) throw new Error('Record Reference kind offset invariant failed');
  const fields: RecordReferenceFields = {
    byteOffset: readU64Be({ bytes, offset: 16 }),
    frameLength: readU32Be({ bytes, offset: 24 }),
    recordKind,
    segmentId: parseSegmentId({ bytes: bytes.subarray(0, 16) }),
  };
  validateFields({ fields });
  return fields;
}

export function sameRecordReferenceFields({ left, right }: {
  left: RecordReferenceFields;
  right: RecordReferenceFields;
}): boolean {
  if (left.byteOffset !== right.byteOffset
    || left.frameLength !== right.frameLength
    || left.recordKind !== right.recordKind) return false;
  for (let index = 0; index < left.segmentId.byteLength; index += 1) {
    if (left.segmentId[index] !== right.segmentId[index]) return false;
  }
  return true;
}

export function encodeHomeRecordReference({ reference }: { reference: HomeRecordReference }): Uint8Array {
  return encodeReference({ fields: reference });
}

export function encodePhysicalRecordReference({ reference }: { reference: PhysicalRecordReference }): Uint8Array {
  return encodeReference({ fields: reference });
}

export function decodeRequiredHomeRecordReference({ bytes }: { bytes: Uint8Array }): HomeRecordReference {
  return decodeReference({ bytes }) as HomeRecordReference;
}

export function decodeRequiredPhysicalRecordReference({ bytes }: { bytes: Uint8Array }): PhysicalRecordReference {
  return decodeReference({ bytes }) as PhysicalRecordReference;
}


export function encodeOptionalHomeRecordReference({ reference }: { reference: HomeRecordReference | null }): Uint8Array {
  return reference === null ? new Uint8Array(SIZE) : encodeHomeRecordReference({ reference });
}

export function encodeOptionalPhysicalRecordReference({ reference }: { reference: PhysicalRecordReference | null }): Uint8Array {
  return reference === null ? new Uint8Array(SIZE) : encodePhysicalRecordReference({ reference });
}

export function decodeOptionalHomeRecordReference({ bytes }: { bytes: Uint8Array }): HomeRecordReference | null {
  if (bytes.byteLength !== SIZE) throw new RangeError(`Record Reference must be exactly ${SIZE} bytes`);
  return bytesAreAllZero({ bytes }) ? null : decodeRequiredHomeRecordReference({ bytes });
}

export function decodeOptionalPhysicalRecordReference({ bytes }: { bytes: Uint8Array }): PhysicalRecordReference | null {
  if (bytes.byteLength !== SIZE) throw new RangeError(`Record Reference must be exactly ${SIZE} bytes`);
  return bytesAreAllZero({ bytes }) ? null : decodeRequiredPhysicalRecordReference({ bytes });
}

export function createHomeRecordReference({ fields }: { fields: RecordReferenceFields }): HomeRecordReference {
  validateFields({ fields });
  return { ...fields, byteOffset: createUInt64({ value: fields.byteOffset }), segmentId: parseSegmentId({ bytes: fields.segmentId }) } as HomeRecordReference;
}

export function createPhysicalRecordReference({ fields }: { fields: RecordReferenceFields }): PhysicalRecordReference {
  validateFields({ fields });
  return { ...fields, byteOffset: createUInt64({ value: fields.byteOffset }), segmentId: parseSegmentId({ bytes: fields.segmentId }) } as PhysicalRecordReference;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
