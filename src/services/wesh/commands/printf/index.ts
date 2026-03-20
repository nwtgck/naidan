import type { StandardArgvParserSpec } from '@/services/wesh/argv';
import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/services/wesh/types';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';

type PrintfToken =
  | { kind: 'literal'; text: string }
  | { kind: 'conversion'; spec: 's' | 'd' | 'b' };

const printfArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
  ],
  allowShortFlagBundles: false,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

function decodePrintfEscapes({
  text,
  stopOnControlC,
}: {
  text: string;
  stopOnControlC: boolean;
}): { text: string; stopped: boolean } {
  let output = '';

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char !== '\\') {
      output += char;
      continue;
    }

    const next = text[index + 1];
    if (next === undefined) {
      output += '\\';
      continue;
    }

    index += 1;
    switch (next) {
    case 'a':
      output += '\u0007';
      continue;
    case 'b':
      output += '\b';
      continue;
    case 'c':
      if (stopOnControlC) {
        return { text: output, stopped: true };
      }
      output += '\\c';
      continue;
    case 'e':
      output += '\u001b';
      continue;
    case 'f':
      output += '\f';
      continue;
    case 'n':
      output += '\n';
      continue;
    case 'r':
      output += '\r';
      continue;
    case 't':
      output += '\t';
      continue;
    case 'v':
      output += '\v';
      continue;
    case '\\':
      output += '\\';
      continue;
    case '"':
      output += '"';
      continue;
    case '0': {
      let octal = '0';
      while (octal.length < 3) {
        const digit = text[index + 1];
        if (digit === undefined || !/^[0-7]$/.test(digit)) {
          break;
        }
        index += 1;
        octal += digit;
      }
      output += String.fromCharCode(parseInt(octal, 8));
      continue;
    }
    case 'x':
    case 'u':
    case 'U': {
      let digitCount: number;
      switch (next) {
      case 'x':
        digitCount = 2;
        break;
      case 'u':
        digitCount = 4;
        break;
      case 'U':
        digitCount = 8;
        break;
      default: {
        const _ex: never = next;
        throw new Error(`Unhandled printf escape: ${_ex}`);
      }
      }
      let digits = '';
      while (digits.length < digitCount) {
        const digit = text[index + 1];
        if (digit === undefined || !/^[0-9a-fA-F]$/.test(digit)) {
          break;
        }
        index += 1;
        digits += digit;
      }
      if (digits.length === 0) {
        output += `\\${next}`;
        continue;
      }
      output += String.fromCodePoint(parseInt(digits, 16));
      continue;
    }
    default:
      output += `\\${next}`;
      continue;
    }
  }

  return { text: output, stopped: false };
}

function parsePrintfFormat({
  format,
}: {
  format: string;
}): { ok: true; tokens: PrintfToken[] } | { ok: false; message: string } {
  const tokens: PrintfToken[] = [];
  let literal = '';

  for (let index = 0; index < format.length; index++) {
    const char = format[index];
    if (char !== '%') {
      literal += char;
      continue;
    }

    const next = format[index + 1];
    if (next === undefined) {
      return { ok: false, message: "printf: invalid format character '%'" };
    }

    if (next === '%') {
      literal += '%';
      index += 1;
      continue;
    }

    switch (next) {
    case 's':
    case 'd':
    case 'b':
      if (literal.length > 0) {
        tokens.push({ kind: 'literal', text: literal });
        literal = '';
      }
      tokens.push({ kind: 'conversion', spec: next });
      index += 1;
      continue;
    default:
      return { ok: false, message: `printf: invalid format character '${next}'` };
    }
  }

  if (literal.length > 0) {
    tokens.push({ kind: 'literal', text: literal });
  }

  return { ok: true, tokens };
}

function formatPrintfInteger({
  value,
}: {
  value: string | undefined;
}): string {
  if (value === undefined) {
    return '0';
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return '0';
  }

  return String(Math.trunc(parsed));
}

function formatPrintfToken({
  token,
  value,
}: {
  token: PrintfToken;
  value: string | undefined;
}): { text: string; stopped: boolean } {
  switch (token.kind) {
  case 'literal': {
    return decodePrintfEscapes({ text: token.text, stopOnControlC: true });
  }
  case 'conversion': {
    switch (token.spec) {
    case 's':
      return decodePrintfEscapes({ text: value ?? '', stopOnControlC: true });
    case 'd':
      return { text: formatPrintfInteger({ value }), stopped: false };
    case 'b':
      return decodePrintfEscapes({ text: value ?? '', stopOnControlC: true });
    default: {
      const _ex: never = token.spec;
      throw new Error(`Unhandled printf spec: ${_ex}`);
    }
    }
  }
  default: {
    const _ex: never = token;
    throw new Error(`Unhandled printf token: ${_ex}`);
  }
  }
}

async function writeFormattedText({
  context,
  text,
}: {
  context: WeshCommandContext;
  text: string;
}): Promise<void> {
  await context.text().print({ text });
}

export const printfCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'printf',
    description: 'Format and print data',
    usage: 'printf FORMAT [ARGUMENT]...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    if (context.args.length === 1 && context.args[0] === '--help') {
      await writeCommandHelp({
        context,
        command: 'printf',
        argvSpec: printfArgvSpec,
      });
      return { exitCode: 0 };
    }

    if (context.args.length === 0) {
      await writeCommandUsageError({
        context,
        command: 'printf',
        message: 'printf: missing format operand',
        argvSpec: printfArgvSpec,
      });
      return { exitCode: 1 };
    }

    const [format, ...args] = context.args;
    if (format === undefined) {
      await writeCommandUsageError({
        context,
        command: 'printf',
        message: 'printf: missing format operand',
        argvSpec: printfArgvSpec,
      });
      return { exitCode: 1 };
    }

    const parsed = parsePrintfFormat({ format });
    if (!parsed.ok) {
      await writeCommandUsageError({
        context,
        command: 'printf',
        message: parsed.message,
        argvSpec: printfArgvSpec,
      });
      return { exitCode: 1 };
    }

    let conversionCount = 0;
    for (const token of parsed.tokens) {
      switch (token.kind) {
      case 'literal':
        continue;
      case 'conversion':
        conversionCount += 1;
        continue;
      default: {
        const _ex: never = token;
        throw new Error(`Unhandled printf token: ${_ex}`);
      }
      }
    }
    if (conversionCount === 0) {
      for (const token of parsed.tokens) {
        switch (token.kind) {
        case 'literal': {
          const formatted = formatPrintfToken({ token, value: undefined });
          if (formatted.stopped) {
            return { exitCode: 0 };
          }
          await writeFormattedText({ context, text: formatted.text });
          continue;
        }
        case 'conversion': {
          const formatted = formatPrintfToken({ token, value: undefined });
          if (formatted.stopped) {
            return { exitCode: 0 };
          }
          await writeFormattedText({ context, text: formatted.text });
          continue;
        }
        default: {
          const _ex: never = token;
          throw new Error(`Unhandled printf token: ${_ex}`);
        }
        }
      }
      return { exitCode: 0 };
    }

    let argIndex = 0;
    let didRunCycle = false;

    while (argIndex < args.length || !didRunCycle) {
      didRunCycle = true;
      for (const token of parsed.tokens) {
        switch (token.kind) {
        case 'literal': {
          const formatted = formatPrintfToken({ token, value: undefined });
          if (formatted.stopped) {
            return { exitCode: 0 };
          }
          await writeFormattedText({ context, text: formatted.text });
          continue;
        }
        case 'conversion': {
          const value = args[argIndex];
          if (argIndex < args.length) {
            argIndex += 1;
          }
          const formatted = formatPrintfToken({ token, value });
          if (formatted.stopped) {
            return { exitCode: 0 };
          }
          await writeFormattedText({ context, text: formatted.text });
          continue;
        }
        default: {
          const _ex: never = token;
          throw new Error(`Unhandled printf token: ${_ex}`);
        }
        }
      }

      if (argIndex >= args.length) {
        break;
      }
    }

    return { exitCode: 0 };
  },
};
