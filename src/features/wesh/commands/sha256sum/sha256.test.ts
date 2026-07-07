import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSha256Hasher } from './sha256';

function createDeterministicBytes({ length }: { length: number }): Uint8Array {
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

function digestWithWesh({
  bytes,
  chunkSizes,
}: {
  bytes: Uint8Array,
  chunkSizes: readonly number[],
}): string {
  const hasher = createSha256Hasher();
  let offset = 0;
  let chunkIndex = 0;

  while (offset < bytes.byteLength) {
    const requestedSize = chunkSizes[chunkIndex % chunkSizes.length]!;
    const end = Math.min(offset + requestedSize, bytes.byteLength);
    hasher.update({ bytes: bytes.subarray(offset, end) });
    offset = end;
    chunkIndex += 1;
  }

  return hasher.digestHex();
}

function digestWithNode({ bytes }: { bytes: Uint8Array }): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('wesh incremental SHA256', () => {
  it('matches node:crypto across binary inputs and chunk boundaries', () => {
    const lengths = [
      0,
      1,
      2,
      3,
      7,
      31,
      55,
      56,
      57,
      63,
      64,
      65,
      127,
      128,
      129,
      255,
      256,
      257,
      1_023,
      1_024,
      1_025,
      4_097,
      65_536,
      1_000_000,
    ];
    const chunkPatterns = [
      {
        name: 'single chunk',
        sizes: [Number.MAX_SAFE_INTEGER],
      },
      {
        name: 'SHA256 boundaries',
        sizes: [1, 63, 64, 65],
      },
      {
        name: 'irregular chunks',
        sizes: [17, 257, 4_093, 5, 128],
      },
    ];

    for (const length of lengths) {
      const bytes = createDeterministicBytes({ length });
      const nodeDigest = digestWithNode({ bytes });

      for (const pattern of chunkPatterns) {
        const weshDigest = digestWithWesh({
          bytes,
          chunkSizes: pattern.sizes,
        });

        expect({
          length,
          chunkPattern: pattern.name,
          digest: weshDigest,
        }).toEqual({
          length,
          chunkPattern: pattern.name,
          digest: nodeDigest,
        });
      }
    }
  });
});
