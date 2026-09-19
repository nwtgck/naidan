import { describe, expect, it } from 'vitest';
import { hexToBytes, writeHexBytes } from './bytes';

describe('wesh git byte helpers', () => {
  it('writes hexadecimal bytes directly into an existing destination range', () => {
    const bytes = Uint8Array.of(9, 9, 9, 9, 9, 9);

    writeHexBytes({ hex: '00a1ff', bytes, offset: 2, byteLength: 3 });

    expect(Array.from(bytes)).toEqual([9, 9, 0, 0xa1, 0xff, 9]);
    expect(Array.from(hexToBytes({ hex: '00a1ff' }))).toEqual([0, 0xa1, 0xff]);
  });

  it('rejects hexadecimal values whose decoded length does not match the destination contract', () => {
    expect(() => writeHexBytes({
      hex: '0011',
      bytes: new Uint8Array(4),
      offset: 0,
      byteLength: 3,
    })).toThrow('Invalid hexadecimal value: 0011');
  });
});
