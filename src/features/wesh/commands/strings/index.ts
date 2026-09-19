import { stripLeadingCLocaleWhitespace } from '@/features/wesh/commands/_shared/numeric-whitespace';
import { parseStandardArgv, type StandardArgvParserSpec } from '@/features/wesh/argv';
import { openCommandInputStream } from '@/features/wesh/commands/_shared/binary-input';
import { findFirstStandardSemanticIssue, standardSemanticIssuePrecedesDiagnostic, stopStandardArgvAtFirstEarlyExit } from '@/features/wesh/commands/_shared/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
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
  value,
}: {
  value: string,
}): { ok: true, value: number } | { ok: false, message: string } {
  const numericText = stripLeadingCLocaleWhitespace({ value });
  if (!/^\+?[1-9]\d*$/u.test(numericText)) {
    return { ok: false, message: `invalid minimum string length: '${value}'` };
  }

  const parsed = Number(numericText);
  if (!Number.isSafeInteger(parsed)) {
    return { ok: false, message: `minimum string length is too big: ${value}` };
  }

  return { ok: true, value: parsed };
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
    if (length === 0) return;
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

const STRINGS_HELP_EARLY_EXIT_OPTIONS = [
  { token: '-h', optionKey: 'help' },
  { token: '--help', optionKey: 'help' },
] as const;

const stringsArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: 'a', long: 'all', effects: [], help: { summary: 'scan the entire file', category: 'common' } },
    { kind: 'flag', short: 'f', long: 'print-file-name', effects: [{ key: 'printFileName', value: true }], help: { summary: 'print the file name before each string', category: 'common' } },
    { kind: 'flag', short: 'h', long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
    { kind: 'value', short: 'n', long: 'bytes', key: 'minimumLength', valueName: 'number', allowAttachedValue: true, parseValue: undefined, help: { summary: 'print sequences of at least NUMBER displayable characters', valueName: 'NUMBER', category: 'common' } },
    { kind: 'flag', short: 'o', long: undefined, effects: [{ key: 'radix', value: 'octal' }], help: { summary: 'same as -t o', category: 'common' } },
    { kind: 'value', short: 's', long: 'output-separator', key: 'separator', valueName: 'string', allowAttachedValue: true, parseValue: undefined, help: { summary: 'set the output separator', valueName: 'STRING', category: 'advanced' } },
    { kind: 'value', short: 't', long: 'radix', key: 'radix', valueName: 'radix', allowAttachedValue: true, parseValue: undefined, help: { summary: 'print the location of each string', valueName: '{o,d,x}', category: 'common' } },
    { kind: 'value', short: 'e', long: 'encoding', key: 'encoding', valueName: '{s,S,b,l,B,L}', allowAttachedValue: true, parseValue: undefined, help: { summary: 'select character size and endianness', valueName: '{s,S,b,l,B,L}', category: 'common' } },
    { kind: 'flag', short: 'w', long: 'include-all-whitespace', effects: [{ key: 'includeAllWhitespace', value: true }], help: { summary: 'treat all whitespace as printable', category: 'advanced' } },
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [
    ({ token }) => {
      if (!/^-[1-9]\d*$/u.test(token)) {
        return undefined;
      }
      return {
        kind: 'matched',
        consumeCount: 1,
        effects: [{ key: 'minimumLength', value: token.slice(1) }],
      };
    },
  ],
};

function findStringsPreHelpSemanticIssue({
  parsed,
}: {
  parsed: ReturnType<typeof parseStandardArgv>,
}): string | undefined {
  const minimum = parseMinimumLength({
    value: (parsed.optionValues.minimumLength as string | undefined) ?? '4',
  });
  if (!minimum.ok) return minimum.message;

  const radix = parsed.optionValues.radix;
  if (typeof radix === 'string' && !['o', 'octal', 'd', 'decimal', 'x', 'hex'].includes(radix)) {
    return `invalid radix: '${radix}'`;
  }
  return undefined;
}

export const stringsCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsedArgs = stopStandardArgvAtFirstEarlyExit({
      args: context.args,
      spec: stringsArgvSpec,
      earlyExitOptions: STRINGS_HELP_EARLY_EXIT_OPTIONS,
    });
    const parsed = parseStandardArgv({ args: parsedArgs, spec: stringsArgvSpec });

    const diagnostic = parsed.diagnostics[0];
    const firstPreHelpSemanticIssue = findFirstStandardSemanticIssue({
      args: parsedArgs,
      spec: stringsArgvSpec,
      parsed,
      findSemanticIssue: findStringsPreHelpSemanticIssue,
    });
    const semanticIssuePrecedesDiagnostic = standardSemanticIssuePrecedesDiagnostic({
      args: parsedArgs,
      spec: stringsArgvSpec,
      parsed,
      findSemanticIssue: findStringsPreHelpSemanticIssue,
    });
    if (diagnostic !== undefined && !semanticIssuePrecedesDiagnostic) {
      await writeCommandUsageError({
        context,
        command: 'strings',
        message: `strings: ${diagnostic.message}`,
        argvSpec: stringsArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (firstPreHelpSemanticIssue !== undefined) {
      await context.text().error({ text: `strings: ${firstPreHelpSemanticIssue}\n` });
      return { exitCode: 1 };
    }

    const minimumLengthParsed = parseMinimumLength({
      value: (parsed.optionValues.minimumLength as string | undefined) ?? '4',
    });
    if (!minimumLengthParsed.ok) {
      throw new Error(`strings pre-help validation missed minimum length: ${minimumLengthParsed.message}`);
    }

    const radixValue = parsed.optionValues.radix as string | undefined;
    const radix = (() => {
      switch (radixValue) {
      case undefined:
        return { kind: 'unset' } as const;
      case 'o':
      case 'octal':
        return { kind: 'set', value: 'octal' } as const;
      case 'd':
      case 'decimal':
        return { kind: 'set', value: 'decimal' } as const;
      case 'x':
      case 'hex':
        return { kind: 'set', value: 'hex' } as const;
      default:
        return { kind: 'invalid', value: radixValue } as const;
      }
    })();
    switch (radix.kind) {
    case 'unset':
    case 'set':
      break;
    case 'invalid':
      throw new Error(`strings pre-help validation missed radix: ${radix.value}`);
    default: {
      const _ex: never = radix;
      throw new Error(`Unhandled strings radix parsing result: ${_ex}`);
    }
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'strings',
        argvSpec: stringsArgvSpec,
      });
      return { exitCode: 0 };
    }

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
        argvSpec: stringsArgvSpec,
      });
      return { exitCode: 1 };
    }

    const inputs = parsed.positionals.length === 0 ? ['-'] : parsed.positionals;
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
            if (runLength === 0) return;
            if (runLength < minimumLengthParsed.value) {
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
