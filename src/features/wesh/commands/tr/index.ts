import { parseStandardArgv, type StandardArgvParserSpec } from '@/features/wesh/argv';
import { STANDARD_HELP_EARLY_EXIT_OPTIONS, stopStandardArgvAtFirstEarlyExit } from '@/features/wesh/commands/_shared/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/features/wesh/types';
import { openHandleReadStream, writeAllBytesToHandle } from '@/features/wesh/utils/fs';
import { iterateReadableStreamChunks } from '@/features/wesh/utils/stream';

interface TrOptions {
  deleteMode: boolean,
  squeezeRepeats: boolean,
  complement: boolean,
  truncateSet1: boolean,
}

const TR_CHARACTER_CLASS_NAMES = [
  'alnum',
  'alpha',
  'blank',
  'cntrl',
  'digit',
  'graph',
  'lower',
  'print',
  'punct',
  'space',
  'upper',
  'xdigit',
] as const;

type TrCharacterClassName = typeof TR_CHARACTER_CLASS_NAMES[number];
type TrSetRole = 'set1' | 'set2';

const trArgvSpec: StandardArgvParserSpec = {
  options: [
    {
      kind: 'flag',
      short: undefined,
      long: 'help',
      effects: [{ key: 'help', value: true }],
      help: { summary: 'display this help and exit', category: 'common' },
    },
    {
      kind: 'flag',
      short: 'd',
      long: 'delete',
      effects: [{ key: 'deleteMode', value: true }],
      help: { summary: 'delete characters in SET1, do not translate', category: 'common' },
    },
    {
      kind: 'flag',
      short: 's',
      long: 'squeeze-repeats',
      effects: [{ key: 'squeezeRepeats', value: true }],
      help: { summary: 'replace each input sequence of a repeated character with one occurrence', category: 'common' },
    },
    {
      kind: 'flag',
      short: 'c',
      long: 'complement',
      effects: [{ key: 'complement', value: true }],
      help: { summary: 'use the complement of SET1', category: 'common' },
    },
    {
      kind: 'flag',
      short: 'C',
      long: undefined,
      effects: [{ key: 'complement', value: true }],
      help: { summary: 'same as -c', category: 'advanced' },
    },
    {
      kind: 'flag',
      short: 't',
      long: 'truncate-set1',
      effects: [{ key: 'truncateSet1', value: true }],
      help: { summary: 'truncate SET1 to the length of SET2', category: 'advanced' },
    },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

const CHARACTER_CLASS_NAME_SET = new Set<string>(TR_CHARACTER_CLASS_NAMES);
const SET_OPERAND_ENCODER = new TextEncoder();
const ASCII_DECODER = new TextDecoder('utf-8', { fatal: true });
const BACKSLASH_BYTE = 0x5c;
const DASH_BYTE = 0x2d;
const OPEN_BRACKET_BYTE = 0x5b;
const CLOSE_BRACKET_BYTE = 0x5d;
const COLON_BYTE = 0x3a;
const EQUALS_BYTE = 0x3d;
const ASTERISK_BYTE = 0x2a;
const BYTE_VALUE_COUNT = 256;
const OUTPUT_BUFFER_SIZE = 16 * 1024;


function splitTrArgs({ args }: { args: string[] }): {
  optionArgs: string[],
  operands: string[],
} {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--') {
      return {
        optionArgs: args.slice(0, index + 1),
        operands: args.slice(index + 1),
      };
    }
    if (token === '-' || token === undefined || !token.startsWith('-')) {
      return {
        optionArgs: args.slice(0, index),
        operands: args.slice(index),
      };
    }
  }
  return { optionArgs: args, operands: [] };
}

function createByteRange({ start, end }: { start: number, end: number }): number[] {
  const result: number[] = [];
  for (let value = start; value <= end; value += 1) {
    result.push(value);
  }
  return result;
}

function expandCharacterClass({ name }: { name: TrCharacterClassName }): number[] {
  switch (name) {
  case 'alnum':
    return [
      ...createByteRange({ start: 48, end: 57 }),
      ...createByteRange({ start: 65, end: 90 }),
      ...createByteRange({ start: 97, end: 122 }),
    ];
  case 'alpha':
    return [
      ...createByteRange({ start: 65, end: 90 }),
      ...createByteRange({ start: 97, end: 122 }),
    ];
  case 'blank':
    return [0x09, 0x20];
  case 'cntrl':
    return [...createByteRange({ start: 0, end: 31 }), 127];
  case 'digit':
    return createByteRange({ start: 48, end: 57 });
  case 'graph':
    return createByteRange({ start: 33, end: 126 });
  case 'lower':
    return createByteRange({ start: 97, end: 122 });
  case 'print':
    return createByteRange({ start: 32, end: 126 });
  case 'punct':
    return [
      ...createByteRange({ start: 33, end: 47 }),
      ...createByteRange({ start: 58, end: 64 }),
      ...createByteRange({ start: 91, end: 96 }),
      ...createByteRange({ start: 123, end: 126 }),
    ];
  case 'space':
    return [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20];
  case 'upper':
    return createByteRange({ start: 65, end: 90 });
  case 'xdigit':
    return [
      ...createByteRange({ start: 48, end: 57 }),
      ...createByteRange({ start: 65, end: 70 }),
      ...createByteRange({ start: 97, end: 102 }),
    ];
  default: {
    const _exhaustive: never = name;
    throw new Error(`Unhandled tr character class: ${_exhaustive}`);
  }
  }
}

class TrSetSyntaxError extends Error {
  constructor({ message }: { message: string }) {
    super(message);
    this.name = 'TrSetSyntaxError';
  }
}

interface ParsedEscape {
  values: number[],
  nextIndex: number,
  warnings: string[],
}

function isOctalByte({ value }: { value: number }): boolean {
  return value >= 0x30 && value <= 0x37;
}

function parseEscapeSequence({
  source,
  index,
}: {
  source: Uint8Array,
  index: number,
}): ParsedEscape {
  const next = source[index + 1];
  if (next === undefined) {
    return {
      values: [BACKSLASH_BYTE],
      nextIndex: index,
      warnings: ['an unescaped backslash at end of string is not portable'],
    };
  }

  if (isOctalByte({ value: next })) {
    const octalDigits: number[] = [next];
    let cursor = index + 2;
    while (octalDigits.length < 3 && cursor < source.length) {
      const digit = source[cursor];
      if (digit === undefined || !isOctalByte({ value: digit })) break;
      octalDigits.push(digit);
      cursor += 1;
    }

    if (octalDigits.length === 3 && octalDigits[0]! >= 0x34) {
      const firstTwoDigits = String.fromCharCode(octalDigits[0]!, octalDigits[1]!);
      const originalDigits = String.fromCharCode(...octalDigits);
      return {
        values: [Number.parseInt(firstTwoDigits, 8)],
        nextIndex: index + 2,
        warnings: [
          `the ambiguous octal escape \\${originalDigits} is being\n\tinterpreted as the 2-byte sequence \\0${firstTwoDigits}, ${String.fromCharCode(octalDigits[2]!)}`,
        ],
      };
    }

    return {
      values: [Number.parseInt(String.fromCharCode(...octalDigits), 8)],
      nextIndex: cursor - 1,
      warnings: [],
    };
  }

  let value: number;
  switch (next) {
  case 0x61:
    value = 0x07;
    break;
  case 0x62:
    value = 0x08;
    break;
  case 0x66:
    value = 0x0c;
    break;
  case 0x6e:
    value = 0x0a;
    break;
  case 0x72:
    value = 0x0d;
    break;
  case 0x74:
    value = 0x09;
    break;
  case 0x76:
    value = 0x0b;
    break;
  case BACKSLASH_BYTE:
    value = BACKSLASH_BYTE;
    break;
  default:
    value = next;
    break;
  }

  return {
    values: [value],
    nextIndex: index + 1,
    warnings: [],
  };
}

function decodeAscii({ bytes }: { bytes: Uint8Array }): string {
  try {
    return ASCII_DECODER.decode(bytes);
  } catch {
    throw new TrSetSyntaxError({ message: 'invalid byte sequence in set expression' });
  }
}

function findTerminator({
  source,
  startIndex,
  first,
  second,
}: {
  source: Uint8Array,
  startIndex: number,
  first: number,
  second: number,
}): number | undefined {
  for (let index = startIndex; index + 1 < source.length; index += 1) {
    if (source[index] === first && source[index + 1] === second) {
      return index;
    }
  }
  return undefined;
}

function parseSingleByteExpression({ source }: { source: Uint8Array }): number | undefined {
  if (source.length === 1) return source[0];
  if (source[0] !== BACKSLASH_BYTE) return undefined;
  const parsed = parseEscapeSequence({ source, index: 0 });
  if (parsed.nextIndex !== source.length - 1 || parsed.values.length !== 1) return undefined;
  return parsed.values[0];
}

type TrSetToken =
  | { kind: 'bytes', values: number[] }
  | { kind: 'range' }
  | { kind: 'class', name: TrCharacterClassName, values: number[] }
  | { kind: 'equivalence', value: number }
  | { kind: 'repeat', value: number, count: number | undefined };

interface TokenizedTrSet {
  tokens: TrSetToken[],
  warnings: string[],
}

function parseRepeatCount({ raw }: { raw: string }): number | undefined {
  if (raw === '' || raw === '0') return undefined;
  if (!/^\d+$/u.test(raw)) {
    throw new TrSetSyntaxError({ message: `invalid repeat count '${raw}' in [c*n] construct` });
  }

  const useOctal = raw.length > 1 && raw.startsWith('0');
  if (useOctal && /[89]/u.test(raw)) {
    throw new TrSetSyntaxError({ message: `invalid repeat count '${raw}' in [c*n] construct` });
  }

  const parsed = Number.parseInt(raw, useOctal ? 8 : 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new TrSetSyntaxError({ message: `invalid repeat count '${raw}' in [c*n] construct` });
  }
  return parsed === 0 ? undefined : parsed;
}

function tokenizeTrSet({
  source,
  role,
}: {
  source: Uint8Array,
  role: TrSetRole,
}): TokenizedTrSet {
  const tokens: TrSetToken[] = [];
  const warnings: string[] = [];

  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    if (current === undefined) continue;

    if (current === BACKSLASH_BYTE) {
      const escaped = parseEscapeSequence({ source, index });
      tokens.push({ kind: 'bytes', values: escaped.values });
      for (const warning of escaped.warnings) warnings.push(warning);
      index = escaped.nextIndex;
      continue;
    }

    if (current === OPEN_BRACKET_BYTE && source[index + 1] === COLON_BYTE) {
      const terminator = findTerminator({
        source,
        startIndex: index + 2,
        first: COLON_BYTE,
        second: CLOSE_BRACKET_BYTE,
      });
      if (terminator !== undefined) {
        const name = decodeAscii({ bytes: source.subarray(index + 2, terminator) });
        if (!CHARACTER_CLASS_NAME_SET.has(name)) {
          throw new TrSetSyntaxError({ message: `invalid character class '${name}'` });
        }
        const className = name as TrCharacterClassName;
        tokens.push({
          kind: 'class',
          name: className,
          values: expandCharacterClass({ name: className }),
        });
        index = terminator + 1;
        continue;
      }
    }

    if (current === OPEN_BRACKET_BYTE && source[index + 1] === EQUALS_BYTE) {
      const terminator = findTerminator({
        source,
        startIndex: index + 2,
        first: EQUALS_BYTE,
        second: CLOSE_BRACKET_BYTE,
      });
      if (terminator !== undefined) {
        const value = parseSingleByteExpression({ source: source.subarray(index + 2, terminator) });
        if (value === undefined) {
          throw new TrSetSyntaxError({ message: 'invalid equivalence class operand' });
        }
        tokens.push({ kind: 'equivalence', value });
        index = terminator + 1;
        continue;
      }
    }

    if (current === OPEN_BRACKET_BYTE) {
      const closeIndex = source.indexOf(CLOSE_BRACKET_BYTE, index + 1);
      if (closeIndex !== -1) {
        const content = source.subarray(index + 1, closeIndex);
        const asteriskIndex = content.indexOf(ASTERISK_BYTE);
        if (asteriskIndex !== -1) {
          const value = parseSingleByteExpression({ source: content.subarray(0, asteriskIndex) });
          if (value === undefined) {
            throw new TrSetSyntaxError({ message: 'invalid repeat character in [c*n] construct' });
          }
          const rawCount = decodeAscii({ bytes: content.subarray(asteriskIndex + 1) });
          const count = parseRepeatCount({ raw: rawCount });
          if (role === 'set1' && count === undefined) {
            throw new TrSetSyntaxError({ message: 'the [c*] repeat construct may not appear in SET1' });
          }
          tokens.push({
            kind: 'repeat',
            value,
            count,
          });
          index = closeIndex;
          continue;
        }
      }
    }

    if (current === DASH_BYTE) {
      tokens.push({ kind: 'range' });
      continue;
    }

    tokens.push({ kind: 'bytes', values: [current] });
  }

  return { tokens, warnings };
}

function validateCaseClassAlignment({
  set1Tokens,
  set2Tokens,
}: {
  set1Tokens: TrSetToken[],
  set2Tokens: TrSetToken[],
}): void {
  for (let index = 0; index < set2Tokens.length; index += 1) {
    const set2Token = set2Tokens[index];
    if (set2Token === undefined) continue;
    let expected: 'lower' | 'upper';
    switch (set2Token.kind) {
    case 'bytes':
    case 'range':
    case 'equivalence':
    case 'repeat':
      continue;
    case 'class':
      switch (set2Token.name) {
      case 'upper':
        expected = 'lower';
        break;
      case 'lower':
        expected = 'upper';
        break;
      case 'alnum':
      case 'alpha':
      case 'blank':
      case 'cntrl':
      case 'digit':
      case 'graph':
      case 'print':
      case 'punct':
      case 'space':
      case 'xdigit':
        continue;
      default: {
        const _ex: never = set2Token.name;
        throw new Error(`Unhandled tr character class: ${_ex}`);
      }
      }
      break;
    default: {
      const _ex: never = set2Token;
      throw new Error(`Unhandled tr set token: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
    }
    }
    const set1Token = set1Tokens[index];
    if (
      set1Token?.kind !== 'class'
      || (set1Token.name !== expected && set1Token.name !== set2Token.name)
    ) {
      throw new TrSetSyntaxError({ message: 'misaligned [:upper:] and/or [:lower:] construct' });
    }
  }
}

function tokenSingleValue({ token }: { token: TrSetToken }): number | undefined {
  switch (token.kind) {
  case 'bytes':
  case 'class':
    return token.values.length === 1 ? token.values[0] : undefined;
  case 'equivalence':
    return token.value;
  case 'range':
  case 'repeat':
    return undefined;
  default: {
    const _exhaustive: never = token;
    return _exhaustive;
  }
  }
}

interface TrSetValuesSegment {
  kind: 'values',
  values: readonly number[],
}

interface TrSetRepeatSegment {
  kind: 'repeat',
  value: number,
  count: bigint,
}

type TrSetSegment = TrSetValuesSegment | TrSetRepeatSegment;

interface TrSetSequence {
  segments: readonly TrSetSegment[],
  length: bigint,
  membership: Uint8Array,
}

function createTrSetSequence({
  segments,
}: {
  segments: readonly TrSetSegment[],
}): TrSetSequence {
  let length = 0n;
  const membership = new Uint8Array(BYTE_VALUE_COUNT);
  for (const segment of segments) {
    switch (segment.kind) {
    case 'values':
      length += BigInt(segment.values.length);
      for (const value of segment.values) membership[value] = 1;
      break;
    case 'repeat':
      if (segment.count > 0n) {
        length += segment.count;
        membership[segment.value] = 1;
      }
      break;
    default: {
      const _ex: never = segment;
      throw new Error(`Unhandled tr set segment: ${JSON.stringify(_ex)}`);
    }
    }
  }
  return { segments, length, membership };
}

function expandedFixedLength({ tokens }: { tokens: TrSetToken[] }): bigint {
  let length = 0n;
  for (let index = 0; index < tokens.length; index += 1) {
    const current = tokens[index];
    if (current === undefined) continue;
    const start = tokenSingleValue({ token: current });
    const rangeOperator = tokens[index + 1];
    const rangeEnd = tokens[index + 2];
    const end = rangeEnd === undefined ? undefined : tokenSingleValue({ token: rangeEnd });
    if (start !== undefined && rangeOperator?.kind === 'range' && end !== undefined) {
      if (start > end) {
        throw new TrSetSyntaxError({
          message: `range-endpoints of '${String.fromCharCode(start)}-${String.fromCharCode(end)}' are in reverse collating sequence order`,
        });
      }
      length += BigInt((end - start) + 1);
      index += 2;
      continue;
    }

    switch (current.kind) {
    case 'bytes':
    case 'class':
      length += BigInt(current.values.length);
      break;
    case 'equivalence':
    case 'range':
      length += 1n;
      break;
    case 'repeat':
      length += BigInt(current.count ?? 0);
      break;
    default: {
      const _exhaustive: never = current;
      return _exhaustive;
    }
    }
  }
  return length;
}

function expandTrSetTokens({
  tokens,
  requiredLength,
}: {
  tokens: TrSetToken[],
  requiredLength: bigint | undefined,
}): TrSetSequence {
  const automaticRepeatCount = tokens.filter((token) => token.kind === 'repeat' && token.count === undefined).length;
  if (automaticRepeatCount > 1) {
    throw new TrSetSyntaxError({ message: 'only one [c*] repeat construct may appear in SET2' });
  }

  const fixedLength = expandedFixedLength({ tokens });
  const automaticLength = requiredLength !== undefined && requiredLength > fixedLength
    ? requiredLength - fixedLength
    : 0n;
  const segments: TrSetSegment[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const current = tokens[index];
    if (current === undefined) continue;
    const rangeOperator = tokens[index + 1];
    const rangeEnd = tokens[index + 2];
    const start = tokenSingleValue({ token: current });
    const end = rangeEnd === undefined ? undefined : tokenSingleValue({ token: rangeEnd });
    if (start !== undefined && rangeOperator?.kind === 'range' && end !== undefined) {
      if (start > end) {
        throw new TrSetSyntaxError({
          message: `range-endpoints of '${String.fromCharCode(start)}-${String.fromCharCode(end)}' are in reverse collating sequence order`,
        });
      }
      segments.push({ kind: 'values', values: createByteRange({ start, end }) });
      index += 2;
      continue;
    }

    switch (current.kind) {
    case 'bytes':
    case 'class':
      if (current.values.length > 0) segments.push({ kind: 'values', values: current.values });
      break;
    case 'equivalence':
      segments.push({ kind: 'values', values: [current.value] });
      break;
    case 'range':
      segments.push({ kind: 'values', values: [DASH_BYTE] });
      break;
    case 'repeat': {
      const count = current.count === undefined ? automaticLength : BigInt(current.count);
      if (count > 0n) segments.push({ kind: 'repeat', value: current.value, count });
      break;
    }
    default: {
      const _exhaustive: never = current;
      throw new Error(`Unhandled tr set token: ${JSON.stringify(_exhaustive)}`);
    }
    }
  }

  return createTrSetSequence({ segments });
}

interface ExpandedTrSet {
  sequence: TrSetSequence,
  warnings: string[],
  tokens: TrSetToken[],
}

function expandTrSet({
  source,
  role,
  requiredLength,
}: {
  source: string,
  role: TrSetRole,
  requiredLength: bigint | undefined,
}): ExpandedTrSet {
  const tokenized = tokenizeTrSet({
    source: SET_OPERAND_ENCODER.encode(source),
    role,
  });
  return {
    sequence: expandTrSetTokens({ tokens: tokenized.tokens, requiredLength }),
    warnings: tokenized.warnings,
    tokens: tokenized.tokens,
  };
}

function trSetSegmentLength({
  segment,
}: {
  segment: TrSetSegment,
}): bigint {
  switch (segment.kind) {
  case 'values':
    return BigInt(segment.values.length);
  case 'repeat':
    return segment.count;
  default: {
    const _ex: never = segment;
    throw new Error(`Unhandled tr set segment: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
  }
  }
}

function trSetValueAt({
  sequence,
  index,
}: {
  sequence: TrSetSequence,
  index: bigint,
}): number | undefined {
  if (index < 0n || index >= sequence.length) return undefined;
  let offset = 0n;
  for (const segment of sequence.segments) {
    const segmentLength = trSetSegmentLength({ segment });
    const nextOffset = offset + segmentLength;
    if (index < nextOffset) {
      switch (segment.kind) {
      case 'values':
        return segment.values[Number(index - offset)];
      case 'repeat':
        return segment.value;
      default: {
        const _ex: never = segment;
        throw new Error(`Unhandled tr set segment: ${JSON.stringify(_ex)}`);
      }
      }
    }
    offset = nextOffset;
  }
  return undefined;
}

function trSetLastValue({ sequence }: { sequence: TrSetSequence }): number | undefined {
  return sequence.length === 0n
    ? undefined
    : trSetValueAt({ sequence, index: sequence.length - 1n });
}

function complementByteSet({ source }: { source: TrSetSequence }): TrSetSequence {
  const values: number[] = [];
  for (let value = 0; value < BYTE_VALUE_COUNT; value += 1) {
    if (source.membership[value] === 0) values.push(value);
  }
  return createTrSetSequence({ segments: [{ kind: 'values', values }] });
}

function lastTrSetPositions({
  sequence,
  limit,
}: {
  sequence: TrSetSequence,
  limit: bigint,
}): (bigint | undefined)[] {
  const result: (bigint | undefined)[] = Array.from({ length: BYTE_VALUE_COUNT }, () => undefined);
  let offset = 0n;
  for (const segment of sequence.segments) {
    if (offset >= limit) break;
    const segmentLength = trSetSegmentLength({ segment });
    const usableLength = (offset + segmentLength) > limit
      ? limit - offset
      : segmentLength;
    switch (segment.kind) {
    case 'values':
      for (let index = 0; index < Number(usableLength); index += 1) {
        const value = segment.values[index];
        if (value !== undefined) result[value] = offset + BigInt(index);
      }
      break;
    case 'repeat':
      if (usableLength > 0n) result[segment.value] = offset + usableLength - 1n;
      break;
    default: {
      const _ex: never = segment;
      throw new Error(`Unhandled tr set segment: ${JSON.stringify(_ex)}`);
    }
    }
    offset += segmentLength;
  }
  return result;
}

function validateComplementedCharacterClassTranslation({
  set1,
  set2,
  options,
}: {
  set1: ExpandedTrSet,
  set2: ExpandedTrSet,
  options: TrOptions,
}): void {
  if (
    options.deleteMode
    || !options.complement
    || !set1.tokens.some((token) => token.kind === 'class')
  ) {
    return;
  }

  const effectiveSet1 = complementByteSet({ source: set1.sequence });
  if (set2.sequence.length > effectiveSet1.length) {
    throw new TrSetSyntaxError({
      message: 'when translating with complemented character classes, SET2 must map all characters in the domain to one',
    });
  }
  const effectiveLength = options.truncateSet1 && set2.sequence.length < effectiveSet1.length
    ? set2.sequence.length
    : effectiveSet1.length;
  const mappedValues = new Set<number>();
  const set2Last = trSetLastValue({ sequence: set2.sequence });
  for (let index = 0n; index < effectiveSet1.length; index += 1n) {
    const from = trSetValueAt({ sequence: effectiveSet1, index });
    if (from === undefined) continue;
    const mapped = index < effectiveLength
      ? (trSetValueAt({ sequence: set2.sequence, index }) ?? set2Last ?? from)
      : from;
    mappedValues.add(mapped);
    if (mappedValues.size > 1) {
      throw new TrSetSyntaxError({
        message: 'when translating with complemented character classes, SET2 must map all characters in the domain to one',
      });
    }
  }
}

function createBufferedByteWriter({
  context,
}: {
  context: WeshCommandContext,
}) {
  const buffer = new Uint8Array(OUTPUT_BUFFER_SIZE);
  let length = 0;

  const flush = async (): Promise<void> => {
    if (length === 0) return;
    await writeAllBytesToHandle({
      handle: context.stdout,
      data: buffer.subarray(0, length),
    });
    length = 0;
  };

  const writeByte = ({ value }: { value: number }): boolean => {
    buffer[length] = value;
    length += 1;
    return length === buffer.length;
  };

  return { writeByte, flush };
}

async function transformInput({
  context,
  set1,
  set2,
  options,
}: {
  context: WeshCommandContext,
  set1: TrSetSequence,
  set2: TrSetSequence,
  options: TrOptions,
}): Promise<void> {
  const effectiveSet1 = options.complement ? complementByteSet({ source: set1 }) : set1;
  const deleteTable = effectiveSet1.membership;
  const squeezeTable = new Uint8Array(BYTE_VALUE_COUNT);
  const translationTable = new Uint8Array(BYTE_VALUE_COUNT);
  for (let value = 0; value < BYTE_VALUE_COUNT; value += 1) translationTable[value] = value;

  if (!options.deleteMode) {
    const effectiveLength = options.truncateSet1 && set2.length < effectiveSet1.length
      ? set2.length
      : effectiveSet1.length;
    const lastPositions = lastTrSetPositions({ sequence: effectiveSet1, limit: effectiveLength });
    const set2Last = trSetLastValue({ sequence: set2 });
    for (let from = 0; from < BYTE_VALUE_COUNT; from += 1) {
      const position = lastPositions[from];
      if (position === undefined) continue;
      translationTable[from] = trSetValueAt({ sequence: set2, index: position }) ?? set2Last ?? from;
    }
  }

  if (options.squeezeRepeats) {
    const squeezeMembership = set2.length === 0n ? effectiveSet1.membership : set2.membership;
    squeezeTable.set(squeezeMembership);
  }

  const writer = createBufferedByteWriter({ context });
  let lastOutput: number | undefined;
  try {
    for await (const chunk of iterateReadableStreamChunks({
      stream: openHandleReadStream({ handle: context.stdin }),
    })) {
      for (const input of chunk) {
        if (options.deleteMode && deleteTable[input] === 1) continue;
        const output = options.deleteMode ? input : translationTable[input]!;
        if (options.squeezeRepeats && squeezeTable[output] === 1 && output === lastOutput) continue;
        if (writer.writeByte({ value: output })) {
          await writer.flush();
        }
        lastOutput = output;
      }
    }
  } finally {
    await writer.flush();
  }
}

function resolveTrOptions({
  parsed,
}: {
  parsed: ReturnType<typeof parseStandardArgv>,
}): TrOptions {
  return {
    deleteMode: parsed.optionValues.deleteMode === true,
    squeezeRepeats: parsed.optionValues.squeezeRepeats === true,
    complement: parsed.optionValues.complement === true,
    truncateSet1: parsed.optionValues.truncateSet1 === true,
  };
}

async function writeTrSetDiagnostic({
  context,
  message,
}: {
  context: WeshCommandContext,
  message: string,
}): Promise<void> {
  await context.text().error({ text: `tr: ${message}\n` });
}

async function writeTrWarning({
  context,
  message,
}: {
  context: WeshCommandContext,
  message: string,
}): Promise<void> {
  await context.text().error({ text: `tr: warning: ${message}\n` });
}

export const trCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'tr',
    description: 'Translate or delete characters',
    usage: 'tr [OPTION]... SET1 [SET2]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const splitArgs = splitTrArgs({ args: context.args });
    const parsed = parseStandardArgv({
      args: stopStandardArgvAtFirstEarlyExit({
        args: splitArgs.optionArgs,
        spec: trArgvSpec,
        earlyExitOptions: STANDARD_HELP_EARLY_EXIT_OPTIONS,
      }),
      spec: trArgvSpec,
    });
    const positionals = [...parsed.positionals, ...splitArgs.operands];

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'tr',
        message: `tr: ${diagnostic.message}`,
        argvSpec: trArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'tr',
        argvSpec: trArgvSpec,
      });
      return { exitCode: 0 };
    }

    if (positionals.length < 1) {
      await writeCommandUsageError({
        context,
        command: 'tr',
        message: 'tr: missing operand',
        argvSpec: trArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (positionals.length > 2) {
      await writeCommandUsageError({
        context,
        command: 'tr',
        message: `tr: extra operand '${positionals[2]}'`,
        argvSpec: trArgvSpec,
      });
      return { exitCode: 1 };
    }

    const options = resolveTrOptions({ parsed });
    const set1Raw = positionals[0] ?? '';
    const set2Raw = positionals[1];
    if (!options.deleteMode && !options.squeezeRepeats && set2Raw === undefined) {
      await writeCommandUsageError({
        context,
        command: 'tr',
        message: 'tr: missing operand',
        argvSpec: trArgvSpec,
      });
      return { exitCode: 1 };
    }
    if (options.deleteMode && !options.squeezeRepeats && set2Raw !== undefined) {
      await writeTrSetDiagnostic({
        context,
        message: 'extra operand: SET2 may be given only when squeezing repeats',
      });
      return { exitCode: 1 };
    }

    try {
      const set1 = expandTrSet({
        source: set1Raw,
        role: 'set1',
        requiredLength: undefined,
      });
      const set2 = expandTrSet({
        source: set2Raw ?? '',
        role: 'set2',
        requiredLength: set1.sequence.length,
      });
      if (!options.deleteMode) {
        if (set2.tokens.some((token) => token.kind === 'class' && token.name !== 'lower' && token.name !== 'upper')) {
          throw new TrSetSyntaxError({
            message: "when translating, the only character classes that may appear in SET2 are 'upper' and 'lower'",
          });
        }
        validateCaseClassAlignment({
          set1Tokens: set1.tokens,
          set2Tokens: set2.tokens,
        });
      }
      if (!options.deleteMode && set2.tokens.some((token) => token.kind === 'equivalence')) {
        throw new TrSetSyntaxError({
          message: '[=c=] expressions may not appear in SET2 when translating',
        });
      }
      if (
        options.deleteMode
        && set2.tokens.some((token) => token.kind === 'repeat' && token.count === undefined)
      ) {
        throw new TrSetSyntaxError({
          message: 'the [c*] construct may appear in SET2 only when translating',
        });
      }
      if (!options.deleteMode && !options.truncateSet1 && set2Raw !== undefined && set2.sequence.length === 0n) {
        throw new TrSetSyntaxError({ message: 'when not truncating SET1, SET2 must be non-empty' });
      }
      validateComplementedCharacterClassTranslation({ set1, set2, options });
      for (const warning of [...set1.warnings, ...set2.warnings]) {
        await writeTrWarning({ context, message: warning });
      }
      await transformInput({
        context,
        set1: set1.sequence,
        set2: set2.sequence,
        options,
      });
      return { exitCode: 0 };
    } catch (error) {
      if (!(error instanceof TrSetSyntaxError)) throw error;
      await writeTrSetDiagnostic({ context, message: error.message });
      return { exitCode: 1 };
    }
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
