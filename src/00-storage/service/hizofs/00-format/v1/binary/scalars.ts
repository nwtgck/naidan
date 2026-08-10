import { createUInt64, type UInt64 } from '@/00-storage/service/hizofs/00-format/v1/scalars';

function assertRange({ bytes, offset, size }: { bytes: Uint8Array; offset: number; size: number }): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + size > bytes.byteLength) {
    throw new RangeError('binary scalar range is outside the provided bytes');
  }
}

export function readU16Be({ bytes, offset }: { bytes: Uint8Array; offset: number }): number {
  assertRange({ bytes, offset, size: 2 });
  const high = bytes[offset];
  const low = bytes[offset + 1];
  if (high === undefined || low === undefined) throw new Error('u16 scalar range invariant failed');
  return high * 0x100 + low;
}

export function writeU16Be({ bytes, offset, value }: { bytes: Uint8Array; offset: number; value: number }): void {
  assertRange({ bytes, offset, size: 2 });
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new RangeError('u16 value is outside range');
  bytes[offset] = value >>> 8;
  bytes[offset + 1] = value;
}

export function readU32Be({ bytes, offset }: { bytes: Uint8Array; offset: number }): number {
  assertRange({ bytes, offset, size: 4 });
  const byte0 = bytes[offset];
  const byte1 = bytes[offset + 1];
  const byte2 = bytes[offset + 2];
  const byte3 = bytes[offset + 3];
  if (byte0 === undefined || byte1 === undefined || byte2 === undefined || byte3 === undefined) {
    throw new Error('u32 scalar range invariant failed');
  }
  // Arithmetic rather than a signed bitwise OR keeps 0x80000000..0xffffffff unsigned.
  return byte0 * 0x1_00_00_00 + byte1 * 0x1_00_00 + byte2 * 0x100 + byte3;
}

export function writeU32Be({ bytes, offset, value }: { bytes: Uint8Array; offset: number; value: number }): void {
  assertRange({ bytes, offset, size: 4 });
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) throw new RangeError('u32 value is outside range');
  bytes[offset] = value >>> 24;
  bytes[offset + 1] = value >>> 16;
  bytes[offset + 2] = value >>> 8;
  bytes[offset + 3] = value;
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
  const high = readU32Be({ bytes, offset });
  const low = readU32Be({ bytes, offset: offset + 4 });
  return createUInt64({ value: BigInt(high) * 0x1_0000_0000n + BigInt(low) });
}

export function writeU64Be({ bytes, offset, value }: { bytes: Uint8Array; offset: number; value: UInt64 }): void {
  assertRange({ bytes, offset, size: 8 });
  writeU32Be({ bytes, offset, value: Number(value >> 32n) });
  writeU32Be({ bytes, offset: offset + 4, value: Number(value & 0xffff_ffffn) });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
