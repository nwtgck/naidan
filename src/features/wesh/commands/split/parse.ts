import type { StandardArgvParserSpec } from '@/features/wesh/argv';
import type { ArgvSpecialParseResult } from '@/features/wesh/argv';

export type SplitMode =
  | { kind: 'lines', count: number }
  | { kind: 'bytes', size: number };

export type SuffixMode =
  | { kind: 'alphabetic' }
  | { kind: 'numeric', start: number };

export interface SplitOptions {
  mode: SplitMode,
  suffixLength: number,
  suffixMode: SuffixMode,
  additionalSuffix: string,
  verbose: boolean,
}

export interface SplitOperands {
  input: string | undefined,
  prefix: string,
}

const MAX_SAFE_SUFFIX_LENGTH = 128;

function parsePositiveInteger({
  value,
  label,
}: {
  value: string,
  label: string,
}): { ok: true, value: number } | { ok: false, message: string } {
  if (!/^\d+$/u.test(value)) {
    return { ok: false, message: `invalid ${label}: '${value}'` };
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return { ok: false, message: `invalid ${label}: '${value}'` };
  }

  return { ok: true, value: parsed };
}

function parseNonNegativeInteger({
  value,
  label,
}: {
  value: string,
  label: string,
}): { ok: true, value: number } | { ok: false, message: string } {
  if (!/^\d+$/u.test(value)) {
    return { ok: false, message: `invalid ${label}: '${value}'` };
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return { ok: false, message: `invalid ${label}: '${value}'` };
  }

  return { ok: true, value: parsed };
}

export function parseLineCount({
  value,
}: {
  value: string,
}): { ok: true, value: number } | { ok: false, message: string } {
  return parsePositiveInteger({ value, label: 'number of lines' });
}

export function parseSuffixLength({
  value,
}: {
  value: string,
}): { ok: true, value: number } | { ok: false, message: string } {
  const parsed = parsePositiveInteger({ value, label: 'suffix length' });
  if (!parsed.ok) {
    return parsed;
  }

  if (parsed.value > MAX_SAFE_SUFFIX_LENGTH) {
    return { ok: false, message: `invalid suffix length: '${value}'` };
  }

  return parsed;
}

export function parseByteSize({
  value,
}: {
  value: string,
}): { ok: true, value: number } | { ok: false, message: string } {
  const match = /^(\d+)([A-Za-z]*)$/u.exec(value);
  if (match === null) {
    return { ok: false, message: `invalid number of bytes: '${value}'` };
  }

  const numberText = match[1];
  const suffix = match[2];
  if (numberText === undefined || suffix === undefined) {
    return { ok: false, message: `invalid number of bytes: '${value}'` };
  }

  const parsed = Number.parseInt(numberText, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return { ok: false, message: `invalid number of bytes: '${value}'` };
  }

  const multiplier = (() => {
    switch (suffix) {
    case '':
      return 1;
    case 'b':
      return 512;
    case 'K':
    case 'KiB':
      return 1024;
    case 'KB':
      return 1000;
    case 'M':
    case 'MiB':
      return 1024 ** 2;
    case 'MB':
      return 1000 ** 2;
    case 'G':
    case 'GiB':
      return 1024 ** 3;
    case 'GB':
      return 1000 ** 3;
    default:
      return undefined;
    }
  })();

  if (multiplier === undefined) {
    return { ok: false, message: `invalid number of bytes: '${value}'` };
  }

  const size = parsed * multiplier;
  if (!Number.isSafeInteger(size) || size <= 0) {
    return { ok: false, message: `invalid number of bytes: '${value}'` };
  }

  return { ok: true, value: size };
}

function parseNumericSuffixStart({
  value,
}: {
  value: string,
}): { ok: true, value: number } | { ok: false, message: string } {
  return parseNonNegativeInteger({ value, label: 'numeric suffix start' });
}

function parseNumericSuffixToken({
  token,
}: {
  token: string,
}): ArgvSpecialParseResult | undefined {
  if (token === '--numeric-suffixes') {
    return {
      kind: 'matched',
      consumeCount: 1,
      effects: [
        { key: 'numericSuffixes', value: true },
        { key: 'numericSuffixStart', value: 0 },
      ],
      occurrences: [
        {
          kind: 'special',
          option: '--numeric-suffixes',
          effects: [
            { key: 'numericSuffixes', value: true },
            { key: 'numericSuffixStart', value: 0 },
          ],
        },
      ],
    };
  }

  const prefix = '--numeric-suffixes=';
  if (!token.startsWith(prefix)) {
    return undefined;
  }

  const rawValue = token.slice(prefix.length);
  const parsed = parseNumericSuffixStart({ value: rawValue });
  if (!parsed.ok) {
    return {
      kind: 'matched',
      consumeCount: 1,
      effects: [
        { key: 'numericSuffixes', value: true },
        { key: 'numericSuffixParseError', value: parsed.message },
      ],
      occurrences: [
        {
          kind: 'special',
          option: '--numeric-suffixes',
          effects: [{ key: 'numericSuffixParseError', value: parsed.message }],
        },
      ],
    };
  }

  return {
    kind: 'matched',
    consumeCount: 1,
    effects: [
      { key: 'numericSuffixes', value: true },
      { key: 'numericSuffixStart', value: parsed.value },
    ],
    occurrences: [
      {
        kind: 'special',
        option: '--numeric-suffixes',
        effects: [
          { key: 'numericSuffixes', value: true },
          { key: 'numericSuffixStart', value: parsed.value },
        ],
      },
    ],
  };
}

export const splitArgvSpec: StandardArgvParserSpec = {
  options: [
    {
      kind: 'value',
      short: 'l',
      long: 'lines',
      key: 'lines',
      valueName: 'NUMBER',
      allowAttachedValue: true,
      parseValue: parseLineCount,
      help: { summary: 'put NUMBER lines per output file', valueName: 'NUMBER', category: 'common' },
    },
    {
      kind: 'value',
      short: 'b',
      long: 'bytes',
      key: 'bytes',
      valueName: 'SIZE',
      allowAttachedValue: true,
      parseValue: parseByteSize,
      help: { summary: 'put SIZE bytes per output file', valueName: 'SIZE', category: 'common' },
    },
    {
      kind: 'value',
      short: 'a',
      long: 'suffix-length',
      key: 'suffixLength',
      valueName: 'N',
      allowAttachedValue: true,
      parseValue: parseSuffixLength,
      help: { summary: 'use suffixes of length N', valueName: 'N', category: 'common' },
    },
    {
      kind: 'flag',
      short: 'd',
      long: undefined,
      effects: [
        { key: 'numericSuffixes', value: true },
        { key: 'numericSuffixStart', value: 0 },
      ],
      help: { summary: 'use numeric suffixes starting at 0', category: 'common' },
    },
    {
      kind: 'flag',
      short: undefined,
      long: 'numeric-suffixes',
      effects: [
        { key: 'numericSuffixes', value: true },
        { key: 'numericSuffixStart', value: 0 },
      ],
      help: { summary: 'use numeric suffixes, optionally starting at FROM with --numeric-suffixes=FROM', category: 'common' },
    },
    {
      kind: 'value',
      short: undefined,
      long: 'additional-suffix',
      key: 'additionalSuffix',
      valueName: 'SUFFIX',
      allowAttachedValue: false,
      parseValue: undefined,
      help: { summary: 'append SUFFIX to output file names', valueName: 'SUFFIX', category: 'common' },
    },
    {
      kind: 'flag',
      short: undefined,
      long: 'verbose',
      effects: [{ key: 'verbose', value: true }],
      help: { summary: 'print a diagnostic before each output file is opened', category: 'common' },
    },
    {
      kind: 'flag',
      short: undefined,
      long: 'help',
      effects: [{ key: 'help', value: true }],
      help: { summary: 'display this help and exit', category: 'common' },
    },
  ],
  allowShortFlagBundles: false,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [
    ({ token }) => parseNumericSuffixToken({ token }),
  ],
};

export function buildSplitOptions({
  optionValues,
}: {
  optionValues: Record<string, boolean | string | number>,
}): { ok: true, options: SplitOptions } | { ok: false, message: string } {
  const numericSuffixError = optionValues.numericSuffixParseError;
  if (typeof numericSuffixError === 'string') {
    return { ok: false, message: numericSuffixError };
  }

  const hasLines = typeof optionValues.lines === 'number';
  const hasBytes = typeof optionValues.bytes === 'number';
  if (hasLines && hasBytes) {
    return { ok: false, message: 'cannot split in more than one way' };
  }

  const mode: SplitMode = hasBytes
    ? { kind: 'bytes', size: optionValues.bytes as number }
    : { kind: 'lines', count: hasLines ? optionValues.lines as number : 1000 };

  const suffixLength = typeof optionValues.suffixLength === 'number'
    ? optionValues.suffixLength
    : 2;
  const numericSuffixStart = typeof optionValues.numericSuffixStart === 'number'
    ? optionValues.numericSuffixStart
    : 0;

  return {
    ok: true,
    options: {
      mode,
      suffixLength,
      suffixMode: optionValues.numericSuffixes === true
        ? { kind: 'numeric', start: numericSuffixStart }
        : { kind: 'alphabetic' },
      additionalSuffix: typeof optionValues.additionalSuffix === 'string'
        ? optionValues.additionalSuffix
        : '',
      verbose: optionValues.verbose === true,
    },
  };
}

export function parseSplitOperands({
  positionals,
}: {
  positionals: string[],
}): { ok: true, operands: SplitOperands } | { ok: false, message: string } {
  if (positionals.length > 2) {
    return { ok: false, message: `extra operand '${positionals[2]}'` };
  }

  if (positionals.length === 0) {
    return { ok: true, operands: { input: undefined, prefix: 'x' } };
  }

  if (positionals.length === 1) {
    return { ok: true, operands: { input: positionals[0], prefix: 'x' } };
  }

  return {
    ok: true,
    operands: {
      input: positionals[0],
      prefix: positionals[1] ?? 'x',
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  buildSplitOptions,
  parseByteSize,
  parseLineCount,
  parseSplitOperands,
  parseSuffixLength,
};
