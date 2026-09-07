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


  it('preserves a UTF-8 BOM split across byte-backed source chunks', async () => {
    const chunks = [
      Uint8Array.of(0xef),
      Uint8Array.of(0xbb),
      Uint8Array.of(0xbf, ...new TextEncoder().encode(`\
printf 'ok\\n'
`)),
    ];
    const source: ShellSource = {
      kind: 'bytes',
      async read(): Promise<Uint8Array | undefined> {
        return chunks.shift();
      },
    };

    await expect(readShellSourceToText({ source }))
      .resolves.toBe(`\
\ufeffprintf 'ok\\n'
`);
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

  it('hides NUL bytes from parser text while retaining them for fd-side reads', async () => {
    const visiblePrefix = new TextEncoder().encode(`\
cat
abc`);
    const visibleSuffix = new TextEncoder().encode(`\
TAIL
`);
    const bytes = new Uint8Array(visiblePrefix.length + 1 + visibleSuffix.length);
    bytes.set(visiblePrefix, 0);
    bytes[visiblePrefix.length] = 0x00;
    bytes.set(visibleSuffix, visiblePrefix.length + 1);
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

    await expect(reader.read()).resolves.toEqual({
      text: `\
cat
abcTAIL
`,
      completion: 'may-continue',
    });
    reader.consumeText({ characters: 4 });
    expect(reader.getRetainedText()).toBe(`\
abcTAIL
`);

    const retained = new Uint8Array(bytes.length - 4);
    expect(reader.readRetainedBytes({ buffer: retained, offset: 0, length: retained.length }))
      .toBe(retained.length);
    expect([...retained]).toEqual([...bytes.subarray(4)]);
  });

  it('filters NUL before UTF-8 decoding across source chunks', async () => {
    const chunks = [
      Uint8Array.of(0xc3, 0x00),
      Uint8Array.of(0xa9, 0x00, 0x58, 0x0a),
    ];
    const reader = createShellSourceReader({
      source: {
        kind: 'bytes',
        async read(): Promise<Uint8Array | undefined> {
          return chunks.shift();
        },
      },
    });

    await expect(reader.read()).resolves.toEqual({
      text: '',
      completion: 'may-continue',
    });
    await expect(reader.read()).resolves.toEqual({
      text: 'éX\n',
      completion: 'may-continue',
    });
    reader.consumeText({ characters: 1 });
    expect(reader.getRetainedText()).toBe('X\n');

    const retained = new Uint8Array(3);
    expect(reader.readRetainedBytes({ buffer: retained, offset: 0, length: retained.length })).toBe(3);
    expect([...retained]).toEqual([0x00, 0x58, 0x0a]);
  });

  it('consumes trailing parser-invisible NUL when EOF completes the current shell unit', async () => {
    const command = new TextEncoder().encode('cat');
    const bytes = new Uint8Array(command.length + 1);
    bytes.set(command, 0);
    bytes[command.length] = 0x00;
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

    await expect(reader.read()).resolves.toEqual({
      text: 'cat',
      completion: 'may-continue',
    });
    await expect(reader.read()).resolves.toEqual({
      text: '',
      completion: 'complete',
    });
    reader.consumeText({ characters: command.length });
    expect(reader.getRetainedText()).toBe('');

    const retained = new Uint8Array(1);
    expect(reader.readRetainedBytes({ buffer: retained, offset: 0, length: 1 })).toBe(0);
  });

  it('keeps trailing parser-invisible NUL available as raw stdin data', async () => {
    const command = new TextEncoder().encode(`\
cat
`);
    const bytes = new Uint8Array(command.length + 1);
    bytes.set(command, 0);
    bytes[command.length] = 0x00;
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

    await expect(reader.read()).resolves.toEqual({
      text: `\
cat
`,
      completion: 'may-continue',
    });
    reader.consumeText({ characters: command.length });
    expect(reader.getRetainedText()).toBe('');

    const retained = new Uint8Array(1);
    expect(reader.readRetainedBytes({ buffer: retained, offset: 0, length: 1 })).toBe(1);
    expect([...retained]).toEqual([0x00]);
  });

  it('keeps retained projection stable across many consumed source segments', async () => {
    const firstBatchSize = 96;
    const secondBatchSize = 64;
    let emittedBytes = 0;
    const reader = createShellSourceReader({
      source: {
        kind: 'bytes',
        async read(): Promise<Uint8Array | undefined> {
          if (emittedBytes >= firstBatchSize + secondBatchSize) {
            return undefined;
          }
          emittedBytes += 1;
          return Uint8Array.of(0x78);
        },
      },
    });

    for (let index = 0; index < firstBatchSize; index += 1) {
      await expect(reader.read()).resolves.toEqual({
        text: 'x',
        completion: 'may-continue',
      });
    }
    expect(reader.getRetainedText()).toBe('x'.repeat(firstBatchSize));

    reader.consumeText({ characters: 64 });
    expect(reader.getRetainedText()).toBe('x'.repeat(32));

    for (let index = 0; index < secondBatchSize; index += 1) {
      await reader.read();
    }
    expect(reader.getRetainedText()).toBe('x'.repeat(32 + secondBatchSize));

    reader.consumeText({ characters: 32 + secondBatchSize });
    expect(reader.getRetainedText()).toBe('');
    await expect(reader.read()).resolves.toEqual({
      text: '',
      completion: 'complete',
    });
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

  it('keeps handle-backed shebang passthrough chunks independent across reads', async () => {
    const source = createShebangStrippedShellSource({
      source: createHandleShellSource({
        handle: createTestReadHandleFromText({
          text: 'abcdef',
        }),
      }),
    });
    if (source.kind !== 'bytes') {
      throw new Error('Expected a byte-backed stripped source');
    }

    const first = await source.read({ maximumBytes: 2 });
    const second = await source.read({ maximumBytes: 2 });
    const third = await source.read({ maximumBytes: 2 });
    expect(first === undefined ? undefined : new TextDecoder().decode(first)).toBe('ab');
    expect(second === undefined ? undefined : new TextDecoder().decode(second)).toBe('cd');
    expect(third === undefined ? undefined : new TextDecoder().decode(third)).toBe('ef');
    expect(first?.buffer).not.toBe(second?.buffer);
    expect(second?.buffer).not.toBe(third?.buffer);
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

  it('preserves shebang stripping across bounded byte-source chunk boundaries', async () => {
    const cases = [
      '',
      '#',
      '#!',
      '#!\n',
      '#!/bin/bash',
      '#!/bin/bash\n',
      `\
#!/bin/bash
body
`,
      `\
#!/bin/bash\r
body
`,
      `\
#x
body
`,
      `\
x#!
body
`,
      '#!\0still-shebang\nbody\n',
    ];

    for (const text of cases) {
      const bytes = new TextEncoder().encode(text.replace('\\0', '\0'));
      const newlineIndex = bytes.indexOf(0x0a);
      const expected = bytes.length >= 2 && bytes[0] === 0x23 && bytes[1] === 0x21
        ? newlineIndex < 0 ? new Uint8Array(0) : bytes.subarray(newlineIndex + 1)
        : bytes;

      for (let sourceChunkSize = 1; sourceChunkSize <= 5; sourceChunkSize += 1) {
        for (let maximumBytes = 1; maximumBytes <= 5; maximumBytes += 1) {
          let sourceOffset = 0;
          const source = createShebangStrippedShellSource({
            source: {
              kind: 'bytes',
              async read({ maximumBytes: requestedMaximumBytes }: {
                maximumBytes: number,
              }): Promise<Uint8Array | undefined> {
                if (sourceOffset >= bytes.length) return undefined;
                const length = Math.min(sourceChunkSize, requestedMaximumBytes, bytes.length - sourceOffset);
                const chunk = bytes.subarray(sourceOffset, sourceOffset + length);
                sourceOffset += length;
                return chunk;
              },
            },
          });
          if (source.kind !== 'bytes') throw new Error('Expected byte-backed stripped source');

          const output: number[] = [];
          while (true) {
            const chunk = await source.read({ maximumBytes });
            if (chunk === undefined) break;
            expect(chunk.length).toBeLessThanOrEqual(maximumBytes);
            output.push(...chunk);
          }
          expect(output).toEqual([...expected]);
        }
      }
    }
  });

});
