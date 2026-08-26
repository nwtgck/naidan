import { describe, expect, it } from 'vitest';
import { encodeCommandDataText } from '@/features/wesh/commands/_shared/data-codec';
import {
  iterateCommandDataTextChunks,
  iterateXargsDelimitedItems,
  iterateXargsInputLines,
  iterateXargsInsertItems,
  iterateXargsLogicalLines,
  iterateXargsStandardItems,
  iterateXargsTextIgnoringNulSuffixes,
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

  it('preserves a leading UTF-8 byte-order mark as input data', async () => {
    const bytes = new TextEncoder().encode('\uFEFFalpha beta');
    const textChunks = iterateCommandDataTextChunks({
      chunks: iterateValues({
        values: [bytes.subarray(0, 1), bytes.subarray(1, 3), bytes.subarray(3)],
      }),
    });

    const items = await collect({
      values: iterateXargsStandardItems({
        textChunks,
        eofString: undefined,
      }),
    });

    expect(items).toEqual(['\uFEFFalpha', 'beta']);
  });

  it('decodes UTF-8 characters split across byte chunks', async () => {
    const bytes = new TextEncoder().encode('alpha 日本語 beta');
    const textChunks = iterateCommandDataTextChunks({
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

  it('preserves malformed bytes and incomplete UTF-8 across byte chunks', async () => {
    const textChunks = iterateCommandDataTextChunks({
      chunks: iterateValues({
        values: [
          Uint8Array.of(0xff, 0x20, 0xe3),
          Uint8Array.of(0x81),
          Uint8Array.of(0x82, 0x20, 0xf0, 0x9f),
          Uint8Array.of(0x98),
        ],
      }),
    });
    const items = await collect({
      values: iterateXargsStandardItems({ textChunks, eofString: undefined }),
    });

    expect(items).toHaveLength(3);
    expect(encodeCommandDataText({ text: items[0]! })).toEqual(Uint8Array.of(0xff));
    expect(items[1]).toBe('あ');
    expect(encodeCommandDataText({ text: items[2]! })).toEqual(Uint8Array.of(0xf0, 0x9f, 0x98));
  });

  it('splits reversible command-data text into physical lines', async () => {
    const lines = await collect({
      values: iterateXargsInputLines({
        textChunks: iterateCommandDataTextChunks({
          chunks: iterateValues({
            values: [Uint8Array.of(0xff, 0x0a, 0xe3), Uint8Array.of(0x81, 0x82, 0x0a)],
          }),
        }),
      }),
    });

    expect(lines).toHaveLength(2);
    expect(encodeCommandDataText({ text: lines[0]! })).toEqual(Uint8Array.of(0xff));
    expect(lines[1]).toBe('あ');
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

  it('does not create a delimited item for an empty input stream', async () => {
    const items = await collect({
      values: iterateXargsDelimitedItems({
        textChunks: iterateValues({ values: [] }),
        delimiter: ',',
      }),
    });

    expect(items).toEqual([]);
  });

  it('discards NUL suffixes through the configured logical boundary', async () => {
    let warningCount = 0;
    const standard = await collect({
      values: iterateXargsTextIgnoringNulSuffixes({
        textChunks: iterateValues({ values: ['a\0b', ' c\0d\ne'] }),
        boundary: { kind: 'whitespace' },
        onIgnoredNul: async () => {
          warningCount += 1;
        },
      }),
    });
    const delimiter = await collect({
      values: iterateXargsTextIgnoringNulSuffixes({
        textChunks: iterateValues({ values: ['a\0b', ',c'] }),
        boundary: { kind: 'delimiter', delimiter: ',' },
      }),
    });

    expect(standard.join('')).toBe(`\
a c
e`);
    expect(delimiter.join('')).toBe('a,c');
    expect(warningCount).toBe(2);
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

  it('does not treat an unterminated final item as the logical EOF marker', async () => {
    const items = await collect({
      values: iterateXargsStandardItems({
        textChunks: iterateValues({ values: ['alpha STOP'] }),
        eofString: 'STOP',
      }),
    });

    expect(items).toEqual(['alpha', 'STOP']);
  });

  it('treats an unterminated marker at the start of its line as logical EOF', async () => {
    const standalone = await collect({
      values: iterateXargsStandardItems({
        textChunks: iterateValues({ values: ['STOP'] }),
        eofString: 'STOP',
      }),
    });
    const afterNewline = await collect({
      values: iterateXargsStandardItems({
        textChunks: iterateValues({ values: [`\
alpha
STOP`] }),
        eofString: 'STOP',
      }),
    });

    expect(standalone).toEqual([]);
    expect(afterNewline).toEqual(['alpha']);
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

  it('rejects quotes that cross a physical newline in standard input', async () => {
    await expect(collect({
      values: iterateXargsStandardItems({
        textChunks: iterateValues({ values: [`\
'alpha
beta'`] }),
        eofString: undefined,
      }),
    })).rejects.toThrow('unmatched quote');
  });

  it('preserves backslash-newline continuations in insert mode', async () => {
    const items = await collect({
      values: iterateXargsInsertItems({
        lines: iterateValues({ values: ['alpha\\', 'beta', 'gamma'] }),
        eofString: undefined,
      }),
    });

    expect(items).toEqual([`\
alpha
beta`, 'gamma']);
  });

  it('preserves backslash-newline continuations as one max-lines item', async () => {
    const lines = await collect({
      values: iterateXargsLogicalLines({
        lines: iterateValues({ values: ['alpha\\', 'beta', 'gamma'] }),
      }),
    });

    expect(lines).toEqual([
      [`\
alpha
beta`],
      ['gamma'],
    ]);
  });
});
