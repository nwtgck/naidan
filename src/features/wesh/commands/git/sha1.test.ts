import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSha1Hasher, sha1Hex } from './sha1';

function deterministicBytes({ length }: { length: number }): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = 0x12345678;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    bytes[index] = state & 0xff;
  }
  return bytes;
}

describe('wesh git SHA1', () => {
  it('matches node:crypto across chunk boundaries', () => {
    for (const length of [0, 1, 7, 55, 56, 63, 64, 65, 127, 128, 1024, 65_537]) {
      const bytes = deterministicBytes({ length });
      const expected = createHash('sha1').update(bytes).digest('hex');
      expect(sha1Hex({ bytes })).toBe(expected);

      const hasher = createSha1Hasher();
      let offset = 0;
      const chunkSizes = [1, 63, 17, 257];
      let chunkIndex = 0;
      while (offset < bytes.byteLength) {
        const end = Math.min(bytes.byteLength, offset + chunkSizes[chunkIndex % chunkSizes.length]!);
        hasher.update({ bytes: bytes.subarray(offset, end) });
        offset = end;
        chunkIndex += 1;
      }
      expect(hasher.digestHex()).toBe(expected);
    }
  });
});
