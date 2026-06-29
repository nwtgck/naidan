import { parseStandardArgv, type StandardArgvParserSpec } from '@/features/wesh/argv';
import { openCommandInputStream } from '@/features/wesh/commands/_shared/binary-input';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/features/wesh/types';
import { writeAllBytesToHandle } from '@/features/wesh/utils/fs';
import { createBufferedTextWriter } from '@/features/wesh/utils/io';
import { iterateReadableStreamChunks } from '@/features/wesh/utils/stream';

function parseWrap({
  value,
}: {
  value: string,
}): { ok: true, value: number } | { ok: false, message: string } {
  if (!/^\d+$/u.test(value)) {
    return { ok: false, message: `invalid wrap size: '${value}'` };
  }

  return { ok: true, value: Number.parseInt(value, 10) };
}

function encodeBytesToBase64({
  bytes,
}: {
  bytes: Uint8Array,
}): string {
  const parts: string[] = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
  }
  return btoa(parts.join(''));
}

async function writeWrappedBase64({
  writer,
  value,
  wrap,
  column,
}: {
  writer: ReturnType<typeof createBufferedTextWriter>,
  value: string,
  wrap: number,
  column: number,
}): Promise<number> {
  if (wrap === 0) {
    await writer.write({ text: value });
    return column + value.length;
  }

  let currentColumn = column;
  let offset = 0;
  while (offset < value.length) {
    const available = wrap - currentColumn;
    const length = Math.min(available, value.length - offset);
    await writer.write({
      text: value.slice(offset, offset + length),
    });
    offset += length;
    currentColumn += length;
    if (currentColumn === wrap) {
      await writer.write({ text: '\n' });
      currentColumn = 0;
    }
  }
  return currentColumn;
}

async function encodeStream({
  context,
  input,
  wrap,
}: {
  context: WeshCommandContext,
  input: string | undefined,
  wrap: number,
}): Promise<void> {
  const writer = createBufferedTextWriter({
    handle: context.stdout,
    maxBufferLength: 16 * 1024,
  });
  let carry = new Uint8Array(0);
  let column = 0;
  let wroteEncodedData = false;

  try {
    for await (const chunk of iterateReadableStreamChunks({
      stream: await openCommandInputStream({ context, input }),
    })) {
      const combined = carry.byteLength === 0
        ? chunk
        : (() => {
          const value = new Uint8Array(carry.byteLength + chunk.byteLength);
          value.set(carry);
          value.set(chunk, carry.byteLength);
          return value;
        })();
      const completeLength = combined.byteLength - (combined.byteLength % 3);
      if (completeLength > 0) {
        column = await writeWrappedBase64({
          writer,
          value: encodeBytesToBase64({
            bytes: combined.subarray(0, completeLength),
          }),
          wrap,
          column,
        });
        wroteEncodedData = true;
      }
      carry = new Uint8Array(combined.subarray(completeLength));
    }

    if (carry.byteLength > 0) {
      column = await writeWrappedBase64({
        writer,
        value: encodeBytesToBase64({ bytes: carry }),
        wrap,
        column,
      });
      wroteEncodedData = true;
    }

    if (wrap === 0) {
      await writer.write({ text: '\n' });
    } else if (wroteEncodedData && column > 0) {
      await writer.write({ text: '\n' });
    }
  } finally {
    await writer.flush();
  }
}

function isBase64Whitespace({
  byte,
}: {
  byte: number,
}): boolean {
  switch (byte) {
  case 0x09:
  case 0x0a:
  case 0x0b:
  case 0x0c:
  case 0x0d:
  case 0x20:
    return true;
  default:
    return false;
  }
}

function isBase64Byte({
  byte,
}: {
  byte: number,
}): boolean {
  return (byte >= 0x41 && byte <= 0x5a)
    || (byte >= 0x61 && byte <= 0x7a)
    || (byte >= 0x30 && byte <= 0x39)
    || byte === 0x2b
    || byte === 0x2f
    || byte === 0x3d;
}

function decodeBase64Group({
  value,
}: {
  value: string,
}): Uint8Array {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error('invalid input');
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function decodeStream({
  context,
  input,
}: {
  context: WeshCommandContext,
  input: string | undefined,
}): Promise<void> {
  let group = '';
  let finished = false;
  const output = new Uint8Array(32 * 1024);
  let outputLength = 0;

  const flush = async (): Promise<void> => {
    if (outputLength === 0) {
      return;
    }
    await writeAllBytesToHandle({
      handle: context.stdout,
      data: output.subarray(0, outputLength),
    });
    outputLength = 0;
  };

  const appendDecoded = async ({
    value,
  }: {
    value: Uint8Array,
  }): Promise<void> => {
    if (outputLength + value.byteLength > output.byteLength) {
      await flush();
    }
    output.set(value, outputLength);
    outputLength += value.byteLength;
  };

  for await (const chunk of iterateReadableStreamChunks({
    stream: await openCommandInputStream({ context, input }),
  })) {
    for (const byte of chunk) {
      if (isBase64Whitespace({ byte })) {
        continue;
      }
      if (finished || !isBase64Byte({ byte })) {
        throw new Error('invalid input');
      }
      group += String.fromCharCode(byte);
      if (group.length < 4) {
        continue;
      }
      await appendDecoded({
        value: decodeBase64Group({ value: group }),
      });
      if (group.includes('=')) {
        finished = true;
      }
      group = '';
    }
  }

  if (group.length === 1) {
    throw new Error('invalid input');
  }
  if (group.length > 0) {
    await appendDecoded({
      value: decodeBase64Group({ value: group }),
    });
  }
  await flush();
}

const base64ArgvSpec: StandardArgvParserSpec = {
  options: [
    {
      kind: 'flag',
      short: 'd',
      long: 'decode',
      effects: [{ key: 'decode', value: true }],
      help: { summary: 'decode data', category: 'common' },
    },
    {
      kind: 'value',
      short: 'w',
      long: 'wrap',
      key: 'wrap',
      valueName: 'cols',
      allowAttachedValue: true,
      parseValue: ({ value }) => parseWrap({ value }),
      help: { summary: 'wrap encoded lines after COLS character (default 76)', valueName: 'COLS', category: 'common' },
    },
    {
      kind: 'flag',
      short: undefined,
      long: 'help',
      effects: [{ key: 'help', value: true }],
      help: { summary: 'display this help and exit', category: 'common' },
    },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

export const base64CommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'base64',
    description: 'Base64 encode or decode data',
    usage: 'base64 [OPTION]... [FILE]...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: base64ArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'base64',
        message: `base64: ${diagnostic.message}`,
        argvSpec: base64ArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'base64',
        argvSpec: base64ArgvSpec,
      });
      return { exitCode: 0 };
    }

    const wrap = typeof parsed.optionValues.wrap === 'number' ? parsed.optionValues.wrap : 76;
    const inputs = parsed.positionals.length === 0 ? ['-'] : parsed.positionals;
    let exitCode = 0;

    for (const input of inputs) {
      try {
        if (parsed.optionValues.decode === true) {
          await decodeStream({ context, input });
        } else {
          await encodeStream({ context, input, wrap });
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        await context.text().error({
          text: `base64: ${input === '-' ? 'standard input' : input}: ${message}\n`,
        });
        exitCode = 1;
      }
    }

    return { exitCode };
  },
};
