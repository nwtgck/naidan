import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult, WeshFileHandle } from '@/services/wesh/types';
import { openFileReadStream, openHandleReadStream } from '@/services/wesh/utils/fs';
import { createBufferedTextWriter } from '@/services/wesh/utils/io';
import { iterateReadableStreamChunks } from '@/services/wesh/utils/stream';
import { iterateUtf8Records } from '@/services/wesh/utils/text-records';

type SortMode = 'lexical' | 'numeric' | 'general-numeric' | 'human-numeric' | 'month' | 'version';
type SortOrder = 'forward' | 'reverse';
type SortCheckMode = 'none' | 'strict' | 'silent';

interface SortEntry {
  value: string,
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

type SortKeyParseResult = { ok: true, value: SortKeySpec } | { ok: false, message: string };
type SortResolvedOptionsResult = { ok: true, value: SortResolvedOptions } | { ok: false, message: string };

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
    result = Array.from(result).filter((char) => {
      const code = char.charCodeAt(0);
      return code > 0x1f && code !== 0x7f;
    }).join('');
  }

  if (normalization.foldCase) {
    result = result.toLowerCase();
  }

  return result;
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
  if (leftValue < rightValue) return -1;
  if (leftValue > rightValue) return 1;
  return 0;
}

function parseLeadingNumericPrefix({ value }: { value: string }): number {
  const match = value.match(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)/);
  if (match === null) return 0;
  const parsed = Number.parseFloat(match[0]);
  return Number.isNaN(parsed) ? 0 : parsed;
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
  const leftValue = parseLeadingNumericPrefix({ value: normalizeText({ value: left, normalization }) });
  const rightValue = parseLeadingNumericPrefix({ value: normalizeText({ value: right, normalization }) });
  if (leftValue < rightValue) return -1;
  if (leftValue > rightValue) return 1;
  return 0;
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
  const leftValue = Number.parseFloat(normalizeText({ value: left, normalization }));
  const rightValue = Number.parseFloat(normalizeText({ value: right, normalization }));

  const leftNaN = Number.isNaN(leftValue);
  const rightNaN = Number.isNaN(rightValue);
  if (leftNaN && rightNaN) return 0;
  if (leftNaN) return 1;
  if (rightNaN) return -1;
  if (leftValue < rightValue) return -1;
  if (leftValue > rightValue) return 1;
  return 0;
}

function parseHumanNumericValue({ value }: { value: string }): number {
  const match = value.trimStart().match(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[kmgtpezyrqKMGTPEZYRQ](?:i?[bB])?)?/);
  if (match === null) return 0;

  const numericMatch = match[0].match(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)/);
  if (numericMatch === null) return 0;

  const numberPart = Number.parseFloat(numericMatch[0]);
  const suffix = match[0].slice(numericMatch[0].length).replace(/(?:i?[bB])$/u, '');
  const unit = suffix.length > 0 ? suffix[0]!.toUpperCase() : undefined;
  const multipliers: Record<string, number> = {
    K: 1024,
    M: 1024 ** 2,
    G: 1024 ** 3,
    T: 1024 ** 4,
    P: 1024 ** 5,
    E: 1024 ** 6,
    Z: 1024 ** 7,
    Y: 1024 ** 8,
    R: 1024 ** 9,
    Q: 1024 ** 10,
  };

  if (unit === undefined) return numberPart;
  return numberPart * (multipliers[unit] ?? 1);
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
  const leftValue = parseHumanNumericValue({ value: normalizeText({ value: left, normalization }) });
  const rightValue = parseHumanNumericValue({ value: normalizeText({ value: right, normalization }) });
  if (leftValue < rightValue) return -1;
  if (leftValue > rightValue) return 1;
  return 0;
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
  const monthOrder = new Map<string, number>([
    ['jan', 1], ['feb', 2], ['mar', 3], ['apr', 4], ['may', 5], ['jun', 6],
    ['jul', 7], ['aug', 8], ['sep', 9], ['oct', 10], ['nov', 11], ['dec', 12],
  ]);

  const leftMonth = monthOrder.get(normalizeText({ value: left, normalization }).trimStart().slice(0, 3).toLowerCase());
  const rightMonth = monthOrder.get(normalizeText({ value: right, normalization }).trimStart().slice(0, 3).toLowerCase());

  if (leftMonth !== undefined && rightMonth !== undefined) {
    if (leftMonth < rightMonth) return -1;
    if (leftMonth > rightMonth) return 1;
    return 0;
  }

  if (leftMonth !== undefined) return -1;
  if (rightMonth !== undefined) return 1;
  return compareLexical({ left, right, normalization });
}

function compareVersionChunks({
  left,
  right,
}: {
  left: string,
  right: string,
}): number {
  const leftChunks = left.match(/(\d+|\D+)/g) ?? [''];
  const rightChunks = right.match(/(\d+|\D+)/g) ?? [''];
  const count = Math.max(leftChunks.length, rightChunks.length);

  for (let index = 0; index < count; index++) {
    const leftChunk = leftChunks[index] ?? '';
    const rightChunk = rightChunks[index] ?? '';
    if (leftChunk === rightChunk) continue;

    const leftNumeric = /^\d+$/.test(leftChunk);
    const rightNumeric = /^\d+$/.test(rightChunk);
    if (leftNumeric && rightNumeric) {
      const leftTrimmed = leftChunk.replace(/^0+/, '') || '0';
      const rightTrimmed = rightChunk.replace(/^0+/, '') || '0';
      if (leftTrimmed.length < rightTrimmed.length) return -1;
      if (leftTrimmed.length > rightTrimmed.length) return 1;
      if (leftTrimmed < rightTrimmed) return -1;
      if (leftTrimmed > rightTrimmed) return 1;
      continue;
    }

    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    if (leftChunk < rightChunk) return -1;
    if (leftChunk > rightChunk) return 1;
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
  if (line.length === 0) return [];

  if (separator === undefined) {
    const spans: Array<{ start: number, end: number }> = [];
    let index = 0;
    while (index < line.length) {
      while (index < line.length && (line[index] === ' ' || line[index] === '\t')) {
        index++;
      }
      const start = index;
      while (index < line.length && line[index] !== ' ' && line[index] !== '\t') {
        index++;
      }
      if (start < index) {
        spans.push({ start, end: index });
      }
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
  if (!ignoreLeadingBlanks) return span.start;

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

  const position = base + Math.max(char - 1, 0);
  switch (kind) {
  case 'start':
    return Math.min(position, span.end);
  case 'end':
    return Math.min(position + 1, line.length);
  default: {
    const _ex: never = kind;
    throw new Error(`Unhandled span position kind: ${_ex}`);
  }
  }
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
    return { ok: false, message: 'empty key definition is not allowed' };
  }

  const parts = token.split(',');
  if (parts.length > 2) {
    return { ok: false, message: `invalid key definition: '${token}'` };
  }

  const parsePart = ({
    part,
  }: {
    part: string,
  }): { ok: true, value: { field: number, char: number | undefined, modifiers: string } } | { ok: false, message: string } => {
    const match = part.match(/^([1-9]\d*)(?:\.([1-9]\d*))?([A-Za-z]*)$/);
    if (match === null) {
      return { ok: false, message: `invalid key definition: '${token}'` };
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
  if (!startPart.ok) return startPart;

  const endPart = parts[1] === undefined ? undefined : parsePart({ part: parts[1] });
  if (endPart !== undefined && !endPart.ok) return endPart;

  const modifiers = new Set<string>();
  for (const modifier of startPart.value.modifiers) modifiers.add(modifier);
  if (endPart !== undefined) {
    for (const modifier of endPart.value.modifiers) modifiers.add(modifier);
  }

  let mode: SortMode | undefined;
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
      mode = 'general-numeric';
      break;
    case 'h':
      mode = 'human-numeric';
      break;
    case 'i':
      ignoreNonprinting = true;
      break;
    case 'M':
      mode = 'month';
      break;
    case 'n':
      mode = 'numeric';
      break;
    case 'r':
    case 'R':
      reverse = true;
      break;
    case 'V':
      mode = 'version';
      break;
    default:
      return { ok: false, message: `invalid key definition: '${token}'` };
    }
  }

  if (endPart !== undefined && startPart.value.field > endPart.value.field) {
    return { ok: false, message: `invalid key definition: '${token}'` };
  }

  if (
    endPart !== undefined
    && startPart.value.field === endPart.value.field
    && startPart.value.char !== undefined
    && endPart.value.char !== undefined
    && startPart.value.char > endPart.value.char
  ) {
    return { ok: false, message: `invalid key definition: '${token}'` };
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

function collectKeySpecs({
  occurrences,
}: {
  occurrences: ReturnType<typeof parseStandardArgv>['occurrences'],
}): SortKeyParseResult[] {
  const results: SortKeyParseResult[] = [];
  for (const occurrence of occurrences) {
    switch (occurrence.kind) {
    case 'flag':
      continue;
    case 'special':
      continue;
    case 'value':
      if (occurrence.key !== 'key') continue;
      if (typeof occurrence.value !== 'string') {
        results.push({ ok: false, message: `invalid key definition: '${String(occurrence.value)}'` });
        continue;
      }
      results.push(parseKeyToken({ token: occurrence.value }));
      continue;
    default: {
      const _ex: never = occurrence;
      throw new Error(`Unhandled argv occurrence: ${_ex}`);
    }
    }
  }
  return results;
}

function resolveSortOptions({
  parsed,
}: {
  parsed: ReturnType<typeof parseStandardArgv>,
}): SortResolvedOptionsResult {
  const keySpecsResult = collectKeySpecs({ occurrences: parsed.occurrences });
  for (const result of keySpecsResult) {
    if (!result.ok) return result;
  }

  const keySpecs = keySpecsResult
    .filter((result): result is { ok: true, value: SortKeySpec } => result.ok)
    .map((result) => result.value);

  const fieldSeparatorValue = typeof parsed.optionValues.fieldSeparator === 'string'
    ? decodeFieldSeparator({ value: parsed.optionValues.fieldSeparator })
    : undefined;

  const mode = (() => {
    switch (parsed.optionValues.mode) {
    case 'numeric':
      return 'numeric';
    case 'general-numeric':
      return 'general-numeric';
    case 'human-numeric':
      return 'human-numeric';
    case 'month':
      return 'month';
    case 'version':
      return 'version';
    default:
      return 'lexical';
    }
  })();

  return {
    ok: true,
    value: {
      mode,
      order: parsed.optionValues.order === 'reverse' ? 'reverse' : 'forward',
      uniqueness: parsed.optionValues.uniqueness === 'unique' ? 'unique' : 'all',
      stable: parsed.optionValues.stable === true,
      foldCase: parsed.optionValues.foldCase === true,
      ignoreLeadingBlanks: parsed.optionValues.ignoreLeadingBlanks === true,
      dictionaryOrder: parsed.optionValues.dictionaryOrder === true,
      ignoreNonprinting: parsed.optionValues.ignoreNonprinting === true,
      checkMode:
        parsed.optionValues.checkMode === 'silent'
          ? 'silent'
          : parsed.optionValues.checkMode === 'strict'
            ? 'strict'
            : 'none',
      merge: parsed.optionValues.merge === true,
      zeroTerminated: parsed.optionValues.zeroTerminated === true,
      outputPath: typeof parsed.optionValues.outputPath === 'string' ? parsed.optionValues.outputPath : undefined,
      fieldSeparator: fieldSeparatorValue,
      keySpecs: keySpecs.map((keySpec) => ({
        ...keySpec,
        ignoreLeadingBlanks: keySpec.ignoreLeadingBlanks || parsed.optionValues.ignoreLeadingBlanks === true,
        foldCase: keySpec.foldCase || parsed.optionValues.foldCase === true,
        dictionaryOrder: keySpec.dictionaryOrder || parsed.optionValues.dictionaryOrder === true,
        ignoreNonprinting: keySpec.ignoreNonprinting || parsed.optionValues.ignoreNonprinting === true,
        fieldSeparator: fieldSeparatorValue,
      })),
    },
  };
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
  if (startSpan === undefined) return '';

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

  if (end <= start) return '';
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
  const compareWholeLines = (): number => compareLexical({
    left: left.value,
    right: right.value,
    normalization: getNormalization({
      options: {
        foldCase: options.foldCase,
        ignoreLeadingBlanks: options.ignoreLeadingBlanks,
        dictionaryOrder: options.dictionaryOrder,
        ignoreNonprinting: options.ignoreNonprinting,
      },
    }),
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
        left: resolveKeyText({ line: left.value, keySpec }),
        right: resolveKeyText({ line: right.value, keySpec }),
        mode: keySpec.mode ?? options.mode,
        normalization,
      });

      if (compared !== 0) {
        const oriented = keySpec.reverse ? -compared : compared;
        return applySortOrder({ value: oriented, order: options.order });
      }
    }
  } else {
    const primary = compareValues({
      left: left.value,
      right: right.value,
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

function createEmptyAsyncIterator(): AsyncIterator<string> {
  return {
    next: async () => ({ done: true, value: undefined }),
  };
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
}): Promise<AsyncIterator<string>> {
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
  return iterateUtf8Records({
    chunks: iterateReadableStreamChunks({ stream }),
    delimiterByte: zeroTerminated ? 0 : 0x0a,
    stripTrailingCarriageReturn: !zeroTerminated,
  })[Symbol.asyncIterator]();
}

async function closeIterator({
  iterator,
}: {
  iterator: AsyncIterator<string> | undefined,
}): Promise<void> {
  await iterator?.return?.();
}

function estimateSortEntryBytes({
  value,
}: {
  value: string,
}): number {
  return 64 + value.length * 2;
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
  const writer = createBufferedTextWriter({
    handle,
    maxBufferLength: 32 * 1024,
  });
  const delimiter = zeroTerminated ? '\0' : '\n';
  try {
    for (const entry of entries) {
      await writer.write({ text: entry.value });
      await writer.write({ text: delimiter });
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
}): Promise<AsyncIterator<string>> {
  const stream = await openFileReadStream({
    files: context.files,
    path,
  });
  return iterateUtf8Records({
    chunks: iterateReadableStreamChunks({ stream }),
    delimiterByte: zeroTerminated ? 0 : 0x0a,
    stripTrailingCarriageReturn: false,
  })[Symbol.asyncIterator]();
}

interface SortOutput {
  readonly handle: WeshFileHandle,
  readonly writer: ReturnType<typeof createBufferedTextWriter>,
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
      writer: createBufferedTextWriter({
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
        writer: createBufferedTextWriter({
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
  readonly writer: ReturnType<typeof createBufferedTextWriter>,
}

async function emitMergedIterators({
  iterators,
  options,
  output,
}: {
  iterators: readonly AsyncIterator<string>[],
  options: SortResolvedOptions,
  output: SortWriter,
}): Promise<void> {
  const current = await Promise.all(iterators.map(async (iterator) => iterator.next()));
  const delimiter = options.zeroTerminated ? '\0' : '\n';
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
        value: candidateResult.value,
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
      await output.writer.write({ text: selected.value });
      await output.writer.write({ text: delimiter });
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
    writer: createBufferedTextWriter({
      handle,
      maxBufferLength: 32 * 1024,
    }),
  };
  const iterators: AsyncIterator<string>[] = [];
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
        throw error;
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

export function orderSortRunPaths({
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
  const iterators: AsyncIterator<string>[] = [];
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
    writer: createBufferedTextWriter({
      handle,
      maxBufferLength: 32 * 1024,
    }),
  };
  const iterators: AsyncIterator<string>[] = [];
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
    let iterator: AsyncIterator<string> | undefined;
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
        const current: SortEntry = { value: next.value, index: lineNumber - 1 };
        if (previous !== undefined && compareEntries({ left: previous, right: current, options }) > 0) {
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

const sortArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: 'b', long: 'ignore-leading-blanks', effects: [{ key: 'ignoreLeadingBlanks', value: true }], help: { summary: 'ignore leading blanks when comparing', category: 'common' } },
    { kind: 'flag', short: 'd', long: 'dictionary-order', effects: [{ key: 'dictionaryOrder', value: true }], help: { summary: 'consider only blanks and alphanumeric characters', category: 'advanced' } },
    { kind: 'flag', short: 'f', long: 'ignore-case', effects: [{ key: 'foldCase', value: true }], help: { summary: 'fold lower case to upper case characters', category: 'common' } },
    { kind: 'flag', short: 'g', long: 'general-numeric-sort', effects: [{ key: 'mode', value: 'general-numeric' }], help: { summary: 'compare according to general numerical value', category: 'advanced' } },
    { kind: 'flag', short: 'h', long: 'human-numeric-sort', effects: [{ key: 'mode', value: 'human-numeric' }], help: { summary: 'compare human readable numbers (e.g. 2K)', category: 'advanced' } },
    { kind: 'flag', short: 'i', long: 'ignore-nonprinting', effects: [{ key: 'ignoreNonprinting', value: true }], help: { summary: 'consider only printable characters', category: 'advanced' } },
    { kind: 'value', short: 'k', long: 'key', key: 'key', valueName: 'KEYDEF', allowAttachedValue: true, parseValue: undefined, help: { summary: 'sort by a key definition', category: 'common' } },
    { kind: 'flag', short: 'm', long: 'merge', effects: [{ key: 'merge', value: true }], help: { summary: 'merge already-sorted inputs', category: 'advanced' } },
    { kind: 'flag', short: 'M', long: 'month-sort', effects: [{ key: 'mode', value: 'month' }], help: { summary: 'sort by month name', category: 'advanced' } },
    { kind: 'flag', short: 'n', long: 'numeric-sort', effects: [{ key: 'mode', value: 'numeric' }], help: { summary: 'compare according to numerical value', category: 'common' } },
    { kind: 'value', short: 'o', long: 'output', key: 'outputPath', valueName: 'FILE', allowAttachedValue: true, parseValue: undefined, help: { summary: 'write output to FILE', category: 'common' } },
    { kind: 'flag', short: 'r', long: 'reverse', effects: [{ key: 'order', value: 'reverse' }], help: { summary: 'reverse the result of comparisons', category: 'common' } },
    { kind: 'flag', short: 's', long: 'stable', effects: [{ key: 'stable', value: true }], help: { summary: 'stabilize sort by disabling last-resort comparison', category: 'common' } },
    { kind: 'value', short: 't', long: 'field-separator', key: 'fieldSeparator', valueName: 'SEP', allowAttachedValue: true, parseValue: undefined, help: { summary: 'use SEP as the field separator', category: 'common' } },
    { kind: 'flag', short: 'u', long: 'unique', effects: [{ key: 'uniqueness', value: 'unique' }], help: { summary: 'output only the first of equal lines', category: 'common' } },
    { kind: 'flag', short: 'V', long: 'version-sort', effects: [{ key: 'mode', value: 'version' }], help: { summary: 'natural sort of version numbers', category: 'advanced' } },
    { kind: 'flag', short: 'z', long: 'zero-terminated', effects: [{ key: 'zeroTerminated', value: true }], help: { summary: 'line delimiter is NUL, not newline', category: 'common' } },
    { kind: 'flag', short: 'c', long: undefined, effects: [{ key: 'checkMode', value: 'strict' }], help: { summary: 'check whether input is sorted (--check)', category: 'common' } },
    { kind: 'flag', short: 'C', long: undefined, effects: [{ key: 'checkMode', value: 'silent' }], help: { summary: 'like -c, but do not report the first disorder (--check=quiet)', category: 'common' } },
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'showHelp', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [
    ({ token }) => {
      switch (token) {
      case '--check':
        return { kind: 'matched', consumeCount: 1, effects: [{ key: 'checkMode', value: 'strict' }] };
      case '--check=quiet':
      case '--check=silent':
        return { kind: 'matched', consumeCount: 1, effects: [{ key: 'checkMode', value: 'silent' }] };
      case '--check=diagnose-first':
        return { kind: 'matched', consumeCount: 1, effects: [{ key: 'checkMode', value: 'strict' }] };
      default:
        return undefined;
      }
    },
  ],
};

export const sortCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'sort',
    description: 'Sort lines of text files',
    usage: 'sort [OPTION]... [FILE]...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: sortArgvSpec,
    });

    if (parsed.diagnostics.length > 0) {
      await writeCommandUsageError({
        context,
        command: 'sort',
        message: `sort: ${parsed.diagnostics[0]!.message}`,
        argvSpec: sortArgvSpec,
      });
      return { exitCode: 2 };
    }

    if (parsed.optionValues.showHelp === true) {
      await writeCommandHelp({
        context,
        command: 'sort',
        argvSpec: sortArgvSpec,
      });
      return { exitCode: 0 };
    }

    const resolved = resolveSortOptions({ parsed });
    if (!resolved.ok) {
      await writeCommandUsageError({
        context,
        command: 'sort',
        message: `sort: ${resolved.message}`,
        argvSpec: sortArgvSpec,
      });
      return { exitCode: 2 };
    }

    const options = resolved.value;
    const files: Array<string | undefined> = parsed.positionals.length === 0
      ? [undefined]
      : parsed.positionals;

    switch (options.checkMode) {
    case 'strict':
    case 'silent':
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
          const iterators: AsyncIterator<string>[] = [];
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
        let iterator: AsyncIterator<string> | undefined;
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
              value: next.value,
              index: globalIndex,
            };
            globalIndex += 1;
            entries.push(entry);
            entriesBytes += estimateSortEntryBytes({ value: entry.value });
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
        const delimiter = options.zeroTerminated ? '\0' : '\n';
        let previous: SortEntry | undefined;
        for (const entry of entries) {
          if (
            options.uniqueness === 'unique'
            && previous !== undefined
            && compareEntries({ left: previous, right: entry, options }) === 0
          ) {
            continue;
          }
          await output.writer.write({ text: entry.value });
          await output.writer.write({ text: delimiter });
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
