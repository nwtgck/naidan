import { STANDARD_HELP_EARLY_EXIT_OPTIONS, stopStandardArgvAtFirstEarlyExit } from '@/features/wesh/commands/_shared/argv';
import { parseStandardArgv } from '@/features/wesh/argv';
import type { StandardArgvParserSpec } from '@/features/wesh/argv';
import { resolveCharacterLocaleMode } from '@/features/wesh/commands/_shared/locale';
import { stripLeadingCLocaleWhitespace } from '@/features/wesh/commands/_shared/numeric-whitespace';
import type { WeshCharacterLocaleMode } from '@/features/wesh/commands/_shared/locale';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import type {
  WeshCommandContext,
  WeshCommandImplementation,
  WeshCommandResult,
  WeshEfficientFileWriter,
  WeshFileHandle,
} from '@/features/wesh/types';
import { resolvePath } from '@/features/wesh/path';
import { openHandleReadStream, openFileReadStream } from '@/features/wesh/utils/fs';

type UniqAllRepeatedMethod = 'none' | 'prepend' | 'separate';
type UniqGroupMethod = 'separate' | 'prepend' | 'append' | 'both';
type UniqDelimiter = 0x00 | 0x0a;

interface UniqOutputPolicy {
  outputUnique: boolean,
  outputFirstRepeated: boolean,
  outputLaterRepeated: boolean,
  allRepeatedMethod: UniqAllRepeatedMethod,
}

const UNIQ_ALL_REPEATED_METHODS: readonly UniqAllRepeatedMethod[] = [
  'none',
  'prepend',
  'separate',
];

const UNIQ_GROUP_METHODS: readonly UniqGroupMethod[] = [
  'separate',
  'prepend',
  'append',
  'both',
];

interface UniqRecord {
  data: Uint8Array,
}

interface UniqComparisonOptions {
  ignoreCase: boolean,
  skipFields: number,
  skipChars: number,
  checkChars: number | undefined,
  characterLocaleMode: WeshCharacterLocaleMode,
  delimiter: UniqDelimiter,
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

function parseNonNegativeInteger({
  value,
  label,
}: {
  value: string,
  label: string,
}): { ok: true, value: number } | { ok: false, message: string } {
  const numericText = stripLeadingCLocaleWhitespace({ value });
  const match = /^\+?(\d+)$/u.exec(numericText);
  if (match === null) {
    return { ok: false, message: `invalid argument to ${label}: ${value}` };
  }

  const parsed = BigInt(match[1]!);
  return {
    ok: true,
    value: parsed > BigInt(Number.MAX_SAFE_INTEGER)
      ? Number.MAX_SAFE_INTEGER
      : Number(parsed),
  };
}

function isBlankByte({
  byte,
  delimiter,
}: {
  byte: number,
  delimiter: UniqDelimiter,
}): boolean {
  return byte === 0x20
    || byte === 0x09
    || (delimiter === 0x00 && byte === 0x0a);
}

function skipFields({
  data,
  fieldCount,
  delimiter,
}: {
  data: Uint8Array,
  fieldCount: number,
  delimiter: UniqDelimiter,
}): number {
  let index = 0;

  for (let field = 0; field < fieldCount && index < data.length; field++) {
    while (index < data.length && isBlankByte({ byte: data[index] ?? 0, delimiter })) index++;
    while (index < data.length && !isBlankByte({ byte: data[index] ?? 0, delimiter })) index++;
  }

  return index;
}

function isContinuationByte({
  byte,
}: {
  byte: number | undefined,
}): boolean {
  return byte !== undefined && byte >= 0x80 && byte <= 0xbf;
}

function utf8CharacterByteLength({
  data,
  index,
}: {
  data: Uint8Array,
  index: number,
}): number {
  const first = data[index];
  if (first === undefined || first <= 0x7f) return 1;

  const second = data[index + 1];
  const third = data[index + 2];
  const fourth = data[index + 3];

  if (
    first >= 0xc2
    && first <= 0xdf
    && isContinuationByte({ byte: second })
  ) {
    return 2;
  }

  if (
    first === 0xe0
    && second !== undefined
    && second >= 0xa0
    && second <= 0xbf
    && isContinuationByte({ byte: third })
  ) {
    return 3;
  }

  if (
    ((first >= 0xe1 && first <= 0xec) || (first >= 0xee && first <= 0xef))
    && isContinuationByte({ byte: second })
    && isContinuationByte({ byte: third })
  ) {
    return 3;
  }

  if (
    first === 0xed
    && second !== undefined
    && second >= 0x80
    && second <= 0x9f
    && isContinuationByte({ byte: third })
  ) {
    return 3;
  }

  if (
    first === 0xf0
    && second !== undefined
    && second >= 0x90
    && second <= 0xbf
    && isContinuationByte({ byte: third })
    && isContinuationByte({ byte: fourth })
  ) {
    return 4;
  }

  if (
    first >= 0xf1
    && first <= 0xf3
    && isContinuationByte({ byte: second })
    && isContinuationByte({ byte: third })
    && isContinuationByte({ byte: fourth })
  ) {
    return 4;
  }

  if (
    first === 0xf4
    && second !== undefined
    && second >= 0x80
    && second <= 0x8f
    && isContinuationByte({ byte: third })
    && isContinuationByte({ byte: fourth })
  ) {
    return 4;
  }

  return 1;
}

function advanceByCharacters({
  data,
  start,
  count,
  characterLocaleMode,
}: {
  data: Uint8Array,
  start: number,
  count: number,
  characterLocaleMode: WeshCharacterLocaleMode,
}): number {
  switch (characterLocaleMode) {
  case 'ascii':
    return Math.min(data.length, start + count);
  case 'unicode':
    break;
  default: {
    const _ex: never = characterLocaleMode;
    throw new Error(`Unhandled character locale mode: ${_ex}`);
  }
  }

  let index = start;
  let remaining = count;
  while (index < data.length && remaining > 0) {
    index += utf8CharacterByteLength({ data, index });
    remaining -= 1;
  }
  return index;
}

function foldAsciiCaseBytes({
  data,
}: {
  data: Uint8Array,
}): Uint8Array {
  let folded: Uint8Array | undefined;
  for (let index = 0; index < data.length; index++) {
    const byte = data[index] ?? 0;
    if (byte < 0x41 || byte > 0x5a) continue;
    folded ??= data.slice();
    folded[index] = byte + 0x20;
  }
  return folded ?? data;
}

function normalizeForComparison({
  record,
  options,
}: {
  record: UniqRecord,
  options: UniqComparisonOptions,
}): Uint8Array {
  const { data } = record;
  let index = skipFields({
    data,
    fieldCount: options.skipFields,
    delimiter: options.delimiter,
  });

  index = advanceByCharacters({
    data,
    start: index,
    count: options.skipChars,
    characterLocaleMode: options.characterLocaleMode,
  });
  const end = options.checkChars === undefined
    ? data.length
    : advanceByCharacters({
      data,
      start: index,
      count: options.checkChars,
      characterLocaleMode: options.characterLocaleMode,
    });
  const comparable = data.subarray(index, end);
  return options.ignoreCase
    ? foldAsciiCaseBytes({ data: comparable })
    : comparable;
}

function concatByteArrays({
  parts,
  length,
}: {
  parts: readonly Uint8Array[],
  length: number,
}): Uint8Array {
  if (parts.length === 1 && parts[0]?.length === length) {
    return parts[0].slice();
  }

  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function formatRecord({
  record,
  count,
  showCount,
  delimiter,
}: {
  record: UniqRecord,
  count: number,
  showCount: boolean,
  delimiter: UniqDelimiter,
}): Uint8Array {
  const prefix = showCount
    ? new TextEncoder().encode(`${count.toString().padStart(7)} `)
    : new Uint8Array();
  return concatByteArrays({
    parts: [prefix, record.data, Uint8Array.of(delimiter)],
    length: prefix.length + record.data.length + 1,
  });
}

function parseAllRepeatedMethod({
  value,
}: {
  value: string,
}): UniqAllRepeatedMethod | undefined {
  const matches = UNIQ_ALL_REPEATED_METHODS.filter(method => method.startsWith(value));
  return matches.length === 1 ? matches[0] : undefined;
}

function parseAllRepeatedLongOption({
  token,
}: {
  token: string,
}) {
  const prefix = '--all-repeated=';
  if (!token.startsWith(prefix)) return undefined;

  const value = token.slice(prefix.length);
  const method = parseAllRepeatedMethod({ value });
  const effects = method === undefined
    ? [{ key: 'allRepeatedParseError', value }]
    : [
      { key: 'allRepeated', value: true },
      { key: 'allRepeatedMethod', value: method },
    ];
  return {
    kind: 'matched' as const,
    consumeCount: 1,
    effects,
    occurrences: [{
      kind: 'special' as const,
      option: '--all-repeated',
      effects,
    }],
  };
}

function parseGroupMethod({
  value,
}: {
  value: string,
}): UniqGroupMethod | undefined {
  const matches = UNIQ_GROUP_METHODS.filter(method => method.startsWith(value));
  return matches.length === 1 ? matches[0] : undefined;
}

function parseGroupLongOption({
  token,
}: {
  token: string,
}) {
  const prefix = '--group=';
  if (!token.startsWith(prefix)) return undefined;

  const value = token.slice(prefix.length);
  const method = parseGroupMethod({ value });
  const effects = method === undefined
    ? [{ key: 'groupParseError', value }]
    : [
      { key: 'group', value: true },
      { key: 'groupMethod', value: method },
    ];
  return {
    kind: 'matched' as const,
    consumeCount: 1,
    effects,
    occurrences: [{
      kind: 'special' as const,
      option: '--group',
      effects,
    }],
  };
}

function groupHasLeadingSeparator({
  method,
}: {
  method: UniqGroupMethod,
}): boolean {
  switch (method) {
  case 'prepend':
  case 'both':
    return true;
  case 'separate':
  case 'append':
    return false;
  default: {
    const _ex: never = method;
    return _ex;
  }
  }
}

function groupHasTrailingSeparator({
  method,
}: {
  method: UniqGroupMethod,
}): boolean {
  switch (method) {
  case 'append':
  case 'both':
    return true;
  case 'separate':
  case 'prepend':
    return false;
  default: {
    const _ex: never = method;
    return _ex;
  }
  }
}

function resolveOutputPolicy({
  duplicatesOnly,
  uniqueOnly,
  allRepeated,
  allRepeatedMethod,
}: {
  duplicatesOnly: boolean,
  uniqueOnly: boolean,
  allRepeated: boolean,
  allRepeatedMethod: UniqAllRepeatedMethod,
}): UniqOutputPolicy {
  return {
    outputUnique: !duplicatesOnly && !allRepeated,
    outputFirstRepeated: !uniqueOnly,
    outputLaterRepeated: allRepeated,
    allRepeatedMethod,
  };
}

function buildComparisonKey({
  record,
  options,
}: {
  record: UniqRecord,
  options: UniqComparisonOptions,
}): Uint8Array {
  return normalizeForComparison({ record, options });
}

function byteArraysEqual({
  left,
  right,
}: {
  left: Uint8Array,
  right: Uint8Array,
}): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

async function writeAll({
  handle,
  buffer,
}: {
  handle: WeshFileHandle,
  buffer: Uint8Array,
}): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write({
      buffer,
      offset,
      length: buffer.length - offset,
    });
    if (bytesWritten === 0) {
      throw new Error('short write');
    }
    offset += bytesWritten;
  }
}

async function openUniqInputStream({
  context,
  inputPath,
}: {
  context: WeshCommandContext,
  inputPath: string | undefined,
}): Promise<ReadableStream<Uint8Array>> {
  if (inputPath === undefined || inputPath === '-') {
    return openHandleReadStream({ handle: context.stdin });
  }

  return await openFileReadStream({
    files: context.files,
    path: resolveInputPath({ cwd: context.cwd, path: inputPath }),
  });
}

async function *readUniqRecords({
  stream,
  delimiter,
}: {
  stream: ReadableStream<Uint8Array>,
  delimiter: UniqDelimiter,
}): AsyncGenerator<UniqRecord> {
  const reader = stream.getReader();
  let pendingParts: Uint8Array[] = [];
  let pendingLength = 0;

  const finishRecord = ({
    trailingPart,
  }: {
    trailingPart: Uint8Array,
  }): UniqRecord => {
    const data = concatByteArrays({
      parts: [...pendingParts, trailingPart],
      length: pendingLength + trailingPart.length,
    });
    pendingParts = [];
    pendingLength = 0;
    return { data };
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;

      let recordStart = 0;
      for (let index = 0; index < value.length; index++) {
        if (value[index] !== delimiter) continue;
        yield finishRecord({
          trailingPart: value.subarray(recordStart, index),
        });
        recordStart = index + 1;
      }

      if (recordStart < value.length) {
        const remainder = value.subarray(recordStart).slice();
        pendingParts.push(remainder);
        pendingLength += remainder.length;
      }
    }

    if (pendingLength > 0) {
      yield finishRecord({
        trailingPart: new Uint8Array(),
      });
    }
  } finally {
    reader.releaseLock();
  }
}

type UniqOutputTarget =
  | { kind: 'stdout', handle: WeshFileHandle }
  | { kind: 'writer', writer: WeshEfficientFileWriter }
  | { kind: 'handle', handle: WeshFileHandle };

async function openUniqOutputTarget({
  context,
  outputPath,
}: {
  context: WeshCommandContext,
  outputPath: string | undefined,
}): Promise<UniqOutputTarget> {
  if (outputPath === undefined || outputPath === '-') {
    return {
      kind: 'stdout',
      handle: context.stdout,
    };
  }

  const path = resolveInputPath({ cwd: context.cwd, path: outputPath });
  if (context.files.tryCreateFileWriterEfficiently !== undefined) {
    const writerResult = await context.files.tryCreateFileWriterEfficiently({
      path,
      mode: 'truncate',
    });
    switch (writerResult.kind) {
    case 'writer':
      return {
        kind: 'writer',
        writer: writerResult.writer,
      };
    case 'fallback_required':
      break;
    default: {
      const _ex: never = writerResult;
      throw new Error(`Unhandled efficient writer result: ${JSON.stringify(_ex)}`);
    }
    }
  }

  return {
    kind: 'handle',
    handle: await context.files.open({
      path,
      flags: { access: 'write', creation: 'if-needed', truncate: 'truncate', append: 'preserve' },
    }),
  };
}

async function writeUniqOutput({
  target,
  buffer,
}: {
  target: UniqOutputTarget,
  buffer: Uint8Array,
}): Promise<void> {
  switch (target.kind) {
  case 'stdout':
  case 'handle':
    await writeAll({
      handle: target.handle,
      buffer,
    });
    return;
  case 'writer':
    await target.writer.write({
      chunk: buffer,
    });
    return;
  default: {
    const _ex: never = target;
    throw new Error(`Unhandled uniq output target: ${JSON.stringify(_ex)}`);
  }
  }
}

async function closeUniqOutputTarget({
  target,
}: {
  target: UniqOutputTarget,
}): Promise<void> {
  switch (target.kind) {
  case 'stdout':
    return;
  case 'writer':
    await target.writer.close();
    return;
  case 'handle':
    await target.handle.close();
    return;
  default: {
    const _ex: never = target;
    throw new Error(`Unhandled uniq output target: ${JSON.stringify(_ex)}`);
  }
  }
}

async function emitUniqRecord({
  target,
  record,
  count,
  showCount,
  delimiter,
}: {
  target: UniqOutputTarget,
  record: UniqRecord,
  count: number,
  showCount: boolean,
  delimiter: UniqDelimiter,
}): Promise<void> {
  const data = formatRecord({
    record,
    count,
    showCount,
    delimiter,
  });
  await writeUniqOutput({
    target,
    buffer: data,
  });
}

async function inputAndOutputReferToSameFile({
  context,
  inputPath,
  outputPath,
}: {
  context: WeshCommandContext,
  inputPath: string | undefined,
  outputPath: string | undefined,
}): Promise<boolean> {
  if (
    inputPath === undefined
    || inputPath === '-'
    || outputPath === undefined
    || outputPath === '-'
  ) {
    return false;
  }

  const resolvedInputPath = resolvePath({ cwd: context.cwd, path: inputPath });
  const resolvedOutputPath = resolvePath({ cwd: context.cwd, path: outputPath });
  if (resolvedInputPath === resolvedOutputPath) return true;

  try {
    const inputResolution = await context.files.resolve({ path: resolvedInputPath });
    const outputResolution = await context.files.resolve({ path: resolvedOutputPath });
    return inputResolution.fullPath === outputResolution.fullPath;
  } catch {
    return false;
  }
}

export const uniqCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const uniqArgvSpec: StandardArgvParserSpec = {
      options: [
        { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
        { kind: 'flag', short: 'c', long: 'count', effects: [{ key: 'count', value: true }], help: { summary: 'prefix lines by the number of occurrences', category: 'common' } },
        { kind: 'flag', short: 'd', long: 'repeated', effects: [{ key: 'duplicatesOnly', value: true }], help: { summary: 'only print duplicate lines, one for each group', category: 'common' } },
        { kind: 'flag', short: 'D', long: undefined, effects: [{ key: 'allRepeated', value: true }, { key: 'allRepeatedMethod', value: 'none' }], help: { summary: 'print all duplicate lines', category: 'common' } },
        { kind: 'flag', short: undefined, long: 'all-repeated', effects: [{ key: 'allRepeated', value: true }, { key: 'allRepeatedMethod', value: 'none' }], help: { summary: 'print all duplicate lines; METHOD may separate groups', category: 'advanced' } },
        { kind: 'flag', short: undefined, long: 'group', effects: [{ key: 'group', value: true }, { key: 'groupMethod', value: 'separate' }], help: { summary: 'show all items, separating groups with an empty line', category: 'advanced' } },
        { kind: 'flag', short: 'u', long: 'unique', effects: [{ key: 'uniqueOnly', value: true }], help: { summary: 'only print unique lines', category: 'common' } },
        { kind: 'flag', short: 'i', long: 'ignore-case', effects: [{ key: 'ignoreCase', value: true }], help: { summary: 'ignore differences in case when comparing', category: 'common' } },
        {
          kind: 'value',
          short: 'f',
          long: 'skip-fields',
          key: 'skipFields',
          valueName: 'fields',
          allowAttachedValue: true,
          parseValue: ({ value }) => {
            const parsed = parseNonNegativeInteger({ value, label: 'skip-fields' });
            return parsed.ok ? { ok: true, value: parsed.value } : parsed;
          },
          help: { summary: 'avoid comparing the first N fields', valueName: 'N', category: 'common' },
        },
        {
          kind: 'value',
          short: 's',
          long: 'skip-chars',
          key: 'skipChars',
          valueName: 'chars',
          allowAttachedValue: true,
          parseValue: ({ value }) => {
            const parsed = parseNonNegativeInteger({ value, label: 'skip-chars' });
            return parsed.ok ? { ok: true, value: parsed.value } : parsed;
          },
          help: { summary: 'avoid comparing the first N characters', valueName: 'N', category: 'common' },
        },
        {
          kind: 'value',
          short: 'w',
          long: 'check-chars',
          key: 'checkChars',
          valueName: 'chars',
          allowAttachedValue: true,
          parseValue: ({ value }) => {
            const parsed = parseNonNegativeInteger({ value, label: 'check-chars' });
            return parsed.ok ? { ok: true, value: parsed.value } : parsed;
          },
          help: { summary: 'compare no more than N characters in lines', valueName: 'N', category: 'common' },
        },
        { kind: 'flag', short: 'z', long: 'zero-terminated', effects: [{ key: 'zeroTerminated', value: true }], help: { summary: 'line delimiter is NUL, not newline', category: 'advanced' } },
      ],
      allowShortFlagBundles: true,
      stopAtDoubleDash: true,
      treatSingleDashAsPositional: true,
      specialTokenParsers: [
        ({ token }) => parseAllRepeatedLongOption({ token }),
        ({ token }) => parseGroupLongOption({ token }),
      ],
    };

    const parsed = parseStandardArgv({
      args: stopStandardArgvAtFirstEarlyExit({ args: context.args, spec: uniqArgvSpec, earlyExitOptions: STANDARD_HELP_EARLY_EXIT_OPTIONS }),
      spec: uniqArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'uniq',
        message: `uniq: ${diagnostic.message}`,
        argvSpec: uniqArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'uniq',
        argvSpec: uniqArgvSpec,
      });
      return { exitCode: 0 };
    }

    const allRepeatedParseError = parsed.optionValues.allRepeatedParseError;
    if (typeof allRepeatedParseError === 'string') {
      await writeCommandUsageError({
        context,
        command: 'uniq',
        message: allRepeatedParseError.length === 0
          ? "uniq: ambiguous argument '' for '--all-repeated'"
          : `uniq: invalid argument '${allRepeatedParseError}' for '--all-repeated'`,
        argvSpec: uniqArgvSpec,
      });
      return { exitCode: 1 };
    }

    const groupParseError = parsed.optionValues.groupParseError;
    if (typeof groupParseError === 'string') {
      await writeCommandUsageError({
        context,
        command: 'uniq',
        message: groupParseError.length === 0
          ? "uniq: ambiguous argument '' for '--group'"
          : `uniq: invalid argument '${groupParseError}' for '--group'`,
        argvSpec: uniqArgvSpec,
      });
      return { exitCode: 1 };
    }

    const allRepeated = parsed.optionValues.allRepeated === true;
    if (allRepeated && parsed.optionValues.count === true) {
      await writeCommandUsageError({
        context,
        command: 'uniq',
        message: 'uniq: printing all duplicated lines and repeat counts is meaningless',
        argvSpec: uniqArgvSpec,
      });
      return { exitCode: 1 };
    }

    const group = parsed.optionValues.group === true;
    if (
      group
      && (
        parsed.optionValues.count === true
        || parsed.optionValues.duplicatesOnly === true
        || parsed.optionValues.uniqueOnly === true
        || allRepeated
      )
    ) {
      await writeCommandUsageError({
        context,
        command: 'uniq',
        message: 'uniq: --group is mutually exclusive with -c/-d/-D/-u',
        argvSpec: uniqArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.positionals.length > 2) {
      await writeCommandUsageError({
        context,
        command: 'uniq',
        message: `uniq: extra operand '${parsed.positionals[2]}'`,
        argvSpec: uniqArgvSpec,
      });
      return { exitCode: 1 };
    }

    const inputPath = parsed.positionals[0];
    const outputPath = parsed.positionals[1];
    const zeroTerminated = parsed.optionValues.zeroTerminated === true;
    const delimiter: UniqDelimiter = zeroTerminated ? 0x00 : 0x0a;
    const rawAllRepeatedMethod = parsed.optionValues.allRepeatedMethod;
    const allRepeatedMethod: UniqAllRepeatedMethod = rawAllRepeatedMethod === 'prepend'
      || rawAllRepeatedMethod === 'separate'
      ? rawAllRepeatedMethod
      : 'none';
    const outputPolicy = resolveOutputPolicy({
      duplicatesOnly: parsed.optionValues.duplicatesOnly === true,
      uniqueOnly: parsed.optionValues.uniqueOnly === true,
      allRepeated,
      allRepeatedMethod,
    });
    const rawGroupMethod = parsed.optionValues.groupMethod;
    const groupMethod: UniqGroupMethod | undefined = group
      ? rawGroupMethod === 'prepend' || rawGroupMethod === 'append' || rawGroupMethod === 'both'
        ? rawGroupMethod
        : 'separate'
      : undefined;

    const comparisonOptions: UniqComparisonOptions = {
      ignoreCase: parsed.optionValues.ignoreCase === true,
      skipFields: typeof parsed.optionValues.skipFields === 'number' ? parsed.optionValues.skipFields : 0,
      skipChars: typeof parsed.optionValues.skipChars === 'number' ? parsed.optionValues.skipChars : 0,
      checkChars: typeof parsed.optionValues.checkChars === 'number' ? parsed.optionValues.checkChars : undefined,
      characterLocaleMode: resolveCharacterLocaleMode({ env: context.env }),
      delimiter,
    };

    let runtimeOperand = inputPath ?? '-';
    try {
      const inputAndOutputAreSameFile = await inputAndOutputReferToSameFile({
        context,
        inputPath,
        outputPath,
      });

      let inputStream: ReadableStream<Uint8Array>;
      let outputTarget: UniqOutputTarget;
      if (inputAndOutputAreSameFile) {
        runtimeOperand = outputPath ?? '-';
        outputTarget = await openUniqOutputTarget({
          context,
          outputPath,
        });
        try {
          runtimeOperand = inputPath ?? '-';
          inputStream = await openUniqInputStream({
            context,
            inputPath,
          });
        } catch (error: unknown) {
          await closeUniqOutputTarget({ target: outputTarget });
          throw error;
        }
      } else {
        runtimeOperand = inputPath ?? '-';
        inputStream = await openUniqInputStream({
          context,
          inputPath,
        });
        runtimeOperand = outputPath ?? '-';
        outputTarget = await openUniqOutputTarget({
          context,
          outputPath,
        });
      }

      try {
        if (groupMethod !== undefined) {
          let previousKey: Uint8Array | undefined;
          let sawRecord = false;
          for await (const record of readUniqRecords({ stream: inputStream, delimiter })) {
            const key = buildComparisonKey({
              record,
              options: comparisonOptions,
            });
            if (!sawRecord) {
              if (groupHasLeadingSeparator({ method: groupMethod })) {
                await writeUniqOutput({
                  target: outputTarget,
                  buffer: Uint8Array.of(delimiter),
                });
              }
              sawRecord = true;
            } else if (previousKey !== undefined && !byteArraysEqual({ left: key, right: previousKey })) {
              await writeUniqOutput({
                target: outputTarget,
                buffer: Uint8Array.of(delimiter),
              });
            }

            await emitUniqRecord({
              target: outputTarget,
              record,
              count: 1,
              showCount: false,
              delimiter,
            });
            previousKey = key;
          }
          if (sawRecord && groupHasTrailingSeparator({ method: groupMethod })) {
            await writeUniqOutput({
              target: outputTarget,
              buffer: Uint8Array.of(delimiter),
            });
          }
        } else {
          let groupRecord: UniqRecord | undefined;
          let groupCount = 0;
          let groupKey: Uint8Array | undefined;
          let emittedDuplicateGroup = false;

          const emitGroupSeparator = async () => {
            switch (outputPolicy.allRepeatedMethod) {
            case 'none':
              return;
            case 'prepend':
              break;
            case 'separate':
              if (!emittedDuplicateGroup) return;
              break;
            default: {
              const _ex: never = outputPolicy.allRepeatedMethod;
              throw new Error(`Unhandled uniq all-repeated method: ${_ex}`);
            }
            }
            await writeUniqOutput({
              target: outputTarget,
              buffer: Uint8Array.of(delimiter),
            });
          };

          const flush = async () => {
            if (groupRecord === undefined) return;

            const shouldEmit = groupCount === 1
              ? outputPolicy.outputUnique
              : !outputPolicy.outputLaterRepeated && outputPolicy.outputFirstRepeated;
            if (!shouldEmit) return;

            await emitUniqRecord({
              target: outputTarget,
              record: groupRecord,
              count: groupCount,
              showCount: parsed.optionValues.count === true,
              delimiter,
            });
          };

          for await (const record of readUniqRecords({ stream: inputStream, delimiter })) {
            const key = buildComparisonKey({
              record,
              options: comparisonOptions,
            });

            if (groupRecord === undefined) {
              groupRecord = record;
              groupCount = 1;
              groupKey = key;
              continue;
            }

            if (groupKey !== undefined && byteArraysEqual({ left: key, right: groupKey })) {
              groupCount += 1;
              if (outputPolicy.outputLaterRepeated) {
                if (groupCount === 2) {
                  await emitGroupSeparator();
                  emittedDuplicateGroup = true;
                  if (outputPolicy.outputFirstRepeated) {
                    await emitUniqRecord({
                      target: outputTarget,
                      record: groupRecord,
                      count: 1,
                      showCount: false,
                      delimiter,
                    });
                  }
                }
                await emitUniqRecord({
                  target: outputTarget,
                  record,
                  count: 1,
                  showCount: false,
                  delimiter,
                });
              }
              continue;
            }

            await flush();
            groupRecord = record;
            groupCount = 1;
            groupKey = key;
          }

          await flush();
        }
      } finally {
        await closeUniqOutputTarget({
          target: outputTarget,
        });
      }
      return { exitCode: 0 };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await context.text().error({ text: `uniq: ${runtimeOperand}: ${message}\n` });
      return { exitCode: 1 };
    }
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
