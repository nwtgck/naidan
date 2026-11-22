import { stripLeadingCLocaleWhitespace } from '@/features/wesh/commands/_shared/numeric-whitespace';
import {
  defineArgvCatalog,
  defineArgvHelpPresentation,
  HELP_EARLY_EXIT_OPTIONS,
  parseStandardArgv,
  stopArgvAtFirstEarlyExit,
  type StandardArgvAction,
  type StandardArgvPolicy,
} from '@/features/wesh/argv-v2';

export type SplitMode =
  | { kind: 'lines', count: number }
  | { kind: 'bytes', size: number }
  | { kind: 'lineBytes', size: number };

export type SuffixMode =
  | { kind: 'alphabetic' }
  | { kind: 'numeric', start: number };

export type SplitSuffixLength =
  | { kind: 'auto', initialLength: number }
  | { kind: 'fixed', length: number };

export interface SplitOptions {
  mode: SplitMode,
  suffixLength: SplitSuffixLength,
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
  const numericText = stripLeadingCLocaleWhitespace({ value });
  if (!/^\+?\d+$/u.test(numericText)) {
    return { ok: false, message: `invalid ${label}: '${value}'` };
  }

  const parsed = Number.parseInt(numericText, 10);
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
  const numericText = stripLeadingCLocaleWhitespace({ value });
  if (!/^\d+$/u.test(numericText)) {
    return { ok: false, message: `invalid ${label}: '${value}'` };
  }

  const parsed = Number.parseInt(numericText, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return { ok: false, message: `invalid ${label}: '${value}'` };
  }

  return { ok: true, value: parsed };
}

export function parseLineCount({
  rawValue: value,
}: {
  rawValue: string,
}): { kind: 'parsed', value: number } | { kind: 'invalid', message: string } {
  const parsed = parsePositiveInteger({ value, label: 'number of lines' });
  return parsed.ok ? { kind: 'parsed', value: parsed.value } : { kind: 'invalid', message: parsed.message };
}

export function parseSuffixLength({
  rawValue: value,
}: {
  rawValue: string,
}): { kind: 'parsed', value: number } | { kind: 'invalid', message: string } {
  const parsed = parsePositiveInteger({ value, label: 'suffix length' });
  if (!parsed.ok) {
    return { kind: 'invalid', message: parsed.message };
  }

  if (parsed.value > MAX_SAFE_SUFFIX_LENGTH) {
    return { kind: 'invalid', message: `invalid suffix length: '${value}'` };
  }

  return { kind: 'parsed', value: parsed.value };
}

export function parseByteSize({
  rawValue: value,
}: {
  rawValue: string,
}): { kind: 'parsed', value: number } | { kind: 'invalid', message: string } {
  const numericText = stripLeadingCLocaleWhitespace({ value });
  const match = /^(\+?\d+)([A-Za-z]*)$/u.exec(numericText);
  if (match === null) {
    return { kind: 'invalid', message: `invalid number of bytes: '${value}'` };
  }

  const numberText = match[1];
  const suffix = match[2];
  if (numberText === undefined || suffix === undefined) {
    return { kind: 'invalid', message: `invalid number of bytes: '${value}'` };
  }

  const parsed = Number.parseInt(numberText, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return { kind: 'invalid', message: `invalid number of bytes: '${value}'` };
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
    return { kind: 'invalid', message: `invalid number of bytes: '${value}'` };
  }

  const size = parsed * multiplier;
  if (!Number.isSafeInteger(size) || size <= 0) {
    return { kind: 'invalid', message: `invalid number of bytes: '${value}'` };
  }

  return { kind: 'parsed', value: size };
}

function parseNumericSuffixStart({
  rawValue: value,
}: {
  rawValue: string,
}): { kind: 'parsed', value: number } | { kind: 'invalid', message: string } {
  const parsed = parseNonNegativeInteger({ value, label: 'numeric suffix start' });
  return parsed.ok ? { kind: 'parsed', value: parsed.value } : { kind: 'invalid', message: parsed.message };
}

const splitArgvOptions = [
  {
    semantic: { kind: 'required-value', key: 'lines', parse: parseLineCount },
    forms: [
      { kind: 'short', name: 'l', value: { kind: 'required-attached-or-following', missingValueName: 'NUMBER' } },
      { kind: 'long', name: 'lines', value: { kind: 'required', missingValueName: 'NUMBER' } },
    ],
    help: { summary: 'put NUMBER lines per output file', valueName: 'NUMBER', category: 'common' },
  },
  {
    semantic: { kind: 'required-value', key: 'bytes', parse: parseByteSize },
    forms: [
      { kind: 'short', name: 'b', value: { kind: 'required-attached-or-following', missingValueName: 'SIZE' } },
      { kind: 'long', name: 'bytes', value: { kind: 'required', missingValueName: 'SIZE' } },
    ],
    help: { summary: 'put SIZE bytes per output file', valueName: 'SIZE', category: 'common' },
  },
  {
    semantic: { kind: 'required-value', key: 'lineBytes', parse: parseByteSize },
    forms: [
      { kind: 'short', name: 'C', value: { kind: 'required-attached-or-following', missingValueName: 'SIZE' } },
      { kind: 'long', name: 'line-bytes', value: { kind: 'required', missingValueName: 'SIZE' } },
    ],
    help: { summary: 'put at most SIZE bytes of records per output file', valueName: 'SIZE', category: 'common' },
  },
  {
    semantic: { kind: 'required-value', key: 'suffixLength', parse: parseSuffixLength },
    forms: [
      { kind: 'short', name: 'a', value: { kind: 'required-attached-or-following', missingValueName: 'N' } },
      { kind: 'long', name: 'suffix-length', value: { kind: 'required', missingValueName: 'N' } },
    ],
    help: { summary: 'use suffixes of length N', valueName: 'N', category: 'common' },
  },
  {
    semantic: {
      kind: 'effects',
      effects: [
        { key: 'numericSuffixes', value: true },
        { key: 'numericSuffixAutoExpand', value: true },
      ],
    },
    forms: [
      { kind: 'short', name: 'd', value: { kind: 'none' } },
    ],
    help: { summary: 'use numeric suffixes starting at 0', category: 'common' },
  },
  {
    semantic: { kind: 'deferred', tag: 'numericSuffixes' },
    forms: [
      { kind: 'long', name: 'numeric-suffixes', value: { kind: 'optional-inline' } },
    ],
    help: { summary: 'use numeric suffixes, optionally starting at FROM with --numeric-suffixes=FROM', category: 'common' },
  },
  {
    semantic: { kind: 'required-value', key: 'additionalSuffix', parse: undefined },
    forms: [
      { kind: 'long', name: 'additional-suffix', value: { kind: 'required', missingValueName: 'SUFFIX' } },
    ],
    help: { summary: 'append SUFFIX to output file names', valueName: 'SUFFIX', category: 'common' },
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'verbose', value: true }] },
    forms: [
      { kind: 'long', name: 'verbose', value: { kind: 'none' } },
    ],
    help: { summary: 'print a diagnostic before each output file is opened', category: 'common' },
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
    forms: [
      { kind: 'long', name: 'help', value: { kind: 'none' } },
    ],
    help: { summary: 'display this help and exit', category: 'common' },
  },
] as const;

type SplitArgvTag = 'numericSuffixes' | 'legacyLineCount';
const splitArgvCatalog = defineArgvCatalog<StandardArgvAction<SplitArgvTag>>({
  nonExecutableLongOptions: [],
  definitions: [
    ...splitArgvOptions,
    {
      // Number-looking tokens can be option values or operands too. The scanner
      // owns that distinction, and split checks the obsolete spelling itself.
      semantic: { kind: 'deferred', tag: 'legacyLineCount' },
      forms: Array.from({ length: 10 }, (_, digit) => ({
        kind: 'short',
        name: String(digit),
        value: { kind: 'optional-attached' },
      })),
    },
  ],
});
export const splitArgvHelp = defineArgvHelpPresentation({
  catalog: splitArgvCatalog,
  rows: splitArgvOptions.map(({ forms, help }) => ({ forms, ...help })),
});
const splitArgvPolicy: StandardArgvPolicy = {
  longNameMatch: 'exact',
  optionBoundary: 'continue',
  occurrenceRetention: 'all',
};

export function buildSplitOptions({
  optionValues,
}: {
  optionValues: Record<string, boolean | string | number>,
}): { ok: true, options: SplitOptions } | { ok: false, message: string } {
  const hasLines = typeof optionValues.lines === 'number';
  const hasBytes = typeof optionValues.bytes === 'number';
  const hasLineBytes = typeof optionValues.lineBytes === 'number';
  if ([hasLines, hasBytes, hasLineBytes].filter(Boolean).length > 1) {
    return { ok: false, message: 'cannot split in more than one way' };
  }

  const mode: SplitMode = hasBytes
    ? { kind: 'bytes', size: optionValues.bytes as number }
    : hasLineBytes
      ? { kind: 'lineBytes', size: optionValues.lineBytes as number }
      : { kind: 'lines', count: hasLines ? optionValues.lines as number : 1000 };

  const explicitSuffixLength = typeof optionValues.suffixLength === 'number'
    ? optionValues.suffixLength
    : undefined;
  const numericSuffixStart = typeof optionValues.numericSuffixStart === 'number'
    ? optionValues.numericSuffixStart
    : 0;
  const suffixMode: SuffixMode = optionValues.numericSuffixes === true
    ? { kind: 'numeric', start: numericSuffixStart }
    : { kind: 'alphabetic' };
  const mayAutoExpand = suffixMode.kind === 'alphabetic'
    || (
      optionValues.numericSuffixAutoExpand === true
      && optionValues.numericSuffixStartExplicit !== true
    );
  const suffixLength: SplitSuffixLength = explicitSuffixLength === undefined && mayAutoExpand
    ? { kind: 'auto', initialLength: 2 }
    : { kind: 'fixed', length: explicitSuffixLength ?? 2 };

  return {
    ok: true,
    options: {
      mode,
      suffixLength,
      suffixMode,
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
  positionals: readonly string[],
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

export function parseSplitArgv({ args }: { args: readonly string[] }):
  | { kind: 'help' }
  | { kind: 'error', message: string }
  | { kind: 'ok', options: SplitOptions, operands: SplitOperands } {
  const parsed = parseStandardArgv({
    args: stopArgvAtFirstEarlyExit({
      args,
      catalog: splitArgvCatalog,
      policy: splitArgvPolicy,
      earlyExitOptions: HELP_EARLY_EXIT_OPTIONS,
    }),
    catalog: splitArgvCatalog,
    policy: splitArgvPolicy,
  });

  const diagnostic = parsed.diagnostics[0];
  const malformed = parsed.deferred.find(occurrence => occurrence.semantic.tag === 'legacyLineCount'
    && !/^-d*\d+$/u.test(args[occurrence.argvIndex] ?? ''));
  if (malformed !== undefined && (diagnostic === undefined || malformed.argvIndex < diagnostic.argvIndex)) {
    const digit = args[malformed.argvIndex]?.[malformed.tokenStart];
    return { kind: 'error', message: `invalid option -- '${digit}'` };
  }
  if (diagnostic !== undefined) {
    return { kind: 'error', message: diagnostic.message };
  }
  if (parsed.optionValues.help === true) {
    return { kind: 'help' };
  }

  const modernModes = (parsed.occurrences ?? []).filter(({ semantic }) => semantic.kind === 'required-value'
    && (semantic.key === 'lines' || semantic.key === 'bytes' || semantic.key === 'lineBytes')).length;
  const optionValues = { ...parsed.optionValues };
  let legacyLineCount: number | undefined;
  let numericSuffixError: string | undefined;
  let legacyLineCountError: string | undefined;
  for (const { semantic, argvIndex, tokenStart, value } of parsed.deferred) {
    const tag = semantic.tag;
    switch (tag) {
    case 'numericSuffixes': {
      optionValues.numericSuffixes = true;
      if (!('rawValue' in value)) {
        optionValues.numericSuffixAutoExpand = true;
        break;
      }
      const start = parseNumericSuffixStart({ rawValue: value.rawValue });
      switch (start.kind) {
      case 'invalid':
        numericSuffixError = start.message;
        break;
      case 'parsed':
        optionValues.numericSuffixStart = start.value;
        optionValues.numericSuffixStartExplicit = true;
        break;
      default: {
        const _ex: never = start;
        throw new Error(`Unhandled numeric suffix value: ${JSON.stringify(_ex)}`);
      }
      }
      break;
    }
    case 'legacyLineCount': {
      const count = parseLineCount({ rawValue: args[argvIndex]!.slice(tokenStart) });
      switch (count.kind) {
      case 'invalid':
        legacyLineCountError = count.message;
        break;
      case 'parsed':
        legacyLineCount = count.value;
        break;
      default: {
        const _ex: never = count;
        throw new Error(`Unhandled obsolete line count: ${JSON.stringify(_ex)}`);
      }
      }
      break;
    }
    default: {
      const _ex: never = tag;
      throw new Error(`Unhandled split argument: ${_ex}`);
    }
    }
  }
  if (modernModes > 1 || (modernModes > 0 && legacyLineCount !== undefined)) {
    return { kind: 'error', message: 'cannot split in more than one way' };
  }
  const valueError = numericSuffixError ?? legacyLineCountError;
  if (valueError !== undefined) {
    return { kind: 'error', message: valueError };
  }
  if (legacyLineCount !== undefined) {
    optionValues.lines = legacyLineCount;
  }

  const options = buildSplitOptions({ optionValues });
  if (!options.ok) {
    return { kind: 'error', message: options.message };
  }
  const operands = parseSplitOperands({ positionals: parsed.positionals });
  if (!operands.ok) {
    return { kind: 'error', message: operands.message };
  }
  return { kind: 'ok', options: options.options, operands: operands.operands };
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
