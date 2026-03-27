import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/services/wesh/types';
import { readFile, streamToFilePath } from '@/services/wesh/utils/fs';

type SortMode = 'lexical' | 'numeric' | 'general-numeric' | 'human-numeric' | 'month' | 'version';
type SortOrder = 'forward' | 'reverse';
type SortCheckMode = 'none' | 'strict' | 'silent';

interface SortEntry {
  value: string;
  index: number;
}

interface SortInputGroup {
  entries: SortEntry[];
}

interface SortKeySpec {
  startField: number;
  startChar: number | undefined;
  endField: number | undefined;
  endChar: number | undefined;
  mode: SortMode | undefined;
  reverse: boolean;
  ignoreLeadingBlanks: boolean;
  foldCase: boolean;
  dictionaryOrder: boolean;
  ignoreNonprinting: boolean;
}

interface SortResolvedKeySpec extends SortKeySpec {
  fieldSeparator: string | undefined;
}

interface SortResolvedOptions {
  mode: SortMode;
  order: SortOrder;
  uniqueness: 'all' | 'unique';
  stable: boolean;
  foldCase: boolean;
  ignoreLeadingBlanks: boolean;
  dictionaryOrder: boolean;
  ignoreNonprinting: boolean;
  checkMode: SortCheckMode;
  merge: boolean;
  zeroTerminated: boolean;
  outputPath: string | undefined;
  fieldSeparator: string | undefined;
  keySpecs: SortResolvedKeySpec[];
}

function resolveInputPath({
  cwd,
  path,
}: {
  cwd: string;
  path: string;
}): string {
  if (path.startsWith('/')) {
    return path;
  }

  return cwd === '/' ? `/${path}` : `${cwd}/${path}`;
}

type SortKeyParseResult = { ok: true; value: SortKeySpec } | { ok: false; message: string };
type SortResolvedOptionsResult = { ok: true; value: SortResolvedOptions } | { ok: false; message: string };

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
    foldCase: boolean;
    ignoreLeadingBlanks: boolean;
    dictionaryOrder: boolean;
    ignoreNonprinting: boolean;
  };
}): {
  foldCase: boolean;
  ignoreLeadingBlanks: boolean;
  dictionaryOrder: boolean;
  ignoreNonprinting: boolean;
} {
  return options;
}

function normalizeText({
  value,
  normalization,
}: {
  value: string;
  normalization: {
    foldCase: boolean;
    ignoreLeadingBlanks: boolean;
    dictionaryOrder: boolean;
    ignoreNonprinting: boolean;
  };
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
  left: string;
  right: string;
  normalization: ReturnType<typeof getNormalization>;
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
  left: string;
  right: string;
  normalization: ReturnType<typeof getNormalization>;
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
  left: string;
  right: string;
  normalization: ReturnType<typeof getNormalization>;
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
  left: string;
  right: string;
  normalization: ReturnType<typeof getNormalization>;
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
  left: string;
  right: string;
  normalization: ReturnType<typeof getNormalization>;
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
  left: string;
  right: string;
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
  left: string;
  right: string;
  normalization: ReturnType<typeof getNormalization>;
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
  left: string;
  right: string;
  mode: SortMode;
  normalization: ReturnType<typeof getNormalization>;
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

function splitDelimitedText({
  text,
  delimiter,
}: {
  text: string;
  delimiter: string;
}): string[] {
  if (text.length === 0) return [];
  const parts = text.split(delimiter);
  if (text.endsWith(delimiter)) {
    parts.pop();
  }
  return parts;
}

function splitFields({
  line,
  separator,
}: {
  line: string;
  separator: string | undefined;
}): Array<{ start: number; end: number }> {
  if (line.length === 0) return [];

  if (separator === undefined) {
    const spans: Array<{ start: number; end: number }> = [];
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

  const spans: Array<{ start: number; end: number }> = [];
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
  line: string;
  span: { start: number; end: number };
  ignoreLeadingBlanks: boolean;
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
  line: string;
  span: { start: number; end: number };
  char: number | undefined;
  ignoreLeadingBlanks: boolean;
  kind: 'start' | 'end';
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
  value: number;
  order: SortOrder;
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
  stable: boolean;
  uniqueness: SortResolvedOptions['uniqueness'];
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
  token: string;
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
    part: string;
  }): { ok: true; value: { field: number; char: number | undefined; modifiers: string } } | { ok: false; message: string } => {
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
  occurrences: ReturnType<typeof parseStandardArgv>['occurrences'];
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
  parsed: ReturnType<typeof parseStandardArgv>;
}): SortResolvedOptionsResult {
  const keySpecsResult = collectKeySpecs({ occurrences: parsed.occurrences });
  for (const result of keySpecsResult) {
    if (!result.ok) return result;
  }

  const keySpecs = keySpecsResult
    .filter((result): result is { ok: true; value: SortKeySpec } => result.ok)
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
  line: string;
  keySpec: SortResolvedKeySpec;
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
  left: SortEntry;
  right: SortEntry;
  options: SortResolvedOptions;
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

function dedupeSortedEntries({
  entries,
  options,
}: {
  entries: SortEntry[];
  options: SortResolvedOptions;
}): SortEntry[] {
  if (entries.length === 0) return [];

  const deduped: SortEntry[] = [entries[0]!];
  for (let index = 1; index < entries.length; index++) {
    const previous = deduped[deduped.length - 1]!;
    const current = entries[index]!;
    if (compareEntries({ left: previous, right: current, options }) !== 0) {
      deduped.push(current);
    }
  }

  return deduped;
}

function isSorted({
  entries,
  options,
}: {
  entries: SortEntry[];
  options: SortResolvedOptions;
}): { ok: true } | { ok: false; index: number } {
  for (let index = 1; index < entries.length; index++) {
    const previous = entries[index - 1]!;
    const current = entries[index]!;
    if (compareEntries({ left: previous, right: current, options }) > 0) {
      return { ok: false, index };
    }
  }
  return { ok: true };
}

function renderEntries({
  entries,
  zeroTerminated,
}: {
  entries: SortEntry[];
  zeroTerminated: boolean;
}): string {
  if (entries.length === 0) return '';
  const delimiter = zeroTerminated ? '\0' : '\n';
  return `${entries.map((entry) => entry.value).join(delimiter)}${delimiter}`;
}

function mergeSortedGroups({
  groups,
  options,
}: {
  groups: SortInputGroup[];
  options: SortResolvedOptions;
}): SortEntry[] {
  const positions = new Array<number>(groups.length).fill(0);
  const merged: SortEntry[] = [];

  while (true) {
    let selectedGroupIndex: number | undefined;
    let selectedEntry: SortEntry | undefined;

    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
      const candidate = groups[groupIndex]?.entries[positions[groupIndex] ?? 0];
      if (candidate === undefined) continue;

      if (selectedEntry === undefined) {
        selectedEntry = candidate;
        selectedGroupIndex = groupIndex;
        continue;
      }

      const compared = compareEntries({
        left: candidate,
        right: selectedEntry,
        options,
      });
      if (compared < 0 || (compared === 0 && groupIndex < (selectedGroupIndex ?? Number.MAX_SAFE_INTEGER))) {
        selectedEntry = candidate;
        selectedGroupIndex = groupIndex;
      }
    }

    if (selectedEntry === undefined || selectedGroupIndex === undefined) {
      return merged;
    }

    merged.push(selectedEntry);
    positions[selectedGroupIndex] = (positions[selectedGroupIndex] ?? 0) + 1;
  }
}

async function readTextFromStdin({
  context,
}: {
  context: WeshCommandContext;
}): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of context.text().input) {
    chunks.push(chunk);
  }
  return chunks.join('\n');
}

async function readInputItems({
  context,
  file,
  zeroTerminated,
  stdinText,
}: {
  context: WeshCommandContext;
  file: string | undefined;
  zeroTerminated: boolean;
  stdinText: string | undefined;
}): Promise<{ ok: true; items: string[] } | { ok: false; message: string }> {
  if (file === undefined || file === '-') {
    const text = stdinText ?? await readTextFromStdin({ context });
    return {
      ok: true,
      items: splitDelimitedText({
        text,
        delimiter: zeroTerminated ? '\0' : '\n',
      }),
    };
  }

  try {
    const fullPath = resolveInputPath({ cwd: context.cwd, path: file });
    const bytes = await readFile({ files: context.files, path: fullPath });
    const text = new TextDecoder().decode(bytes);
    return {
      ok: true,
      items: splitDelimitedText({
        text: zeroTerminated ? text : text.replace(/\r\n/g, '\n'),
        delimiter: zeroTerminated ? '\0' : '\n',
      }),
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `sort: ${file}: ${message}` };
  }
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
    const text = context.text();
    const errors: string[] = [];
    const items: string[] = [];
    const inputGroups: SortInputGroup[] = [];
    let stdinText: string | undefined;

    const readStdinText = async (): Promise<string> => {
      if (stdinText !== undefined) return stdinText;
      stdinText = await readTextFromStdin({ context });
      return stdinText;
    };

    if (parsed.positionals.length === 0) {
      const stdinItems = splitDelimitedText({
        text: await readStdinText(),
        delimiter: options.zeroTerminated ? '\0' : '\n',
      });
      items.push(...stdinItems);
      inputGroups.push({
        entries: stdinItems.map((value, index) => ({ value, index })),
      });
    } else {
      for (const file of parsed.positionals) {
        const result = await readInputItems({
          context,
          file,
          zeroTerminated: options.zeroTerminated,
          stdinText: file === '-' ? await readStdinText() : undefined,
        });
        if (!result.ok) {
          errors.push(result.message);
          continue;
        }
        items.push(...result.items);
        inputGroups.push({
          entries: result.items.map((value, index) => ({ value, index })),
        });
      }
    }

    if (errors.length > 0) {
      for (const error of errors) {
        await text.error({ text: `${error}\n` });
      }
      return { exitCode: 2 };
    }

    const entries = items.map((value, index) => ({ value, index }));

    switch (options.checkMode) {
    case 'strict':
    case 'silent': {
      const result = isSorted({ entries, options });
      if (!result.ok && options.checkMode === 'strict') {
        const current = entries[result.index];
        await text.error({
          text: `sort: disorder at line ${result.index + 1}: ${current?.value ?? ''}\n`,
        });
      }
      return { exitCode: result.ok ? 0 : 1 };
    }
    case 'none':
      break;
    default: {
      const _ex: never = options.checkMode;
      throw new Error(`Unhandled sort check mode: ${_ex}`);
    }
    }

    let sortedEntries = options.merge
      ? mergeSortedGroups({
        groups: inputGroups,
        options,
      })
      : [...entries].sort((left, right) => compareEntries({
        left,
        right,
        options,
      }));

    switch (options.uniqueness) {
    case 'all':
      break;
    case 'unique':
      sortedEntries = dedupeSortedEntries({ entries: sortedEntries, options });
      break;
    default: {
      const _ex: never = options.uniqueness;
      throw new Error(`Unhandled sort uniqueness: ${_ex}`);
    }
    }

    const outputText = renderEntries({
      entries: sortedEntries,
      zeroTerminated: options.zeroTerminated,
    });

    switch (options.outputPath) {
    case undefined:
      if (outputText.length > 0) {
        await text.print({ text: outputText });
      }
      break;
    default: {
      const fullPath = resolveInputPath({ cwd: context.cwd, path: options.outputPath });
      await streamToFilePath({
        files: context.files,
        path: fullPath,
        mode: 'truncate',
        stream: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(outputText));
            controller.close();
          },
        }),
      });
      break;
    }
    }

    return { exitCode: 0 };
  },
};
