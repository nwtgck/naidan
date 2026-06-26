import { describe, expect, it } from 'vitest';
import { iterateUtf8Lines } from './text-records';

async function collectLines({
  chunkTexts,
}: {
  chunkTexts: string[],
}): Promise<string[]> {
  const encoder = new TextEncoder();
  const chunks: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() {
      for (const text of chunkTexts) {
        yield encoder.encode(text);
      }
    },
  };
  const lines: string[] = [];
  for await (const line of iterateUtf8Lines({ chunks })) {
    lines.push(line);
  }
  return lines;
}

describe('iterateUtf8Lines', () => {
  it('preserves lines split across chunks and strips CR before LF', async () => {
    await expect(collectLines({
      chunkTexts: ['alpha\r', '\nbet', 'a\n', '\ngamma'],
    })).resolves.toEqual([
      'alpha',
      'beta',
      '',
      'gamma',
    ]);
  });

  it('does not emit an extra record after a trailing newline', async () => {
    await expect(collectLines({
      chunkTexts: ['alpha\n'],
    })).resolves.toEqual(['alpha']);
  });

  it('handles a long record without repeated whole-record concatenation', async () => {
    const fragment = 'x'.repeat(64 * 1024);
    const lines = await collectLines({
      chunkTexts: Array.from({ length: 16 }, () => fragment),
    });
    expect(lines).toEqual([fragment.repeat(16)]);
  });
});
