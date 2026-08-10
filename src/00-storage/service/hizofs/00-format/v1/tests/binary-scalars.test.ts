import { describe, expect, it } from 'vitest';
import { readU16Be, readU32Be, readU64Be, writeU16Be, writeU32Be, writeU64Be } from '@/00-storage/service/hizofs/00-format/v1/binary/scalars';
import { createUInt64 } from '@/00-storage/service/hizofs/00-format/v1/scalars';

describe('HizoFS V1 binary scalar helpers', () => {
  it('matches DataView Big Endian U16 encoding and decoding at non-zero byte offsets', () => {
    for (const value of [0, 1, 0xff, 0x100, 0x7fff, 0x8000, 0xffff]) {
      const backing = new Uint8Array(12).fill(0xa5);
      const bytes = backing.subarray(3, 9);
      writeU16Be({ bytes, offset: 2, value });
      const oracle = new DataView(backing.buffer, backing.byteOffset + 5, 2);
      expect(oracle.getUint16(0, false)).toBe(value);
      expect(readU16Be({ bytes, offset: 2 })).toBe(value);
      expect(backing[4]).toBe(0xa5);
      expect(backing[7]).toBe(0xa5);
    }
  });

  it('matches DataView Big Endian U32 encoding and preserves unsigned high-bit values', () => {
    for (const value of [0, 1, 0xff, 0x1_0000, 0x7fff_ffff, 0x8000_0000, 0xffff_ffff, 0x1234_5678]) {
      const backing = new Uint8Array(16).fill(0x5a);
      const bytes = backing.subarray(4, 13);
      writeU32Be({ bytes, offset: 3, value });
      const oracle = new DataView(backing.buffer, backing.byteOffset + 7, 4);
      expect(oracle.getUint32(0, false)).toBe(value);
      expect(readU32Be({ bytes, offset: 3 })).toBe(value);
      expect(backing[6]).toBe(0x5a);
      expect(backing[11]).toBe(0x5a);
    }
  });

  it('matches DataView Big Endian U64 encoding across u32 and signed-bit boundaries', () => {
    for (const value of [
      0n,
      1n,
      0xffff_ffffn,
      0x1_0000_0000n,
      0x7fff_ffff_ffff_ffffn,
      0x8000_0000_0000_0000n,
      0xffff_ffff_ffff_ffffn,
      0x0123_4567_89ab_cdefn,
    ]) {
      const backing = new Uint8Array(20).fill(0x3c);
      const bytes = backing.subarray(3, 18);
      writeU64Be({ bytes, offset: 4, value: createUInt64({ value }) });
      const oracle = new DataView(backing.buffer, backing.byteOffset + 7, 8);
      expect(oracle.getBigUint64(0, false)).toBe(value);
      expect(readU64Be({ bytes, offset: 4 })).toBe(value);
      expect(backing[6]).toBe(0x3c);
      expect(backing[15]).toBe(0x3c);
    }
  });

  it('preserves range validation', () => {
    expect(() => readU16Be({ bytes: new Uint8Array(1), offset: 0 })).toThrow('outside');
    expect(() => writeU16Be({ bytes: new Uint8Array(2), offset: 0, value: 0x1_0000 })).toThrow('u16');
    expect(() => readU32Be({ bytes: new Uint8Array(4), offset: 1 })).toThrow('outside');
    expect(() => writeU32Be({ bytes: new Uint8Array(4), offset: 0, value: 0x1_0000_0000 })).toThrow('u32');
    expect(() => readU64Be({ bytes: new Uint8Array(8), offset: 1 })).toThrow('outside');
  });
});
