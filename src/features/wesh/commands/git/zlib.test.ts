import { describe, expect, it } from 'vitest';
import { deflateZlibChunks, inflateZlib } from './zlib';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('wesh git zlib helpers', () => {
  it('compresses multiple input chunks as one continuous zlib stream', async () => {
    const compressed = await deflateZlibChunks({
      chunks: [encoder.encode('blob 6\0'), encoder.encode('hello\n')],
    });

    expect(decoder.decode(await inflateZlib({ bytes: compressed }))).toBe('blob 6\0hello\n');
  });

  it('supports an empty chunk sequence', async () => {
    const compressed = await deflateZlibChunks({ chunks: [] });

    expect(await inflateZlib({ bytes: compressed })).toEqual(new Uint8Array());
  });
});
