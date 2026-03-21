import type { StandardArgvParserSpec } from '@/services/wesh/argv';
import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/services/wesh/types';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';

interface SeqParsedArgs {
  help: boolean;
  separator: string;
  equalWidth: boolean;
  format: string | undefined;
  positionals: string[];
  diagnostic: string | undefined;
}

type SeqPrintfConversion = 'f' | 'F' | 'e' | 'E' | 'g' | 'G' | 'd' | 'i';

interface SeqPrintfSpec {
  kind: 'printf';
  prefix: string;
  suffix: string;
  conversion: SeqPrintfConversion;
  width: number | undefined;
  zeroPad: boolean;
  precision: number | undefined;
}

type SeqFormatSpec =
  | { kind: 'plain' }
  | SeqPrintfSpec;

const seqArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
    { kind: 'value', short: 's', long: 'separator', key: 'separator', valueName: 'STRING', allowAttachedValue: true, parseValue: undefined, help: { summary: 'use STRING to separate numbers', valueName: 'STRING', category: 'common' } },
    { kind: 'flag', short: 'w', long: 'equal-width', effects: [{ key: 'equalWidth', value: true }], help: { summary: 'equalize width by padding with leading zeroes', category: 'common' } },
    { kind: 'value', short: 'f', long: 'format', key: 'format', valueName: 'FORMAT', allowAttachedValue: true, parseValue: undefined, help: { summary: 'use printf style floating-point FORMAT', valueName: 'FORMAT', category: 'advanced' } },
  ],
  allowShortFlagBundles: false,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

function isNumericOperand({
  value,
}: {
  value: string;
}): boolean {
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value);
}

function isFixedPointDecimal({
  value,
}: {
  value: string;
}): boolean {
  return /^[+-]?(?:\d+|\d+\.\d+|\.\d+)$/.test(value);
}

function parseSeqNumber({
  value,
}: {
  value: string;
}): { ok: true; number: number } | { ok: false; message: string } {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return { ok: false, message: `invalid floating point argument: '${value}'` };
  }

  return { ok: true, number: parsed };
}

function parseSeqArgs({
  args,
}: {
  args: string[];
}): SeqParsedArgs {
  const parsed: SeqParsedArgs = {
    help: false,
    separator: '\n',
    equalWidth: false,
    format: undefined,
    positionals: [],
    diagnostic: undefined,
  };

  let optionsDone = false;
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token === undefined) continue;

    if (!optionsDone && token === '--') {
      optionsDone = true;
      continue;
    }

    if (!optionsDone && token === '--help') {
      parsed.help = true;
      continue;
    }

    if (!optionsDone && (token === '-w' || token === '--equal-width')) {
      parsed.equalWidth = true;
      continue;
    }

    if (!optionsDone && (token === '-s' || /^-s.+$/u.test(token))) {
      const value = token.length > 2 ? token.slice(2) : undefined;
      if (value !== undefined) {
        parsed.separator = value;
      } else {
        const next = args[index + 1];
        if (next === undefined) {
          parsed.diagnostic = "seq: option requires a value for STRING";
          break;
        }
        parsed.separator = next;
        index += 1;
      }
      continue;
    }

    if (!optionsDone && (token === '--separator' || token.startsWith('--separator='))) {
      const value = token.startsWith('--separator=') ? token.slice('--separator='.length) : args[index + 1];
      if (value === undefined) {
        parsed.diagnostic = "seq: option requires a value for STRING";
        break;
      }
      parsed.separator = value;
      if (token === '--separator') {
        index += 1;
      }
      continue;
    }

    if (!optionsDone && (token === '-f' || /^-f.+$/u.test(token))) {
      const value = token.length > 2 ? token.slice(2) : args[index + 1];
      if (value === undefined) {
        parsed.diagnostic = "seq: option requires a value for FORMAT";
        break;
      }
      parsed.format = value;
      if (token === '-f') {
        index += 1;
      }
      continue;
    }

    if (!optionsDone && (token === '--format' || token.startsWith('--format='))) {
      const value = token.startsWith('--format=') ? token.slice('--format='.length) : args[index + 1];
      if (value === undefined) {
        parsed.diagnostic = "seq: option requires a value for FORMAT";
        break;
      }
      parsed.format = value;
      if (token === '--format') {
        index += 1;
      }
      continue;
    }

    if (!optionsDone && token.startsWith('--')) {
      parsed.diagnostic = `seq: unrecognized option '${token}'`;
      break;
    }

    if (!optionsDone && token.startsWith('-') && !isNumericOperand({ value: token })) {
      parsed.diagnostic = `seq: invalid option -- '${token.slice(1, 2)}'`;
      break;
    }

    parsed.positionals.push(token);
  }

  return parsed;
}

function parseSeqFormatSpec({
  format,
}: {
  format: string;
}): { ok: true; spec: SeqFormatSpec } | { ok: false; message: string } {
  if (format.length === 0) {
    return { ok: true, spec: { kind: 'plain' } };
  }

  let prefix = '';
  let suffix = '';
  let placeholder: Omit<SeqPrintfSpec, 'prefix' | 'suffix'> | undefined;
  let readingSuffix = false;

  for (let index = 0; index < format.length; index++) {
    const char = format[index];
    if (char !== '%') {
      if (readingSuffix) {
        suffix += char;
      } else {
        prefix += char;
      }
      continue;
    }

    const next = format[index + 1];
    if (next === undefined) {
      return { ok: false, message: "seq: invalid format string: ends with '%'" };
    }

    if (next === '%') {
      if (readingSuffix) {
        suffix += '%';
      } else {
        prefix += '%';
      }
      index += 1;
      continue;
    }

    if (placeholder !== undefined) {
      return { ok: false, message: 'seq: invalid format string: multiple conversion specifications' };
    }

    let cursor = index + 1;
    let zeroPad = false;
    if (format[cursor] === '0') {
      zeroPad = true;
      cursor += 1;
    }

    let widthText = '';
    while (cursor < format.length && /[0-9]/.test(format[cursor] ?? '')) {
      widthText += format[cursor];
      cursor += 1;
    }

    let precision: number | undefined;
    if (format[cursor] === '.') {
      cursor += 1;
      let precisionText = '';
      while (cursor < format.length && /[0-9]/.test(format[cursor] ?? '')) {
        precisionText += format[cursor];
        cursor += 1;
      }
      if (precisionText.length === 0) {
        return { ok: false, message: 'seq: invalid format string: missing precision digits' };
      }
      precision = Number(precisionText);
    }

    const conversion = format[cursor];
    if (
      conversion === undefined
      || !['f', 'F', 'e', 'E', 'g', 'G', 'd', 'i'].includes(conversion)
    ) {
      return { ok: false, message: `seq: invalid format string: unsupported conversion '${conversion ?? '%'}'` };
    }

    placeholder = {
      kind: 'printf',
      conversion: conversion as SeqPrintfConversion,
      width: widthText.length > 0 ? Number(widthText) : undefined,
      zeroPad,
      precision,
    };
    readingSuffix = true;
    index = cursor;
  }

  if (placeholder === undefined) {
    return { ok: false, message: 'seq: invalid format string: missing conversion specification' };
  }

  return { ok: true, spec: { prefix, suffix, ...placeholder } };
}

function formatSeqValue({
  value,
  spec,
}: {
  value: number;
  spec: SeqFormatSpec;
}): string {
  switch (spec.kind) {
  case 'plain':
    return Number.isInteger(value) ? String(value) : String(value);
  case 'printf': {
    let text: string;
    switch (spec.conversion) {
    case 'd':
    case 'i':
      text = String(Math.trunc(value));
      break;
    case 'f':
    case 'F':
      text = value.toFixed(spec.precision ?? 6);
      break;
    case 'e':
    case 'E':
      text = value.toExponential(spec.precision ?? 6);
      break;
    case 'g':
    case 'G':
      text = value.toPrecision(spec.precision ?? 6);
      if (!/[eE]/.test(text)) {
        text = text.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '').replace(/\.$/, '');
      }
      break;
    default: {
      const _ex: never = spec.conversion;
      throw new Error(`Unhandled seq conversion: ${_ex}`);
    }
    }

    if (spec.conversion === 'F' || spec.conversion === 'E' || spec.conversion === 'G') {
      text = text.toUpperCase();
    }

    if (spec.width !== undefined && text.length < spec.width) {
      if (spec.zeroPad) {
        if (text.startsWith('-') || text.startsWith('+')) {
          text = `${text[0]}${text.slice(1).padStart(spec.width - 1, '0')}`;
        } else {
          text = text.padStart(spec.width, '0');
        }
      } else {
        text = text.padStart(spec.width, ' ');
      }
    }

    return `${spec.prefix}${text}${spec.suffix}`;
  }
  default: {
    const _ex: never = spec;
    throw new Error(`Unhandled seq spec: ${_ex}`);
  }
  }
}

function computeDefaultPrecision({
  operands,
}: {
  operands: string[];
}): number | undefined {
  if (!operands.every((operand) => isFixedPointDecimal({ value: operand }))) {
    return undefined;
  }

  return operands.reduce((max, operand) => {
    const decimalIndex = operand.indexOf('.');
    if (decimalIndex < 0) {
      return max;
    }
    return Math.max(max, operand.length - decimalIndex - 1);
  }, 0);
}

function formatDefaultNumber({
  value,
  precision,
}: {
  value: number;
  precision: number | undefined;
}): string {
  if (precision !== undefined) {
    return value.toFixed(precision);
  }

  return Number.isInteger(value) ? String(value) : String(value);
}

function padEqualWidth({
  value,
  width,
}: {
  value: string;
  width: number;
}): string {
  if (value.length >= width) {
    return value;
  }

  if (value.startsWith('-') || value.startsWith('+')) {
    return `${value[0]}${value.slice(1).padStart(width - 1, '0')}`;
  }

  return value.padStart(width, '0');
}

export const seqCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'seq',
    description: 'Print a sequence of numbers',
    usage: 'seq [OPTION]... LAST | seq [OPTION]... FIRST LAST | seq [OPTION]... FIRST INCREMENT LAST',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseSeqArgs({ args: context.args });
    if (parsed.diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'seq',
        message: parsed.diagnostic,
        argvSpec: seqArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.help) {
      await writeCommandHelp({
        context,
        command: 'seq',
        argvSpec: seqArgvSpec,
      });
      return { exitCode: 0 };
    }

    const operands = parsed.positionals;
    if (operands.length === 0) {
      await writeCommandUsageError({
        context,
        command: 'seq',
        message: 'seq: missing operand',
        argvSpec: seqArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (operands.length > 3) {
      await writeCommandUsageError({
        context,
        command: 'seq',
        message: 'seq: extra operand',
        argvSpec: seqArgvSpec,
      });
      return { exitCode: 1 };
    }

    const numericOperands = operands.map((operand) => parseSeqNumber({ value: operand }));
    const failedOperand = numericOperands.find((operand) => !operand.ok);
    if (failedOperand !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'seq',
        message: failedOperand.message,
        argvSpec: seqArgvSpec,
      });
      return { exitCode: 1 };
    }

    const firstOperand = numericOperands[0];
    const secondOperand = numericOperands[1];
    const thirdOperand = numericOperands[2];

    let first = 1;
    if (operands.length > 1 && firstOperand?.ok === true) {
      first = firstOperand.number;
    }

    let increment = 1;
    if (operands.length > 2 && secondOperand?.ok === true) {
      increment = secondOperand.number;
    }

    let last = 1;
    if (operands.length === 1 && firstOperand?.ok === true) {
      last = firstOperand.number;
    } else if (operands.length === 2 && secondOperand?.ok === true) {
      last = secondOperand.number;
    } else if (operands.length === 3 && thirdOperand?.ok === true) {
      last = thirdOperand.number;
    }

    if (increment === 0) {
      await writeCommandUsageError({
        context,
        command: 'seq',
        message: 'seq: invalid zero increment',
        argvSpec: seqArgvSpec,
      });
      return { exitCode: 1 };
    }

    let formatSpec: SeqFormatSpec = { kind: 'plain' };
    if (parsed.format !== undefined) {
      const parsedFormat = parseSeqFormatSpec({ format: parsed.format });
      if (!parsedFormat.ok) {
        await writeCommandUsageError({
          context,
          command: 'seq',
          message: parsedFormat.message,
          argvSpec: seqArgvSpec,
        });
        return { exitCode: 1 };
      }
      formatSpec = parsedFormat.spec;
    }

    const values: number[] = [];
    const epsilon = 1e-12;
    if (increment > 0) {
      for (let current = first; current <= last + epsilon; current += increment) {
        values.push(current);
        if (values.length > 1000000) {
          break;
        }
      }
    } else {
      for (let current = first; current >= last - epsilon; current += increment) {
        values.push(current);
        if (values.length > 1000000) {
          break;
        }
      }
    }

    const defaultPrecision = parsed.format === undefined ? computeDefaultPrecision({ operands }) : undefined;
    let rendered = values.map((value) => {
      if (parsed.format !== undefined) {
        return formatSeqValue({ value, spec: formatSpec });
      }

      return formatDefaultNumber({ value, precision: defaultPrecision });
    });

    if (parsed.equalWidth) {
      const width = rendered.reduce((max, value) => Math.max(max, value.length), 0);
      rendered = rendered.map((value) => padEqualWidth({ value, width }));
    }

    const separator = parsed.separator;
    const output = rendered.join(separator);
    const suffix = separator === '\n' && rendered.length > 0 ? '\n' : '';
    await context.text().print({ text: output + suffix });

    return { exitCode: 0 };
  },
};
