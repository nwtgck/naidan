import { describe, expect, it } from 'vitest';
import {
  createHandleShellSource,
  createShebangStrippedShellSource,
  createShellSourceReader,
  createTextShellSource,
  readShellSourceToText,
  type ShellSource,
} from './source';
import { createTestReadHandleFromText } from '@/features/wesh/utils/test-stream';

describe('ShellSource', () => {
  it('keeps immutable text without an encode/decode round trip', async () => {
    const source = createTextShellSource({ text: 'echo 😀' });

    expect(source).toEqual({
      kind: 'text',
      text: 'echo 😀',
    });
    await expect(readShellSourceToText({ source })).resolves.toBe('echo 😀');
  });

  it('adapts an existing file handle without taking ownership of it', async () => {
    const handle = createTestReadHandleFromText({ text: 'abcdef' });
    const source = createHandleShellSource({ handle });
    expect(source.kind).toBe('handle');
    await expect(readShellSourceToText({ source })).resolves.toBe('abcdef');
  });

  it('decodes byte-backed source chunks through one streaming decoder', async () => {
    const encoded = new TextEncoder().encode('before😀after');
    let offset = 0;
    const chunkSizes = [7, 1, 1, 1, 1, 5];
    const source: ShellSource = {
      kind: 'bytes',
      async read({ maximumBytes: _maximumBytes }: {
        maximumBytes: number,
      }): Promise<Uint8Array | undefined> {
        const chunkSize = chunkSizes.shift();
        if (chunkSize === undefined || offset >= encoded.length) {
          return undefined;
        }
        const chunk = encoded.subarray(offset, offset + chunkSize);
        offset += chunk.length;
        return chunk;
      },
    };

    await expect(readShellSourceToText({ source })).resolves.toBe('before😀after');
  });


  it('keeps exact retained bytes when parser text contains invalid UTF-8', async () => {
    const command = new TextEncoder().encode('cat\n');
    const bytes = new Uint8Array(command.length + 2);
    bytes.set(command, 0);
    bytes.set([0xff, 0x0a], command.length);
    let emitted = false;
    const reader = createShellSourceReader({
      source: {
        kind: 'bytes',
        async read() {
          if (emitted) {
            return undefined;
          }
          emitted = true;
          return bytes;
        },
      },
    });

    const invalidByteText = '\udcff';
    await expect(reader.read()).resolves.toEqual({
      text: `\
cat
${invalidByteText}
`,
      completion: 'may-continue',
    });
    reader.consumeText({ characters: 4 });
    expect(reader.getRetainedText()).toBe(`\
${invalidByteText}
`);

    const retained = new Uint8Array(2);
    expect(reader.readRetainedBytes({ buffer: retained, offset: 0, length: retained.length })).toBe(2);
    expect([...retained]).toEqual([0xff, 0x0a]);
    expect(reader.getRetainedText()).toBe('');
  });

  it('rebuilds parser text after fd-side consumption splits a UTF-8 sequence', async () => {
    const command = new TextEncoder().encode(`\
cat
😀
`);
    let emitted = false;
    const reader = createShellSourceReader({
      source: {
        kind: 'bytes',
        async read() {
          if (emitted) {
            return undefined;
          }
          emitted = true;
          return command;
        },
      },
    });

    await reader.read();
    reader.consumeText({ characters: 4 });
    expect(reader.getRetainedText()).toBe(`\
😀
`);

    const firstByte = new Uint8Array(1);
    expect(reader.readRetainedBytes({ buffer: firstByte, offset: 0, length: 1 })).toBe(1);
    expect([...firstByte]).toEqual([0xf0]);
    expect(reader.getRetainedText()).toBe(`\
\udc9f\udc98\udc80
`);
  });

  it('strips a shebang from text-backed sources', async () => {
    const source = createShebangStrippedShellSource({
      source: createTextShellSource({
        text: `\
#!/usr/bin/env bash
printf 'ok\\n'
`,
      }),
    });

    await expect(readShellSourceToText({ source })).resolves.toBe("printf 'ok\\n'\n");
  });

  it('strips a shebang split across byte-source chunks without exceeding requested reads', async () => {
    const chunks = [
      new TextEncoder().encode('#'),
      new TextEncoder().encode('!'),
      new TextEncoder().encode(`\
/bin/bash
printf`),
      new TextEncoder().encode(" 'ok\\n'\n"),
    ];
    let chunkIndex = 0;
    let chunkOffset = 0;
    const source = createShebangStrippedShellSource({
      source: {
        kind: 'bytes',
        async read({ maximumBytes }: { maximumBytes: number }): Promise<Uint8Array | undefined> {
          const chunk = chunks[chunkIndex];
          if (chunk === undefined) {
            return undefined;
          }
          const output = chunk.subarray(chunkOffset, chunkOffset + maximumBytes);
          chunkOffset += output.length;
          if (chunkOffset >= chunk.length) {
            chunkIndex += 1;
            chunkOffset = 0;
          }
          return output;
        },
      },
    });

    const pieces: Uint8Array[] = [];
    if (source.kind !== 'bytes') {
      throw new Error('Expected a byte-backed shell source');
    }
    while (true) {
      const chunk = await source.read({ maximumBytes: 3 });
      if (chunk === undefined) {
        break;
      }
      expect(chunk.length).toBeLessThanOrEqual(3);
      pieces.push(chunk);
    }
    const totalLength = pieces.reduce((sum, chunk) => sum + chunk.length, 0);
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of pieces) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    expect(new TextDecoder().decode(combined)).toBe("printf 'ok\\n'\n");
  });

  it('keeps the backing handle identity available for shared source ownership', () => {
    const handle = createTestReadHandleFromText({ text: 'echo ok' });
    const source = createHandleShellSource({ handle });

    expect(source).toEqual({
      kind: 'handle',
      handle,
    });
  });
});
