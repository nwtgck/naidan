import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import { readCommandInputAsBytes } from '@/services/wesh/commands/_shared/binary-input';
import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/services/wesh/types';

type StringsRadix = 'octal' | 'decimal' | 'hex';

function parseMinimumLength({
  value,
}: {
  value: string;
}): { ok: true; value: number } | { ok: false; message: string } {
  if (!/^[1-9]\d*$/u.test(value)) {
    return { ok: false, message: `invalid minimum string length: '${value}'` };
  }

  return { ok: true, value: Number.parseInt(value, 10) };
}

function isPrintableByte({
  byte,
  includeAllWhitespace,
}: {
  byte: number;
  includeAllWhitespace: boolean;
}): boolean {
  if (byte >= 0x20 && byte <= 0x7e) {
    return true;
  }

  if (!includeAllWhitespace) {
    return false;
  }

  switch (byte) {
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
  offset: number;
  radix: StringsRadix;
}): string {
  switch (radix) {
  case 'octal':
    return offset.toString(8);
  case 'decimal':
    return offset.toString(10);
  case 'hex':
    return offset.toString(16);
  default: {
    const _ex: never = radix;
    throw new Error(`Unhandled strings radix: ${_ex}`);
  }
  }
}

function collectStrings({
  bytes,
  minimumLength,
  includeAllWhitespace,
}: {
  bytes: Uint8Array;
  minimumLength: number;
  includeAllWhitespace: boolean;
}): Array<{ offset: number; value: string }> {
  const collected: Array<{ offset: number; value: string }> = [];
  let start = -1;
  let current = '';

  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index]!;
    if (isPrintableByte({ byte, includeAllWhitespace })) {
      if (start === -1) {
        start = index;
      }
      current += String.fromCharCode(byte);
      continue;
    }

    if (current.length >= minimumLength) {
      collected.push({ offset: start, value: current });
    }
    start = -1;
    current = '';
  }

  if (current.length >= minimumLength) {
    collected.push({ offset: start, value: current });
  }

  return collected;
}

const stringsArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: 'a', long: 'all', effects: [], help: { summary: 'scan the entire file', category: 'common' } },
    { kind: 'flag', short: 'f', long: 'print-file-name', effects: [{ key: 'printFileName', value: true }], help: { summary: 'print the file name before each string', category: 'common' } },
    { kind: 'flag', short: 'h', long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
    { kind: 'value', short: 'n', long: 'bytes', key: 'minimumLength', valueName: 'number', allowAttachedValue: false, parseValue: undefined, help: { summary: 'print sequences of at least NUMBER displayable characters', valueName: 'NUMBER', category: 'common' } },
    { kind: 'flag', short: 'o', long: undefined, effects: [{ key: 'radix', value: 'octal' }], help: { summary: 'same as -t o', category: 'common' } },
    { kind: 'value', short: 's', long: 'output-separator', key: 'separator', valueName: 'string', allowAttachedValue: false, parseValue: undefined, help: { summary: 'set the output separator', valueName: 'STRING', category: 'advanced' } },
    { kind: 'value', short: 't', long: 'radix', key: 'radix', valueName: 'radix', allowAttachedValue: false, parseValue: undefined, help: { summary: 'print the location of each string', valueName: '{o,d,x}', category: 'common' } },
    { kind: 'flag', short: 'w', long: 'include-all-whitespace', effects: [{ key: 'includeAllWhitespace', value: true }], help: { summary: 'treat all whitespace as printable', category: 'advanced' } },
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

export const stringsCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'strings',
    description: 'Print the printable strings in files',
    usage: 'strings [OPTION]... [FILE]...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: stringsArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'strings',
        message: `strings: ${diagnostic.message}`,
        argvSpec: stringsArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'strings',
        argvSpec: stringsArgvSpec,
      });
      return { exitCode: 0 };
    }

    const minimumLengthParsed = parseMinimumLength({
      value: (parsed.optionValues.minimumLength as string | undefined) ?? '4',
    });
    if (!minimumLengthParsed.ok) {
      await context.text().error({ text: `strings: ${minimumLengthParsed.message}\n` });
      return { exitCode: 1 };
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
      await context.text().error({ text: `strings: invalid radix: '${radix.value}'\n` });
      return { exitCode: 1 };
    default: {
      const _ex: never = radix;
      throw new Error(`Unhandled strings radix parsing result: ${_ex}`);
    }
    }

    const inputs = parsed.positionals.length === 0 ? ['-'] : parsed.positionals;
    const separator = (parsed.optionValues.separator as string | undefined) ?? '\n';
    let exitCode = 0;

    for (const input of inputs) {
      try {
        const bytes = await readCommandInputAsBytes({
          context,
          input,
        });
        const strings = collectStrings({
          bytes,
          minimumLength: minimumLengthParsed.value,
          includeAllWhitespace: parsed.optionValues.includeAllWhitespace === true,
        });

        for (const entry of strings) {
          let output = '';
          if (parsed.optionValues.printFileName === true) {
            output += `${input === '-' ? '(standard input)' : input}:`;
          }
          switch (radix.kind) {
          case 'set':
            output += `${output.length > 0 ? ' ' : ''}${formatOffset({ offset: entry.offset, radix: radix.value })}`;
            break;
          case 'unset':
            break;
          default: {
            const _ex: never = radix;
            throw new Error(`Unhandled strings radix state during output: ${_ex}`);
          }
          }
          if (output.length > 0) {
            output += ' ';
          }
          output += entry.value;
          output += separator;
          await context.text().print({ text: output });
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        await context.text().error({ text: `strings: ${input}: ${message}\n` });
        exitCode = 1;
      }
    }

    return { exitCode };
  },
};
