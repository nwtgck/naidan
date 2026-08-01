import { describe, expect, it } from 'vitest';
import {
  createBinaryHexRows,
  formatBinaryOffset,
  formatBinaryRange,
  formatBytesAsHex,
} from './binary-inspection-hex';

describe('binary hex formatting', () => {
  it('preserves physical offsets and renders printable ASCII beside raw hex', () => {
    const rows = createBinaryHexRows({
      bytes: new Uint8Array([
        0x48, 0x49, 0x5a, 0x4f, 0x46, 0x53, 0x00, 0x00,
        0x20, 0x7e, 0x1f,
      ]),
      baseOffset: 0x20,
      bytesPerRow: 8,
    });

    expect(rows).toEqual([
      {
        offset: 0x20n,
        offsetLabel: '0x00000020',
        hexGroups: ['48', '49', '5a', '4f', '46', '53', '00', '00'],
        ascii: 'HIZOFS..',
      },
      {
        offset: 0x28n,
        offsetLabel: '0x00000028',
        hexGroups: ['20', '7e', '1f'],
        ascii: ' ~.',
      },
    ]);
  });

  it('formats exact inclusive ranges without converting bytes into JSON values', () => {
    expect(formatBinaryOffset({ offset: 10 })).toBe('0x0000000a');
    expect(formatBinaryRange({ offset: 10, byteLength: 2 })).toBe(
      '0x0000000a..0x0000000b',
    );
    expect(formatBinaryRange({ offset: 16, byteLength: 0 })).toBe(
      '0x00000010 (empty)',
    );
    expect(formatBytesAsHex({ bytes: new Uint8Array([0, 15, 255]) })).toBe(
      '00 0f ff',
    );
  });

  it("preserves UInt64-scale offsets without Number conversion", () => {
    const offset = 9_007_199_254_740_993n;
    expect(formatBinaryOffset({ offset })).toBe("0x20000000000001");
    expect(formatBinaryRange({ offset, byteLength: 2 })).toBe(
      "0x20000000000001..0x20000000000002",
    );
    expect(createBinaryHexRows({
      bytes: new Uint8Array([0xaa, 0xbb]),
      baseOffset: offset,
      bytesPerRow: 1,
    }).map(row => row.offset)).toEqual([offset, offset + 1n]);
  });

  it("rejects unsafe Number offsets instead of silently rounding", () => {
    expect(() => formatBinaryOffset({ offset: Number.MAX_SAFE_INTEGER + 1 }))
      .toThrow("non-negative safe integer");
    expect(() => formatBinaryOffset({ offset: -1n })).toThrow("non-negative");
  });

});
