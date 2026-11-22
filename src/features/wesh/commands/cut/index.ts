import {
  defineArgvCatalog,
  defineArgvHelpPresentation,
  formatArgvOptionHelp,
  formatArgvUsageSummary,
  parseStandardArgv,
  type StandardArgvAction,
  type StandardArgvPolicy,
  type StandardArgvRawValue,
} from '@/features/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage-output';
import type { WeshCommandContext, WeshCommandImplementation, WeshCommandResult, WeshFileHandle } from '@/features/wesh/types';
import { openFileReadStream } from '@/features/wesh/utils/fs';

type CutMode = 'bytes' | 'characters' | 'fields';

interface CutRange {
  start: number | undefined,
  end: number | undefined,
}

interface CutByteRecord {
  bytes: Uint8Array,
  hadDelimiter: boolean,
}

interface CutInterval {
  start: number,
  end: number | undefined,
}

interface CutSegment {
  start: number,
  end: number,
}

interface CutFieldSelection {
  bytes: Uint8Array,
  fieldDelimiterCount: number,
  selectedNonTrailingFieldCount: number,
}

function parsePositiveInteger({
  value,
  label,
}: {
  value: string,
  label: string,
}): { ok: true, value: number } | { ok: false, message: string } {
  if (!/^[1-9]\d*$/.test(value)) {
    return { ok: false, message: `invalid ${label}: '${value}'` };
  }

  return { ok: true, value: parseInt(value, 10) };
}

function parseCutRange({
  token,
}: {
  token: string,
}): { ok: true, value: CutRange } | { ok: false, message: string } {
  if (token === '') {
    return { ok: false, message: 'empty list is not allowed' };
  }

  if (!token.includes('-')) {
    const parsed = parsePositiveInteger({ value: token, label: 'list' });
    if (!parsed.ok) {
      return parsed;
    }
    return {
      ok: true,
      value: {
        start: parsed.value,
        end: parsed.value,
      },
    };
  }

  const match = token.match(/^(\d*)-(\d*)$/);
  if (match === null) {
    return { ok: false, message: `invalid list: '${token}'` };
  }

  const startRaw = match[1] ?? '';
  const endRaw = match[2] ?? '';
  const start = startRaw === undefined || startRaw === ''
    ? undefined
    : parsePositiveInteger({ value: startRaw, label: 'list' });
  const end = endRaw === undefined || endRaw === ''
    ? undefined
    : parsePositiveInteger({ value: endRaw, label: 'list' });

  if (start !== undefined && !start.ok) {
    return start;
  }
  if (end !== undefined && !end.ok) {
    return end;
  }

  const normalizedStart = start?.ok === true ? start.value : undefined;
  const normalizedEnd = end?.ok === true ? end.value : undefined;

  if (normalizedStart === undefined && normalizedEnd === undefined) {
    return { ok: false, message: `invalid list: '${token}'` };
  }

  if (
    normalizedStart !== undefined
    && normalizedEnd !== undefined
    && normalizedStart > normalizedEnd
  ) {
    return { ok: false, message: `invalid list: '${token}'` };
  }

  return {
    ok: true,
    value: {
      start: normalizedStart,
      end: normalizedEnd,
    },
  };
}

function parseCutList({
  value,
}: {
  value: string,
}): { ok: true, value: CutRange[] } | { ok: false, message: string } {
  if (value.trim().length === 0) {
    return { ok: false, message: 'empty list is not allowed' };
  }

  const ranges: CutRange[] = [];
  for (const token of value.split(',')) {
    const parsed = parseCutRange({ token });
    if (!parsed.ok) {
      return parsed;
    }
    ranges.push(parsed.value);
  }

  return { ok: true, value: ranges };
}

function normalizeCutIntervals({
  ranges,
  mergeAdjacent,
}: {
  ranges: CutRange[],
  mergeAdjacent: boolean,
}): CutInterval[] {
  const sorted = ranges
    .map((range) => ({
      start: range.start ?? 1,
      end: range.end,
    }))
    .sort((left, right) => {
      if (left.start !== right.start) {
        return left.start - right.start;
      }

      const leftEnd = left.end ?? Number.POSITIVE_INFINITY;
      const rightEnd = right.end ?? Number.POSITIVE_INFINITY;
      return leftEnd - rightEnd;
    });

  const normalized: CutInterval[] = [];
  for (const interval of sorted) {
    const last = normalized[normalized.length - 1];
    if (last === undefined) {
      normalized.push(interval);
      continue;
    }

    const lastEnd = last.end ?? Number.POSITIVE_INFINITY;
    const currentEnd = interval.end ?? Number.POSITIVE_INFINITY;
    if (interval.start <= lastEnd + (mergeAdjacent ? 1 : 0)) {
      last.end = Math.max(lastEnd, currentEnd);
      if (!Number.isFinite(last.end)) {
        last.end = undefined;
      }
      continue;
    }

    normalized.push(interval);
  }

  return normalized;
}

function resolvePath({
  cwd,
  path,
}: {
  cwd: string,
  path: string,
}): string {
  return path.startsWith('/') ? path : `${cwd}/${path}`;
}

function buildSelectedSegments({
  intervals,
  length,
  complement,
}: {
  intervals: CutInterval[],
  length: number,
  complement: boolean,
}): CutSegment[] {
  const selected: CutSegment[] = [];

  for (const interval of intervals) {
    if (interval.start > length) {
      break;
    }

    const end = interval.end ?? length;
    const clippedEnd = Math.min(length, end);
    if (interval.start <= clippedEnd) {
      selected.push({
        start: interval.start - 1,
        end: clippedEnd,
      });
    }
  }

  if (!complement) {
    return selected;
  }

  const complementSegments: CutSegment[] = [];
  let cursor = 0;
  for (const segment of selected) {
    if (cursor < segment.start) {
      complementSegments.push({
        start: cursor,
        end: segment.start,
      });
    }
    cursor = segment.end;
  }
  if (cursor < length) {
    complementSegments.push({
      start: cursor,
      end: length,
    });
  }
  return complementSegments;
}

function createCutRangeTracker({
  intervals,
  complement,
}: {
  intervals: CutInterval[],
  complement: boolean,
}) {
  let intervalIndex = 0;

  return {
    isSelected({ position }: { position: number }): boolean {
      while (intervalIndex < intervals.length) {
        const interval = intervals[intervalIndex]!;
        const end = interval.end ?? Number.POSITIVE_INFINITY;

        if (position < interval.start) {
          return complement;
        }

        if (position <= end) {
          return !complement;
        }

        intervalIndex++;
      }

      return complement;
    },
  };
}

function selectBytes({
  line,
  intervals,
  complement,
  outputDelimiter,
}: {
  line: Uint8Array,
  intervals: CutInterval[],
  complement: boolean,
  outputDelimiter: Uint8Array | undefined,
}): Uint8Array {
  const segments = buildSelectedSegments({
    intervals,
    length: line.length,
    complement,
  });
  const totalLength = segments.reduce((sum, segment) => sum + (segment.end - segment.start), 0);
  const separatorLength = outputDelimiter === undefined
    ? 0
    : Math.max(0, segments.length - 1) * outputDelimiter.length;
  const output = new Uint8Array(totalLength + separatorLength);
  let offset = 0;

  for (const segment of segments) {
    if (outputDelimiter !== undefined && offset > 0) {
      output.set(outputDelimiter, offset);
      offset += outputDelimiter.length;
    }
    const chunk = line.subarray(segment.start, segment.end);
    output.set(chunk, offset);
    offset += chunk.length;
  }

  return output;
}

function selectFields({
  line,
  delimiterByte,
  outputDelimiter,
  intervals,
  complement,
  suppressNoDelimiterLines,
}: {
  line: Uint8Array,
  delimiterByte: number,
  outputDelimiter: Uint8Array,
  intervals: CutInterval[],
  complement: boolean,
  suppressNoDelimiterLines: boolean,
}): CutFieldSelection | undefined {
  if (!line.includes(delimiterByte)) {
    return suppressNoDelimiterLines
      ? undefined
      : {
        bytes: line,
        fieldDelimiterCount: 0,
        selectedNonTrailingFieldCount: 1,
      };
  }

  const selectedFields: CutSegment[] = [];
  const tracker = createCutRangeTracker({
    intervals,
    complement,
  });
  let fieldStart = 0;
  let fieldNumber = 1;
  let fieldDelimiterCount = 0;
  let selectedNonTrailingFieldCount = 0;

  for (let index = 0; index <= line.length; index += 1) {
    if (index < line.length && line[index] !== delimiterByte) {
      continue;
    }

    const selected = tracker.isSelected({ position: fieldNumber });
    const trailingEmptyField = index === line.length && fieldStart === line.length;
    if (selected) {
      selectedFields.push({
        start: fieldStart,
        end: index,
      });
      if (!trailingEmptyField) {
        selectedNonTrailingFieldCount += 1;
      }
    }

    if (index < line.length) {
      fieldDelimiterCount += 1;
    }
    fieldStart = index + 1;
    fieldNumber += 1;
  }

  const separatorCount = Math.max(0, selectedFields.length - 1);
  const selectedByteLength = selectedFields.reduce(
    (total, field) => total + field.end - field.start,
    0,
  );
  const result = new Uint8Array(
    selectedByteLength + separatorCount * outputDelimiter.length,
  );
  let outputOffset = 0;

  for (const [index, field] of selectedFields.entries()) {
    if (index > 0) {
      result.set(outputDelimiter, outputOffset);
      outputOffset += outputDelimiter.length;
    }

    const fieldBytes = line.subarray(field.start, field.end);
    result.set(fieldBytes, outputOffset);
    outputOffset += fieldBytes.length;
  }

  return {
    bytes: result,
    fieldDelimiterCount,
    selectedNonTrailingFieldCount,
  };
}

function createStdinStream({
  handle,
}: {
  handle: WeshFileHandle,
}): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async pull(controller) {
      const buffer = new Uint8Array(4096);
      const { bytesRead } = await handle.read({ buffer });
      if (bytesRead === 0) {
        controller.close();
        return;
      }
      controller.enqueue(buffer.subarray(0, bytesRead));
    },
  });
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

async function openCutInputStream({
  context,
  file,
}: {
  context: WeshCommandContext,
  file: string,
}): Promise<ReadableStream<Uint8Array>> {
  if (file === '-') {
    return createStdinStream({
      handle: context.stdin,
    });
  }

  const path = resolvePath({
    cwd: context.cwd,
    path: file,
  });
  return await openFileReadStream({
    files: context.files,
    path,
  });
}

async function *readByteRecords({
  stream,
  delimiterByte,
}: {
  stream: ReadableStream<Uint8Array>,
  delimiterByte: number,
}): AsyncGenerator<CutByteRecord> {
  const reader = stream.getReader();
  let recordChunks: Uint8Array[] = [];
  let recordLength = 0;

  const flushRecord = ({ hadDelimiter }: { hadDelimiter: boolean }): CutByteRecord => {
    const bytes = new Uint8Array(recordLength);
    let offset = 0;
    for (const chunk of recordChunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    recordChunks = [];
    recordLength = 0;
    return {
      bytes,
      hadDelimiter,
    };
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

      let start = 0;
      for (let index = 0; index < value.length; index += 1) {
        if (value[index] !== delimiterByte) {
          continue;
        }

        if (index > start) {
          const chunk = value.subarray(start, index);
          recordChunks.push(chunk);
          recordLength += chunk.length;
        }
        yield flushRecord({ hadDelimiter: true });
        start = index + 1;
      }

      if (start < value.length) {
        const chunk = value.subarray(start);
        recordChunks.push(chunk);
        recordLength += chunk.length;
      }
    }

    if (recordLength > 0) {
      yield flushRecord({ hadDelimiter: false });
    }
  } finally {
    reader.releaseLock();
  }
}

const cutOptions = [
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
    semantic: { kind: 'deferred', tag: 'help' },
    forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
    summary: 'display this help and exit',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [] },
    forms: [{ kind: 'short', name: 'n', value: { kind: 'none' } }],
    summary: 'ignored for compatibility',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'suppress', value: true }] },
    forms: [
      { kind: 'short', name: 's', value: { kind: 'none' } },
      { kind: 'long', name: 'only-delimited', value: { kind: 'none' } },
    ],
    summary: 'suppress lines without delimiters in field mode',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'complement', value: true }] },
    forms: [{ kind: 'long', name: 'complement', value: { kind: 'none' } }],
    summary: 'complement the selected bytes, characters, or fields',
    category: 'common',
  },
  {
    semantic: { kind: 'deferred', tag: 'bytes' },
    forms: [
      { kind: 'short', name: 'b', value: { kind: 'required-attached-or-following', missingValueName: 'list' } },
      { kind: 'long', name: 'bytes', value: { kind: 'required', missingValueName: 'list' } },
    ],
    summary: 'select only these bytes',
    valueName: 'LIST',
    category: 'common',
  },
  {
    semantic: { kind: 'deferred', tag: 'characters' },
    forms: [
      { kind: 'short', name: 'c', value: { kind: 'required-attached-or-following', missingValueName: 'list' } },
      { kind: 'long', name: 'characters', value: { kind: 'required', missingValueName: 'list' } },
    ],
    summary: 'select only these characters',
    valueName: 'LIST',
    category: 'common',
  },
  {
    semantic: { kind: 'deferred', tag: 'fields' },
    forms: [
      { kind: 'short', name: 'f', value: { kind: 'required-attached-or-following', missingValueName: 'list' } },
      { kind: 'long', name: 'fields', value: { kind: 'required', missingValueName: 'list' } },
    ],
    summary: 'select only these fields',
    valueName: 'LIST',
    category: 'common',
  },
  {
    semantic: { kind: 'deferred', tag: 'delimiter' },
    forms: [
      { kind: 'short', name: 'd', value: { kind: 'required-attached-or-following', missingValueName: 'delimiter' } },
      { kind: 'long', name: 'delimiter', value: { kind: 'required', missingValueName: 'delimiter' } },
    ],
    summary: 'use DELIM instead of TAB for fields',
    valueName: 'DELIM',
    category: 'common',
  },
  {
    semantic: { kind: 'required-value', key: 'outputDelimiter', parse: undefined },
    forms: [{ kind: 'long', name: 'output-delimiter', value: { kind: 'required', missingValueName: 'string' } }],
    summary: 'use STRING as the output delimiter',
    valueName: 'STRING',
    category: 'advanced',
  },
] as const;

type CutArgvTag = Extract<(typeof cutOptions)[number]['semantic'], { kind: 'deferred' }>['tag'];

const cutArgvCatalog = defineArgvCatalog<StandardArgvAction<CutArgvTag>>({
  definitions: cutOptions,
  nonExecutableLongOptions: [],
});
const cutArgvHelp = defineArgvHelpPresentation({ catalog: cutArgvCatalog, rows: cutOptions });
const cutArgvPolicy: StandardArgvPolicy = {
  longNameMatch: 'unique-prefix',
  optionBoundary: 'continue',
  occurrenceRetention: 'none',
};

function readCutOptionValue({ value }: { value: StandardArgvRawValue }): string {
  if (!('rawValue' in value)) {
    throw new Error('Missing parsed cut option value');
  }
  return value.rawValue;
}

async function writeCutUsageError({
  context,
  message,
}: {
  context: WeshCommandContext,
  message: string,
}): Promise<WeshCommandResult> {
  await writeCommandUsageError({
    context,
    command: 'cut',
    message,
    usageSummary: formatArgvUsageSummary({ presentation: cutArgvHelp }),
  });
  return { exitCode: 1 };
}

export const cutCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      catalog: cutArgvCatalog,
      policy: cutArgvPolicy,
    });

    const diagnostic = parsed.diagnostics[0];
    let selection: { mode: CutMode, list: string } | undefined;
    let fieldDelimiterByte: number | undefined;

    // A second list or a malformed delimiter is fatal at its argument position.
    // The selected list itself is parsed only after help, as in GNU cut.
    for (const occurrence of parsed.deferred) {
      if (diagnostic !== undefined && diagnostic.argvIndex <= occurrence.argvIndex) {
        break;
      }

      const tag = occurrence.semantic.tag;
      switch (tag) {
      case 'bytes':
      case 'characters':
      case 'fields':
        if (selection !== undefined) {
          return writeCutUsageError({ context, message: 'cut: only one list may be specified' });
        }
        selection = { mode: tag, list: readCutOptionValue({ value: occurrence.value }) };
        break;
      case 'delimiter': {
        const value = readCutOptionValue({ value: occurrence.value });
        const bytes = new TextEncoder().encode(value);
        if (bytes.length > 1) {
          return writeCutUsageError({ context, message: 'cut: the delimiter must be a single character' });
        }
        fieldDelimiterByte = bytes[0] ?? 0x00;
        break;
      }
      case 'help':
        await writeCommandHelp({
          context,
          command: 'cut',
          optionLines: formatArgvOptionHelp({ presentation: cutArgvHelp }),
        });
        return { exitCode: 0 };
      default: {
        const _ex: never = tag;
        throw new Error(`Unhandled cut option: ${_ex}`);
      }
      }
    }

    if (diagnostic !== undefined) {
      return writeCutUsageError({ context, message: `cut: ${diagnostic.message}` });
    }

    if (selection === undefined) {
      return writeCutUsageError({ context, message: 'cut: must specify exactly one of -b, -c, or -f' });
    }

    const { mode, list } = selection;
    const suppress = parsed.optionValues.suppress === true;
    if (mode !== 'fields' && fieldDelimiterByte !== undefined) {
      return writeCutUsageError({
        context,
        message: 'cut: an input delimiter may be specified only when operating on fields',
      });
    }
    if (mode !== 'fields' && suppress) {
      return writeCutUsageError({
        context,
        message: 'cut: suppressing non-delimited lines makes sense only when operating on fields',
      });
    }

    const parsedList = parseCutList({ value: list });
    if (!parsedList.ok) {
      return writeCutUsageError({ context, message: `cut: ${parsedList.message}` });
    }

    const rawOutputDelimiter = typeof parsed.optionValues.outputDelimiter === 'string'
      ? parsed.optionValues.outputDelimiter
      : undefined;
    const inputFieldDelimiterByte = fieldDelimiterByte ?? 0x09;
    const outputDelimiter = rawOutputDelimiter === undefined
      ? undefined
      : rawOutputDelimiter === ''
        ? Uint8Array.of(0x00)
        : new TextEncoder().encode(rawOutputDelimiter);
    const fieldOutputDelimiter = outputDelimiter ?? Uint8Array.of(inputFieldDelimiterByte);
    const complement = parsed.optionValues.complement === true;
    // Preserve adjacent range boundaries so a byte output delimiter can separate them.
    const intervals = normalizeCutIntervals({
      ranges: parsedList.value,
      mergeAdjacent: mode === 'fields' || outputDelimiter === undefined || complement,
    });
    const zeroTerminated = parsed.optionValues.zeroTerminated === true;
    const recordDelimiterByte = zeroTerminated ? 0x00 : 0x0a;
    const text = context.text();
    let exitCode = 0;

    const inputFiles = parsed.positionals.length === 0 ? ['-'] : parsed.positionals;

    for (const file of inputFiles) {
      if (file === undefined) {
        continue;
      }

      try {
        const stream = await openCutInputStream({
          context,
          file,
        });

        switch (mode) {
        case 'bytes':
        case 'characters':
          for await (const record of readByteRecords({
            stream,
            delimiterByte: recordDelimiterByte,
          })) {
            const selected = selectBytes({
              line: record.bytes,
              intervals,
              complement,
              outputDelimiter,
            });
            if (selected.length > 0) {
              await writeAll({
                handle: context.stdout,
                buffer: selected,
              });
            }
            await writeAll({
              handle: context.stdout,
              buffer: Uint8Array.of(recordDelimiterByte),
            });
          }
          break;
        case 'fields':
          for await (const record of readByteRecords({
            stream,
            delimiterByte: recordDelimiterByte,
          })) {
            const selected = selectFields({
              line: record.bytes,
              delimiterByte: inputFieldDelimiterByte,
              outputDelimiter: fieldOutputDelimiter,
              intervals,
              complement,
              suppressNoDelimiterLines: suppress,
            });
            if (selected === undefined) {
              continue;
            }

            if (selected.bytes.length > 0) {
              await writeAll({
                handle: context.stdout,
                buffer: selected.bytes,
              });
            }
            const omitSyntheticZeroDelimiter = zeroTerminated
              && !record.hadDelimiter
              && record.bytes[record.bytes.length - 1] === inputFieldDelimiterByte
              && selected.fieldDelimiterCount === 1
              && (suppress
                ? selected.selectedNonTrailingFieldCount > 0
                : selected.selectedNonTrailingFieldCount === 0);
            if (!omitSyntheticZeroDelimiter) {
              await writeAll({
                handle: context.stdout,
                buffer: Uint8Array.of(recordDelimiterByte),
              });
            }
          }
          break;
        default: {
          const _ex: never = mode;
          throw new Error(`Unhandled cut mode: ${_ex}`);
        }
        }
      } catch (error: unknown) {
        exitCode = 1;
        const message = error instanceof Error ? error.message : String(error);
        await text.error({ text: `cut: ${file}: ${message}\n` });
      }
    }

    return { exitCode };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
