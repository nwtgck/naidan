import { describe, expect, it } from 'vitest';
import {
  iterateByteRecordEntries,
  iterateUtf8Lines,
  iterateUtf8RecordEntries,
  materializeByteRecord,
} from './text-records';

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

  it('preserves byte-order marks at the beginning of every record', async () => {
    await expect(collectLines({
      chunkTexts: [`\
\uFEFFalpha
\uFEFFbeta`],
    })).resolves.toEqual([
      '\uFEFFalpha',
      '\uFEFFbeta',
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

describe('iterateUtf8RecordEntries', () => {
  it('tracks byte lengths and optional bytes across chunk boundaries', async () => {
    const encoder = new TextEncoder();
    const chunks = (async function* (): AsyncIterable<Uint8Array> {
      yield encoder.encode('ab');
      yield Uint8Array.of(0x63, 0x0d);
      yield Uint8Array.of(0x0a, 0x64, 0x65);
      yield encoder.encode('f');
    })();
    const records = [];
    for await (const record of iterateUtf8RecordEntries({
      chunks,
      delimiterByte: 0x0a,
      stripTrailingCarriageReturn: true,
      includeBytes: true,
    })) {
      records.push({
        text: record.text,
        bytes: record.bytes === undefined ? undefined : new TextDecoder().decode(record.bytes),
        byteLength: record.byteLength,
        termination: record.termination,
      });
    }
    expect(records).toEqual([
      {
        text: 'abc',
        bytes: 'abc',
        byteLength: 5,
        termination: 'delimiter',
      },
      {
        text: 'def',
        bytes: 'def',
        byteLength: 3,
        termination: 'end_of_input',
      },
    ]);
  });
});

describe('iterateByteRecordEntries', () => {
  it('preserves invalid bytes and delimiters across chunk boundaries', async () => {
    const chunks = (async function* (): AsyncIterable<Uint8Array> {
      yield Uint8Array.of(0xff, 0x0d);
      yield Uint8Array.of(0x0a, 0x61);
      yield Uint8Array.of(0x0a, 0xfe);
    })();
    const records = [];
    for await (const record of iterateByteRecordEntries({
      chunks,
      delimiterByte: 0x0a,
    })) {
      records.push({
        bytes: [...record.bytes],
        materialized: [...materializeByteRecord({ record, delimiterByte: 0x0a })],
        byteLength: record.byteLength,
        termination: record.termination,
      });
    }

    expect(records).toEqual([
      {
        bytes: [0xff, 0x0d],
        materialized: [0xff, 0x0d, 0x0a],
        byteLength: 3,
        termination: 'delimiter',
      },
      {
        bytes: [0x61],
        materialized: [0x61, 0x0a],
        byteLength: 2,
        termination: 'delimiter',
      },
      {
        bytes: [0xfe],
        materialized: [0xfe],
        byteLength: 1,
        termination: 'end_of_input',
      },
    ]);
  });
});
