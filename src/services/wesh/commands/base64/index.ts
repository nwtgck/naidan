import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import { readCommandInputAsBytes } from '@/services/wesh/commands/_shared/binary-input';
import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/services/wesh/types';

function parseWrap({
  value,
}: {
  value: string;
}): { ok: true; value: number } | { ok: false; message: string } {
  if (!/^\d+$/u.test(value)) {
    return { ok: false, message: `invalid wrap size: '${value}'` };
  }

  return { ok: true, value: Number.parseInt(value, 10) };
}

function encodeBytesToBase64({
  bytes,
}: {
  bytes: Uint8Array;
}): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function wrapBase64({
  value,
  wrap,
}: {
  value: string;
  wrap: number;
}): string {
  if (wrap === 0) {
    return `${value}\n`;
  }

  let output = '';
  for (let index = 0; index < value.length; index += wrap) {
    output += `${value.slice(index, index + wrap)}\n`;
  }
  return output;
}

function decodeBase64ToBytes({
  value,
}: {
  value: string;
}): Uint8Array {
  const sanitized = value.replace(/\s+/gu, '');
  if (sanitized.length === 0) {
    return new Uint8Array(0);
  }

  if (sanitized.length % 4 === 1) {
    throw new Error('invalid input');
  }

  let binary: string;
  try {
    binary = atob(sanitized);
  } catch {
    throw new Error('invalid input');
  }

  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function writeBytes({
  handle,
  bytes,
}: {
  handle: WeshCommandContext['stdout'];
  bytes: Uint8Array;
}): Promise<void> {
  let written = 0;
  while (written < bytes.length) {
    const { bytesWritten } = await handle.write({
      buffer: bytes,
      offset: written,
      length: bytes.length - written,
    });
    if (bytesWritten === 0) {
      break;
    }
    written += bytesWritten;
  }
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
        const bytes = await readCommandInputAsBytes({
          context,
          input,
        });

        if (parsed.optionValues.decode === true) {
          const decoded = decodeBase64ToBytes({
            value: new TextDecoder().decode(bytes),
          });
          await writeBytes({
            handle: context.stdout,
            bytes: decoded,
          });
          continue;
        }

        await context.text().print({
          text: wrapBase64({
            value: encodeBytesToBase64({ bytes }),
            wrap,
          }),
        });
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
