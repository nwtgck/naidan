import {
  analyzeArgvLongForm,
  analyzeArgvShortForm,
  defineArgvCatalog,
  defineArgvHelpPresentation,
  formatArgvOptionHelp,
  formatArgvUsageSummary,
  parseStandardArgv,
  type StandardArgvAction,
  type StandardArgvPolicy,
} from '@/features/wesh/argv';
import { openCommandInputStream } from '@/features/wesh/commands/_shared/binary-input';
import { stripLeadingCLocaleWhitespace } from '@/features/wesh/commands/_shared/numeric-whitespace';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage-output';
import type {
  WeshCommandContext,
  WeshCommandImplementation,
  WeshCommandResult,
  WeshFileHandle,
} from '@/features/wesh/types';
import { iterateReadableStreamChunks } from '@/features/wesh/utils/stream';

type StringsRadix = 'octal' | 'decimal' | 'hex';
type StringsEncoding = 'seven-bit' | 'eight-bit' | 'big16' | 'little16' | 'big32' | 'little32';

const OUTPUT_BUFFER_SIZE = 16 * 1024;
const RUN_FRAGMENT_SIZE = 8 * 1024;

function parseMinimumLength({
  rawValue,
}: {
  rawValue: string,
}): { kind: 'parsed', value: number } | { kind: 'invalid', message: string } {
  const numericText = stripLeadingCLocaleWhitespace({ value: rawValue });
  if (!/^\+?[1-9]\d*$/u.test(numericText)) {
    return { kind: 'invalid', message: `invalid minimum string length: '${rawValue}'` };
  }

  const parsed = Number(numericText);
  if (!Number.isSafeInteger(parsed)) {
    return { kind: 'invalid', message: `minimum string length is too big: ${rawValue}` };
  }

  return { kind: 'parsed', value: parsed };
}

function parseRadix({
  rawValue,
}: {
  rawValue: string,
}): { kind: 'parsed', value: StringsRadix } | { kind: 'invalid', message: string } {
  switch (rawValue) {
  case 'o':
  case 'octal':
    return { kind: 'parsed', value: 'octal' };
  case 'd':
  case 'decimal':
    return { kind: 'parsed', value: 'decimal' };
  case 'x':
  case 'hex':
    return { kind: 'parsed', value: 'hex' };
  default:
    return { kind: 'invalid', message: `invalid radix: '${rawValue}'` };
  }
}

function parseEncoding({
  value,
}: {
  value: string | undefined,
}): { ok: true, value: StringsEncoding } | { ok: false, message: string } {
  switch (value) {
  case undefined:
  case 's':
    return { ok: true, value: 'seven-bit' };
  case 'S':
    return { ok: true, value: 'eight-bit' };
  case 'b':
    return { ok: true, value: 'big16' };
  case 'l':
    return { ok: true, value: 'little16' };
  case 'B':
    return { ok: true, value: 'big32' };
  case 'L':
    return { ok: true, value: 'little32' };
  default:
    return { ok: false, message: `invalid encoding: '${value}'` };
  }
}

function getEncodingWidth({
  encoding,
}: {
  encoding: StringsEncoding,
}): number {
  switch (encoding) {
  case 'seven-bit':
  case 'eight-bit':
    return 1;
  case 'big16':
  case 'little16':
    return 2;
  case 'big32':
  case 'little32':
    return 4;
  default: {
    const _ex: never = encoding;
    throw new Error(`Unhandled strings encoding: ${_ex}`);
  }
  }
}

function decodeCodeUnit({
  bytes,
  offset,
  encoding,
}: {
  bytes: Uint8Array,
  offset: number,
  encoding: StringsEncoding,
}): number {
  switch (encoding) {
  case 'seven-bit':
  case 'eight-bit':
    return bytes[offset]!;
  case 'big16':
    return (bytes[offset]! << 8) | bytes[offset + 1]!;
  case 'little16':
    return bytes[offset]! | (bytes[offset + 1]! << 8);
  case 'big32':
    return (
      bytes[offset]! * 0x1000000
      + (bytes[offset + 1]! << 16)
      + (bytes[offset + 2]! << 8)
      + bytes[offset + 3]!
    );
  case 'little32':
    return (
      bytes[offset]!
      + (bytes[offset + 1]! << 8)
      + (bytes[offset + 2]! << 16)
      + bytes[offset + 3]! * 0x1000000
    );
  default: {
    const _ex: never = encoding;
    throw new Error(`Unhandled strings encoding: ${_ex}`);
  }
  }
}

function isPrintableCodeUnit({
  codeUnit,
  encoding,
  includeAllWhitespace,
}: {
  codeUnit: number,
  encoding: StringsEncoding,
  includeAllWhitespace: boolean,
}): boolean {
  if (codeUnit === 0x09 || (codeUnit >= 0x20 && codeUnit <= 0x7e)) {
    return true;
  }

  if (encoding === 'eight-bit' && codeUnit >= 0x80 && codeUnit <= 0xff) {
    return true;
  }

  if (!includeAllWhitespace) {
    return false;
  }

  switch (codeUnit) {
  case 0x09:
  case 0x0a:
  case 0x0b:
  case 0x0c:
  case 0x0d:
    return true;
  default:
    return false;
  }
}

function formatOffset({
  offset,
  radix,
}: {
  offset: number,
  radix: StringsRadix,
}): string {
  switch (radix) {
  case 'octal':
    return offset.toString(8).padStart(7, ' ');
  case 'decimal':
    return offset.toString(10).padStart(7, ' ');
  case 'hex':
    return offset.toString(16).padStart(7, ' ');
  default: {
    const _ex: never = radix;
    throw new Error(`Unhandled strings radix: ${_ex}`);
  }
  }
}

async function writeAll({
  handle,
  bytes,
}: {
  handle: WeshFileHandle,
  bytes: Uint8Array,
}): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write({
      buffer: bytes,
      offset,
      length: bytes.byteLength - offset,
    });
    if (bytesWritten === 0) {
      throw new Error('short write');
    }
    offset += bytesWritten;
  }
}

function createBufferedByteWriter({
  handle,
}: {
  handle: WeshFileHandle,
}) {
  const buffer = new Uint8Array(OUTPUT_BUFFER_SIZE);
  let length = 0;

  const flush = async (): Promise<void> => {
    if (length === 0) {
      return;
    }
    await writeAll({ handle, bytes: buffer.subarray(0, length) });
    length = 0;
  };

  return {
    async write({ bytes }: { bytes: Uint8Array }): Promise<void> {
      let offset = 0;
      while (offset < bytes.byteLength) {
        if (length === buffer.byteLength) {
          await flush();
        }

        if (length === 0 && bytes.byteLength - offset >= buffer.byteLength) {
          await writeAll({ handle, bytes: bytes.subarray(offset) });
          return;
        }

        const writableLength = Math.min(
          buffer.byteLength - length,
          bytes.byteLength - offset,
        );
        buffer.set(bytes.subarray(offset, offset + writableLength), length);
        length += writableLength;
        offset += writableLength;
      }
    },
    flush,
  };
}

function createRunAccumulator() {
  let current = new Uint8Array(RUN_FRAGMENT_SIZE);
  let currentLength = 0;
  let fragments: Uint8Array[] = [];
  let characterLength = 0;

  return {
    append({ byte }: { byte: number }): void {
      if (currentLength === current.byteLength) {
        fragments.push(current);
        current = new Uint8Array(RUN_FRAGMENT_SIZE);
        currentLength = 0;
      }
      current[currentLength] = byte;
      currentLength += 1;
      characterLength += 1;
    },
    getCharacterLength(): number {
      return characterLength;
    },
    takeFragments(): Uint8Array[] {
      const result = currentLength === 0
        ? fragments
        : [...fragments, current.subarray(0, currentLength)];
      current = new Uint8Array(RUN_FRAGMENT_SIZE);
      currentLength = 0;
      fragments = [];
      characterLength = 0;
      return result;
    },
    reset(): void {
      currentLength = 0;
      fragments = [];
      characterLength = 0;
    },
  };
}

const stringsOptions = [
  {
    semantic: { kind: 'effects', effects: [] },
    forms: [
      { kind: 'short', name: 'a', value: { kind: 'none' } },
      { kind: 'long', name: 'all', value: { kind: 'none' } },
    ],
    summary: 'scan the entire file',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'printFileName', value: true }] },
    forms: [
      { kind: 'short', name: 'f', value: { kind: 'none' } },
      { kind: 'long', name: 'print-file-name', value: { kind: 'none' } },
    ],
    summary: 'print the file name before each string',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
    forms: [
      { kind: 'short', name: 'h', value: { kind: 'none' } },
      { kind: 'long', name: 'help', value: { kind: 'none' } },
    ],
    summary: 'display this help and exit',
    category: 'common',
  },
  {
    semantic: { kind: 'required-value', key: 'minimumLength', parse: parseMinimumLength },
    forms: [
      { kind: 'short', name: 'n', value: { kind: 'required-attached-or-following', missingValueName: 'number' } },
      { kind: 'long', name: 'bytes', value: { kind: 'required', missingValueName: 'number' } },
    ],
    summary: 'print sequences of at least NUMBER displayable characters',
    valueName: 'NUMBER',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'radix', value: 'octal' }] },
    forms: [{ kind: 'short', name: 'o', value: { kind: 'none' } }],
    summary: 'same as -t o',
    category: 'common',
  },
  {
    semantic: { kind: 'required-value', key: 'separator', parse: undefined },
    forms: [
      { kind: 'short', name: 's', value: { kind: 'required-attached-or-following', missingValueName: 'string' } },
      { kind: 'long', name: 'output-separator', value: { kind: 'required', missingValueName: 'string' } },
    ],
    summary: 'set the output separator',
    valueName: 'STRING',
    category: 'advanced',
  },
  {
    semantic: { kind: 'required-value', key: 'radix', parse: parseRadix },
    forms: [
      { kind: 'short', name: 't', value: { kind: 'required-attached-or-following', missingValueName: 'radix' } },
      { kind: 'long', name: 'radix', value: { kind: 'required', missingValueName: 'radix' } },
    ],
    summary: 'print the location of each string',
    valueName: '{o,d,x}',
    category: 'common',
  },
  {
    semantic: { kind: 'required-value', key: 'encoding', parse: undefined },
    forms: [
      { kind: 'short', name: 'e', value: { kind: 'required-attached-or-following', missingValueName: '{s,S,b,l,B,L}' } },
      { kind: 'long', name: 'encoding', value: { kind: 'required', missingValueName: '{s,S,b,l,B,L}' } },
    ],
    summary: 'select character size and endianness',
    valueName: '{s,S,b,l,B,L}',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'includeAllWhitespace', value: true }] },
    forms: [
      { kind: 'short', name: 'w', value: { kind: 'none' } },
      { kind: 'long', name: 'include-all-whitespace', value: { kind: 'none' } },
    ],
    summary: 'treat all whitespace as printable',
    category: 'advanced',
  },
] as const;

const stringsArgvCatalog = defineArgvCatalog<StandardArgvAction<never>>({
  definitions: stringsOptions,
  nonExecutableLongOptions: [],
});
const stringsArgvHelp = defineArgvHelpPresentation({ catalog: stringsArgvCatalog, rows: stringsOptions });
const stringsArgvPolicy: StandardArgvPolicy = {
  longNameMatch: 'exact',
  optionBoundary: 'continue',
  occurrenceRetention: 'none',
};

// Normalize obsolete minimum lengths and stop at help, including help within
// a short option bundle. Required values and tokens after -- are left intact.
function normalizeStringsArgs({ args }: { args: readonly string[] }): readonly string[] {
  const normalized: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === '--') {
      return normalized.concat(args.slice(index));
    }
    if (/^-[1-9]\d*$/u.test(token)) {
      normalized.push(`-n${token.slice(1)}`);
      continue;
    }
    if (token === '--help') {
      normalized.push(token);
      break;
    }

    let claimsFollowingValue = false;
    if (token.startsWith('--')) {
      const option = analyzeArgvLongForm({ token, catalog: stringsArgvCatalog, longNameMatch: stringsArgvPolicy.longNameMatch });
      claimsFollowingValue = option.kind === 'matched' && option.value.kind === 'following-required';
    } else if (token.startsWith('-')) {
      let offset = 1;
      while (offset < token.length) {
        const option = analyzeArgvShortForm({ token, bodyOffset: offset, prefix: '-', catalog: stringsArgvCatalog });
        switch (option.kind) {
        case 'unknown':
          offset = token.length;
          break;
        case 'matched':
          offset = option.nextBodyOffset;
          if (option.option === '-h') {
            normalized.push(token.slice(0, offset));
            return normalized;
          }
          claimsFollowingValue = option.value.kind === 'following-required';
          break;
        default: {
          const _ex: never = option;
          throw new Error(`Unhandled strings option: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
        }
        }
      }
    }

    normalized.push(token);
    const following = args[index + 1];
    if (claimsFollowingValue && following !== undefined) {
      normalized.push(following);
      index += 1;
    }
  }
  return normalized;
}

export const stringsCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: normalizeStringsArgs({ args: context.args }),
      catalog: stringsArgvCatalog,
      policy: stringsArgvPolicy,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      const message = `strings: ${diagnostic.message}`;
      switch (diagnostic.kind) {
      case 'invalid_option_value':
        await context.text().error({ text: `${message}\n` });
        break;
      case 'unknown_short_option':
      case 'unknown_long_option':
      case 'ambiguous_long_option':
      case 'missing_option_value':
      case 'unexpected_option_value':
        await writeCommandUsageError({
          context,
          command: 'strings',
          message,
          usageSummary: formatArgvUsageSummary({ presentation: stringsArgvHelp }),
        });
        break;
      default: {
        const _ex: never = diagnostic;
        throw new Error(`Unhandled strings diagnostic: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
      }
      }
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'strings',
        optionLines: formatArgvOptionHelp({ presentation: stringsArgvHelp }),
      });
      return { exitCode: 0 };
    }

    // Binutils validates only the final encoding, after handling help.
    const encodingParsed = parseEncoding({
      value: parsed.optionValues.encoding as string | undefined,
    });
    if (!encodingParsed.ok) {
      await context.text().error({ text: `strings: ${encodingParsed.message}\n` });
      return { exitCode: 1 };
    }

    if (parsed.positionals.includes('-')) {
      await writeCommandUsageError({
        context,
        command: 'strings',
        message: "strings: invalid option -- '-'",
        usageSummary: formatArgvUsageSummary({ presentation: stringsArgvHelp }),
      });
      return { exitCode: 1 };
    }

    const inputs = parsed.positionals.length === 0 ? ['-'] : parsed.positionals;
    const minimumLength = typeof parsed.optionValues.minimumLength === 'number' ? parsed.optionValues.minimumLength : 4;
    const radixValue = parsed.optionValues.radix as StringsRadix | undefined;
    const radix = radixValue === undefined ? { kind: 'unset' } as const : { kind: 'set', value: radixValue } as const;
    const encoder = new TextEncoder();
    const separatorBytes = encoder.encode((parsed.optionValues.separator as string | undefined) ?? '\n');
    const writer = createBufferedByteWriter({ handle: context.stdout });
    const encodingWidth = getEncodingWidth({ encoding: encodingParsed.value });
    let exitCode = 0;

    try {
      for (const input of inputs) {
        try {
          let pending = new Uint8Array(0);
          let totalBytesReceived = 0;
          let runOffset = 0;
          const run = createRunAccumulator();

          const flushRun = async (): Promise<void> => {
            const runLength = run.getCharacterLength();
            if (runLength === 0) {
              return;
            }
            if (runLength < minimumLength) {
              run.reset();
              return;
            }

            let prefix = '';
            if (parsed.optionValues.printFileName === true) {
              prefix += `${input === '-' ? '(standard input)' : input}:`;
            }
            switch (radix.kind) {
            case 'set':
              prefix += `${prefix.length > 0 ? ' ' : ''}${formatOffset({ offset: runOffset, radix: radix.value })}`;
              break;
            case 'unset':
              break;
            default: {
              const _ex: never = radix;
              throw new Error(`Unhandled strings radix state during output: ${_ex}`);
            }
            }
            if (prefix.length > 0) {
              prefix += ' ';
              await writer.write({ bytes: encoder.encode(prefix) });
            }
            for (const fragment of run.takeFragments()) {
              await writer.write({ bytes: fragment });
            }
            await writer.write({ bytes: separatorBytes });
          };

          for await (const chunk of iterateReadableStreamChunks({
            stream: await openCommandInputStream({ context, input }),
          })) {
            const combinedStartOffset = totalBytesReceived - pending.byteLength;
            totalBytesReceived += chunk.byteLength;
            const bytes = pending.byteLength === 0
              ? chunk
              : (() => {
                const combined = new Uint8Array(pending.byteLength + chunk.byteLength);
                combined.set(pending);
                combined.set(chunk, pending.byteLength);
                return combined;
              })();
            let offset = 0;
            while (offset + encodingWidth <= bytes.byteLength) {
              const codeUnit = decodeCodeUnit({
                bytes,
                offset,
                encoding: encodingParsed.value,
              });
              if (isPrintableCodeUnit({
                codeUnit,
                encoding: encodingParsed.value,
                includeAllWhitespace: parsed.optionValues.includeAllWhitespace === true,
              })) {
                if (run.getCharacterLength() === 0) {
                  runOffset = combinedStartOffset + offset;
                }
                run.append({ byte: codeUnit & 0xff });
                offset += encodingWidth;
                continue;
              }

              if (run.getCharacterLength() > 0) {
                await flushRun();
              }
              // GNU strings searches for the next wide-character run at every
              // byte boundary. Advancing by the whole encoding width here
              // misses valid unaligned UTF-16/UTF-32 strings after arbitrary
              // binary data.
              offset += 1;
            }

            pending = bytes.slice(offset);
          }

          await flushRun();
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          await context.text().error({ text: `strings: ${input}: ${message}\n` });
          exitCode = 1;
        }
      }
    } finally {
      await writer.flush();
    }

    return { exitCode };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
