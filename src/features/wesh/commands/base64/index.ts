import { stripLeadingCLocaleWhitespace } from '@/features/wesh/commands/_shared/numeric-whitespace';
import { defineArgvCatalog, defineArgvHelpPresentation, formatArgvOptionHelp, formatArgvUsageSummary, HELP_EARLY_EXIT_OPTIONS, parseStandardArgv, stopArgvAtFirstEarlyExit, type ArgvOptionDefinition, type StandardArgvAction, type StandardArgvPolicy } from '@/features/wesh/argv-v2';
import { openCommandInputStream } from '@/features/wesh/commands/_shared/binary-input';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage-output';
import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/features/wesh/types';
import { writeAllBytesToHandle } from '@/features/wesh/utils/fs';
import { createBufferedTextWriter } from '@/features/wesh/utils/io';
import { iterateReadableStreamChunks } from '@/features/wesh/utils/stream';

function parseWrap({
  value,
}: {
  value: string,
}): { ok: true, value: number } | { ok: false, message: string } {
  const numericText = stripLeadingCLocaleWhitespace({ value });
  const match = /^\+?(\d+)$/u.exec(numericText);
  if (match === null) {
    return { ok: false, message: `invalid wrap size: '${value}'` };
  }

  const parsed = BigInt(match[1]!);
  return {
    ok: true,
    value: parsed > BigInt(Number.MAX_SAFE_INTEGER)
      ? Number.MAX_SAFE_INTEGER
      : Number(parsed),
  };
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

    if (wrap !== 0 && wroteEncodedData && column > 0) {
      await writer.write({ text: '\n' });
    }
  } finally {
    await writer.flush();
  }
}

function decodeBase64Value({
  byte,
}: {
  byte: number,
}): number | undefined {
  if (byte >= 0x41 && byte <= 0x5a) return byte - 0x41;
  if (byte >= 0x61 && byte <= 0x7a) return byte - 0x61 + 26;
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30 + 52;
  if (byte === 0x2b) return 62;
  if (byte === 0x2f) return 63;
  return undefined;
}

async function decodeStream({
  context,
  input,
  ignoreGarbage,
}: {
  context: WeshCommandContext,
  input: string | undefined,
  ignoreGarbage: boolean,
}): Promise<void> {
  const output = new Uint8Array(32 * 1024);
  let outputLength = 0;
  let quantumLength: 0 | 1 | 2 | 3 = 0;
  let first = 0;
  let second = 0;
  let third = 0;
  let requiresSecondPadding = false;

  const flush = async (): Promise<void> => {
    if (outputLength === 0) return;
    await writeAllBytesToHandle({
      handle: context.stdout,
      data: output.subarray(0, outputLength),
    });
    outputLength = 0;
  };

  const appendDecodedByte = async ({
    byte,
  }: {
    byte: number,
  }): Promise<void> => {
    if (outputLength === output.byteLength) await flush();
    output[outputLength] = byte;
    outputLength += 1;
  };

  const failInvalidInput = async (): Promise<never> => {
    await flush();
    throw new Error('invalid input');
  };

  for await (const chunk of iterateReadableStreamChunks({
    stream: await openCommandInputStream({ context, input }),
  })) {
    for (const byte of chunk) {
      if (byte === 0x0a) continue;

      const value = decodeBase64Value({ byte });
      if (value !== undefined) {
        if (requiresSecondPadding) await failInvalidInput();

        switch (quantumLength) {
        case 0:
          first = value;
          quantumLength = 1;
          break;
        case 1:
          second = value;
          await appendDecodedByte({ byte: (first << 2) | (second >> 4) });
          quantumLength = 2;
          break;
        case 2:
          third = value;
          await appendDecodedByte({ byte: ((second & 0x0f) << 4) | (third >> 2) });
          quantumLength = 3;
          break;
        case 3:
          await appendDecodedByte({ byte: ((third & 0x03) << 6) | value });
          quantumLength = 0;
          break;
        default: {
          const _ex: never = quantumLength;
          throw new Error(`Unhandled base64 quantum length: ${_ex}`);
        }
        }
        continue;
      }

      if (byte === 0x3d) {
        if (requiresSecondPadding) {
          requiresSecondPadding = false;
          quantumLength = 0;
          continue;
        }
        if (quantumLength === 2) {
          if ((second & 0x0f) !== 0) await failInvalidInput();
          requiresSecondPadding = true;
          continue;
        }
        if (quantumLength === 3) {
          if ((third & 0x03) !== 0) await failInvalidInput();
          quantumLength = 0;
          continue;
        }
        await failInvalidInput();
      }

      if (!ignoreGarbage) await failInvalidInput();
    }
  }

  if (requiresSecondPadding || quantumLength === 1) await failInvalidInput();
  if (quantumLength === 2 && (second & 0x0f) !== 0) await failInvalidInput();
  if (quantumLength === 3 && (third & 0x03) !== 0) await failInvalidInput();
  await flush();
}

const base64DecodeOption = {
  semantic: { kind: 'effects', effects: [{ key: 'decode', value: true }] },
  forms: [
    { kind: 'short', name: 'd', value: { kind: 'none' } },
    { kind: 'long', name: 'decode', value: { kind: 'none' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<never>>;
const base64IgnoreGarbageOption = {
  semantic: { kind: 'effects', effects: [{ key: 'ignoreGarbage', value: true }] },
  forms: [
    { kind: 'short', name: 'i', value: { kind: 'none' } },
    { kind: 'long', name: 'ignore-garbage', value: { kind: 'none' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<never>>;
const base64WrapOption = {
  semantic: {
    kind: 'required-value',
    key: 'wrap',
    parse: ({ rawValue }: { rawValue: string }) => {
      const parsed = parseWrap({ value: rawValue });
      return parsed.ok
        ? { kind: 'parsed' as const, value: parsed.value }
        : { kind: 'invalid' as const, message: parsed.message };
    },
  },
  forms: [
    { kind: 'short', name: 'w', value: { kind: 'required-attached-or-following', missingValueName: 'cols' } },
    { kind: 'long', name: 'wrap', value: { kind: 'required', missingValueName: 'cols' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<never>>;
const base64HelpOption = {
  semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
  forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<never>>;

const base64ArgvCatalog = defineArgvCatalog<StandardArgvAction<never>>({
  nonExecutableLongOptions: ['version'],
  definitions: [base64DecodeOption, base64IgnoreGarbageOption, base64WrapOption, base64HelpOption],
});
const base64ArgvHelp = defineArgvHelpPresentation({
  catalog: base64ArgvCatalog,
  rows: [
    { forms: base64DecodeOption.forms, summary: 'decode data', category: 'common' },
    { forms: base64IgnoreGarbageOption.forms, summary: 'when decoding, ignore non-alphabet characters', category: 'common' },
    { forms: base64WrapOption.forms, summary: 'wrap encoded lines after COLS character (default 76)', valueName: 'COLS', category: 'common' },
    { forms: base64HelpOption.forms, summary: 'display this help and exit', category: 'common' },
  ],
});

const base64ArgvPolicy: StandardArgvPolicy = {
  longNameMatch: 'unique-prefix',
  optionBoundary: 'continue',
  occurrenceRetention: 'none',
};

export const base64CommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'base64',
    description: 'Base64 encode or decode data',
    usage: 'base64 [OPTION]... [FILE]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: stopArgvAtFirstEarlyExit({ args: context.args, catalog: base64ArgvCatalog, policy: base64ArgvPolicy, earlyExitOptions: HELP_EARLY_EXIT_OPTIONS }),
      catalog: base64ArgvCatalog,
      policy: base64ArgvPolicy,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'base64',
        message: `base64: ${diagnostic.message}`,
        usageSummary: formatArgvUsageSummary({ presentation: base64ArgvHelp }),
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'base64',
        optionLines: formatArgvOptionHelp({ presentation: base64ArgvHelp }),
      });
      return { exitCode: 0 };
    }

    if (parsed.positionals.length > 1) {
      await writeCommandUsageError({
        context,
        command: 'base64',
        message: `base64: extra operand '${parsed.positionals[1] ?? ''}'`,
        usageSummary: formatArgvUsageSummary({ presentation: base64ArgvHelp }),
      });
      return { exitCode: 1 };
    }

    const wrap = typeof parsed.optionValues.wrap === 'number' ? parsed.optionValues.wrap : 76;
    const input = parsed.positionals[0] ?? '-';
    try {
      if (parsed.optionValues.decode === true) {
        await decodeStream({
          context,
          input,
          ignoreGarbage: parsed.optionValues.ignoreGarbage === true,
        });
      } else {
        await encodeStream({ context, input, wrap });
      }
      return { exitCode: 0 };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await context.text().error({
        text: message === 'invalid input'
          ? 'base64: invalid input\n'
          : `base64: ${input === '-' ? 'standard input' : input}: ${message}\n`,
      });
      return { exitCode: 1 };
    }
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
