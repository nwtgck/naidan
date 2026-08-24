import { exceedsSafeRegularExpressionInputLimit } from '@/features/wesh/commands/_shared/backtracking-safety';
import { foldAsciiCase, uppercaseAscii } from '@/features/wesh/commands/_shared/locale';
import type { AwkAssignmentOperator, AwkAssignmentTarget, AwkBinaryOperator, AwkExpression, AwkFunctionDefinition, AwkNumericString, AwkPattern, AwkProgram, AwkStatement, AwkUnaryOperator, AwkValue } from './types';
import { findPosixLeftmostLongestMatch, splitByPosixLeftmostLongestMatches } from '@/features/wesh/commands/_shared/posix-regexp';
import { compileAwkRegularExpression } from '@/features/wesh/commands/awk/regexp';

const float64BitsView = new DataView(new ArrayBuffer(8));
const AWK_MAX_MATERIALIZED_FIELD_COUNT = 100_000;
const AWK_MAX_PRINTF_WIDTH = 1_000_000;
const AWK_MAX_PRINTF_PRECISION = 100;

type AwkStatementControl = 'normal' | 'next' | 'break' | 'continue_loop' | 'exit' | 'return';

class AwkFunctionExitControl {
}

export function isAwkFunctionExitControl({ error }: { error: unknown }): boolean {
  return error instanceof AwkFunctionExitControl;
}

interface AwkRecord {
  text: string,
  fields: AwkValue[],
  hadNewline: boolean,
}

interface AwkArrayAliasTarget {
  getEntries(): Map<string, AwkValue> | undefined,
  setEntries({ entries }: { entries: Map<string, AwkValue> }): void,
}

interface AwkCallFrame {
  locals: Set<string>,
  scalars: Map<string, AwkValue>,
  arrays: Map<string, Map<string, AwkValue>>,
  arrayAliasTargets: Map<string, AwkArrayAliasTarget>,
  returnValue: AwkValue,
}

export interface AwkRuntimeState {
  variables: Map<string, AwkValue>,
  arrays: Map<string, Map<string, AwkValue>>,
  currentRecord: AwkRecord | undefined,
  nr: number,
  fnr: number,
  filename: string,
  exitCode: number | undefined,
  nextFileRequested: boolean,
  randomSeed: number,
  randomState: number,
  functions: Map<string, AwkFunctionDefinition>,
  callFrames: AwkCallFrame[],
  outputTarget: string[],
  outputRedirections: Map<string, { open: boolean }>,
  outputCommandPipes: Map<string, string[]>,
  outputCommandSequences: Map<string, number>,
  completedOutputCommands: Map<number, string>,
  nextOutputCommandSequence: number,
  nextOutputCommandSequenceToFlush: number,
  outputCommandFlushOrderingActive: boolean,
  ioChain: Promise<void>,
  writeRedirect({ path, mode, text }: {
    path: string,
    mode: 'truncate' | 'append',
    text: string,
  }): Promise<void>,
  readCurrentInput(): Promise<{ status: -1 | 0 | 1, record: AwkRecord | undefined }>,
  readFileInput({ path }: { path: string }): Promise<{ status: -1 | 0 | 1, record: AwkRecord | undefined }>,
  readCommandInput({ command }: { command: string }): Promise<{ status: -1 | 0 | 1, record: AwkRecord | undefined }>,
  closeInput({ path }: { path: string }): Promise<number | undefined>,
  flushOutput({ output }: { output: string[] }): Promise<void>,
  executeSystem({ script, output }: { script: string, output: string[] }): Promise<number>,
  executeOutputPipe({ command, input }: {
    command: string,
    input: string,
  }): Promise<{ exitCode: number, output: string }>,
  rangePatternStates: Map<AwkPattern, boolean>,
}

function isNumericLike({
  value,
}: {
  value: string,
}): boolean {
  return /^[ \t]*[-+]?(?:\d+\.?\d*|\.\d+)[ \t]*$/.test(value);
}

function createInputValue({ value }: { value: string }): AwkValue {
  if (!isNumericLike({ value })) return value;
  return {
    kind: 'numeric-string',
    text: value,
    numberValue: Number(value),
  } satisfies AwkNumericString;
}

function isNumericString(value: AwkValue): value is AwkNumericString {
  return typeof value === 'object' && !(value instanceof RegExp) && value.kind === 'numeric-string';
}

function coerceToNumber({
  value,
}: {
  value: AwkValue,
}): number {
  switch (typeof value) {
  case 'number':
    return value;
  case 'string': {
    const numericPrefix = value.match(/^[ \t]*[-+]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][-+]?\d+)?/);
    return numericPrefix?.[0] === undefined ? 0 : Number(numericPrefix[0]);
  }
  case 'object':
    return value instanceof RegExp ? 0 : value.numberValue;
  default:
    return 0;
  }
}

function roundAbsoluteNumberToDecimalInteger({
  value,
  decimalPlaces,
}: {
  value: number,
  decimalPlaces: number,
}): bigint {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('awk: internal decimal rounding requires a finite non-negative value');
  }
  if (value === 0) return 0n;

  float64BitsView.setFloat64(0, value, false);
  const bits = float64BitsView.getBigUint64(0, false);
  const exponentBits = Number((bits >> 52n) & 0x7ffn);
  const fractionBits = bits & ((1n << 52n) - 1n);
  const significand = exponentBits === 0
    ? fractionBits
    : (1n << 52n) | fractionBits;
  const exponent2 = exponentBits === 0
    ? -1074
    : exponentBits - 1023 - 52;

  let numerator = significand;
  let denominator = 1n;
  if (exponent2 >= 0) {
    numerator <<= BigInt(exponent2);
  } else {
    denominator <<= BigInt(-exponent2);
  }
  if (decimalPlaces >= 0) {
    numerator *= 10n ** BigInt(decimalPlaces);
  } else {
    denominator *= 10n ** BigInt(-decimalPlaces);
  }

  let quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const doubledRemainder = remainder * 2n;
  if (
    doubledRemainder > denominator
    || (doubledRemainder === denominator && quotient % 2n !== 0n)
  ) {
    quotient += 1n;
  }
  return quotient;
}

function formatFixedNumber({
  value,
  precision,
}: {
  value: number,
  precision: number,
}): string {
  if (!Number.isFinite(value)) return coerceToString({ value });
  const negative = value < 0 || Object.is(value, -0);
  const rounded = roundAbsoluteNumberToDecimalInteger({
    value: Math.abs(value),
    decimalPlaces: precision,
  });
  const digits = rounded.toString().padStart(precision + 1, '0');
  const unsigned = precision === 0
    ? digits
    : `${digits.slice(0, -precision)}.${digits.slice(-precision)}`;
  return negative ? `-${unsigned}` : unsigned;
}

function formatExponentialNumber({
  value,
  precision,
  uppercase,
}: {
  value: number,
  precision: number,
  uppercase: boolean,
}): string {
  if (!Number.isFinite(value)) return coerceToString({ value });
  const negative = value < 0 || Object.is(value, -0);
  const absolute = Math.abs(value);
  let exponent = absolute === 0 ? 0 : Math.floor(Math.log10(absolute));
  while (absolute !== 0 && absolute < 10 ** exponent) exponent -= 1;
  while (absolute >= 10 ** (exponent + 1)) exponent += 1;

  let rounded = roundAbsoluteNumberToDecimalInteger({
    value: absolute,
    decimalPlaces: precision - exponent,
  });
  const digitCount = precision + 1;
  const carryLimit = 10n ** BigInt(digitCount);
  if (rounded >= carryLimit) {
    rounded /= 10n;
    exponent += 1;
  }
  const digits = rounded.toString().padStart(digitCount, '0');
  const mantissa = precision === 0
    ? digits
    : `${digits[0]}.${digits.slice(1)}`;
  const marker = uppercase ? 'E' : 'e';
  const exponentSign = exponent < 0 ? '-' : '+';
  const rendered = `${mantissa}${marker}${exponentSign}${String(Math.abs(exponent)).padStart(2, '0')}`;
  return negative ? `-${rendered}` : rendered;
}

function formatGeneralNumber({
  value,
  precision,
}: {
  value: number,
  precision: number,
}): string {
  if (value === 0) return Object.is(value, -0) ? '-0' : '0';
  const exponent = Math.floor(Math.log10(Math.abs(value)));
  if (exponent < -4 || exponent >= precision) {
    return formatExponentialNumber({
      value,
      precision: Math.max(0, precision - 1),
      uppercase: false,
    }).replace(/(\.\d*?[1-9])0+(e)/, '$1$2').replace(/\.0+(e)/, '$1');
  }

  const fractionDigits = Math.max(0, precision - 1 - exponent);
  return formatFixedNumber({ value, precision: fractionDigits })
    .replace(/(\.\d*?[1-9])0+$/, '$1')
    .replace(/\.0+$/, '');
}

function coerceToString({
  value,
}: {
  value: AwkValue,
}): string {
  if (value instanceof RegExp) {
    return value.source;
  }

  if (isNumericString(value)) return value.text;

  if (typeof value === 'number') {
    if (value === Number.POSITIVE_INFINITY) return '+inf';
    if (value === Number.NEGATIVE_INFINITY) return '-inf';
    if (Number.isNaN(value)) {
      float64BitsView.setFloat64(0, value, false);
      return (float64BitsView.getBigUint64(0, false) >> 63n) === 1n ? '-nan' : '+nan';
    }
    if (Number.isInteger(value)) return String(value);
    return formatGeneralNumber({ value, precision: 6 });
  }

  return String(value);
}

function formatNumberUsingAwkFormat({
  value,
  format,
}: {
  value: number,
  format: string,
}): string {
  if (!Number.isFinite(value)) return coerceToString({ value });
  if (Number.isInteger(value)) return String(value);
  return formatPrintfOutput({
    format,
    argumentsList: [value],
  });
}

function coerceToPrintString({
  value,
  state,
}: {
  value: AwkValue,
  state: AwkRuntimeState,
}): string {
  if (typeof value !== 'number') return coerceToString({ value });
  return formatNumberUsingAwkFormat({
    value,
    format: coerceToString({ value: getVariable({ state, name: 'OFMT' }) }),
  });
}

function coerceToConcatenationString({
  value,
  state,
}: {
  value: AwkValue,
  state: AwkRuntimeState,
}): string {
  if (typeof value !== 'number') return coerceToString({ value });
  return formatNumberUsingAwkFormat({
    value,
    format: coerceToString({ value: getVariable({ state, name: 'CONVFMT' }) }),
  });
}

function testAwkRegularExpression({
  regex,
  input,
}: {
  regex: RegExp;
  input: string;
}): boolean {
  if (exceedsSafeRegularExpressionInputLimit({ regex, input })) {
    throw new Error('awk: regular expression input exceeds the safe backtracking limit');
  }
  regex.lastIndex = 0;
  return regex.test(input);
}

function coerceToRegex({
  value,
}: {
  value: AwkValue,
}): RegExp {
  switch (typeof value) {
  case 'number':
    return compileAwkRegularExpression({ source: String(value), flags: '' });
  case 'string':
    return compileAwkRegularExpression({ source: value, flags: '' });
  case 'object':
    return value instanceof RegExp
      ? value
      : compileAwkRegularExpression({ source: value.text, flags: '' });
  default:
    throw new Error('Unhandled awk regex value');
  }
}

async function evaluateRegexOperand({
  expression,
  state,
}: {
  expression: AwkExpression,
  state: AwkRuntimeState,
}): Promise<RegExp> {
  // eslint-disable-next-line local-rules-switch/force-switch-for-union -- Regex literals need one fast path; all other expressions share coercion.
  if (expression.kind === 'regex') return expression.value;
  return coerceToRegex({ value: await evaluateExpression({ expression, state }) });
}

function isTruthy({
  value,
}: {
  value: AwkValue,
}): boolean {
  switch (typeof value) {
  case 'number':
    return value !== 0;
  case 'string':
    return value.length > 0;
  case 'object':
    return value instanceof RegExp ? true : value.numberValue !== 0;
  default:
    return true;
  }
}

function splitFields({
  line,
  fieldSeparator,
}: {
  line: string,
  fieldSeparator: string | RegExp,
}): AwkValue[] {
  if (typeof fieldSeparator === 'string') {
    if (fieldSeparator === '') {
      return Array.from(line, (value) => createInputValue({ value }));
    }

    if (fieldSeparator === ' ') {
      const trimmed = line.replace(/^[ \t\n]+|[ \t\n]+$/gu, '');
      return trimmed === '' ? [] : trimmed.split(/[ \t\n]+/u).map((value) => createInputValue({ value }));
    }

    if (fieldSeparator.length === 1) {
      return line.split(fieldSeparator).map((value) => createInputValue({ value }));
    }

    const regex = compileAwkRegularExpression({
      source: fieldSeparator,
      flags: '',
    });
    return splitByPosixLeftmostLongestMatches({ regex, source: line })
      .map((part) => createInputValue({ value: part.text }));
  }

  return splitByPosixLeftmostLongestMatches({ regex: fieldSeparator, source: line })
    .map((part) => createInputValue({ value: part.text }));
}

function getVariable({
  state,
  name,
}: {
  state: AwkRuntimeState,
  name: string,
}): AwkValue {
  switch (name) {
  case 'NR':
    return state.nr;
  case 'FNR':
    return state.fnr;
  case 'NF':
    return state.currentRecord?.fields.length ?? 0;
  case 'FILENAME':
    return state.filename;
  case 'FS':
  case 'OFS':
  case 'ORS':
  case 'RS':
  case 'OFMT':
  case 'CONVFMT':
  case 'SUBSEP':
    return state.variables.get(name) ?? '';
  default: {
    const frame = state.callFrames.at(-1);
    if (frame?.locals.has(name) === true) {
      if (frame.scalars.has(name)) return frame.scalars.get(name) ?? '';
      if (
        frame.arrays.has(name)
        || frame.arrayAliasTargets.get(name)?.getEntries() !== undefined
      ) {
        throw new Error(`awk: illegal reference to array ${name}`);
      }
      return '';
    }
    if (state.arrays.has(name)) {
      throw new Error(`awk: illegal reference to array ${name}`);
    }
    return state.variables.get(name) ?? '';
  }
  }
}

function getArrayEntries({
  state,
  name,
}: {
  state: AwkRuntimeState,
  name: string,
}): Map<string, AwkValue> | undefined {
  const frame = state.callFrames.at(-1);
  if (frame?.locals.has(name) === true) {
    return frame.arrays.get(name)
      ?? frame.arrayAliasTargets.get(name)?.getEntries();
  }
  return state.arrays.get(name);
}

function resolveArrayAliasTarget({
  state,
  name,
}: {
  state: AwkRuntimeState,
  name: string,
}): AwkArrayAliasTarget | undefined {
  const frame = state.callFrames.at(-1);
  if (frame?.locals.has(name) === true) {
    if (frame.scalars.has(name)) return undefined;
    const inherited = frame.arrayAliasTargets.get(name);
    if (inherited !== undefined) return inherited;
    return {
      getEntries: () => frame.arrays.get(name),
      setEntries: ({ entries }) => frame.arrays.set(name, entries),
    };
  }
  if (state.variables.has(name)) return undefined;
  return {
    getEntries: () => state.arrays.get(name),
    setEntries: ({ entries }) => state.arrays.set(name, entries),
  };
}

function getArrayValue({
  state,
  name,
  index,
}: {
  state: AwkRuntimeState,
  name: string,
  index: string,
}): AwkValue {
  return requireArrayEntries({ state, name }).get(index) ?? '';
}

function requireArrayEntries({
  state,
  name,
}: {
  state: AwkRuntimeState,
  name: string,
}): Map<string, AwkValue> {
  const entries = getArrayEntries({ state, name });
  if (entries !== undefined) return entries;

  const frame = state.callFrames.at(-1);
  if (frame?.locals.has(name) === true) {
    if (frame.scalars.has(name)) {
      throw new Error(`awk: '${name}' is not an array`);
    }
    const localEntries = new Map<string, AwkValue>();
    frame.arrays.set(name, localEntries);
    frame.arrayAliasTargets.get(name)?.setEntries({ entries: localEntries });
    return localEntries;
  }
  if (state.variables.has(name)) {
    throw new Error(`awk: '${name}' is not an array`);
  }
  const globalEntries = new Map<string, AwkValue>();
  state.arrays.set(name, globalEntries);
  return globalEntries;
}

function setVariable({
  state,
  name,
  value,
}: {
  state: AwkRuntimeState,
  name: string,
  value: AwkValue,
}): void {
  switch (name) {
  case 'NR':
    state.nr = coerceToNumber({ value });
    return;
  case 'FNR':
    state.fnr = coerceToNumber({ value });
    return;
  case 'FILENAME':
    state.filename = coerceToString({ value });
    return;
  case 'NF': {
    const nextFieldCount = Math.max(0, Math.trunc(coerceToNumber({ value })));
    const currentRecord = state.currentRecord ?? {
      text: '',
      fields: [],
      hadNewline: false,
    };
    if (
      (!Number.isFinite(nextFieldCount) || nextFieldCount > AWK_MAX_MATERIALIZED_FIELD_COUNT)
      && nextFieldCount > currentRecord.fields.length
    ) {
      throw new Error(`awk: field count ${nextFieldCount} exceeds safety limit ${AWK_MAX_MATERIALIZED_FIELD_COUNT}`);
    }
    const fields = currentRecord.fields.slice(0, nextFieldCount);
    if (fields.length < nextFieldCount) {
      const previousLength = fields.length;
      fields.length = nextFieldCount;
      fields.fill('', previousLength);
    }
    const outputFieldSeparator = coerceToString({ value: getVariable({ state, name: 'OFS' }) });
    state.currentRecord = {
      ...currentRecord,
      fields,
      text: fields.map((field) => coerceToString({ value: field })).join(outputFieldSeparator),
    };
    return;
  }
  default:
    break;
  }

  const frame = state.callFrames.at(-1);
  if (frame?.locals.has(name) === true) {
    if (
      frame.arrays.has(name)
      || frame.arrayAliasTargets.get(name)?.getEntries() !== undefined
    ) {
      throw new Error(`awk: illegal reference to array ${name}`);
    }
    frame.scalars.set(name, value);
    frame.arrayAliasTargets.delete(name);
    return;
  }

  if (state.arrays.has(name)) {
    throw new Error(`awk: illegal reference to array ${name}`);
  }

  state.variables.set(name, value);
}

async function resolveFieldIndex({
  state,
  expression,
}: {
  state: AwkRuntimeState,
  expression: AwkExpression,
}): Promise<number> {
  const index = Math.trunc(coerceToNumber({
    value: await evaluateExpression({ expression, state }),
  }));
  if (index < 0) {
    throw new Error(`awk: negative field index ${index}`);
  }
  return index;
}

function setCurrentRecord({
  state,
  record,
}: {
  state: AwkRuntimeState,
  record: AwkRecord,
}): void {
  const fieldSeparator = coerceToString({ value: getVariable({ state, name: 'FS' }) });
  state.currentRecord = {
    ...record,
    fields: splitFields({
      line: record.text,
      fieldSeparator,
    }),
  };
}

function setCurrentRecordText({
  state,
  text,
}: {
  state: AwkRuntimeState,
  text: string,
}): void {
  const fieldSeparator = coerceToString({ value: getVariable({ state, name: 'FS' }) });
  state.currentRecord = {
    ...(state.currentRecord ?? { hadNewline: false }),
    text,
    fields: splitFields({
      line: text,
      fieldSeparator,
    }),
  };
}

function setFieldValue({
  state,
  index,
  value,
}: {
  state: AwkRuntimeState,
  index: number,
  value: AwkValue,
}): void {
  if (index === 0) {
    setCurrentRecordText({ state, text: coerceToString({ value }) });
    return;
  }

  const currentRecord = state.currentRecord ?? {
    text: '',
    fields: [],
    hadNewline: false,
  };
  if (
    (!Number.isFinite(index) || index > AWK_MAX_MATERIALIZED_FIELD_COUNT)
    && index > currentRecord.fields.length
  ) {
    throw new Error(`awk: field index ${index} exceeds safety limit ${AWK_MAX_MATERIALIZED_FIELD_COUNT}`);
  }
  const fields = [...currentRecord.fields];
  if (fields.length < index) {
    const previousLength = fields.length;
    fields.length = index;
    fields.fill('', previousLength);
  }
  fields[index - 1] = value;

  const outputFieldSeparator = coerceToString({ value: getVariable({ state, name: 'OFS' }) });
  state.currentRecord = {
    ...currentRecord,
    fields,
    text: fields.map((field) => coerceToString({ value: field })).join(outputFieldSeparator),
  };
}

function setArrayValue({
  state,
  name,
  index,
  value,
}: {
  state: AwkRuntimeState,
  name: string,
  index: string,
  value: AwkValue,
}): void {
  const frame = state.callFrames.at(-1);
  if (frame?.locals.has(name) === true) {
    if (frame.scalars.has(name)) {
      throw new Error(`awk: illegal reference to variable ${name}`);
    }
    let localEntries = frame.arrays.get(name);
    if (localEntries === undefined) {
      const aliasTarget = frame.arrayAliasTargets.get(name);
      localEntries = aliasTarget?.getEntries() ?? new Map<string, AwkValue>();
      aliasTarget?.setEntries({ entries: localEntries });
      frame.arrays.set(name, localEntries);
    }
    localEntries.set(index, value);
    return;
  }

  if (state.variables.has(name)) {
    throw new Error(`awk: illegal reference to variable ${name}`);
  }
  let entries = state.arrays.get(name);
  if (entries === undefined) {
    entries = new Map<string, AwkValue>();
    state.arrays.set(name, entries);
  }
  entries.set(index, value);
}

function clearArray({
  state,
  name,
}: {
  state: AwkRuntimeState,
  name: string,
}): Map<string, AwkValue> {
  const frame = state.callFrames.at(-1);
  if (frame?.locals.has(name) === true) {
    if (frame.scalars.has(name)) {
      throw new Error(`awk: illegal reference to variable ${name}`);
    }
    let localEntries = frame.arrays.get(name);
    if (localEntries === undefined) {
      const aliasTarget = frame.arrayAliasTargets.get(name);
      localEntries = aliasTarget?.getEntries() ?? new Map<string, AwkValue>();
      aliasTarget?.setEntries({ entries: localEntries });
      frame.arrays.set(name, localEntries);
    } else {
      localEntries.clear();
    }
    return localEntries;
  }

  if (state.variables.has(name)) {
    throw new Error(`awk: illegal reference to variable ${name}`);
  }
  const globalEntries = state.arrays.get(name);
  if (globalEntries !== undefined) {
    globalEntries.clear();
    return globalEntries;
  }

  const entries = new Map<string, AwkValue>();
  state.arrays.set(name, entries);
  return entries;
}

function applyAwkReplacement({
  replacement,
  match,
}: {
  replacement: string,
  match: string,
}): string {
  let output = '';

  for (let index = 0; index < replacement.length; index += 1) {
    const char = replacement[index];
    const nextChar = replacement[index + 1];

    if (char === '\\' && nextChar !== undefined) {
      if (nextChar === '&' || nextChar === '\\') {
        output += nextChar;
        index += 1;
        continue;
      }
    }

    if (char === '&') {
      output += match;
      continue;
    }

    output += char;
  }

  return output;
}

function replaceInText({
  source,
  pattern,
  replacement,
  mode,
}: {
  source: string,
  pattern: RegExp,
  replacement: string,
  mode: 'first' | 'global',
}): { text: string, count: number } {
  const regex = new RegExp(pattern.source, pattern.flags.replace(/g/g, ''));

  switch (mode) {
  case 'first': {
    const match = findPosixLeftmostLongestMatch({ regex, source, startIndex: 0 });
    if (match === undefined) return { text: source, count: 0 };
    return {
      text: source.slice(0, match.index)
        + applyAwkReplacement({ replacement, match: match.text })
        + source.slice(match.index + match.text.length),
      count: 1,
    };
  }
  case 'global': {
    let count = 0;
    let cursor = 0;
    let searchIndex = 0;
    let previousNonEmptyMatchEnd = -1;
    let text = '';

    while (searchIndex <= source.length) {
      const match = findPosixLeftmostLongestMatch({
        regex,
        source,
        startIndex: searchIndex,
      });
      if (match === undefined) break;

      const matched = match.text;
      const start = match.index;
      const end = start + matched.length;
      if (matched.length === 0 && start === previousNonEmptyMatchEnd) {
        if (start >= source.length) break;
        const codePoint = source.codePointAt(start);
        const nextIndex = start + (codePoint !== undefined && codePoint > 0xffff ? 2 : 1);
        text += source.slice(cursor, nextIndex);
        cursor = nextIndex;
        searchIndex = nextIndex;
        previousNonEmptyMatchEnd = -1;
        continue;
      }

      text += source.slice(cursor, start);
      text += applyAwkReplacement({ replacement, match: matched });
      count += 1;

      if (matched.length > 0) {
        cursor = end;
        searchIndex = end;
        previousNonEmptyMatchEnd = end;
        continue;
      }

      if (start >= source.length) {
        cursor = start;
        break;
      }

      const codePoint = source.codePointAt(start);
      const nextIndex = start + (codePoint !== undefined && codePoint > 0xffff ? 2 : 1);
      text += source.slice(start, nextIndex);
      cursor = nextIndex;
      searchIndex = nextIndex;
      previousNonEmptyMatchEnd = -1;
    }

    text += source.slice(cursor);
    return { text, count };
  }
  default: {
    const _ex: never = mode;
    throw new Error(`Unhandled substitution mode: ${_ex}`);
  }
  }
}

async function applySubstitution({
  state,
  expression,
  mode,
}: {
  state: AwkRuntimeState,
  expression: Extract<AwkExpression, { kind: 'call' }>,
  mode: 'first' | 'global',
}): Promise<number> {
  const pattern = await evaluateRegexOperand({
    expression: expression.args[0] ?? { kind: 'string', value: '' },
    state,
  });
  const replacement = coerceToString({
    value: await evaluateExpression({
      expression: expression.args[1] ?? { kind: 'string', value: '' },
      state,
    }),
  });

  const targetExpression = expression.args[2];
  if (targetExpression === undefined) {
    const source = state.currentRecord?.text ?? '';
    const result = replaceInText({
      source,
      pattern,
      replacement,
      mode,
    });
    setCurrentRecordText({
      state,
      text: result.text,
    });
    return result.count;
  }

  switch (targetExpression.kind) {
  case 'identifier': {
    const source = coerceToString({
      value: getVariable({
        state,
        name: targetExpression.name,
      }),
    });
    const result = replaceInText({
      source,
      pattern,
      replacement,
      mode,
    });
    setVariable({
      state,
      name: targetExpression.name,
      value: result.text,
    });
    return result.count;
  }
  case 'indexed': {
    const index = coerceToString({
      value: await evaluateExpression({
        expression: targetExpression.index,
        state,
      }),
    });
    const source = coerceToString({
      value: getArrayValue({
        state,
        name: targetExpression.name,
        index,
      }),
    });
    const result = replaceInText({
      source,
      pattern,
      replacement,
      mode,
    });
    setArrayValue({
      state,
      name: targetExpression.name,
      index,
      value: result.text,
    });
    return result.count;
  }
  case 'field': {
    const fieldIndex = await resolveFieldIndex({ state, expression: targetExpression.index });
    if (fieldIndex === 0) {
      const source = state.currentRecord?.text ?? '';
      const result = replaceInText({
        source,
        pattern,
        replacement,
        mode,
      });
      setCurrentRecordText({
        state,
        text: result.text,
      });
      return result.count;
    }

    const source = coerceToString({ value: state.currentRecord?.fields[fieldIndex - 1] ?? '' });
    const result = replaceInText({
      source,
      pattern,
      replacement,
      mode,
    });
    setFieldValue({
      state,
      index: fieldIndex,
      value: result.text,
    });
    return result.count;
  }
  default:
    throw new Error("awk: sub requires a variable, field, or array element as its third argument");
  }
}

function deleteArrayEntry({
  state,
  name,
  index,
}: {
  state: AwkRuntimeState,
  name: string,
  index: string,
}): void {
  requireArrayEntries({ state, name }).delete(index);
}

async function getAssignmentTargetValue({
  state,
  target,
}: {
  state: AwkRuntimeState,
  target: AwkAssignmentTarget,
}): Promise<AwkValue> {
  switch (target.kind) {
  case 'variable':
    return getVariable({ state, name: target.name });
  case 'indexed':
    return getArrayValue({
      state,
      name: target.name,
      index: coerceToString({
        value: await evaluateExpression({ expression: target.index, state }),
      }),
    });
  case 'field': {
    const index = await resolveFieldIndex({ state, expression: target.index });
    return index === 0
      ? state.currentRecord?.text ?? ''
      : state.currentRecord?.fields[index - 1] ?? '';
  }
  default: {
    const _ex: never = target;
    throw new Error(`Unhandled awk assignment target: ${JSON.stringify(_ex)}`);
  }
  }
}

async function setAssignmentTargetValue({
  state,
  target,
  value,
}: {
  state: AwkRuntimeState,
  target: AwkAssignmentTarget,
  value: AwkValue,
}): Promise<void> {
  switch (target.kind) {
  case 'variable':
    setVariable({ state, name: target.name, value });
    return;
  case 'indexed':
    setArrayValue({
      state,
      name: target.name,
      index: coerceToString({
        value: await evaluateExpression({ expression: target.index, state }),
      }),
      value,
    });
    return;
  case 'field':
    setFieldValue({
      state,
      index: await resolveFieldIndex({ state, expression: target.index }),
      value: coerceToString({ value }),
    });
    return;
  default: {
    const _ex: never = target;
    throw new Error(`Unhandled awk assignment target: ${JSON.stringify(_ex)}`);
  }
  }
}

function applyAssignmentOperator({
  operator,
  current,
  right,
}: {
  operator: AwkAssignmentOperator,
  current: AwkValue,
  right: AwkValue,
}): AwkValue {
  switch (operator) {
  case '=':
    return right;
  case '+=':
    return coerceToNumber({ value: current }) + coerceToNumber({ value: right });
  case '-=':
    return coerceToNumber({ value: current }) - coerceToNumber({ value: right });
  case '*=':
    return coerceToNumber({ value: current }) * coerceToNumber({ value: right });
  case '/=':
    return coerceToNumber({ value: current }) / coerceToNumber({ value: right });
  case '%=':
    return coerceToNumber({ value: current }) % coerceToNumber({ value: right });
  case '^=':
    return coerceToNumber({ value: current }) ** coerceToNumber({ value: right });
  default: {
    const _ex: never = operator;
    throw new Error(`Unhandled awk assignment operator: ${_ex}`);
  }
  }
}

async function updateTarget({
  state,
  target,
  operator,
  position,
}: {
  state: AwkRuntimeState,
  target: Extract<AwkExpression, { kind: 'update' }>['target'],
  operator: Extract<AwkExpression, { kind: 'update' }>['operator'],
  position: Extract<AwkExpression, { kind: 'update' }>['position'],
}): Promise<AwkValue> {
  const delta = (() => {
    switch (operator) {
    case '++':
      return 1;
    case '--':
      return -1;
    default: {
      const _ex: never = operator;
      throw new Error(`Unhandled awk update operator: ${_ex}`);
    }
    }
  })();

  const selectReturnValue = ({
    currentNumber,
    nextValue,
  }: {
    currentNumber: number,
    nextValue: number,
  }): number => {
    switch (position) {
    case 'prefix':
      return nextValue;
    case 'postfix':
      return currentNumber;
    default: {
      const _ex: never = position;
      throw new Error(`Unhandled awk update position: ${_ex}`);
    }
    }
  };

  switch (target.kind) {
  case 'variable':
  case 'indexed':
  case 'field': {
    const current = await getAssignmentTargetValue({ state, target });
    const currentNumber = coerceToNumber({ value: current });
    const nextValue = currentNumber + delta;
    await setAssignmentTargetValue({ state, target, value: nextValue });
    return selectReturnValue({ currentNumber, nextValue });
  }
  default: {
    const _ex: never = target;
    throw new Error(`Unhandled awk update target: ${JSON.stringify(_ex)}`);
  }
  }
}

function formatPrintfOutput({
  format,
  argumentsList,
}: {
  format: string,
  argumentsList: AwkValue[],
}): string {
  let output = '';
  let argumentIndex = 0;

  for (let index = 0; index < format.length; index += 1) {
    const char = format[index];
    if (char !== '%') {
      output += char;
      continue;
    }

    if (format[index + 1] === '%') {
      output += '%';
      index += 1;
      continue;
    }

    const remainder = format.slice(index + 1);
    const matched = /^([-+ 0#]*)(\*|\d+)?(?:\.(\*|\d+))?([cdeEifgGosuxX])/.exec(remainder);
    if (matched === null) {
      throw new Error(`awk: unsupported printf format '%${format[index + 1] ?? ''}'`);
    }

    const [specifier, parsedFlags = '', widthText, precisionText, conversionRaw] = matched;
    if (conversionRaw === undefined) {
      throw new Error('awk: missing printf conversion');
    }
    const conversion = conversionRaw as 'c' | 'd' | 'e' | 'E' | 'i' | 'f' | 'g' | 'G' | 'o' | 's' | 'u' | 'x' | 'X';
    let flags = parsedFlags;
    const widthArgument = widthText === '*'
      ? Math.trunc(coerceToNumber({ value: argumentsList[argumentIndex++] ?? '' }))
      : undefined;
    const precisionArgument = precisionText === '*'
      ? Math.trunc(coerceToNumber({ value: argumentsList[argumentIndex++] ?? '' }))
      : undefined;
    const width = (() => {
      if (widthArgument !== undefined) {
        if (widthArgument < 0) {
          flags += '-';
          return Math.abs(widthArgument);
        }
        return widthArgument;
      }
      return widthText === undefined ? undefined : Number(widthText);
    })();
    const precision = (() => {
      if (precisionArgument !== undefined) {
        return precisionArgument < 0 ? undefined : precisionArgument;
      }
      return precisionText === undefined ? undefined : Number(precisionText);
    })();
    if (width !== undefined && (!Number.isFinite(width) || width > AWK_MAX_PRINTF_WIDTH)) {
      throw new Error(`awk: printf width ${width} exceeds safety limit ${AWK_MAX_PRINTF_WIDTH}`);
    }
    if (precision !== undefined && (!Number.isFinite(precision) || precision > AWK_MAX_PRINTF_PRECISION)) {
      throw new Error(`awk: printf precision ${precision} exceeds safety limit ${AWK_MAX_PRINTF_PRECISION}`);
    }

    const argument = argumentsList[argumentIndex] ?? '';
    argumentIndex += 1;

    let rendered = (() => {
      switch (conversion) {
      case 's': {
        const value = coerceToString({ value: argument });
        return precision === undefined ? value : value.slice(0, precision);
      }
      case 'd':
      case 'i': {
        const integer = Math.trunc(coerceToNumber({ value: argument }));
        if (precision === 0 && integer === 0) return '';
        const sign = integer < 0 ? '-' : '';
        const digits = String(Math.abs(integer)).padStart(precision ?? 0, '0');
        return `${sign}${digits}`;
      }
      case 'e':
      case 'E':
        return formatExponentialNumber({
          value: coerceToNumber({ value: argument }),
          precision: precision ?? 6,
          uppercase: conversion === 'E',
        });
      case 'f':
        return formatFixedNumber({
          value: coerceToNumber({ value: argument }),
          precision: precision ?? 6,
        });
      case 'g':
      case 'G': {
        const value = coerceToNumber({ value: argument });
        const formatted = formatGeneralNumber({
          value,
          precision: Math.max(1, precision ?? 6),
        });
        switch (conversion) {
        case 'g':
          return formatted;
        case 'G':
          return formatted.toUpperCase();
        default: {
          const _ex: never = conversion;
          throw new Error(`Unhandled awk general conversion: ${_ex}`);
        }
        }
      }
      case 'c': {
        if (typeof argument === 'string' && argument.length > 0) return argument[0] ?? '';
        return String.fromCodePoint(Math.trunc(coerceToNumber({ value: argument })));
      }
      case 'o': {
        const integer = Math.trunc(coerceToNumber({ value: argument })) >>> 0;
        if (precision === 0 && integer === 0) return '';
        return integer.toString(8).padStart(precision ?? 0, '0');
      }
      case 'u': {
        const integer = Math.trunc(coerceToNumber({ value: argument })) >>> 0;
        if (precision === 0 && integer === 0) return '';
        return String(integer).padStart(precision ?? 0, '0');
      }
      case 'x': {
        const integer = Math.trunc(coerceToNumber({ value: argument })) >>> 0;
        if (precision === 0 && integer === 0) return '';
        return integer.toString(16).padStart(precision ?? 0, '0');
      }
      case 'X': {
        const integer = Math.trunc(coerceToNumber({ value: argument })) >>> 0;
        if (precision === 0 && integer === 0) return '';
        return integer.toString(16).toUpperCase().padStart(precision ?? 0, '0');
      }
      default: {
        const _ex: never = conversion;
        throw new Error(`Unhandled awk printf conversion: ${_ex}`);
      }
      }
    })();

    let prefix = '';
    switch (conversion) {
    case 'd':
    case 'e':
    case 'E':
    case 'i':
    case 'f':
    case 'g':
    case 'G':
      if (rendered.startsWith('-')) {
        prefix = '-';
        rendered = rendered.slice(1);
      } else if (flags.includes('+')) {
        prefix = '+';
      } else if (flags.includes(' ')) {
        prefix = ' ';
      }
      break;
    case 'o':
      if (flags.includes('#') && rendered !== '0' && !rendered.startsWith('0')) prefix = '0';
      break;
    case 'x':
      if (flags.includes('#') && coerceToNumber({ value: argument }) !== 0) prefix = '0x';
      break;
    case 'X':
      if (flags.includes('#') && coerceToNumber({ value: argument }) !== 0) prefix = '0X';
      break;
    case 'c':
    case 's':
    case 'u':
      break;
    default: {
      const _ex: never = conversion;
      throw new Error(`Unhandled awk printf conversion flags: ${_ex}`);
    }
    }

    if (flags.includes('#') && conversion === 'f' && !rendered.includes('.')) {
      rendered += '.';
    }

    const unpadded = `${prefix}${rendered}`;
    if (width !== undefined && unpadded.length < width) {
      const integerPrecisionDisablesZeroPadding = precision !== undefined
        && ['d', 'i', 'o', 'u', 'x', 'X'].includes(conversion);
      const paddingCharacter = flags.includes('0')
        && !flags.includes('-')
        && !integerPrecisionDisablesZeroPadding
        ? '0'
        : ' ';
      const padding = paddingCharacter.repeat(width - unpadded.length);
      if (flags.includes('-')) {
        rendered = `${unpadded}${padding}`;
      } else {
        switch (paddingCharacter) {
        case '0':
          rendered = `${prefix}${padding}${rendered}`;
          break;
        case ' ':
          rendered = `${padding}${unpadded}`;
          break;
        default: {
          const _ex: never = paddingCharacter;
          throw new Error(`Unhandled awk padding character: ${_ex}`);
        }
        }
      }
    } else {
      rendered = unpadded;
    }

    output += rendered;
    index += specifier.length;
  }

  return output;
}

async function executeForClausePart({
  part,
  state,
}: {
  part: Extract<AwkStatement, { kind: 'for' }>['initializer'],
  state: AwkRuntimeState,
}): Promise<void> {
  if (part === undefined) return;

  switch (part.kind) {
  case 'assign': {
    const right = await evaluateExpression({ expression: part.expression, state });
    const value = applyAssignmentOperator({
      operator: part.operator,
      current: await getAssignmentTargetValue({ state, target: part.target }),
      right,
    });
    await setAssignmentTargetValue({ state, target: part.target, value });
    return;
  }
  case 'expression':
    await evaluateExpression({ expression: part.expression, state });
    return;
  default: {
    const _ex: never = part;
    throw new Error(`Unhandled awk for clause part: ${JSON.stringify(_ex)}`);
  }
  }
}

function queueRedirectOutput({
  state,
  path,
  operator,
  text,
}: {
  state: AwkRuntimeState,
  path: string,
  operator: '>' | '>>' | '|',
  text: string,
}): void {
  let mode: 'truncate' | 'append';
  switch (operator) {
  case '|': {
    let buffered = state.outputCommandPipes.get(path);
    if (buffered === undefined) {
      buffered = [];
      state.outputCommandPipes.set(path, buffered);
      if (state.outputCommandFlushOrderingActive) {
        state.outputCommandSequences.set(path, state.nextOutputCommandSequence);
        state.nextOutputCommandSequence += 1;
      }
    }
    buffered.push(text);
    return;
  }
  case '>':
    mode = state.outputRedirections.get(path)?.open === true ? 'append' : 'truncate';
    break;
  case '>>':
    mode = 'append';
    break;
  default: {
    const _ex: never = operator;
    throw new Error(`Unhandled awk output redirection operator: ${_ex}`);
  }
  }

  state.outputRedirections.set(path, { open: true });
  state.ioChain = state.ioChain.then(async () => {
    await state.writeRedirect({ path, mode, text });
  });
}

function assignOutputCommandSequence({
  state,
  command,
}: {
  state: AwkRuntimeState,
  command: string,
}): number {
  const existing = state.outputCommandSequences.get(command);
  if (existing !== undefined) return existing;
  const sequence = state.nextOutputCommandSequence;
  state.nextOutputCommandSequence += 1;
  state.outputCommandSequences.set(command, sequence);
  return sequence;
}

async function flushCompletedOutputCommands({
  state,
}: {
  state: AwkRuntimeState,
}): Promise<void> {
  while (true) {
    const output = state.completedOutputCommands.get(state.nextOutputCommandSequenceToFlush);
    if (output === undefined) return;
    state.completedOutputCommands.delete(state.nextOutputCommandSequenceToFlush);
    state.nextOutputCommandSequenceToFlush += 1;
    if (output.length > 0) await state.flushOutput({ output: [output] });
  }
}

async function activateOutputCommandFlushOrdering({
  state,
}: {
  state: AwkRuntimeState,
}): Promise<void> {
  if (state.outputCommandFlushOrderingActive) return;
  await state.flushOutput({ output: state.outputTarget });
  state.outputCommandFlushOrderingActive = true;
  for (const command of state.outputCommandPipes.keys()) {
    assignOutputCommandSequence({ state, command });
  }
}

async function closeCommandOutput({
  state,
  command,
}: {
  state: AwkRuntimeState,
  command: string,
}): Promise<number | undefined> {
  const buffered = state.outputCommandPipes.get(command);
  if (buffered === undefined) return undefined;
  state.outputCommandPipes.delete(command);
  await state.ioChain;

  if (!state.outputCommandFlushOrderingActive) {
    const pendingOutput = state.outputTarget.splice(0, state.outputTarget.length);
    await state.flushOutput({ output: pendingOutput });
    const result = await state.executeOutputPipe({
      command,
      input: buffered.join(''),
    });
    if (result.output.length > 0) await state.flushOutput({ output: [result.output] });
    return result.exitCode;
  }

  const sequence = assignOutputCommandSequence({ state, command });
  state.outputCommandSequences.delete(command);
  const result = await state.executeOutputPipe({
    command,
    input: buffered.join(''),
  });
  state.completedOutputCommands.set(sequence, result.output);
  await flushCompletedOutputCommands({ state });

  if (state.outputCommandPipes.size === 0) {
    await flushCompletedOutputCommands({ state });
    await state.flushOutput({ output: state.outputTarget });
    state.outputCommandFlushOrderingActive = false;
    state.outputCommandSequences.clear();
    state.completedOutputCommands.clear();
    state.nextOutputCommandSequence = 0;
    state.nextOutputCommandSequenceToFlush = 0;
  }
  return result.exitCode;
}

function closeOutputRedirection({
  state,
  path,
}: {
  state: AwkRuntimeState,
  path: string,
}): number {
  const existing = state.outputRedirections.get(path);
  if (existing?.open !== true) return -1;
  existing.open = false;
  return 0;
}

async function executeUserDefinedFunction({
  definition,
  argumentExpressions,
  state,
}: {
  definition: AwkFunctionDefinition,
  argumentExpressions: AwkExpression[],
  state: AwkRuntimeState,
}): Promise<AwkValue> {
  const frame: AwkCallFrame = {
    locals: new Set(definition.parameters),
    scalars: new Map<string, AwkValue>(),
    arrays: new Map<string, Map<string, AwkValue>>(),
    arrayAliasTargets: new Map<string, AwkArrayAliasTarget>(),
    returnValue: '',
  };

  for (const [index, parameter] of definition.parameters.entries()) {
    const argument = argumentExpressions[index];
    if (argument === undefined) continue;
    // eslint-disable-next-line local-rules-switch/force-switch-for-union -- Only identifier arguments can alias AWK arrays; every other expression is scalar.
    if (argument.kind === 'identifier') {
      const array = getArrayEntries({ state, name: argument.name });
      if (array !== undefined) {
        frame.arrays.set(parameter, array);
        continue;
      }
      const aliasTarget = resolveArrayAliasTarget({ state, name: argument.name });
      if (aliasTarget !== undefined) {
        frame.arrayAliasTargets.set(parameter, aliasTarget);
        continue;
      }
    }

    frame.scalars.set(
      parameter,
      await evaluateExpression({ expression: argument, state }),
    );
  }

  state.callFrames.push(frame);
  try {
    for (const statement of definition.statements) {
      const control = await executeStatement({ statement, state, output: state.outputTarget });
      switch (control) {
      case 'normal':
        break;
      case 'return':
        return frame.returnValue;
      case 'next':
      case 'break':
      case 'continue_loop':
        throw new Error(`awk: '${control}' is not supported from a user-defined function`);
      case 'exit':
        throw new AwkFunctionExitControl();
      default: {
        const _ex: never = control;
        throw new Error(`Unhandled awk control flow: ${_ex}`);
      }
      }
    }
    return '';
  } finally {
    state.callFrames.pop();
  }
}

async function evaluateExpressions({
  expressions,
  state,
}: {
  expressions: AwkExpression[],
  state: AwkRuntimeState,
}): Promise<AwkValue[]> {
  const values: AwkValue[] = [];
  for (const expression of expressions) {
    values.push(await evaluateExpression({ expression, state }));
  }
  return values;
}

async function evaluateExpression({
  expression,
  state,
}: {
  expression: AwkExpression,
  state: AwkRuntimeState,
}): Promise<AwkValue> {
  switch (expression.kind) {
  case 'number':
    return expression.value;
  case 'string':
    return expression.value;
  case 'regex':
    return testAwkRegularExpression({ regex: expression.value, input: state.currentRecord?.text ?? '' }) ? 1 : 0;
  case 'identifier':
    return getVariable({ state, name: expression.name });
  case 'indexed':
    return getArrayValue({
      state,
      name: expression.name,
      index: coerceToString({
        value: await evaluateExpression({
          expression: expression.index,
          state,
        }),
      }),
    });
  case 'field': {
    const index = await resolveFieldIndex({ state, expression: expression.index });
    if (index === 0) {
      return state.currentRecord?.text ?? '';
    }
    return state.currentRecord?.fields[index - 1] ?? '';
  }
  case 'subscript': {
    const items = await evaluateExpressions({ expressions: expression.items, state });
    return items
      .map((item) => coerceToString({ value: item }))
      .join(coerceToString({ value: getVariable({ state, name: 'SUBSEP' }) }));
  }
  case 'call': {
    if (expression.callee === 'length') {
      const firstArgument = expression.args[0];
      if (firstArgument !== undefined) {
        switch (firstArgument.kind) {
        case 'identifier': {
          const array = getArrayEntries({ state, name: firstArgument.name });
          if (array !== undefined) return array.size;
          break;
        }
        default:
          break;
        }
      }
    }

    if (expression.callee === 'split') {
      const sourceExpression = expression.args[0];
      const source = coerceToString({
        value: sourceExpression === undefined
          ? ''
          : await evaluateExpression({ expression: sourceExpression, state }),
      });
      const targetExpression = expression.args[1];
      if (targetExpression === undefined || targetExpression.kind !== 'identifier') {
        throw new Error("awk: split requires an array variable as its second argument");
      }
      const separatorExpression = expression.args[2];
      let separator: string | RegExp;
      if (separatorExpression === undefined) {
        separator = coerceToString({ value: getVariable({ state, name: 'FS' }) });
      } else {
        // eslint-disable-next-line local-rules-switch/force-switch-for-union -- Regex literals need one fast path; all other expressions share evaluation.
        if (separatorExpression.kind === 'regex') {
          separator = separatorExpression.value;
        } else {
          separator = coerceToString({
            value: await evaluateExpression({
              expression: separatorExpression,
              state,
            }),
          });
        }
      }
      const parts = splitFields({
        line: source,
        fieldSeparator: separator,
      });
      const entries = clearArray({
        state,
        name: targetExpression.name,
      });
      for (const [index, part] of parts.entries()) {
        entries.set(String(index + 1), part);
      }
      return parts.length;
    }

    const definition = state.functions.get(expression.callee);
    if (definition !== undefined) {
      return await executeUserDefinedFunction({
        definition,
        argumentExpressions: expression.args,
        state,
      });
    }

    const args = await evaluateExpressions({ expressions: expression.args, state });

    switch (expression.callee) {
    case 'length': {
      const target = args[0] ?? (state.currentRecord?.text ?? '');
      return coerceToString({ value: target }).length;
    }
    case 'int':
      return Math.trunc(coerceToNumber({ value: args[0] ?? 0 }));
    case 'sqrt':
      return Math.sqrt(coerceToNumber({ value: args[0] ?? 0 }));
    case 'exp':
      return Math.exp(coerceToNumber({ value: args[0] ?? 0 }));
    case 'log':
      return Math.log(coerceToNumber({ value: args[0] ?? 0 }));
    case 'sin':
      return Math.sin(coerceToNumber({ value: args[0] ?? 0 }));
    case 'cos':
      return Math.cos(coerceToNumber({ value: args[0] ?? 0 }));
    case 'atan2':
      return Math.atan2(
        coerceToNumber({ value: args[0] ?? 0 }),
        coerceToNumber({ value: args[1] ?? 0 }),
      );
    case 'rand': {
      state.randomState = (Math.imul(state.randomState, 1664525) + 1013904223) >>> 0;
      return state.randomState / 0x1_0000_0000;
    }
    case 'srand': {
      const previousSeed = state.randomSeed;
      const requestedSeed = args[0] === undefined
        ? Date.now()
        : coerceToNumber({ value: args[0] });
      const normalizedSeed = Number.isFinite(requestedSeed)
        ? Math.trunc(requestedSeed) >>> 0
        : 1;
      state.randomSeed = normalizedSeed;
      state.randomState = normalizedSeed;
      return previousSeed;
    }
    case 'sprintf':
      return formatPrintfOutput({
        format: coerceToString({ value: args[0] ?? '' }),
        argumentsList: args.slice(1),
      });
    case 'index': {
      const source = coerceToString({ value: args[0] ?? '' });
      const needle = coerceToString({ value: args[1] ?? '' });
      if (needle.length === 0) return 1;
      const position = source.indexOf(needle);
      return position === -1 ? 0 : position + 1;
    }
    case 'substr': {
      const source = coerceToString({ value: args[0] ?? '' });
      const start = Math.max(1, Math.trunc(coerceToNumber({ value: args[1] ?? 1 })));
      const length = args[2] === undefined ? undefined : Math.max(0, Math.trunc(coerceToNumber({ value: args[2] })));
      const startIndex = start - 1;
      return length === undefined ? source.slice(startIndex) : source.slice(startIndex, startIndex + length);
    }
    case 'tolower':
      return foldAsciiCase({ value: coerceToString({ value: args[0] ?? '' }) });
    case 'toupper':
      return uppercaseAscii({ value: coerceToString({ value: args[0] ?? '' }) });
    case 'match': {
      const source = coerceToString({ value: args[0] ?? '' });
      const patternExpression = expression.args[1] ?? { kind: 'string', value: '' };
      const pattern = await evaluateRegexOperand({ expression: patternExpression, state });
      const matched = findPosixLeftmostLongestMatch({ regex: pattern, source, startIndex: 0 });
      if (matched === undefined) {
        setVariable({ state, name: 'RSTART', value: 0 });
        setVariable({ state, name: 'RLENGTH', value: -1 });
        return 0;
      }
      setVariable({ state, name: 'RSTART', value: matched.index + 1 });
      setVariable({ state, name: 'RLENGTH', value: matched.text.length });
      return matched.index + 1;
    }
    case 'sub':
      return await applySubstitution({ state, expression, mode: 'first' });
    case 'gsub':
      return await applySubstitution({ state, expression, mode: 'global' });
    case 'fflush': {
      await state.ioChain;
      const target = args[0] === undefined ? '' : coerceToString({ value: args[0] });
      if (target.length === 0) {
        await state.flushOutput({ output: state.outputTarget });
        if (state.outputCommandPipes.size > 0) {
          if (!state.outputCommandFlushOrderingActive) {
            state.outputCommandFlushOrderingActive = true;
            for (const command of state.outputCommandPipes.keys()) {
              assignOutputCommandSequence({ state, command });
            }
          }
        }
        return 0;
      }
      if (state.outputRedirections.get(target)?.open === true) return 0;
      if (state.outputCommandPipes.has(target)) {
        await activateOutputCommandFlushOrdering({ state });
        return 0;
      }
      return -1;
    }
    case 'close': {
      const path = coerceToString({ value: args[0] ?? '' });
      const commandStatus = await closeCommandOutput({ state, command: path });
      const outputStatus = closeOutputRedirection({ state, path });
      const inputStatus = await state.closeInput({ path });
      if (commandStatus !== undefined) return commandStatus;
      if (outputStatus === 0) return 0;
      return inputStatus ?? -1;
    }
    case 'system': {
      await state.ioChain;
      const pendingOutput = state.outputTarget.splice(0, state.outputTarget.length);
      return await state.executeSystem({
        script: coerceToString({ value: args[0] ?? '' }),
        output: pendingOutput,
      });
    }
    case 'split':
      throw new Error('awk: internal split dispatch error');
    default:
      throw new Error(`awk: unsupported builtin function '${expression.callee}'`);
    }
  }
  case 'getline': {
    const { result, advancesRecordNumber } = await (async () => {
      switch (expression.source.kind) {
      case 'current-input':
        return {
          result: await state.readCurrentInput(),
          advancesRecordNumber: true,
        };
      case 'file':
        return {
          result: await state.readFileInput({
            path: coerceToString({
              value: await evaluateExpression({
                expression: expression.source.expression,
                state,
              }),
            }),
          }),
          advancesRecordNumber: false,
        };
      case 'command':
        return {
          result: await state.readCommandInput({
            command: coerceToString({
              value: await evaluateExpression({
                expression: expression.source.expression,
                state,
              }),
            }),
          }),
          advancesRecordNumber: false,
        };
      default: {
        const _ex: never = expression.source;
        throw new Error(`Unhandled awk getline source: ${JSON.stringify(_ex)}`);
      }
      }
    })();
    if (result.status !== 1 || result.record === undefined) {
      return result.status;
    }

    if (advancesRecordNumber) {
      state.nr += 1;
      state.fnr += 1;
    }

    if (expression.target === undefined) {
      setCurrentRecord({ state, record: result.record });
    } else {
      await setAssignmentTargetValue({
        state,
        target: expression.target,
        value: createInputValue({ value: result.record.text }),
      });
    }
    return 1;
  }
  case 'assignment': {
    const right = await evaluateExpression({ expression: expression.expression, state });
    const value = applyAssignmentOperator({
      operator: expression.operator,
      current: await getAssignmentTargetValue({ state, target: expression.target }),
      right,
    });
    await setAssignmentTargetValue({ state, target: expression.target, value });
    return value;
  }
  case 'update':
    return await updateTarget({
      state,
      target: expression.target,
      operator: expression.operator,
      position: expression.position,
    });
  case 'conditional':
    return await evaluateExpression({
      expression: isTruthy({
        value: await evaluateExpression({ expression: expression.condition, state }),
      }) ? expression.whenTrue : expression.whenFalse,
      state,
    });
  case 'binary': {
    const pending: Array<{
      operator: AwkBinaryOperator,
      right: AwkExpression,
    }> = [];
    let leftExpression: AwkExpression = expression;
    while (leftExpression.kind === 'binary') {
      pending.push({
        operator: leftExpression.operator,
        right: leftExpression.right,
      });
      leftExpression = leftExpression.left;
    }

    let value = await evaluateExpression({ expression: leftExpression, state });
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const frame = pending[index];
      if (frame === undefined) {
        throw new Error('Unreachable missing awk binary frame');
      }

      const operator = frame.operator;
      switch (operator) {
      case '||':
        if (isTruthy({ value })) {
          value = 1;
        } else {
          value = isTruthy({
            value: await evaluateExpression({ expression: frame.right, state }),
          }) ? 1 : 0;
        }
        continue;
      case '&&':
        if (!isTruthy({ value })) {
          value = 0;
        } else {
          value = isTruthy({
            value: await evaluateExpression({ expression: frame.right, state }),
          }) ? 1 : 0;
        }
        continue;
      case 'in':
        switch (frame.right.kind) {
        case 'identifier':
          value = requireArrayEntries({
            state,
            name: frame.right.name,
          }).has(coerceToString({ value })) ? 1 : 0;
          continue;
        default:
          throw new Error("awk: right operand of 'in' must be an array variable");
        }
      case 'concat':
      case '+':
      case '-':
      case '*':
      case '/':
      case '%':
      case '^':
      case '==':
      case '!=':
      case '<':
      case '<=':
      case '>':
      case '>=':
      case '~':
      case '!~':
        break;
      default: {
        const _ex: never = operator;
        throw new Error(`Unhandled awk binary operator: ${_ex}`);
      }
      }

      const right = operator === '~' || operator === '!~'
        ? await evaluateRegexOperand({ expression: frame.right, state })
        : await evaluateExpression({ expression: frame.right, state });

      switch (operator) {
      case 'concat':
        value = `${coerceToConcatenationString({ value, state })}${coerceToConcatenationString({ value: right, state })}`;
        break;
      case '+':
        value = coerceToNumber({ value }) + coerceToNumber({ value: right });
        break;
      case '-':
        value = coerceToNumber({ value }) - coerceToNumber({ value: right });
        break;
      case '*':
        value = coerceToNumber({ value }) * coerceToNumber({ value: right });
        break;
      case '/':
        value = coerceToNumber({ value }) / coerceToNumber({ value: right });
        break;
      case '%':
        value = coerceToNumber({ value }) % coerceToNumber({ value: right });
        break;
      case '^': {
        const leftNumber = coerceToNumber({ value });
        const result = leftNumber ** coerceToNumber({ value: right });
        value = Number.isNaN(result) && leftNumber < 0 ? -Number.NaN : result;
        break;
      }
      case '==':
        value = compareValues({ left: value, right }) === 0 ? 1 : 0;
        break;
      case '!=':
        value = compareValues({ left: value, right }) !== 0 ? 1 : 0;
        break;
      case '<':
        value = compareValues({ left: value, right }) < 0 ? 1 : 0;
        break;
      case '<=':
        value = compareValues({ left: value, right }) <= 0 ? 1 : 0;
        break;
      case '>':
        value = compareValues({ left: value, right }) > 0 ? 1 : 0;
        break;
      case '>=':
        value = compareValues({ left: value, right }) >= 0 ? 1 : 0;
        break;
      case '~':
        value = testAwkRegularExpression({
          regex: coerceToRegex({ value: right }),
          input: coerceToString({ value }),
        }) ? 1 : 0;
        break;
      case '!~':
        value = testAwkRegularExpression({
          regex: coerceToRegex({ value: right }),
          input: coerceToString({ value }),
        }) ? 0 : 1;
        break;
      default: {
        const _ex: never = operator;
        throw new Error(`Unhandled awk binary operator result: ${_ex}`);
      }
      }
    }
    return value;
  }
  case 'unary': {
    const operators: AwkUnaryOperator[] = [];
    let operand: AwkExpression = expression;
    while (operand.kind === 'unary') {
      operators.push(operand.operator);
      operand = operand.expression;
    }

    let value = await evaluateExpression({ expression: operand, state });
    for (let index = operators.length - 1; index >= 0; index -= 1) {
      const operator = operators[index];
      switch (operator) {
      case '!':
        value = isTruthy({ value }) ? 0 : 1;
        break;
      case '+':
        value = coerceToNumber({ value });
        break;
      case '-':
        value = -coerceToNumber({ value });
        break;
      case undefined:
        throw new Error('Unreachable missing awk unary operator');
      default: {
        const _ex: never = operator;
        throw new Error(`Unhandled awk unary operator: ${_ex}`);
      }
      }
    }
    return value;
  }
  default: {
    const _ex: never = expression;
    throw new Error(`Unhandled awk expression: ${JSON.stringify(_ex)}`);
  }
  }
}

function compareValues({
  left,
  right,
}: {
  left: AwkValue,
  right: AwkValue,
}): number {
  const leftNumber = typeof left === 'number'
    ? left
    : isNumericString(left) ? left.numberValue : undefined;
  const rightNumber = typeof right === 'number'
    ? right
    : isNumericString(right) ? right.numberValue : undefined;
  if (leftNumber !== undefined && rightNumber !== undefined) {
    if (leftNumber === rightNumber) return 0;
    return leftNumber < rightNumber ? -1 : 1;
  }

  const leftString = coerceToString({ value: left });
  const rightString = coerceToString({ value: right });
  if (leftString === rightString) return 0;
  return leftString < rightString ? -1 : 1;
}

async function matchesPattern({
  pattern,
  state,
}: {
  pattern: AwkPattern,
  state: AwkRuntimeState,
}): Promise<boolean> {
  switch (pattern.kind) {
  case 'begin':
    return false;
  case 'end':
    return false;
  case 'always':
    return true;
  case 'expression': {
    switch (pattern.expression.kind) {
    case 'regex':
      return testAwkRegularExpression({ regex: pattern.expression.value, input: state.currentRecord?.text ?? '' });
    case 'number':
    case 'string':
    case 'identifier':
    case 'indexed':
    case 'field':
    case 'subscript':
    case 'update':
    case 'binary':
    case 'unary':
    case 'call':
    case 'getline':
    case 'conditional':
    case 'assignment':
      return isTruthy({
        value: await evaluateExpression({
          expression: pattern.expression,
          state,
        }),
      });
    default: {
      const _ex: never = pattern.expression;
      throw new Error(`Unhandled awk pattern expression: ${JSON.stringify(_ex)}`);
    }
    }
  }
  case 'range': {
    const wasActive = state.rangePatternStates.get(pattern) === true;
    const startsNow = wasActive || isTruthy({
      value: await evaluateExpression({ expression: pattern.start, state }),
    });
    if (!startsNow) return false;

    const endsNow = isTruthy({
      value: await evaluateExpression({ expression: pattern.end, state }),
    });
    state.rangePatternStates.set(pattern, !endsNow);
    return true;
  }
  default: {
    const _ex: never = pattern;
    throw new Error(`Unhandled awk pattern: ${JSON.stringify(_ex)}`);
  }
  }
}

async function executeStatement({
  statement,
  state,
  output,
}: {
  statement: AwkStatement,
  state: AwkRuntimeState,
  output: string[],
}): Promise<AwkStatementControl> {
  switch (statement.kind) {
  case 'assign': {
    const right = await evaluateExpression({ expression: statement.expression, state });
    const value = applyAssignmentOperator({
      operator: statement.operator,
      current: await getAssignmentTargetValue({ state, target: statement.target }),
      right,
    });
    await setAssignmentTargetValue({ state, target: statement.target, value });
    return 'normal';
  }
  case 'expression':
    await evaluateExpression({ expression: statement.expression, state });
    return 'normal';
  case 'if': {
    const statements = isTruthy({
      value: await evaluateExpression({
        expression: statement.condition,
        state,
      }),
    }) ? statement.thenStatements : statement.elseStatements ?? [];

    for (const nestedStatement of statements) {
      const control = await executeStatement({
        statement: nestedStatement,
        state,
        output,
      });
      switch (control) {
      case 'normal':
        break;
      case 'next':
      case 'break':
      case 'continue_loop':
      case 'exit':
      case 'return':
        return control;
      default: {
        const _ex: never = control;
        throw new Error(`Unhandled awk control flow: ${_ex}`);
      }
      }
    }

    return 'normal';
  }
  case 'while': {
    let iterationCount = 0;
    while (isTruthy({
      value: await evaluateExpression({
        expression: statement.condition,
        state,
      }),
    })) {
      iterationCount += 1;
      if (iterationCount > 100000) {
        throw new Error('awk: while loop iteration limit exceeded');
      }

      let shouldContinueLoop = false;
      for (const nestedStatement of statement.statements) {
        const control = await executeStatement({
          statement: nestedStatement,
          state,
          output,
        });
        switch (control) {
        case 'normal':
          break;
        case 'continue_loop':
          shouldContinueLoop = true;
          break;
        case 'break':
          return 'normal';
        case 'next':
          return 'next';
        case 'exit':
          return 'exit';
        case 'return':
          return 'return';
        default: {
          const _ex: never = control;
          throw new Error(`Unhandled awk control flow: ${_ex}`);
        }
        }
        if (shouldContinueLoop) break;
      }
      if (shouldContinueLoop) continue;
    }
    return 'normal';
  }
  case 'doWhile': {
    let iterationCount = 0;
    do {
      iterationCount += 1;
      if (iterationCount > 100000) {
        throw new Error('awk: do-while loop iteration limit exceeded');
      }

      let shouldContinueLoop = false;
      for (const nestedStatement of statement.statements) {
        const control = await executeStatement({
          statement: nestedStatement,
          state,
          output,
        });
        switch (control) {
        case 'normal':
          break;
        case 'continue_loop':
          shouldContinueLoop = true;
          break;
        case 'break':
          return 'normal';
        case 'next':
          return 'next';
        case 'exit':
          return 'exit';
        case 'return':
          return 'return';
        default: {
          const _ex: never = control;
          throw new Error(`Unhandled awk control flow: ${_ex}`);
        }
        }
        if (shouldContinueLoop) break;
      }
    } while (isTruthy({
      value: await evaluateExpression({ expression: statement.condition, state }),
    }));
    return 'normal';
  }
  case 'for': {
    await executeForClausePart({
      part: statement.initializer,
      state,
    });

    let iterationCount = 0;
    while (statement.condition === undefined || isTruthy({
      value: await evaluateExpression({
        expression: statement.condition,
        state,
      }),
    })) {
      iterationCount += 1;
      if (iterationCount > 100000) {
        throw new Error('awk: for loop iteration limit exceeded');
      }

      let shouldContinueLoop = false;
      for (const nestedStatement of statement.statements) {
        const control = await executeStatement({
          statement: nestedStatement,
          state,
          output,
        });
        switch (control) {
        case 'normal':
          break;
        case 'continue_loop':
          shouldContinueLoop = true;
          break;
        case 'break':
          return 'normal';
        case 'next':
          return 'next';
        case 'exit':
          return 'exit';
        case 'return':
          return 'return';
        default: {
          const _ex: never = control;
          throw new Error(`Unhandled awk control flow: ${_ex}`);
        }
        }
        if (shouldContinueLoop) break;
      }

      await executeForClausePart({
        part: statement.increment,
        state,
      });
      if (shouldContinueLoop) continue;
    }
    return 'normal';
  }
  case 'forIn': {
    const keys = [...requireArrayEntries({
      state,
      name: statement.arrayName,
    }).keys()];
    for (const key of keys) {
      setVariable({
        state,
        name: statement.variableName,
        value: key,
      });

      let shouldContinueLoop = false;
      for (const nestedStatement of statement.statements) {
        const control = await executeStatement({
          statement: nestedStatement,
          state,
          output,
        });
        switch (control) {
        case 'normal':
          break;
        case 'continue_loop':
          shouldContinueLoop = true;
          break;
        case 'break':
          return 'normal';
        case 'next':
          return 'next';
        case 'exit':
          return 'exit';
        case 'return':
          return 'return';
        default: {
          const _ex: never = control;
          throw new Error(`Unhandled awk control flow: ${_ex}`);
        }
        }
        if (shouldContinueLoop) break;
      }
      if (shouldContinueLoop) continue;
    }
    return 'normal';
  }
  case 'delete':
    switch (statement.target.kind) {
    case 'array':
      clearArray({
        state,
        name: statement.target.name,
      });
      return 'normal';
    case 'indexed':
      deleteArrayEntry({
        state,
        name: statement.target.name,
        index: coerceToString({
          value: await evaluateExpression({
            expression: statement.target.index,
            state,
          }),
        }),
      });
      return 'normal';
    default: {
      const _ex: never = statement.target;
      throw new Error(`Unhandled awk delete target: ${JSON.stringify(_ex)}`);
    }
    }
  case 'next':
    return 'next';
  case 'nextfile':
    state.nextFileRequested = true;
    return 'next';
  case 'break':
    return 'break';
  case 'continue':
    return 'continue_loop';
  case 'exit':
    state.exitCode = statement.expression === undefined
      ? 0
      : Math.trunc(coerceToNumber({
        value: await evaluateExpression({ expression: statement.expression, state }),
      }));
    return 'exit';
  case 'return': {
    const frame = state.callFrames.at(-1);
    if (frame === undefined) {
      throw new Error("awk: 'return' is not allowed outside a function");
    }
    frame.returnValue = statement.expression === undefined
      ? ''
      : await evaluateExpression({ expression: statement.expression, state });
    return 'return';
  }
  case 'print': {
    const fieldSeparator = coerceToString({ value: getVariable({ state, name: 'OFS' }) });
    const recordSeparator = coerceToString({ value: getVariable({ state, name: 'ORS' }) });
    const printValues = await evaluateExpressions({
      expressions: statement.expressions,
      state,
    });
    const formatted = statement.expressions.length === 0
      ? `${state.currentRecord?.text ?? ''}${recordSeparator}`
      : `${printValues.map((value) =>
        coerceToPrintString({
          value,
          state,
        })).join(fieldSeparator)}${recordSeparator}`;

    if (statement.redirection === undefined) {
      output.push(formatted);
    } else {
      queueRedirectOutput({
        state,
        path: coerceToString({
          value: await evaluateExpression({ expression: statement.redirection.target, state }),
        }),
        operator: statement.redirection.operator,
        text: formatted,
      });
    }
    return 'normal';
  }
  case 'printf': {
    const formatted = formatPrintfOutput({
      format: coerceToString({
        value: await evaluateExpression({
          expression: statement.format,
          state,
        }),
      }),
      argumentsList: await evaluateExpressions({
        expressions: statement.arguments,
        state,
      }),
    });
    if (statement.redirection === undefined) {
      output.push(formatted);
    } else {
      queueRedirectOutput({
        state,
        path: coerceToString({
          value: await evaluateExpression({ expression: statement.redirection.target, state }),
        }),
        operator: statement.redirection.operator,
        text: formatted,
      });
    }
    return 'normal';
  }
  default: {
    const _ex: never = statement;
    throw new Error(`Unhandled awk statement: ${JSON.stringify(_ex)}`);
  }
  }
}

function splitRecords({
  text,
}: {
  text: string,
}): AwkRecord[] {
  const lines = text.split(/\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  return lines.map((line) => {
    const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;
    return {
      text: normalized,
      fields: [],
      hadNewline: true,
    };
  });
}

export function createAwkRuntime({
  variables,
  arrays,
  functions,
  writeRedirect,
  readCurrentInput,
  readFileInput,
  readCommandInput,
  closeInput,
  flushOutput,
  executeSystem,
  executeOutputPipe,
}: {
  variables: Map<string, AwkValue>,
  arrays: Map<string, Map<string, AwkValue>>,
  functions: AwkFunctionDefinition[],
  writeRedirect({ path, mode, text }: {
    path: string,
    mode: 'truncate' | 'append',
    text: string,
  }): Promise<void>,
  readCurrentInput(): Promise<{ status: -1 | 0 | 1, record: AwkRecord | undefined }>,
  readFileInput({ path }: { path: string }): Promise<{ status: -1 | 0 | 1, record: AwkRecord | undefined }>,
  readCommandInput({ command }: { command: string }): Promise<{ status: -1 | 0 | 1, record: AwkRecord | undefined }>,
  closeInput({ path }: { path: string }): Promise<number | undefined>,
  flushOutput({ output }: { output: string[] }): Promise<void>,
  executeSystem({ script, output }: { script: string, output: string[] }): Promise<number>,
  executeOutputPipe({ command, input }: {
    command: string,
    input: string,
  }): Promise<{ exitCode: number, output: string }>,
}): AwkRuntimeState {
  const initialRandomSeed = 1;
  const state: AwkRuntimeState = {
    variables: new Map(variables),
    arrays: new Map(arrays),
    currentRecord: undefined,
    nr: 0,
    fnr: 0,
    filename: '',
    exitCode: undefined,
    nextFileRequested: false,
    randomSeed: initialRandomSeed,
    randomState: initialRandomSeed,
    functions: new Map(functions.map((definition) => [definition.name, definition])),
    callFrames: [],
    outputTarget: [],
    outputRedirections: new Map(),
    outputCommandPipes: new Map(),
    outputCommandSequences: new Map(),
    completedOutputCommands: new Map(),
    nextOutputCommandSequence: 0,
    nextOutputCommandSequenceToFlush: 0,
    outputCommandFlushOrderingActive: false,
    ioChain: Promise.resolve(),
    writeRedirect,
    readCurrentInput,
    readFileInput,
    readCommandInput,
    closeInput,
    flushOutput,
    executeSystem,
    executeOutputPipe,
    rangePatternStates: new Map(),
  };

  if (!state.variables.has('FS')) state.variables.set('FS', ' ');
  if (!state.variables.has('OFS')) state.variables.set('OFS', ' ');
  if (!state.variables.has('ORS')) state.variables.set('ORS', '\n');
  if (!state.variables.has('RS')) state.variables.set('RS', '\n');
  if (!state.variables.has('OFMT')) state.variables.set('OFMT', '%.6g');
  if (!state.variables.has('CONVFMT')) state.variables.set('CONVFMT', '%.6g');
  if (!state.variables.has('SUBSEP')) state.variables.set('SUBSEP', '\u001c');
  return state;
}

export async function flushAwkRuntimeCommandPipes({
  runtime,
}: {
  runtime: AwkRuntimeState,
}): Promise<void> {
  for (const command of [...runtime.outputCommandPipes.keys()]) {
    await closeCommandOutput({ state: runtime, command });
  }
}

export async function flushAwkRuntimeIo({
  runtime,
}: {
  runtime: AwkRuntimeState,
}): Promise<void> {
  await runtime.ioChain;
}

export function getAwkRuntimeArrayEntryAsString({
  runtime,
  arrayName,
  index,
}: {
  runtime: AwkRuntimeState,
  arrayName: string,
  index: string,
}): string | undefined {
  const entries = getArrayEntries({ state: runtime, name: arrayName });
  if (entries?.has(index) !== true) return undefined;
  return coerceToString({ value: entries.get(index) ?? '' });
}

export function getAwkRuntimeVariableAsString({
  runtime,
  name,
}: {
  runtime: AwkRuntimeState,
  name: string,
}): string {
  return coerceToString({ value: getVariable({ state: runtime, name }) });
}

async function executeAwkStatements({
  program,
  runtime,
  patternKind,
  output,
}: {
  program: AwkProgram,
  runtime: AwkRuntimeState,
  patternKind: 'begin' | 'end',
  output: string[],
}): Promise<void> {
  runtime.outputTarget = output;
  for (const rule of program.rules) {
    if (rule.pattern.kind !== patternKind) {
      continue;
    }

    for (const statement of rule.statements) {
      const control = await executeStatement({ statement, state: runtime, output });
      switch (control) {
      case 'normal':
        break;
      case 'next':
        throw new Error(`awk: 'next' is not allowed in ${patternKind.toUpperCase()}`);
      case 'break':
        throw new Error("awk: 'break' is not allowed outside loops");
      case 'continue_loop':
        throw new Error("awk: 'continue' is not allowed outside loops");
      case 'exit':
        return;
      case 'return':
        throw new Error("awk: 'return' is not allowed outside a function");
      default: {
        const _ex: never = control;
        throw new Error(`Unhandled awk control flow: ${_ex}`);
      }
      }
    }
  }
}

export async function executeAwkBegin({
  program,
  runtime,
  output,
}: {
  program: AwkProgram,
  runtime: AwkRuntimeState,
  output: string[],
}): Promise<void> {
  await executeAwkStatements({
    program,
    runtime,
    patternKind: 'begin',
    output,
  });
}

export async function executeAwkRecord({
  program,
  runtime,
  record,
  output,
}: {
  program: AwkProgram,
  runtime: AwkRuntimeState,
  record: AwkRecord,
  output: string[],
}): Promise<void> {
  runtime.outputTarget = output;
  runtime.nr += 1;
  runtime.fnr += 1;
  const fieldSeparator = coerceToString({ value: getVariable({ state: runtime, name: 'FS' }) });
  runtime.currentRecord = {
    ...record,
    fields: splitFields({
      line: record.text,
      fieldSeparator,
    }),
  };

  for (const rule of program.rules) {
    if (!await matchesPattern({ pattern: rule.pattern, state: runtime })) continue;
    let nextRecord = false;
    for (const statement of rule.statements) {
      const control = await executeStatement({ statement, state: runtime, output });
      switch (control) {
      case 'normal':
        break;
      case 'next':
        nextRecord = true;
        break;
      case 'break':
        throw new Error("awk: 'break' is not allowed outside loops");
      case 'continue_loop':
        throw new Error("awk: 'continue' is not allowed outside loops");
      case 'exit':
        return;
      case 'return':
        throw new Error("awk: 'return' is not allowed outside a function");
      default: {
        const _ex: never = control;
        throw new Error(`Unhandled awk control flow: ${_ex}`);
      }
      }
      if (nextRecord) break;
    }
    if (nextRecord) break;
  }
}

export async function executeAwkEnd({
  program,
  runtime,
  output,
}: {
  program: AwkProgram,
  runtime: AwkRuntimeState,
  output: string[],
}): Promise<void> {
  await executeAwkStatements({
    program,
    runtime,
    patternKind: 'end',
    output,
  });
}

export async function executeAwkProgram({
  program,
  runtime,
  inputs,
}: {
  program: AwkProgram,
  runtime: AwkRuntimeState,
  inputs: string[],
}): Promise<string> {
  const output: string[] = [];
  await executeAwkBegin({
    program,
    runtime,
    output,
  });

  for (const input of inputs) {
    runtime.fnr = 0;
    const records = splitRecords({ text: input });
    for (const record of records) {
      await executeAwkRecord({
        program,
        runtime,
        record,
        output,
      });
    }
  }

  await executeAwkEnd({
    program,
    runtime,
    output,
  });
  return output.join('');
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
