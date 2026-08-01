import { createUInt64, type UInt64 } from '@/00-storage/service/hizofs/00-format/v1/scalars';

function assertRange({ bytes, offset, size }: { bytes: Uint8Array; offset: number; size: number }): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + size > bytes.byteLength) {
    throw new RangeError('binary scalar range is outside the provided bytes');
  }
}

export function readU16Be({ bytes, offset }: { bytes: Uint8Array; offset: number }): number {
  assertRange({ bytes, offset, size: 2 });
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 2).getUint16(0, false);
}

export function writeU16Be({ bytes, offset, value }: { bytes: Uint8Array; offset: number; value: number }): void {
  assertRange({ bytes, offset, size: 2 });
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new RangeError('u16 value is outside range');
  new DataView(bytes.buffer, bytes.byteOffset + offset, 2).setUint16(0, value, false);
}

export function readU32Be({ bytes, offset }: { bytes: Uint8Array; offset: number }): number {
  assertRange({ bytes, offset, size: 4 });
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
}

export function writeU32Be({ bytes, offset, value }: { bytes: Uint8Array; offset: number; value: number }): void {
  assertRange({ bytes, offset, size: 4 });
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) throw new RangeError('u32 value is outside range');
  new DataView(bytes.buffer, bytes.byteOffset + offset, 4).setUint32(0, value, false);
}


const INT64_MINIMUM = -(1n << 63n);
const INT64_MAXIMUM = (1n << 63n) - 1n;

export function readI64Be({ bytes, offset }: { bytes: Uint8Array; offset: number }): bigint {
  assertRange({ bytes, offset, size: 8 });
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getBigInt64(0, false);
}

export function writeI64Be({ bytes, offset, value }: { bytes: Uint8Array; offset: number; value: bigint }): void {
  assertRange({ bytes, offset, size: 8 });
  if (value < INT64_MINIMUM || value > INT64_MAXIMUM) throw new RangeError('i64 value is outside range');
  new DataView(bytes.buffer, bytes.byteOffset + offset, 8).setBigInt64(0, value, false);
}

export function readU64Be({ bytes, offset }: { bytes: Uint8Array; offset: number }): UInt64 {
  assertRange({ bytes, offset, size: 8 });
  return createUInt64({ value: new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getBigUint64(0, false) });
}

export function writeU64Be({ bytes, offset, value }: { bytes: Uint8Array; offset: number; value: UInt64 }): void {
  assertRange({ bytes, offset, size: 8 });
  new DataView(bytes.buffer, bytes.byteOffset + offset, 8).setBigUint64(0, value, false);
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
