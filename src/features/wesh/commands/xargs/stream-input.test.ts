import { describe, expect, it } from 'vitest';
import {
  iterateUtf8TextChunks,
  iterateXargsDelimitedItems,
  iterateXargsLogicalLines,
  iterateXargsStandardItems,
} from '@/features/wesh/commands/xargs/stream-input';

async function collect<T>({
  values,
}: {
  values: AsyncIterable<T>,
}): Promise<T[]> {
  const collected: T[] = [];
  for await (const value of values) {
    collected.push(value);
  }
  return collected;
}

async function* iterateValues<T>({
  values,
}: {
  values: readonly T[],
}): AsyncIterable<T> {
  for (const value of values) {
    yield value;
  }
}

describe('xargs streaming input', () => {
  it('preserves quoting and escaping across text chunks', async () => {
    const items = await collect({
      values: iterateXargsStandardItems({
        textChunks: iterateValues({
          values: ['alpha "two', ' words" three\\', ' four'],
        }),
        eofString: undefined,
      }),
    });

    expect(items).toEqual(['alpha', 'two words', 'three four']);
  });

  it('decodes UTF-8 characters split across byte chunks', async () => {
    const bytes = new TextEncoder().encode('alpha 日本語 beta');
    const textChunks = iterateUtf8TextChunks({
      chunks: iterateValues({
        values: [
          bytes.subarray(0, 8),
          bytes.subarray(8, 10),
          bytes.subarray(10),
        ],
      }),
    });

    const items = await collect({
      values: iterateXargsStandardItems({
        textChunks,
        eofString: undefined,
      }),
    });

    expect(items).toEqual(['alpha', '日本語', 'beta']);
  });

  it('preserves empty delimited items without adding a trailing item', async () => {
    const items = await collect({
      values: iterateXargsDelimitedItems({
        textChunks: iterateValues({ values: ['one,', ',two', ','] }),
        delimiter: ',',
      }),
    });

    expect(items).toEqual(['one', '', 'two']);
  });

  it('stops the source iterator at the logical EOF marker', async () => {
    let sourceClosed = false;
    async function* source(): AsyncIterable<string> {
      try {
        yield 'alpha STOP ';
        yield 'ignored';
      } finally {
        sourceClosed = true;
      }
    }

    const items = await collect({
      values: iterateXargsStandardItems({
        textChunks: source(),
        eofString: 'STOP',
      }),
    });

    expect(items).toEqual(['alpha']);
    expect(sourceClosed).toBe(true);
  });

  it('groups continued logical lines without collecting the full input', async () => {
    const lines = await collect({
      values: iterateXargsLogicalLines({
        lines: iterateValues({
          values: ['alpha  ', 'beta', '', 'gamma'],
        }),
      }),
    });

    expect(lines).toEqual([
      ['alpha', 'beta'],
      ['gamma'],
    ]);
  });
});
