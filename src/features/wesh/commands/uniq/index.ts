import {
  defineArgvCatalog,
  defineArgvHelpPresentation,
  formatArgvOptionHelp,
  formatArgvUsageSummary,
  HELP_EARLY_EXIT_OPTIONS,
  parseStandardArgv,
  stopArgvAtFirstEarlyExit,
  type StandardArgvAction,
  type StandardArgvPolicy,
} from '@/features/wesh/argv';
import { resolveCharacterLocaleMode } from '@/features/wesh/commands/_shared/locale';
import { stripLeadingCLocaleWhitespace } from '@/features/wesh/commands/_shared/numeric-whitespace';
import type { WeshCharacterLocaleMode } from '@/features/wesh/commands/_shared/locale';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage-output';
import type {
  WeshCommandContext,
  WeshCommandImplementation,
  WeshCommandResult,
  WeshEfficientFileWriter,
  WeshFileHandle,
} from '@/features/wesh/types';
import { toAbsolutePath } from '@/features/wesh/path';
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

function parseNonNegativeInteger({
  rawValue,
  label,
}: {
  rawValue: string,
  label: string,
}): { kind: 'parsed', value: number } | { kind: 'invalid', message: string } {
  const numericText = stripLeadingCLocaleWhitespace({ value: rawValue });
  const match = /^\+?(\d+)$/u.exec(numericText);
  if (match === null) {
    return { kind: 'invalid', message: `invalid argument to ${label}: ${rawValue}` };
  }

  const parsed = BigInt(match[1]!);
  return {
    kind: 'parsed',
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
    while (index < data.length && isBlankByte({ byte: data[index] ?? 0, delimiter })) {
      index++;
    }
    while (index < data.length && !isBlankByte({ byte: data[index] ?? 0, delimiter })) {
      index++;
    }
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
  if (first === undefined || first <= 0x7f) {
    return 1;
  }

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
    if (byte < 0x41 || byte > 0x5a) {
      continue;
    }
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

function parseUniqMethod<TMethod extends string>({
  value,
  methods,
  fallback,
  option,
}: {
  value: string | undefined,
  methods: readonly TMethod[],
  fallback: TMethod,
  option: '--all-repeated' | '--group',
}): { ok: true, value: TMethod } | { ok: false, message: string } {
  if (value === undefined) {
    return { ok: true, value: fallback };
  }
  const matches = methods.filter(method => method.startsWith(value));
  const match = matches.length === 1 ? matches[0] : undefined;
  if (match !== undefined) {
    return { ok: true, value: match };
  }
  const reason = matches.length === 0 ? 'invalid' : 'ambiguous';
  return { ok: false, message: `${reason} argument '${value}' for '${option}'` };
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
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) {
      return false;
    }
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
    path: toAbsolutePath({ cwd: context.cwd, path: inputPath }),
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
      if (done) {
        break;
      }
      if (value === undefined) {
        continue;
      }

      let recordStart = 0;
      for (let index = 0; index < value.length; index++) {
        if (value[index] !== delimiter) {
          continue;
        }
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

  const path = toAbsolutePath({ cwd: context.cwd, path: outputPath });
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

  const resolvedInputPath = toAbsolutePath({ cwd: context.cwd, path: inputPath });
  const resolvedOutputPath = toAbsolutePath({ cwd: context.cwd, path: outputPath });
  if (resolvedInputPath === resolvedOutputPath) {
    return true;
  }

  try {
    const inputResolution = await context.files.resolve({ path: resolvedInputPath });
    const outputResolution = await context.files.resolve({ path: resolvedOutputPath });
    return inputResolution.fullPath === outputResolution.fullPath;
  } catch {
    return false;
  }
}

const uniqOptions = [
  {
    semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
    forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
    summary: 'display this help and exit',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'count', value: true }] },
    forms: [
      { kind: 'short', name: 'c', value: { kind: 'none' } },
      { kind: 'long', name: 'count', value: { kind: 'none' } },
    ],
    summary: 'prefix lines by the number of occurrences',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'duplicatesOnly', value: true }] },
    forms: [
      { kind: 'short', name: 'd', value: { kind: 'none' } },
      { kind: 'long', name: 'repeated', value: { kind: 'none' } },
    ],
    summary: 'only print duplicate lines, one for each group',
    category: 'common',
  },
  {
    semantic: { kind: 'deferred', tag: 'allRepeated' },
    forms: [
      { kind: 'short', name: 'D', value: { kind: 'none' } },
      { kind: 'long', name: 'all-repeated', value: { kind: 'optional-inline' } },
    ],
    summary: 'print all duplicate lines; METHOD may separate groups',
    valueName: 'METHOD',
    category: 'common',
  },
  {
    semantic: { kind: 'deferred', tag: 'group' },
    forms: [{ kind: 'long', name: 'group', value: { kind: 'optional-inline' } }],
    summary: 'show all items, separating groups with an empty line',
    valueName: 'METHOD',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'uniqueOnly', value: true }] },
    forms: [
      { kind: 'short', name: 'u', value: { kind: 'none' } },
      { kind: 'long', name: 'unique', value: { kind: 'none' } },
    ],
    summary: 'only print unique lines',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'ignoreCase', value: true }] },
    forms: [
      { kind: 'short', name: 'i', value: { kind: 'none' } },
      { kind: 'long', name: 'ignore-case', value: { kind: 'none' } },
    ],
    summary: 'ignore differences in case when comparing',
    category: 'common',
  },
  {
    semantic: {
      kind: 'required-value',
      key: 'skipFields',
      parse: ({ rawValue }: { rawValue: string }) => parseNonNegativeInteger({ rawValue, label: 'skip-fields' }),
    },
    forms: [
      { kind: 'short', name: 'f', value: { kind: 'required-attached-or-following', missingValueName: 'fields' } },
      { kind: 'long', name: 'skip-fields', value: { kind: 'required', missingValueName: 'fields' } },
    ],
    summary: 'avoid comparing the first N fields',
    valueName: 'N',
    category: 'common',
  },
  {
    semantic: {
      kind: 'required-value',
      key: 'skipChars',
      parse: ({ rawValue }: { rawValue: string }) => parseNonNegativeInteger({ rawValue, label: 'skip-chars' }),
    },
    forms: [
      { kind: 'short', name: 's', value: { kind: 'required-attached-or-following', missingValueName: 'chars' } },
      { kind: 'long', name: 'skip-chars', value: { kind: 'required', missingValueName: 'chars' } },
    ],
    summary: 'avoid comparing the first N characters',
    valueName: 'N',
    category: 'common',
  },
  {
    semantic: {
      kind: 'required-value',
      key: 'checkChars',
      parse: ({ rawValue }: { rawValue: string }) => parseNonNegativeInteger({ rawValue, label: 'check-chars' }),
    },
    forms: [
      { kind: 'short', name: 'w', value: { kind: 'required-attached-or-following', missingValueName: 'chars' } },
      { kind: 'long', name: 'check-chars', value: { kind: 'required', missingValueName: 'chars' } },
    ],
    summary: 'compare no more than N characters in lines',
    valueName: 'N',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'zeroTerminated', value: true }] },
    forms: [
      { kind: 'short', name: 'z', value: { kind: 'none' } },
      { kind: 'long', name: 'zero-terminated', value: { kind: 'none' } },
    ],
    summary: 'line delimiter is NUL, not newline',
    category: 'advanced',
  },
] as const;

type UniqArgvTag = Extract<(typeof uniqOptions)[number]['semantic'], { kind: 'deferred' }>['tag'];

const uniqArgvCatalog = defineArgvCatalog<StandardArgvAction<UniqArgvTag>>({
  definitions: uniqOptions,
  nonExecutableLongOptions: ['version'],
});
const uniqArgvHelp = defineArgvHelpPresentation({ catalog: uniqArgvCatalog, rows: uniqOptions });
const uniqArgvPolicy: StandardArgvPolicy = {
  longNameMatch: 'unique-prefix',
  optionBoundary: 'continue',
  occurrenceRetention: 'none',
};

async function writeUniqUsageError({
  context,
  message,
}: {
  context: WeshCommandContext,
  message: string,
}): Promise<WeshCommandResult> {
  await writeCommandUsageError({
    context,
    command: 'uniq',
    message: `uniq: ${message}`,
    usageSummary: formatArgvUsageSummary({ presentation: uniqArgvHelp }),
  });
  return { exitCode: 1 };
}

export const uniqCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const args = stopArgvAtFirstEarlyExit({
      args: context.args,
      catalog: uniqArgvCatalog,
      policy: uniqArgvPolicy,
      earlyExitOptions: HELP_EARLY_EXIT_OPTIONS,
    });
    const parsed = parseStandardArgv({ args, catalog: uniqArgvCatalog, policy: uniqArgvPolicy });
    const diagnostic = parsed.diagnostics[0];
    let allRepeatedMethod: UniqAllRepeatedMethod | undefined;
    let groupMethod: UniqGroupMethod | undefined;

    // Method values are validated before later options. Output selection
    // conflicts are checked after help.
    for (const occurrence of parsed.deferred) {
      if (diagnostic !== undefined && diagnostic.argvIndex <= occurrence.argvIndex) {
        break;
      }
      const value = 'rawValue' in occurrence.value ? occurrence.value.rawValue : undefined;
      const tag = occurrence.semantic.tag;
      switch (tag) {
      case 'allRepeated': {
        const method = parseUniqMethod({
          value,
          methods: UNIQ_ALL_REPEATED_METHODS,
          fallback: 'none',
          option: '--all-repeated',
        });
        if (!method.ok) {
          return writeUniqUsageError({ context, message: method.message });
        }
        allRepeatedMethod = method.value;
        break;
      }
      case 'group': {
        const method = parseUniqMethod({
          value,
          methods: UNIQ_GROUP_METHODS,
          fallback: 'separate',
          option: '--group',
        });
        if (!method.ok) {
          return writeUniqUsageError({ context, message: method.message });
        }
        groupMethod = method.value;
        break;
      }
      default: {
        const _ex: never = tag;
        throw new Error(`Unhandled uniq option: ${_ex}`);
      }
      }
    }

    if (diagnostic !== undefined) {
      return writeUniqUsageError({ context, message: diagnostic.message });
    }
    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'uniq',
        optionLines: formatArgvOptionHelp({ presentation: uniqArgvHelp }),
      });
      return { exitCode: 0 };
    }

    const allRepeated = allRepeatedMethod !== undefined;
    if (allRepeated && parsed.optionValues.count === true) {
      return writeUniqUsageError({
        context,
        message: 'printing all duplicated lines and repeat counts is meaningless',
      });
    }

    if (
      groupMethod !== undefined
      && (
        parsed.optionValues.count === true
        || parsed.optionValues.duplicatesOnly === true
        || parsed.optionValues.uniqueOnly === true
        || allRepeated
      )
    ) {
      return writeUniqUsageError({ context, message: '--group is mutually exclusive with -c/-d/-D/-u' });
    }

    if (parsed.positionals.length > 2) {
      return writeUniqUsageError({ context, message: `extra operand '${parsed.positionals[2]}'` });
    }

    const inputPath = parsed.positionals[0];
    const outputPath = parsed.positionals[1];
    const zeroTerminated = parsed.optionValues.zeroTerminated === true;
    const delimiter: UniqDelimiter = zeroTerminated ? 0x00 : 0x0a;
    const outputPolicy = resolveOutputPolicy({
      duplicatesOnly: parsed.optionValues.duplicatesOnly === true,
      uniqueOnly: parsed.optionValues.uniqueOnly === true,
      allRepeated,
      allRepeatedMethod: allRepeatedMethod ?? 'none',
    });

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
              if (!emittedDuplicateGroup) {
                return;
              }
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
            if (groupRecord === undefined) {
              return;
            }

            const shouldEmit = groupCount === 1
              ? outputPolicy.outputUnique
              : !outputPolicy.outputLaterRepeated && outputPolicy.outputFirstRepeated;
            if (!shouldEmit) {
              return;
            }

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
