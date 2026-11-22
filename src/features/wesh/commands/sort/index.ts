import {
  defineArgvCatalog,
  defineArgvHelpPresentation,
  formatArgvOptionHelp,
  formatArgvUsageSummary,
  parseStandardArgv,
  type ParsedStandardArgv,
  type StandardArgvAction,
  type StandardArgvPolicy,
  type StandardArgvRawValue,
} from '@/features/wesh/argv-v2';
import {
  resolveCharacterLocaleMode,
  uppercaseAscii,
  type WeshCharacterLocaleMode,
} from '@/features/wesh/commands/_shared/locale';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage-output';
import type { WeshCommandContext, WeshCommandImplementation, WeshCommandResult, WeshFileHandle } from '@/features/wesh/types';
import { openFileReadStream, openHandleReadStream, writeAllBytesToHandle } from '@/features/wesh/utils/fs';
import { iterateReadableStreamChunks } from '@/features/wesh/utils/stream';
import { iterateUtf8RecordEntries } from '@/features/wesh/utils/text-records';

type SortMode = 'lexical' | 'numeric' | 'general-numeric' | 'human-numeric' | 'month' | 'version';
type SortOrder = 'forward' | 'reverse';
type SortCheckMode = 'none' | 'strict' | 'silent';

interface SortRecord {
  value: string,
  bytes: Uint8Array,
  byteString?: string,
}

interface SortEntry extends SortRecord {
  index: number,
}

interface SortKeySpec {
  startField: number,
  startChar: number | undefined,
  endField: number | undefined,
  endChar: number | undefined,
  mode: SortMode | undefined,
  reverse: boolean,
  ignoreLeadingBlanks: boolean,
  foldCase: boolean,
  dictionaryOrder: boolean,
  ignoreNonprinting: boolean,
}

interface SortResolvedKeySpec extends SortKeySpec {
  fieldSeparator: string | undefined,
}

interface SortResolvedOptions {
  mode: SortMode,
  order: SortOrder,
  uniqueness: 'all' | 'unique',
  stable: boolean,
  foldCase: boolean,
  ignoreLeadingBlanks: boolean,
  dictionaryOrder: boolean,
  ignoreNonprinting: boolean,
  checkMode: SortCheckMode,
  merge: boolean,
  zeroTerminated: boolean,
  outputPath: string | undefined,
  fieldSeparator: string | undefined,
  keySpecs: SortResolvedKeySpec[],
  characterLocaleMode: WeshCharacterLocaleMode,
}

function createBufferedSortWriter({
  handle,
  maxBufferLength,
}: {
  handle: WeshFileHandle,
  maxBufferLength: number,
}) {
  let chunks: Uint8Array[] = [];
  let bufferedLength = 0;

  const flush = async (): Promise<void> => {
    if (bufferedLength === 0) {
      return;
    }
    const data = new Uint8Array(bufferedLength);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    chunks = [];
    bufferedLength = 0;
    await writeAllBytesToHandle({ handle, data });
  };

  return {
    async write({ values }: { values: readonly Uint8Array[] }): Promise<void> {
      for (const value of values) {
        if (value.byteLength === 0) {
          continue;
        }
        chunks.push(value);
        bufferedLength += value.byteLength;
      }
      if (bufferedLength >= maxBufferLength) {
        await flush();
      }
    },
    flush,
  };
}

const SORT_NEWLINE = Uint8Array.of(0x0a);
const SORT_NUL = Uint8Array.of(0x00);

async function writeSortRecord({
  writer,
  record,
  zeroTerminated,
}: {
  writer: ReturnType<typeof createBufferedSortWriter>,
  record: SortRecord,
  zeroTerminated: boolean,
}): Promise<void> {
  await writer.write({
    values: [record.bytes, zeroTerminated ? SORT_NUL : SORT_NEWLINE],
  });
}

function compareSortRecordBytes({
  left,
  right,
}: {
  left: Uint8Array,
  right: Uint8Array,
}): number {
  const length = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) {
      return difference;
    }
  }
  return left.byteLength - right.byteLength;
}

function resolveInputPath({
  cwd,
  path,
}: {
  cwd: string,
  path: string,
}): string {
  if (path.startsWith('/')) {
    return path;
  }

  return cwd === '/' ? `/${path}` : `${cwd}/${path}`;
}

type SortKeyParseError = { ok: false, reason: 'syntax' | 'order', message: string };
type SortKeyParseResult = { ok: true, value: SortKeySpec } | SortKeyParseError;
type SortResolvedOptionsResult =
  | { kind: 'help' }
  | { kind: 'invalid', message: string, exitCode: 1 | 2 }
  | { kind: 'parsed', options: SortResolvedOptions };

function trimLeadingBlanks({ value }: { value: string }): string {
  return value.replace(/^[ \t]+/, '');
}

function decodeFieldSeparator({ value }: { value: string }): string {
  switch (value) {
  case '\\0':
    return '\0';
  case '\\t':
    return '\t';
  case '\\n':
    return '\n';
  case '\\r':
    return '\r';
  default:
    return value;
  }
}

function getNormalization({
  options,
}: {
  options: {
    foldCase: boolean,
    ignoreLeadingBlanks: boolean,
    dictionaryOrder: boolean,
    ignoreNonprinting: boolean,
  },
}): {
  foldCase: boolean,
  ignoreLeadingBlanks: boolean,
  dictionaryOrder: boolean,
  ignoreNonprinting: boolean,
} {
  return options;
}

function normalizeText({
  value,
  normalization,
}: {
  value: string,
  normalization: {
    foldCase: boolean,
    ignoreLeadingBlanks: boolean,
    dictionaryOrder: boolean,
    ignoreNonprinting: boolean,
  },
}): string {
  let result = value;

  if (normalization.ignoreLeadingBlanks) {
    result = trimLeadingBlanks({ value: result });
  }

  if (normalization.dictionaryOrder) {
    result = result.replace(/[^0-9A-Za-z \t]/g, '');
  }

  if (normalization.ignoreNonprinting) {
    result = result.replace(/[^\x20-\x7e]/gu, '');
  }

  if (normalization.foldCase) {
    // GNU sort's -f semantics fold lower-case ASCII to upper-case.  The
    // direction matters in the C locale because punctuation sorts between
    // upper- and lower-case byte ranges.
    result = uppercaseAscii({ value: result });
  }

  return result;
}

function compareUnicodeScalarValues({
  left,
  right,
}: {
  left: string,
  right: string,
}): number {
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftCodePoint = left.codePointAt(leftIndex)!;
    const rightCodePoint = right.codePointAt(rightIndex)!;
    if (leftCodePoint < rightCodePoint) {
      return -1;
    }
    if (leftCodePoint > rightCodePoint) {
      return 1;
    }
    leftIndex += leftCodePoint > 0xffff ? 2 : 1;
    rightIndex += rightCodePoint > 0xffff ? 2 : 1;
  }
  if (leftIndex < left.length) {
    return 1;
  }
  if (rightIndex < right.length) {
    return -1;
  }
  return 0;
}

function compareLexical({
  left,
  right,
  normalization,
}: {
  left: string,
  right: string,
  normalization: ReturnType<typeof getNormalization>,
}): number {
  const leftValue = normalizeText({ value: left, normalization });
  const rightValue = normalizeText({ value: right, normalization });
  return compareUnicodeScalarValues({ left: leftValue, right: rightValue });
}

interface SortNumericKey {
  sign: -1 | 0 | 1,
  integerDigits: string,
  fractionalDigits: string,
}

function parseNumericKey({ value }: { value: string }): SortNumericKey {
  const normalized = trimLeadingBlanks({ value });
  const match = normalized.match(/^(-?)(?:(\d+)(?:\.(\d*))?|\.(\d+))/);
  if (match === null) {
    return { sign: 0, integerDigits: '0', fractionalDigits: '' };
  }

  const integerDigits = (match[2] ?? '0').replace(/^0+/, '') || '0';
  const fractionalDigits = (match[3] ?? match[4] ?? '').replace(/0+$/, '');
  const isZero = integerDigits === '0' && fractionalDigits.length === 0;
  return {
    sign: isZero ? 0 : match[1] === '-' ? -1 : 1,
    integerDigits,
    fractionalDigits,
  };
}

function compareAbsoluteNumericKeys({
  left,
  right,
}: {
  left: SortNumericKey,
  right: SortNumericKey,
}): number {
  if (left.integerDigits.length < right.integerDigits.length) {
    return -1;
  }
  if (left.integerDigits.length > right.integerDigits.length) {
    return 1;
  }
  if (left.integerDigits < right.integerDigits) {
    return -1;
  }
  if (left.integerDigits > right.integerDigits) {
    return 1;
  }

  const fractionalLength = Math.max(left.fractionalDigits.length, right.fractionalDigits.length);
  for (let index = 0; index < fractionalLength; index += 1) {
    const leftDigit = left.fractionalDigits[index] ?? '0';
    const rightDigit = right.fractionalDigits[index] ?? '0';
    if (leftDigit < rightDigit) {
      return -1;
    }
    if (leftDigit > rightDigit) {
      return 1;
    }
  }
  return 0;
}

function compareNumeric({
  left,
  right,
  normalization,
}: {
  left: string,
  right: string,
  normalization: ReturnType<typeof getNormalization>,
}): number {
  const leftKey = parseNumericKey({ value: normalizeText({ value: left, normalization }) });
  const rightKey = parseNumericKey({ value: normalizeText({ value: right, normalization }) });
  if (leftKey.sign < rightKey.sign) {
    return -1;
  }
  if (leftKey.sign > rightKey.sign) {
    return 1;
  }
  if (leftKey.sign === 0) {
    return 0;
  }
  const absoluteComparison = compareAbsoluteNumericKeys({ left: leftKey, right: rightKey });
  return leftKey.sign === -1 ? -absoluteComparison : absoluteComparison;
}

function parseGeneralNumericKey({ value }: { value: string }): {
  rank: 'non-number' | 'nan' | 'negative-infinity' | 'finite' | 'positive-infinity',
  numericValue: number,
} {
  const trimmed = trimLeadingBlanks({ value });
  if (/^-nan(?:\([^)]*\))?/i.test(trimmed) || /^\+?nan(?:\([^)]*\))?/i.test(trimmed)) {
    return { rank: 'nan', numericValue: Number.NaN };
  }
  if (/^-inf(?:inity)?/i.test(trimmed)) {
    return { rank: 'negative-infinity', numericValue: Number.NEGATIVE_INFINITY };
  }
  if (/^\+?inf(?:inity)?/i.test(trimmed)) {
    return { rank: 'positive-infinity', numericValue: Number.POSITIVE_INFINITY };
  }
  const numericMatch = trimmed.match(/^[+-]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/);
  if (numericMatch === null) {
    return { rank: 'non-number', numericValue: Number.NaN };
  }
  return { rank: 'finite', numericValue: Number.parseFloat(numericMatch[0]) };
}

function getGeneralNumericRankOrder({
  rank,
}: {
  rank: ReturnType<typeof parseGeneralNumericKey>['rank'],
}): number {
  switch (rank) {
  case 'non-number': return 0;
  case 'nan': return 1;
  case 'negative-infinity': return 2;
  case 'finite': return 3;
  case 'positive-infinity': return 4;
  default: {
    const _ex: never = rank;
    throw new Error(`Unhandled general numeric rank: ${_ex}`);
  }
  }
}

function compareGeneralNumeric({
  left,
  right,
  normalization,
}: {
  left: string,
  right: string,
  normalization: ReturnType<typeof getNormalization>,
}): number {
  const leftKey = parseGeneralNumericKey({ value: normalizeText({ value: left, normalization }) });
  const rightKey = parseGeneralNumericKey({ value: normalizeText({ value: right, normalization }) });
  const rankDifference = getGeneralNumericRankOrder({ rank: leftKey.rank })
    - getGeneralNumericRankOrder({ rank: rightKey.rank });
  if (rankDifference !== 0) {
    return rankDifference;
  }
  if (leftKey.rank !== 'finite' || rightKey.rank !== 'finite') {
    return 0;
  }
  if (leftKey.numericValue < rightKey.numericValue) {
    return -1;
  }
  if (leftKey.numericValue > rightKey.numericValue) {
    return 1;
  }
  return 0;
}

function getHumanNumericUnitRank({ suffix }: { suffix: string }): number {
  switch (suffix) {
  case '': return 0;
  case 'K':
  case 'k': return 1;
  case 'M': return 2;
  case 'G': return 3;
  case 'T': return 4;
  case 'P': return 5;
  case 'E': return 6;
  case 'Z': return 7;
  case 'Y': return 8;
  case 'R': return 9;
  case 'Q': return 10;
  default: return 0;
  }
}

function parseHumanNumericKey({ value }: { value: string }): {
  unitRank: number,
  numericValue: number,
} {
  const match = trimLeadingBlanks({ value }).match(/^(-?(?:\d+(?:\.\d*)?|\.\d+))([kKMGTPEZYRQ]?)(?:i?[bB])?/);
  if (match === null) {
    return { unitRank: 0, numericValue: 0 };
  }

  return {
    unitRank: getHumanNumericUnitRank({ suffix: match[2] ?? '' }),
    numericValue: Number.parseFloat(match[1]!),
  };
}

function compareHumanNumeric({
  left,
  right,
  normalization,
}: {
  left: string,
  right: string,
  normalization: ReturnType<typeof getNormalization>,
}): number {
  const leftKey = parseHumanNumericKey({ value: normalizeText({ value: left, normalization }) });
  const rightKey = parseHumanNumericKey({ value: normalizeText({ value: right, normalization }) });
  const leftSign = Math.sign(leftKey.numericValue);
  const rightSign = Math.sign(rightKey.numericValue);
  if (leftSign < rightSign) {
    return -1;
  }
  if (leftSign > rightSign) {
    return 1;
  }
  if (leftSign === 0) {
    return 0;
  }

  if (leftKey.unitRank !== rightKey.unitRank) {
    const rankComparison = leftKey.unitRank < rightKey.unitRank ? -1 : 1;
    return leftSign < 0 ? -rankComparison : rankComparison;
  }
  if (leftKey.numericValue < rightKey.numericValue) {
    return -1;
  }
  if (leftKey.numericValue > rightKey.numericValue) {
    return 1;
  }
  return 0;
}

function getMonthRank({ value }: { value: string }): number | undefined {
  switch (value) {
  case 'jan': return 1;
  case 'feb': return 2;
  case 'mar': return 3;
  case 'apr': return 4;
  case 'may': return 5;
  case 'jun': return 6;
  case 'jul': return 7;
  case 'aug': return 8;
  case 'sep': return 9;
  case 'oct': return 10;
  case 'nov': return 11;
  case 'dec': return 12;
  default: return undefined;
  }
}

function compareMonth({
  left,
  right,
  normalization,
}: {
  left: string,
  right: string,
  normalization: ReturnType<typeof getNormalization>,
}): number {
  const leftMonth = getMonthRank({
    value: trimLeadingBlanks({
      value: normalizeText({ value: left, normalization }),
    }).slice(0, 3).toLowerCase(),
  });
  const rightMonth = getMonthRank({
    value: trimLeadingBlanks({
      value: normalizeText({ value: right, normalization }),
    }).slice(0, 3).toLowerCase(),
  });

  if (leftMonth !== undefined && rightMonth !== undefined) {
    if (leftMonth < rightMonth) {
      return -1;
    }
    if (leftMonth > rightMonth) {
      return 1;
    }
    return 0;
  }

  if (leftMonth !== undefined) {
    return 1;
  }
  if (rightMonth !== undefined) {
    return -1;
  }
  return 0;
}

function getVersionCharacterOrder({ char }: { char: string }): number {
  if (char === '~') {
    return -1;
  }
  if (char === '' || /\d/.test(char)) {
    return 0;
  }
  if (/[A-Za-z]/.test(char)) {
    return char.codePointAt(0) ?? 0;
  }
  return 0x100 + (char.codePointAt(0) ?? 0);
}

function getVersionSpecialRank({ value }: { value: string }): number {
  if (value === '') {
    return -4;
  }
  if (value === '.') {
    return -3;
  }
  if (value === '..') {
    return -2;
  }
  if (value.startsWith('.')) {
    return -1;
  }
  return 0;
}

function compareVersionChunks({
  left,
  right,
}: {
  left: string,
  right: string,
}): number {
  const specialDifference = getVersionSpecialRank({ value: left }) - getVersionSpecialRank({ value: right });
  if (specialDifference !== 0) {
    return specialDifference;
  }

  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length || rightIndex < right.length) {
    while (
      (leftIndex < left.length && !/\d/.test(left[leftIndex]!))
      || (rightIndex < right.length && !/\d/.test(right[rightIndex]!))
    ) {
      const leftChar = left[leftIndex] ?? '';
      const rightChar = right[rightIndex] ?? '';
      const orderDifference = getVersionCharacterOrder({ char: leftChar })
        - getVersionCharacterOrder({ char: rightChar });
      if (orderDifference !== 0) {
        return orderDifference;
      }
      if (leftChar !== '') {
        leftIndex += 1;
      }
      if (rightChar !== '') {
        rightIndex += 1;
      }
    }

    while (left[leftIndex] === '0') {
      leftIndex += 1;
    }
    while (right[rightIndex] === '0') {
      rightIndex += 1;
    }

    let firstDigitDifference = 0;
    while (/\d/.test(left[leftIndex] ?? '') && /\d/.test(right[rightIndex] ?? '')) {
      if (firstDigitDifference === 0) {
        firstDigitDifference = left.charCodeAt(leftIndex) - right.charCodeAt(rightIndex);
      }
      leftIndex += 1;
      rightIndex += 1;
    }
    if (/\d/.test(left[leftIndex] ?? '')) {
      return 1;
    }
    if (/\d/.test(right[rightIndex] ?? '')) {
      return -1;
    }
    if (firstDigitDifference !== 0) {
      return firstDigitDifference;
    }
  }
  return 0;
}

function compareVersion({
  left,
  right,
  normalization,
}: {
  left: string,
  right: string,
  normalization: ReturnType<typeof getNormalization>,
}): number {
  return compareVersionChunks({
    left: normalizeText({ value: left, normalization }),
    right: normalizeText({ value: right, normalization }),
  });
}

function compareValues({
  left,
  right,
  mode,
  normalization,
}: {
  left: string,
  right: string,
  mode: SortMode,
  normalization: ReturnType<typeof getNormalization>,
}): number {
  switch (mode) {
  case 'lexical':
    return compareLexical({ left, right, normalization });
  case 'numeric':
    return compareNumeric({ left, right, normalization });
  case 'general-numeric':
    return compareGeneralNumeric({ left, right, normalization });
  case 'human-numeric':
    return compareHumanNumeric({ left, right, normalization });
  case 'month':
    return compareMonth({ left, right, normalization });
  case 'version':
    return compareVersion({ left, right, normalization });
  default: {
    const _ex: never = mode;
    throw new Error(`Unhandled sort mode: ${_ex}`);
  }
  }
}

function splitFields({
  line,
  separator,
}: {
  line: string,
  separator: string | undefined,
}): Array<{ start: number, end: number }> {
  if (line.length === 0) {
    return [];
  }

  if (separator === undefined) {
    const spans: Array<{ start: number, end: number }> = [];
    let index = 0;
    while (index < line.length) {
      // With the default separator, preceding blanks belong to each field.
      // Trailing blanks also form a field of their own.
      const start = index;
      while (index < line.length && (line[index] === ' ' || line[index] === '\t')) {
        index++;
      }
      while (index < line.length && line[index] !== ' ' && line[index] !== '\t') {
        index++;
      }
      spans.push({ start, end: index });
    }
    return spans;
  }

  if (separator.length === 0) {
    return [{ start: 0, end: line.length }];
  }

  const spans: Array<{ start: number, end: number }> = [];
  let start = 0;

  while (start <= line.length) {
    const separatorIndex = line.indexOf(separator, start);
    if (separatorIndex === -1) {
      spans.push({ start, end: line.length });
      break;
    }

    spans.push({ start, end: separatorIndex });
    start = separatorIndex + separator.length;

    if (start === line.length) {
      spans.push({ start, end: start });
      break;
    }
  }

  return spans;
}

function getSpanBase({
  line,
  span,
  ignoreLeadingBlanks,
}: {
  line: string,
  span: { start: number, end: number },
  ignoreLeadingBlanks: boolean,
}): number {
  if (!ignoreLeadingBlanks) {
    return span.start;
  }

  let index = span.start;
  while (index < span.end && (line[index] === ' ' || line[index] === '\t')) {
    index++;
  }
  return index;
}

function getSpanPosition({
  line,
  span,
  char,
  ignoreLeadingBlanks,
  kind,
}: {
  line: string,
  span: { start: number, end: number },
  char: number | undefined,
  ignoreLeadingBlanks: boolean,
  kind: 'start' | 'end',
}): number {
  const base = getSpanBase({ line, span, ignoreLeadingBlanks });
  if (char === undefined) {
    switch (kind) {
    case 'start':
      return base;
    case 'end':
      return span.end;
    default: {
      const _ex: never = kind;
      throw new Error(`Unhandled span position kind: ${_ex}`);
    }
    }
  }

  const characterCount = (() => {
    switch (kind) {
    case 'start':
      return char - 1;
    case 'end':
      return char;
    default: {
      const _ex: never = kind;
      throw new Error(`Unhandled span position kind: ${_ex}`);
    }
    }
  })();
  let position = base;
  // A .CHAR offset is measured from the selected field start but is not
  // clamped to that field's end.  GNU sort therefore lets -k1.2,1.4 include
  // separator bytes (and even bytes from the following field) when field 1
  // is shorter than four characters.
  for (let index = 0; index < characterCount && position < line.length; index += 1) {
    const codePoint = line.codePointAt(position)!;
    position += codePoint > 0xffff ? 2 : 1;
  }
  return Math.min(position, line.length);
}

function applySortOrder({
  value,
  order,
}: {
  value: number,
  order: SortOrder,
}): number {
  switch (order) {
  case 'forward':
    return value;
  case 'reverse':
    return -value;
  default: {
    const _ex: never = order;
    throw new Error(`Unhandled sort order: ${_ex}`);
  }
  }
}

function shouldTreatAsUnique({
  stable,
  uniqueness,
}: {
  stable: boolean,
  uniqueness: SortResolvedOptions['uniqueness'],
}): boolean {
  switch (uniqueness) {
  case 'all':
    return stable;
  case 'unique':
    return true;
  default: {
    const _ex: never = uniqueness;
    throw new Error(`Unhandled sort uniqueness: ${_ex}`);
  }
  }
}

function parseKeyToken({
  token,
}: {
  token: string,
}): SortKeyParseResult {
  if (token.trim().length === 0) {
    return { ok: false, reason: 'syntax', message: 'empty key definition is not allowed' };
  }

  const parts = token.split(',');
  if (parts.length > 2) {
    return { ok: false, reason: 'syntax', message: `invalid key definition: '${token}'` };
  }

  const parsePart = ({
    part,
  }: {
    part: string,
  }): { ok: true, value: { field: number, char: number | undefined, modifiers: string } } | SortKeyParseError => {
    const match = part.match(/^([1-9]\d*)(?:\.([1-9]\d*))?([A-Za-z]*)$/);
    if (match === null) {
      return { ok: false, reason: 'syntax', message: `invalid key definition: '${token}'` };
    }

    return {
      ok: true,
      value: {
        field: Number.parseInt(match[1]!, 10),
        char: match[2] === undefined ? undefined : Number.parseInt(match[2], 10),
        modifiers: match[3] ?? '',
      },
    };
  };

  const startPart = parsePart({ part: parts[0]! });
  if (!startPart.ok) {
    return startPart;
  }

  const endPart = parts[1] === undefined ? undefined : parsePart({ part: parts[1] });
  if (endPart !== undefined && !endPart.ok) {
    return endPart;
  }

  const modifiers = new Set<string>();
  for (const modifier of startPart.value.modifiers) {
    modifiers.add(modifier);
  }
  if (endPart !== undefined) {
    for (const modifier of endPart.value.modifiers) {
      modifiers.add(modifier);
    }
  }

  let mode: SortMode | undefined;
  const keyModes = new Set<SortMode>();
  let reverse = false;
  let ignoreLeadingBlanks = false;
  let foldCase = false;
  let dictionaryOrder = false;
  let ignoreNonprinting = false;

  for (const modifier of modifiers) {
    switch (modifier) {
    case 'b':
      ignoreLeadingBlanks = true;
      break;
    case 'd':
      dictionaryOrder = true;
      break;
    case 'f':
      foldCase = true;
      break;
    case 'g':
      keyModes.add('general-numeric');
      mode = 'general-numeric';
      break;
    case 'h':
      keyModes.add('human-numeric');
      mode = 'human-numeric';
      break;
    case 'i':
      ignoreNonprinting = true;
      break;
    case 'M':
      keyModes.add('month');
      mode = 'month';
      break;
    case 'n':
      keyModes.add('numeric');
      mode = 'numeric';
      break;
    case 'r':
    case 'R':
      reverse = true;
      break;
    case 'V':
      keyModes.add('version');
      mode = 'version';
      break;
    default:
      return { ok: false, reason: 'syntax', message: `invalid key definition: '${token}'` };
    }
  }

  if (keyModes.size > 1) {
    return { ok: false, reason: 'order', message: `incompatible ordering options in key definition: '${token}'` };
  }

  return {
    ok: true,
    value: {
      startField: startPart.value.field,
      startChar: startPart.value.char,
      endField: endPart?.value.field,
      endChar: endPart?.value.char,
      mode,
      reverse,
      ignoreLeadingBlanks,
      foldCase,
      dictionaryOrder,
      ignoreNonprinting,
    },
  };
}

function readSortOptionValue({ value }: { value: StandardArgvRawValue }): string {
  if (!('rawValue' in value)) {
    throw new Error('Missing parsed sort option value');
  }
  return value.rawValue;
}

function parseSortCheckMode({ value }: { value: string | undefined }):
  | { ok: true, mode: Exclude<SortCheckMode, 'none'> }
  | { ok: false, message: string } {
  if (value === '') {
    return { ok: false, message: "ambiguous argument '' for '--check'" };
  }
  if (value === undefined || 'diagnose-first'.startsWith(value)) {
    return { ok: true, mode: 'strict' };
  }
  if ('quiet'.startsWith(value) || 'silent'.startsWith(value)) {
    return { ok: true, mode: 'silent' };
  }
  return { ok: false, message: `invalid argument '${value}' for '--check'` };
}

function resolveSortOptions({
  parsed,
  characterLocaleMode,
}: {
  parsed: ParsedStandardArgv<SortArgvTag>,
  characterLocaleMode: WeshCharacterLocaleMode,
}): SortResolvedOptionsResult {
  const diagnostic = parsed.diagnostics[0];
  const keySpecs: SortKeySpec[] = [];
  let outputPath: string | undefined;
  let fieldSeparator: string | undefined;
  let checkMode: SortCheckMode = 'none';
  let mode: SortMode = 'lexical';
  let incompatibleGlobalModes = false;
  let keyOrderError: string | undefined;

  // Validate syntax and conflicting option values where they occur. Ordering
  // modes are checked after help, and repeated keys retain their argv order.
  for (const occurrence of parsed.deferred) {
    if (diagnostic !== undefined && (
      diagnostic.argvIndex < occurrence.argvIndex
      || (diagnostic.argvIndex === occurrence.argvIndex && diagnostic.tokenOffset <= occurrence.tokenStart)
    )) {
      break;
    }

    const tag = occurrence.semantic.tag;
    switch (tag) {
    case 'key': {
      const key = parseKeyToken({ token: readSortOptionValue({ value: occurrence.value }) });
      if (key.ok) {
        keySpecs.push(key.value);
      } else {
        switch (key.reason) {
        case 'syntax':
          return { kind: 'invalid', message: key.message, exitCode: 2 };
        case 'order':
          keyOrderError ??= key.message;
          break;
        default: {
          const _ex: never = key.reason;
          throw new Error(`Unhandled sort key error: ${_ex}`);
        }
        }
      }
      break;
    }
    case 'outputPath': {
      const path = readSortOptionValue({ value: occurrence.value });
      if (outputPath !== undefined && outputPath !== path) {
        return { kind: 'invalid', message: 'multiple output files specified', exitCode: 2 };
      }
      outputPath = path;
      break;
    }
    case 'fieldSeparator': {
      const separator = decodeFieldSeparator({ value: readSortOptionValue({ value: occurrence.value }) });
      if (new TextEncoder().encode(separator).byteLength !== 1) {
        return { kind: 'invalid', message: `multi-character field separator: '${separator}'`, exitCode: 2 };
      }
      if (fieldSeparator !== undefined && fieldSeparator !== separator) {
        return { kind: 'invalid', message: 'incompatible field separators', exitCode: 2 };
      }
      fieldSeparator = separator;
      break;
    }
    case 'check':
    case 'silentCheck': {
      const value = (() => {
        switch (tag) {
        case 'check':
          return 'rawValue' in occurrence.value ? occurrence.value.rawValue : undefined;
        case 'silentCheck':
          return 'silent';
        default: {
          const _ex: never = tag;
          throw new Error(`Unhandled sort check option: ${_ex}`);
        }
        }
      })();
      const check = parseSortCheckMode({ value });
      if (!check.ok) {
        return { kind: 'invalid', message: check.message, exitCode: 1 };
      }
      if (checkMode !== 'none' && checkMode !== check.mode) {
        return { kind: 'invalid', message: "options '-cC' are incompatible", exitCode: 2 };
      }
      checkMode = check.mode;
      break;
    }
    case 'numeric':
    case 'general-numeric':
    case 'human-numeric':
    case 'month':
    case 'version':
      incompatibleGlobalModes ||= mode !== 'lexical' && mode !== tag;
      mode = tag;
      break;
    case 'help':
      return { kind: 'help' };
    default: {
      const _ex: never = tag;
      throw new Error(`Unhandled sort option: ${_ex}`);
    }
    }
  }

  if (diagnostic !== undefined) {
    return { kind: 'invalid', message: diagnostic.message, exitCode: 2 };
  }
  if (incompatibleGlobalModes) {
    return { kind: 'invalid', message: 'multiple ordering options are incompatible', exitCode: 2 };
  }
  if (keyOrderError !== undefined) {
    return { kind: 'invalid', message: keyOrderError, exitCode: 2 };
  }

  return {
    kind: 'parsed',
    options: {
      mode,
      order: parsed.optionValues.order === 'reverse' ? 'reverse' : 'forward',
      uniqueness: parsed.optionValues.uniqueness === 'unique' ? 'unique' : 'all',
      stable: parsed.optionValues.stable === true,
      foldCase: parsed.optionValues.foldCase === true,
      ignoreLeadingBlanks: parsed.optionValues.ignoreLeadingBlanks === true,
      dictionaryOrder: parsed.optionValues.dictionaryOrder === true,
      ignoreNonprinting: parsed.optionValues.ignoreNonprinting === true,
      checkMode,
      merge: parsed.optionValues.merge === true,
      zeroTerminated: parsed.optionValues.zeroTerminated === true,
      outputPath,
      fieldSeparator,
      characterLocaleMode,
      keySpecs: keySpecs.map((keySpec) => ({
        ...keySpec,
        ignoreLeadingBlanks: keySpec.ignoreLeadingBlanks || parsed.optionValues.ignoreLeadingBlanks === true,
        foldCase: keySpec.foldCase || parsed.optionValues.foldCase === true,
        dictionaryOrder: keySpec.dictionaryOrder || parsed.optionValues.dictionaryOrder === true,
        ignoreNonprinting: keySpec.ignoreNonprinting || parsed.optionValues.ignoreNonprinting === true,
        fieldSeparator,
      })),
    },
  };
}

function bytesToByteString({ bytes }: { bytes: Uint8Array }): string {
  const chunks: string[] = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
  }
  return chunks.join('');
}

function getByteString({ record }: { record: SortRecord }): string {
  if (record.byteString === undefined) {
    record.byteString = bytesToByteString({ bytes: record.bytes });
  }
  return record.byteString;
}

function getComparisonText({
  record,
  characterLocaleMode,
}: {
  record: SortRecord,
  characterLocaleMode: WeshCharacterLocaleMode,
}): string {
  switch (characterLocaleMode) {
  case 'ascii':
    // In the C/POSIX locale, sort character positions and transformed
    // comparisons are byte-oriented.  A one-code-unit-per-byte view avoids
    // UTF-8 decoding replacement characters changing key boundaries or order.
    return getByteString({ record });
  case 'unicode':
    return record.value;
  default: {
    const _ex: never = characterLocaleMode;
    throw new Error(`Unhandled sort character locale mode: ${_ex}`);
  }
  }
}

function resolveKeyText({
  line,
  keySpec,
}: {
  line: string,
  keySpec: SortResolvedKeySpec,
}): string {
  const fields = splitFields({ line, separator: keySpec.fieldSeparator });
  const startSpan = fields[keySpec.startField - 1];
  if (startSpan === undefined) {
    return '';
  }

  const start = getSpanPosition({
    line,
    span: startSpan,
    char: keySpec.startChar,
    ignoreLeadingBlanks: keySpec.ignoreLeadingBlanks,
    kind: 'start',
  });

  if (keySpec.endField === undefined) {
    return line.slice(start);
  }

  const endSpan = fields[keySpec.endField - 1];
  if (endSpan === undefined) {
    return line.slice(start);
  }

  const end = getSpanPosition({
    line,
    span: endSpan,
    char: keySpec.endChar,
    ignoreLeadingBlanks: keySpec.ignoreLeadingBlanks,
    kind: 'end',
  });

  if (end <= start) {
    return '';
  }
  return line.slice(start, end);
}

function compareEntries({
  left,
  right,
  options,
}: {
  left: SortEntry,
  right: SortEntry,
  options: SortResolvedOptions,
}): number {
  const compareWholeLines = (): number => compareSortRecordBytes({
    left: left.bytes,
    right: right.bytes,
  });

  if (options.keySpecs.length > 0) {
    for (const keySpec of options.keySpecs) {
      const normalization = getNormalization({
        options: {
          foldCase: keySpec.foldCase || options.foldCase,
          ignoreLeadingBlanks: keySpec.ignoreLeadingBlanks || options.ignoreLeadingBlanks,
          dictionaryOrder: keySpec.dictionaryOrder || options.dictionaryOrder,
          ignoreNonprinting: keySpec.ignoreNonprinting || options.ignoreNonprinting,
        },
      });

      const compared = compareValues({
        // GNU sort's FIELD.CHAR offsets are byte positions even in a
        // multibyte locale.  Use the byte-preserving view for both locating
        // and comparing a key so a boundary may intentionally split UTF-8.
        left: resolveKeyText({ line: getByteString({ record: left }), keySpec }),
        right: resolveKeyText({ line: getByteString({ record: right }), keySpec }),
        mode: keySpec.mode ?? options.mode,
        normalization,
      });

      if (compared !== 0) {
        const oriented = keySpec.reverse ? -compared : compared;
        return applySortOrder({ value: oriented, order: options.order });
      }
    }
  } else {
    const plainLexicalComparison =
      options.mode === 'lexical'
      && !options.foldCase
      && !options.ignoreLeadingBlanks
      && !options.dictionaryOrder
      && !options.ignoreNonprinting;
    const primary = plainLexicalComparison
      ? compareSortRecordBytes({ left: left.bytes, right: right.bytes })
      : compareValues({
        left: getComparisonText({ record: left, characterLocaleMode: options.characterLocaleMode }),
        right: getComparisonText({ record: right, characterLocaleMode: options.characterLocaleMode }),
        mode: options.mode,
        normalization: getNormalization({
          options: {
            foldCase: options.foldCase,
            ignoreLeadingBlanks: options.ignoreLeadingBlanks,
            dictionaryOrder: options.dictionaryOrder,
            ignoreNonprinting: options.ignoreNonprinting,
          },
        }),
      });

    if (primary !== 0) {
      return applySortOrder({ value: primary, order: options.order });
    }
  }

  if (shouldTreatAsUnique({ stable: options.stable, uniqueness: options.uniqueness })) {
    return 0;
  }

  const fallback = compareWholeLines();
  return applySortOrder({ value: fallback, order: options.order });
}


const SORT_MEMORY_LIMIT_BYTES = 4 * 1024 * 1024;
const SORT_MERGE_FAN_IN = 32;

class SortTemporaryDirectoryError extends Error {
  readonly directory: string;
  readonly detail: string;

  constructor({
    directory,
    detail,
  }: {
    directory: string,
    detail: string,
  }) {
    super(`Cannot create a sort temporary file in ${directory}: ${detail}`);
    this.name = 'SortTemporaryDirectoryError';
    this.directory = directory;
    this.detail = detail;
  }
}

function createEmptyAsyncIterator(): AsyncIterator<SortRecord> {
  return {
    next: async () => ({ done: true, value: undefined }),
  };
}

async function* iterateSortRecords({
  stream,
  zeroTerminated,
  stripTrailingCarriageReturn,
}: {
  stream: ReadableStream<Uint8Array>,
  zeroTerminated: boolean,
  stripTrailingCarriageReturn: boolean,
}): AsyncIterable<SortRecord> {
  for await (const record of iterateUtf8RecordEntries({
    chunks: iterateReadableStreamChunks({ stream }),
    delimiterByte: zeroTerminated ? 0 : 0x0a,
    stripTrailingCarriageReturn,
    includeBytes: true,
  })) {
    yield { value: record.text, bytes: record.bytes! };
  }
}

async function openSortRecordIterator({
  context,
  file,
  zeroTerminated,
  stdinAvailable,
}: {
  context: WeshCommandContext,
  file: string | undefined,
  zeroTerminated: boolean,
  stdinAvailable: { value: boolean },
}): Promise<AsyncIterator<SortRecord>> {
  const usesStdin = file === undefined || file === '-';
  if (usesStdin && !stdinAvailable.value) {
    return createEmptyAsyncIterator();
  }
  if (usesStdin) {
    stdinAvailable.value = false;
  }

  const stream = usesStdin
    ? openHandleReadStream({ handle: context.stdin })
    : await openFileReadStream({
      files: context.files,
      path: resolveInputPath({ cwd: context.cwd, path: file }),
    });
  return iterateSortRecords({
    stream,
    zeroTerminated,
    stripTrailingCarriageReturn: false,
  })[Symbol.asyncIterator]();
}

async function closeIterator({
  iterator,
}: {
  iterator: AsyncIterator<SortRecord> | undefined,
}): Promise<void> {
  await iterator?.return?.();
}

function needsByteStringComparison({ options }: { options: SortResolvedOptions }): boolean {
  if (options.keySpecs.length > 0) {
    return true;
  }
  switch (options.characterLocaleMode) {
  case 'ascii':
    return options.mode !== 'lexical'
      || options.foldCase
      || options.ignoreLeadingBlanks
      || options.dictionaryOrder
      || options.ignoreNonprinting;
  case 'unicode':
    return false;
  default: {
    const _ex: never = options.characterLocaleMode;
    throw new Error(`Unhandled sort character locale mode: ${_ex}`);
  }
  }
}

function estimateSortEntryBytes({
  record,
  options,
}: {
  record: SortRecord,
  options: SortResolvedOptions,
}): number {
  const cachedByteStringBytes = needsByteStringComparison({ options })
    ? record.bytes.byteLength * 2
    : 0;
  return 64 + record.value.length * 2 + record.bytes.byteLength + cachedByteStringBytes;
}

function createTemporaryName({
  prefix,
  pid,
}: {
  prefix: string,
  pid: number,
}): string {
  const random = Math.random().toString(36).slice(2, 14);
  return `${prefix}-${pid}-${random}`;
}

async function writeRun({
  context,
  path,
  entries,
  zeroTerminated,
}: {
  context: WeshCommandContext,
  path: string,
  entries: readonly SortEntry[],
  zeroTerminated: boolean,
}): Promise<void> {
  const handle = await context.files.open({
    path,
    flags: {
      access: 'write',
      creation: 'always',
      truncate: 'truncate',
      append: 'preserve',
    },
  });
  const writer = createBufferedSortWriter({
    handle,
    maxBufferLength: 32 * 1024,
  });
  try {
    for (const entry of entries) {
      await writeSortRecord({ writer, record: entry, zeroTerminated });
    }
    await writer.flush();
  } finally {
    await handle.close();
  }
}

async function openRunIterator({
  context,
  path,
  zeroTerminated,
}: {
  context: WeshCommandContext,
  path: string,
  zeroTerminated: boolean,
}): Promise<AsyncIterator<SortRecord>> {
  const stream = await openFileReadStream({ files: context.files, path });
  return iterateSortRecords({
    stream,
    zeroTerminated,
    stripTrailingCarriageReturn: false,
  })[Symbol.asyncIterator]();
}

interface SortOutput {
  readonly handle: WeshFileHandle,
  readonly writer: ReturnType<typeof createBufferedSortWriter>,
  readonly temporaryPath: string | undefined,
  readonly outputPath: string | undefined,
  readonly recoveryPath: string | undefined,
}

async function createSortOutput({
  context,
  outputPath,
}: {
  context: WeshCommandContext,
  outputPath: string | undefined,
}): Promise<SortOutput> {
  if (outputPath === undefined) {
    return {
      handle: context.stdout,
      writer: createBufferedSortWriter({
        handle: context.stdout,
        maxBufferLength: 32 * 1024,
      }),
      temporaryPath: undefined,
      outputPath: undefined,
      recoveryPath: undefined,
    };
  }

  const resolvedOutputPath = resolveInputPath({
    cwd: context.cwd,
    path: outputPath,
  });
  let outputMode: number | undefined;
  try {
    outputMode = (await context.files.stat({ path: resolvedOutputPath })).mode;
  } catch {
    outputMode = undefined;
  }

  for (let attempt = 0; attempt < 100; attempt++) {
    const temporaryPath = `${resolvedOutputPath}.${createTemporaryName({
      prefix: 'wesh-sort',
      pid: context.pid,
    })}`;
    try {
      const handle = await context.files.open({
        path: temporaryPath,
        flags: {
          access: 'write',
          creation: 'always',
          truncate: 'truncate',
          append: 'preserve',
        },
        mode: outputMode,
      });
      return {
        handle,
        writer: createBufferedSortWriter({
          handle,
          maxBufferLength: 32 * 1024,
        }),
        temporaryPath,
        outputPath: resolvedOutputPath,
        recoveryPath: `${temporaryPath}.original`,
      };
    } catch (error: unknown) {
      if (attempt === 99) {
        throw error;
      }
    }
  }
  throw new Error(`Unable to create sort output for ${resolvedOutputPath}`);
}

async function finalizeSortOutput({
  context,
  output,
  status,
}: {
  context: WeshCommandContext,
  output: SortOutput,
  status: 'commit' | 'abort',
}): Promise<void> {
  if (
    output.temporaryPath === undefined
    || output.outputPath === undefined
    || output.recoveryPath === undefined
  ) {
    await output.writer.flush();
    return;
  }

  let ioError: { readonly value: unknown } | undefined;
  try {
    await output.writer.flush();
  } catch (error: unknown) {
    ioError = { value: error };
  }
  try {
    await output.handle.close();
  } catch (error: unknown) {
    ioError ??= { value: error };
  }
  if (ioError !== undefined) {
    try {
      await context.files.unlink({ path: output.temporaryPath });
    } catch {
      // Preserve the write or close error.
    }
    throw ioError.value;
  }
  switch (status) {
  case 'abort':
    try {
      await context.files.unlink({ path: output.temporaryPath });
    } catch {
      // Best-effort cleanup.
    }
    return;
  case 'commit':
    break;
  default: {
    const _ex: never = status;
    throw new Error(`Unhandled sort output status: ${_ex}`);
  }
  }

  let destinationMoved = false;
  try {
    let destinationExists = false;
    try {
      await context.files.stat({ path: output.outputPath });
      destinationExists = true;
    } catch {
      destinationExists = false;
    }

    if (destinationExists) {
      await context.files.rename({
        oldPath: output.outputPath,
        newPath: output.recoveryPath,
      });
      destinationMoved = true;
    }

    try {
      await context.files.rename({
        oldPath: output.temporaryPath,
        newPath: output.outputPath,
      });
    } catch (error: unknown) {
      if (destinationMoved) {
        await context.files.rename({
          oldPath: output.recoveryPath,
          newPath: output.outputPath,
        });
        destinationMoved = false;
      }
      throw error;
    }

    if (destinationMoved) {
      await context.files.unlink({ path: output.recoveryPath });
    }
  } catch (error: unknown) {
    try {
      await context.files.unlink({ path: output.temporaryPath });
    } catch {
      // Preserve the commit error.
    }
    throw error;
  }
}

interface SortWriter {
  readonly writer: ReturnType<typeof createBufferedSortWriter>,
}

async function emitMergedIterators({
  iterators,
  options,
  output,
}: {
  iterators: readonly AsyncIterator<SortRecord>[],
  options: SortResolvedOptions,
  output: SortWriter,
}): Promise<void> {
  const current = await Promise.all(iterators.map(async (iterator) => iterator.next()));
  let previous: SortEntry | undefined;

  while (true) {
    let selectedIndex: number | undefined;
    let selected: SortEntry | undefined;
    for (let index = 0; index < current.length; index += 1) {
      const candidateResult = current[index];
      if (candidateResult === undefined || candidateResult.done) {
        continue;
      }
      const candidate: SortEntry = {
        ...candidateResult.value,
        index: 0,
      };
      if (selected === undefined) {
        selected = candidate;
        selectedIndex = index;
        continue;
      }
      const compared = compareEntries({ left: candidate, right: selected, options });
      if (compared < 0 || (compared === 0 && index < (selectedIndex ?? Number.MAX_SAFE_INTEGER))) {
        selected = candidate;
        selectedIndex = index;
      }
    }

    if (selected === undefined || selectedIndex === undefined) {
      return;
    }

    const shouldWrite = options.uniqueness === 'all'
      || previous === undefined
      || compareEntries({ left: previous, right: selected, options }) !== 0;
    if (shouldWrite) {
      await writeSortRecord({
        writer: output.writer,
        record: selected,
        zeroTerminated: options.zeroTerminated,
      });
      previous = selected;
    }
    current[selectedIndex] = await iterators[selectedIndex]!.next();
  }
}


async function mergeRunPaths({
  context,
  paths,
  outputPath,
  options,
}: {
  context: WeshCommandContext,
  paths: readonly string[],
  outputPath: string,
  options: SortResolvedOptions,
}): Promise<void> {
  const handle = await context.files.open({
    path: outputPath,
    flags: {
      access: 'write',
      creation: 'always',
      truncate: 'truncate',
      append: 'preserve',
    },
  });
  const output: SortWriter = {
    writer: createBufferedSortWriter({
      handle,
      maxBufferLength: 32 * 1024,
    }),
  };
  const iterators: AsyncIterator<SortRecord>[] = [];
  let completed = false;
  try {
    for (const path of paths) {
      iterators.push(await openRunIterator({
        context,
        path,
        zeroTerminated: options.zeroTerminated,
      }));
    }
    await emitMergedIterators({ iterators, options, output });
    await output.writer.flush();
    completed = true;
  } finally {
    for (const iterator of iterators) {
      await closeIterator({ iterator });
    }
    await handle.close();
    if (!completed) {
      try {
        await context.files.unlink({ path: outputPath });
      } catch {
        // Best-effort cleanup.
      }
    }
  }
}


interface SortRunStore {
  readonly directory: string,
  readonly livePaths: Set<string>,
  readonly levels: string[][],
  readonly inputOrderByPath: Map<string, number>,
  nextRunIndex: number,
  nextInputOrder: number,
}

async function createSortRunStore({
  context,
}: {
  context: WeshCommandContext,
}): Promise<SortRunStore> {
  const baseDirectory = (context.env.get('TMPDIR') || '/tmp').replace(/\/$/u, '');
  for (let attempt = 0; attempt < 100; attempt++) {
    const directory = `${baseDirectory}/${createTemporaryName({
      prefix: '.wesh-sort',
      pid: context.pid,
    })}`;
    try {
      await context.files.mkdir({
        path: directory,
        mode: 0o700,
        recursive: false,
      });
      return {
        directory,
        livePaths: new Set<string>(),
        levels: [],
        inputOrderByPath: new Map<string, number>(),
        nextRunIndex: 0,
        nextInputOrder: 0,
      };
    } catch (error: unknown) {
      if (attempt === 99) {
        throw new SortTemporaryDirectoryError({
          directory: baseDirectory,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  throw new Error('Unable to create sort temporary directory');
}

function allocateSortRunPath({
  store,
}: {
  store: SortRunStore,
}): string {
  const path = `${store.directory}/run-${store.nextRunIndex}`;
  store.nextRunIndex += 1;
  return path;
}

function registerInitialSortRun({
  store,
  path,
}: {
  store: SortRunStore,
  path: string,
}): void {
  store.livePaths.add(path);
  store.inputOrderByPath.set(path, store.nextInputOrder);
  store.nextInputOrder += 1;
}

function registerMergedSortRun({
  store,
  path,
  inputPaths,
}: {
  store: SortRunStore,
  path: string,
  inputPaths: readonly string[],
}): void {
  const inputOrders = inputPaths.map((inputPath) => {
    const order = store.inputOrderByPath.get(inputPath);
    if (order === undefined) {
      throw new Error(`Missing sort run order for ${inputPath}`);
    }
    return order;
  });
  store.livePaths.add(path);
  store.inputOrderByPath.set(path, Math.min(...inputOrders));
}

async function deleteSortRun({
  context,
  store,
  path,
}: {
  context: WeshCommandContext,
  store: SortRunStore,
  path: string,
}): Promise<void> {
  if (!store.livePaths.has(path)) {
    return;
  }
  await context.files.unlink({ path });
  store.livePaths.delete(path);
  store.inputOrderByPath.delete(path);
}

async function tryDeleteSortRun({
  context,
  store,
  path,
}: {
  context: WeshCommandContext,
  store: SortRunStore,
  path: string,
}): Promise<void> {
  try {
    await deleteSortRun({ context, store, path });
  } catch {
    // Keep the path live so final cleanup can retry it.
  }
}

async function addSortRunAtLevel({
  context,
  store,
  path,
  level,
  options,
}: {
  context: WeshCommandContext,
  store: SortRunStore,
  path: string,
  level: number,
  options: SortResolvedOptions,
}): Promise<void> {
  const levelPaths = store.levels[level] ?? [];
  if (store.levels[level] === undefined) {
    store.levels[level] = levelPaths;
  }
  levelPaths.push(path);
  if (levelPaths.length < SORT_MERGE_FAN_IN) {
    return;
  }

  const inputPaths = levelPaths.splice(0, SORT_MERGE_FAN_IN);
  const outputPath = allocateSortRunPath({ store });
  await mergeRunPaths({
    context,
    paths: inputPaths,
    outputPath,
    options,
  });
  registerMergedSortRun({ store, path: outputPath, inputPaths });
  for (const inputPath of inputPaths) {
    await tryDeleteSortRun({ context, store, path: inputPath });
  }
  await addSortRunAtLevel({
    context,
    store,
    path: outputPath,
    level: level + 1,
    options,
  });
}

function orderSortRunPaths({
  paths,
  inputOrderByPath,
}: {
  paths: readonly string[],
  inputOrderByPath: ReadonlyMap<string, number>,
}): string[] {
  return paths
    .map((path) => {
      const inputOrder = inputOrderByPath.get(path);
      if (inputOrder === undefined) {
        throw new Error('Missing sort run input order');
      }
      return { path, inputOrder };
    })
    .sort((left, right) => left.inputOrder - right.inputOrder)
    .map(({ path }) => path);
}

function collectSortRunPaths({
  store,
}: {
  store: SortRunStore,
}): string[] {
  return orderSortRunPaths({
    paths: store.levels.flatMap((paths) => paths),
    inputOrderByPath: store.inputOrderByPath,
  });
}

async function reduceSortRunsToFanIn({
  context,
  store,
  paths,
  options,
}: {
  context: WeshCommandContext,
  store: SortRunStore,
  paths: readonly string[],
  options: SortResolvedOptions,
}): Promise<string[]> {
  let currentPaths = [...paths];
  while (currentPaths.length > SORT_MERGE_FAN_IN) {
    const nextPaths: string[] = [];
    for (let offset = 0; offset < currentPaths.length; offset += SORT_MERGE_FAN_IN) {
      const inputPaths = currentPaths.slice(offset, offset + SORT_MERGE_FAN_IN);
      if (inputPaths.length === 1) {
        nextPaths.push(inputPaths[0]!);
        continue;
      }
      const outputPath = allocateSortRunPath({ store });
      await mergeRunPaths({
        context,
        paths: inputPaths,
        outputPath,
        options,
      });
      registerMergedSortRun({ store, path: outputPath, inputPaths });
      for (const inputPath of inputPaths) {
        await deleteSortRun({ context, store, path: inputPath });
      }
      nextPaths.push(outputPath);
    }
    currentPaths = nextPaths;
  }
  return currentPaths;
}

async function emitRunPaths({
  context,
  paths,
  options,
  output,
}: {
  context: WeshCommandContext,
  paths: readonly string[],
  options: SortResolvedOptions,
  output: SortWriter,
}): Promise<void> {
  const iterators: AsyncIterator<SortRecord>[] = [];
  try {
    for (const path of paths) {
      iterators.push(await openRunIterator({
        context,
        path,
        zeroTerminated: options.zeroTerminated,
      }));
    }
    await emitMergedIterators({ iterators, options, output });
  } finally {
    for (const iterator of iterators) {
      await closeIterator({ iterator });
    }
  }
}

async function mergeInputFilesToRun({
  context,
  files,
  stdinAvailable,
  outputPath,
  options,
}: {
  context: WeshCommandContext,
  files: readonly (string | undefined)[],
  stdinAvailable: { value: boolean },
  outputPath: string,
  options: SortResolvedOptions,
}): Promise<void> {
  const handle = await context.files.open({
    path: outputPath,
    flags: {
      access: 'write',
      creation: 'always',
      truncate: 'truncate',
      append: 'preserve',
    },
  });
  const output: SortWriter = {
    writer: createBufferedSortWriter({
      handle,
      maxBufferLength: 32 * 1024,
    }),
  };
  const iterators: AsyncIterator<SortRecord>[] = [];
  let completed = false;
  try {
    for (const file of files) {
      iterators.push(await openSortRecordIterator({
        context,
        file,
        zeroTerminated: options.zeroTerminated,
        stdinAvailable,
      }));
    }
    await emitMergedIterators({ iterators, options, output });
    await output.writer.flush();
    completed = true;
  } finally {
    for (const iterator of iterators) {
      await closeIterator({ iterator });
    }
    await handle.close();
    if (!completed) {
      try {
        await context.files.unlink({ path: outputPath });
      } catch {
        // Best-effort cleanup.
      }
    }
  }
}

async function cleanupSortRunStore({
  context,
  store,
}: {
  context: WeshCommandContext,
  store: SortRunStore | undefined,
}): Promise<void> {
  if (store === undefined) {
    return;
  }
  for (const path of [...store.livePaths]) {
    try {
      await deleteSortRun({ context, store, path });
    } catch {
      // Best-effort cleanup.
    }
  }
  try {
    await context.files.rmdir({ path: store.directory });
  } catch {
    // Best-effort cleanup.
  }
}

async function checkSortedInputs({
  context,
  files,
  options,
  checkMode,
}: {
  context: WeshCommandContext,
  files: readonly (string | undefined)[],
  options: SortResolvedOptions,
  checkMode: 'strict' | 'silent',
}): Promise<WeshCommandResult> {
  const stdinAvailable = { value: true };
  let previous: SortEntry | undefined;
  let lineNumber = 0;

  for (const file of files) {
    let iterator: AsyncIterator<SortRecord> | undefined;
    try {
      iterator = await openSortRecordIterator({
        context,
        file,
        zeroTerminated: options.zeroTerminated,
        stdinAvailable,
      });
      while (true) {
        const next = await iterator.next();
        if (next.done) {
          break;
        }
        lineNumber += 1;
        const current: SortEntry = { ...next.value, index: lineNumber - 1 };
        if (previous !== undefined) {
          const comparison = compareEntries({ left: previous, right: current, options });
          const isDisordered = comparison > 0
            || (options.uniqueness === 'unique' && comparison === 0);
          if (isDisordered) {
            switch (checkMode) {
            case 'strict':
              await context.text().error({
                text: `sort: disorder at line ${lineNumber}: ${current.value}\n`,
              });
              break;
            case 'silent':
              break;
            default: {
              const _ex: never = checkMode;
              throw new Error(`Unhandled sort check mode: ${_ex}`);
            }
            }
            return { exitCode: 1 };
          }
        }
        previous = current;
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await context.text().error({ text: `sort: ${file ?? '-'}: ${message}\n` });
      return { exitCode: 2 };
    } finally {
      await closeIterator({ iterator });
    }
  }
  return { exitCode: 0 };
}

const sortOptions = [
  {
    semantic: { kind: 'effects', effects: [{ key: 'ignoreLeadingBlanks', value: true }] },
    forms: [
      { kind: 'short', name: 'b', value: { kind: 'none' } },
      { kind: 'long', name: 'ignore-leading-blanks', value: { kind: 'none' } },
    ],
    summary: 'ignore leading blanks when comparing',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'dictionaryOrder', value: true }] },
    forms: [
      { kind: 'short', name: 'd', value: { kind: 'none' } },
      { kind: 'long', name: 'dictionary-order', value: { kind: 'none' } },
    ],
    summary: 'consider only blanks and alphanumeric characters',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'foldCase', value: true }] },
    forms: [
      { kind: 'short', name: 'f', value: { kind: 'none' } },
      { kind: 'long', name: 'ignore-case', value: { kind: 'none' } },
    ],
    summary: 'fold lower case to upper case characters',
    category: 'common',
  },
  {
    semantic: { kind: 'deferred', tag: 'general-numeric' },
    forms: [
      { kind: 'short', name: 'g', value: { kind: 'none' } },
      { kind: 'long', name: 'general-numeric-sort', value: { kind: 'none' } },
    ],
    summary: 'compare according to general numerical value',
    category: 'advanced',
  },
  {
    semantic: { kind: 'deferred', tag: 'human-numeric' },
    forms: [
      { kind: 'short', name: 'h', value: { kind: 'none' } },
      { kind: 'long', name: 'human-numeric-sort', value: { kind: 'none' } },
    ],
    summary: 'compare human readable numbers (e.g. 2K)',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'ignoreNonprinting', value: true }] },
    forms: [
      { kind: 'short', name: 'i', value: { kind: 'none' } },
      { kind: 'long', name: 'ignore-nonprinting', value: { kind: 'none' } },
    ],
    summary: 'consider only printable characters',
    category: 'advanced',
  },
  {
    semantic: { kind: 'deferred', tag: 'key' },
    forms: [
      { kind: 'short', name: 'k', value: { kind: 'required-attached-or-following', missingValueName: 'KEYDEF' } },
      { kind: 'long', name: 'key', value: { kind: 'required', missingValueName: 'KEYDEF' } },
    ],
    summary: 'sort by a key definition',
    valueName: 'KEYDEF',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'merge', value: true }] },
    forms: [
      { kind: 'short', name: 'm', value: { kind: 'none' } },
      { kind: 'long', name: 'merge', value: { kind: 'none' } },
    ],
    summary: 'merge already-sorted inputs',
    category: 'advanced',
  },
  {
    semantic: { kind: 'deferred', tag: 'month' },
    forms: [
      { kind: 'short', name: 'M', value: { kind: 'none' } },
      { kind: 'long', name: 'month-sort', value: { kind: 'none' } },
    ],
    summary: 'sort by month name',
    category: 'advanced',
  },
  {
    semantic: { kind: 'deferred', tag: 'numeric' },
    forms: [
      { kind: 'short', name: 'n', value: { kind: 'none' } },
      { kind: 'long', name: 'numeric-sort', value: { kind: 'none' } },
    ],
    summary: 'compare according to numerical value',
    category: 'common',
  },
  {
    semantic: { kind: 'deferred', tag: 'outputPath' },
    forms: [
      { kind: 'short', name: 'o', value: { kind: 'required-attached-or-following', missingValueName: 'FILE' } },
      { kind: 'long', name: 'output', value: { kind: 'required', missingValueName: 'FILE' } },
    ],
    summary: 'write output to FILE',
    valueName: 'FILE',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'order', value: 'reverse' }] },
    forms: [
      { kind: 'short', name: 'r', value: { kind: 'none' } },
      { kind: 'long', name: 'reverse', value: { kind: 'none' } },
    ],
    summary: 'reverse the result of comparisons',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'stable', value: true }] },
    forms: [
      { kind: 'short', name: 's', value: { kind: 'none' } },
      { kind: 'long', name: 'stable', value: { kind: 'none' } },
    ],
    summary: 'stabilize sort by disabling last-resort comparison',
    category: 'common',
  },
  {
    semantic: { kind: 'deferred', tag: 'fieldSeparator' },
    forms: [
      { kind: 'short', name: 't', value: { kind: 'required-attached-or-following', missingValueName: 'SEP' } },
      { kind: 'long', name: 'field-separator', value: { kind: 'required', missingValueName: 'SEP' } },
    ],
    summary: 'use SEP as the field separator',
    valueName: 'SEP',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'uniqueness', value: 'unique' }] },
    forms: [
      { kind: 'short', name: 'u', value: { kind: 'none' } },
      { kind: 'long', name: 'unique', value: { kind: 'none' } },
    ],
    summary: 'output only the first of equal lines',
    category: 'common',
  },
  {
    semantic: { kind: 'deferred', tag: 'version' },
    forms: [
      { kind: 'short', name: 'V', value: { kind: 'none' } },
      { kind: 'long', name: 'version-sort', value: { kind: 'none' } },
    ],
    summary: 'natural sort of version numbers',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'zeroTerminated', value: true }] },
    forms: [
      { kind: 'short', name: 'z', value: { kind: 'none' } },
      { kind: 'long', name: 'zero-terminated', value: { kind: 'none' } },
    ],
    summary: 'line delimiter is NUL, not newline',
    category: 'common',
  },
  {
    semantic: { kind: 'deferred', tag: 'check' },
    forms: [
      { kind: 'short', name: 'c', value: { kind: 'none' } },
      { kind: 'long', name: 'check', value: { kind: 'optional-inline' } },
    ],
    summary: 'check whether input is sorted',
    valueName: 'MODE',
    category: 'common',
  },
  {
    semantic: { kind: 'deferred', tag: 'silentCheck' },
    forms: [{ kind: 'short', name: 'C', value: { kind: 'none' } }],
    summary: 'check without reporting the first disorder (--check=quiet)',
    category: 'common',
  },
  {
    semantic: { kind: 'deferred', tag: 'help' },
    forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
    summary: 'display this help and exit',
    category: 'common',
  },
] as const;

type SortArgvTag = Extract<(typeof sortOptions)[number]['semantic'], { kind: 'deferred' }>['tag'];

const sortArgvCatalog = defineArgvCatalog<StandardArgvAction<SortArgvTag>>({
  definitions: sortOptions,
  nonExecutableLongOptions: [
    'batch-size',
    'buffer-size',
    'compress-program',
    'debug',
    'files0-from',
    'parallel',
    'random-sort',
    'random-source',
    'sort',
    'temporary-directory',
    'version',
  ],
});
const sortArgvHelp = defineArgvHelpPresentation({ catalog: sortArgvCatalog, rows: sortOptions });
const sortArgvPolicy: StandardArgvPolicy = {
  longNameMatch: 'unique-prefix',
  optionBoundary: 'continue',
  occurrenceRetention: 'none',
};

export const sortCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      catalog: sortArgvCatalog,
      policy: sortArgvPolicy,
    });
    const resolved = resolveSortOptions({
      parsed,
      characterLocaleMode: resolveCharacterLocaleMode({ env: context.env }),
    });
    switch (resolved.kind) {
    case 'help':
      await writeCommandHelp({
        context,
        command: 'sort',
        optionLines: formatArgvOptionHelp({ presentation: sortArgvHelp }),
      });
      return { exitCode: 0 };
    case 'invalid':
      await writeCommandUsageError({
        context,
        command: 'sort',
        message: `sort: ${resolved.message}`,
        usageSummary: formatArgvUsageSummary({ presentation: sortArgvHelp }),
      });
      return { exitCode: resolved.exitCode };
    case 'parsed':
      break;
    default: {
      const _ex: never = resolved;
      throw new Error(`Unhandled sort option result: ${JSON.stringify(_ex)}`);
    }
    }

    const { options } = resolved;
    const files: readonly (string | undefined)[] = parsed.positionals.length === 0
      ? [undefined]
      : parsed.positionals;

    switch (options.checkMode) {
    case 'strict':
    case 'silent':
      if (files.length > 1) {
        const checkOption = (() => {
          switch (options.checkMode) {
          case 'strict':
            return '-c';
          case 'silent':
            return '-C';
          default: {
            const _ex: never = options.checkMode;
            throw new Error(`Unhandled sort check mode: ${_ex}`);
          }
          }
        })();
        await writeCommandUsageError({
          context,
          command: 'sort',
          message: `sort: extra operand '${parsed.positionals[1] ?? ''}' not allowed with ${checkOption}`,
          usageSummary: formatArgvUsageSummary({ presentation: sortArgvHelp }),
        });
        return { exitCode: 2 };
      }
      return checkSortedInputs({
        context,
        files,
        options,
        checkMode: options.checkMode,
      });
    case 'none':
      break;
    default: {
      const _ex: never = options.checkMode;
      throw new Error(`Unhandled sort check mode: ${_ex}`);
    }
    }

    const output = await createSortOutput({
      context,
      outputPath: options.outputPath,
    });
    let outputStatus: 'commit' | 'abort' = 'abort';
    let runStore: SortRunStore | undefined;

    try {
      if (options.merge) {
        const stdinAvailable = { value: true };
        if (files.length <= SORT_MERGE_FAN_IN) {
          const iterators: AsyncIterator<SortRecord>[] = [];
          try {
            for (const file of files) {
              iterators.push(await openSortRecordIterator({
                context,
                file,
                zeroTerminated: options.zeroTerminated,
                stdinAvailable,
              }));
            }
            await emitMergedIterators({ iterators, options, output });
          } finally {
            for (const iterator of iterators) {
              await closeIterator({ iterator });
            }
          }
        } else {
          runStore = await createSortRunStore({ context });
          for (let offset = 0; offset < files.length; offset += SORT_MERGE_FAN_IN) {
            const outputPath = allocateSortRunPath({ store: runStore });
            await mergeInputFilesToRun({
              context,
              files: files.slice(offset, offset + SORT_MERGE_FAN_IN),
              stdinAvailable,
              outputPath,
              options,
            });
            registerInitialSortRun({ store: runStore, path: outputPath });
            await addSortRunAtLevel({
              context,
              store: runStore,
              path: outputPath,
              level: 0,
              options,
            });
          }
          const finalPaths = await reduceSortRunsToFanIn({
            context,
            store: runStore,
            paths: collectSortRunPaths({ store: runStore }),
            options,
          });
          await emitRunPaths({
            context,
            paths: finalPaths,
            options,
            output,
          });
        }
        outputStatus = 'commit';
        return { exitCode: 0 };
      }

      const entries: SortEntry[] = [];
      let entriesBytes = 0;
      let globalIndex = 0;
      const stdinAvailable = { value: true };

      const flushRun = async (): Promise<void> => {
        if (entries.length === 0) {
          return;
        }
        entries.sort((left, right) => compareEntries({ left, right, options }));
        runStore ??= await createSortRunStore({ context });
        const path = allocateSortRunPath({ store: runStore });
        await writeRun({
          context,
          path,
          entries,
          zeroTerminated: options.zeroTerminated,
        });
        registerInitialSortRun({ store: runStore, path });
        await addSortRunAtLevel({
          context,
          store: runStore,
          path,
          level: 0,
          options,
        });
        entries.length = 0;
        entriesBytes = 0;
      };

      for (const file of files) {
        let iterator: AsyncIterator<SortRecord> | undefined;
        try {
          iterator = await openSortRecordIterator({
            context,
            file,
            zeroTerminated: options.zeroTerminated,
            stdinAvailable,
          });
          while (true) {
            const next = await iterator.next();
            if (next.done) {
              break;
            }
            const entry: SortEntry = {
              ...next.value,
              index: globalIndex,
            };
            globalIndex += 1;
            entries.push(entry);
            entriesBytes += estimateSortEntryBytes({ record: entry, options });
            if (entriesBytes >= SORT_MEMORY_LIMIT_BYTES) {
              await flushRun();
            }
          }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          await context.text().error({ text: `sort: ${file ?? '-'}: ${message}\n` });
          return { exitCode: 2 };
        } finally {
          await closeIterator({ iterator });
        }
      }

      if (runStore === undefined) {
        entries.sort((left, right) => compareEntries({ left, right, options }));
        let previous: SortEntry | undefined;
        for (const entry of entries) {
          if (
            options.uniqueness === 'unique'
            && previous !== undefined
            && compareEntries({ left: previous, right: entry, options }) === 0
          ) {
            continue;
          }
          await writeSortRecord({
            writer: output.writer,
            record: entry,
            zeroTerminated: options.zeroTerminated,
          });
          previous = entry;
        }
      } else {
        await flushRun();
        const finalPaths = await reduceSortRunsToFanIn({
          context,
          store: runStore,
          paths: collectSortRunPaths({ store: runStore }),
          options,
        });
        await emitRunPaths({
          context,
          paths: finalPaths,
          options,
          output,
        });
      }

      outputStatus = 'commit';
      return { exitCode: 0 };
    } catch (error: unknown) {
      if (error instanceof SortTemporaryDirectoryError) {
        await context.text().error({
          text: `sort: cannot create temporary file in '${error.directory}': ${error.detail}\n`,
        });
        return { exitCode: 2 };
      }
      throw error;
    } finally {
      try {
        await finalizeSortOutput({ context, output, status: outputStatus });
      } finally {
        await cleanupSortRunStore({ context, store: runStore });
      }
    }
    return { exitCode: 0 };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  orderSortRunPaths,
};
