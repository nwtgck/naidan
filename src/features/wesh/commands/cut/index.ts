import {
  STANDARD_HELP_EARLY_EXIT_OPTIONS,
  standardSemanticIssuePrecedesDiagnostic,
  stopStandardArgvAtFirstEarlyExit,
} from '@/features/wesh/commands/_shared/argv';
import { parseStandardArgv } from '@/features/wesh/argv';
import type { StandardArgvParserSpec } from '@/features/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult, WeshFileHandle } from '@/features/wesh/types';
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
    if (!parsed.ok) return parsed;
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

  if (start !== undefined && !start.ok) return start;
  if (end !== undefined && !end.ok) return end;

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
    if (!parsed.ok) return parsed;
    ranges.push(parsed.value);
  }

  return { ok: true, value: ranges };
}

function normalizeCutIntervals({
  ranges,
}: {
  ranges: CutRange[],
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
    if (interval.start <= lastEnd + 1) {
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
}: {
  line: Uint8Array,
  intervals: CutInterval[],
  complement: boolean,
}): Uint8Array {
  const segments = buildSelectedSegments({
    intervals,
    length: line.length,
    complement,
  });
  const totalLength = segments.reduce((sum, segment) => sum + (segment.end - segment.start), 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;

  for (const segment of segments) {
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

type CutPreHelpSemanticIssue =
  | { readonly kind: 'multiple-lists' }
  | { readonly kind: 'delimiter', readonly value: string };

function findCutPreHelpSemanticIssue({
  parsed,
}: {
  parsed: ReturnType<typeof parseStandardArgv>,
}): CutPreHelpSemanticIssue | undefined {
  const listCount = parsed.occurrences.filter((occurrence) => (
    occurrence.kind === 'value'
    && (occurrence.key === 'bytes' || occurrence.key === 'characters' || occurrence.key === 'fields')
  )).length;
  if (listCount > 1) return { kind: 'multiple-lists' };

  for (const occurrence of parsed.occurrences) {
    if (occurrence.kind !== 'value' || occurrence.key !== 'delimiter' || typeof occurrence.value !== 'string') continue;
    const delimiterByteLength = new TextEncoder().encode(occurrence.value).length;
    if (delimiterByteLength !== 0 && delimiterByteLength !== 1) {
      return { kind: 'delimiter', value: occurrence.value };
    }
  }
  return undefined;
}

export const cutCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'cut',
    description: 'Remove sections from each line of files',
    usage: 'cut [OPTION]... [FILE]...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const cutArgvSpec: StandardArgvParserSpec = {
      options: [
        {
          kind: 'flag',
          short: 'z',
          long: 'zero-terminated',
          effects: [{ key: 'zeroTerminated', value: true }],
          help: { summary: 'line delimiter is NUL, not newline', category: 'common' },
        },
        {
          kind: 'flag',
          short: undefined,
          long: 'help',
          effects: [{ key: 'help', value: true }],
          help: { summary: 'display this help and exit', category: 'common' },
        },
        {
          kind: 'flag',
          short: 'n',
          long: undefined,
          effects: [{ key: 'compatibilityNoOp', value: true }],
          help: { summary: 'ignored for compatibility', category: 'advanced' },
        },
        {
          kind: 'flag',
          short: 's',
          long: 'only-delimited',
          effects: [{ key: 'suppress', value: true }],
          help: { summary: 'suppress lines without delimiters in field mode', category: 'common' },
        },
        {
          kind: 'flag',
          short: undefined,
          long: 'complement',
          effects: [{ key: 'complement', value: true }],
          help: { summary: 'complement the selected bytes, characters, or fields', category: 'common' },
        },
        {
          kind: 'value',
          short: 'b',
          long: 'bytes',
          key: 'bytes',
          valueName: 'list',
          allowAttachedValue: true,
          parseValue: undefined,
          help: { summary: 'select only these bytes', valueName: 'LIST', category: 'common' },
        },
        {
          kind: 'value',
          short: 'c',
          long: 'characters',
          key: 'characters',
          valueName: 'list',
          allowAttachedValue: true,
          parseValue: undefined,
          help: { summary: 'select only these characters', valueName: 'LIST', category: 'common' },
        },
        {
          kind: 'value',
          short: 'f',
          long: 'fields',
          key: 'fields',
          valueName: 'list',
          allowAttachedValue: true,
          parseValue: undefined,
          help: { summary: 'select only these fields', valueName: 'LIST', category: 'common' },
        },
        {
          kind: 'value',
          short: 'd',
          long: 'delimiter',
          key: 'delimiter',
          valueName: 'delimiter',
          allowAttachedValue: true,
          parseValue: undefined,
          help: { summary: 'use DELIM instead of TAB for fields', valueName: 'DELIM', category: 'common' },
        },
        {
          kind: 'value',
          short: undefined,
          long: 'output-delimiter',
          key: 'outputDelimiter',
          valueName: 'string',
          allowAttachedValue: true,
          parseValue: undefined,
          help: { summary: 'use STRING as the output delimiter', valueName: 'STRING', category: 'advanced' },
        },
      ],
      allowShortFlagBundles: true,
      stopAtDoubleDash: true,
      treatSingleDashAsPositional: true,
      specialTokenParsers: [],
    };

    const parsedArgs = stopStandardArgvAtFirstEarlyExit({
      args: context.args,
      spec: cutArgvSpec,
      earlyExitOptions: STANDARD_HELP_EARLY_EXIT_OPTIONS,
    });
    const parsed = parseStandardArgv({ args: parsedArgs, spec: cutArgvSpec });
    const preHelpSemanticIssue = findCutPreHelpSemanticIssue({ parsed });
    const semanticIssuePrecedesDiagnostic = standardSemanticIssuePrecedesDiagnostic({
      args: parsedArgs,
      spec: cutArgvSpec,
      parsed,
      findSemanticIssue: findCutPreHelpSemanticIssue,
    });

    if (parsed.diagnostics.length > 0 && !semanticIssuePrecedesDiagnostic) {
      await writeCommandUsageError({
        context,
        command: 'cut',
        message: `cut: ${parsed.diagnostics[0]!.message}`,
        argvSpec: cutArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (preHelpSemanticIssue !== undefined) {
      switch (preHelpSemanticIssue.kind) {
      case 'multiple-lists':
        await writeCommandUsageError({
          context,
          command: 'cut',
          message: 'cut: only one list may be specified',
          argvSpec: cutArgvSpec,
        });
        return { exitCode: 1 };
      case 'delimiter':
        await writeCommandUsageError({
          context,
          command: 'cut',
          message: 'cut: the delimiter must be a single character',
          argvSpec: cutArgvSpec,
        });
        return { exitCode: 1 };
      default: {
        const _ex: never = preHelpSemanticIssue;
        throw new Error(`Unhandled cut pre-help semantic issue: ${JSON.stringify(_ex)}`);
      }
      }
    }

    const listSelectionCount = parsed.occurrences.reduce((count, occurrence) => {
      switch (occurrence.kind) {
      case 'value':
        return occurrence.key === 'bytes' || occurrence.key === 'characters' || occurrence.key === 'fields'
          ? count + 1
          : count;
      case 'flag':
      case 'special':
        return count;
      default: {
        const _ex: never = occurrence;
        throw new Error(`Unhandled cut option occurrence: ${String(_ex)}`);
      }
      }
    }, 0);
    if (listSelectionCount > 1) {
      throw new Error('cut pre-help validation missed multiple list selections');
    }

    const delimiterValue = typeof parsed.optionValues.delimiter === 'string'
      ? parsed.optionValues.delimiter
      : undefined;
    const encodedFieldDelimiter = delimiterValue === undefined
      ? undefined
      : new TextEncoder().encode(delimiterValue);
    const fieldDelimiterByte = encodedFieldDelimiter === undefined
      ? undefined
      : encodedFieldDelimiter.length === 0
        ? 0x00
        : encodedFieldDelimiter.length === 1
          ? encodedFieldDelimiter[0]
          : undefined;
    if (delimiterValue !== undefined && fieldDelimiterByte === undefined) {
      throw new Error(`cut pre-help validation missed delimiter: ${delimiterValue}`);
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'cut',
        argvSpec: cutArgvSpec,
      });
      return { exitCode: 0 };
    }

    const hasBytes = parsed.optionValues.bytes !== undefined;
    const hasCharacters = parsed.optionValues.characters !== undefined;
    const hasFields = parsed.optionValues.fields !== undefined;
    const selectedModeCount = [hasBytes, hasCharacters, hasFields].filter(Boolean).length;
    if (selectedModeCount !== 1) {
      await writeCommandUsageError({
        context,
        command: 'cut',
        message: 'cut: must specify exactly one of -b, -c, or -f',
        argvSpec: cutArgvSpec,
      });
      return { exitCode: 1 };
    }

    const mode: CutMode = hasBytes
      ? 'bytes'
      : hasCharacters
        ? 'characters'
        : 'fields';

    const listValue = (() => {
      switch (mode) {
      case 'bytes':
        return parsed.optionValues.bytes;
      case 'characters':
        return parsed.optionValues.characters;
      case 'fields':
        return parsed.optionValues.fields;
      default: {
        const _ex: never = mode;
        throw new Error(`Unhandled cut mode: ${_ex}`);
      }
      }
    })();

    if (typeof listValue !== 'string') {
      await writeCommandUsageError({
        context,
        command: 'cut',
        message: `cut: missing ${mode} list`,
        argvSpec: cutArgvSpec,
      });
      return { exitCode: 1 };
    }

    const parsedList = parseCutList({ value: listValue });
    if (!parsedList.ok) {
      await writeCommandUsageError({
        context,
        command: 'cut',
        message: `cut: ${parsedList.message}`,
        argvSpec: cutArgvSpec,
      });
      return { exitCode: 1 };
    }
    const intervals = normalizeCutIntervals({
      ranges: parsedList.value,
    });

    if (mode !== 'fields' && delimiterValue !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'cut',
        message: 'cut: an input delimiter may be specified only when operating on fields',
        argvSpec: cutArgvSpec,
      });
      return { exitCode: 1 };
    }
    if (mode !== 'fields' && parsed.optionValues.suppress === true) {
      await writeCommandUsageError({
        context,
        command: 'cut',
        message: 'cut: suppressing non-delimited lines makes sense only when operating on fields',
        argvSpec: cutArgvSpec,
      });
      return { exitCode: 1 };
    }

    const rawOutputDelimiter = typeof parsed.optionValues.outputDelimiter === 'string'
      ? parsed.optionValues.outputDelimiter
      : undefined;
    const inputFieldDelimiterByte = fieldDelimiterByte ?? 0x09;
    const outputDelimiter = rawOutputDelimiter === undefined
      ? Uint8Array.of(inputFieldDelimiterByte)
      : rawOutputDelimiter === ''
        ? Uint8Array.of(0x00)
        : new TextEncoder().encode(rawOutputDelimiter);
    const complement = parsed.optionValues.complement === true;
    const suppress = parsed.optionValues.suppress === true;
    const zeroTerminated = parsed.optionValues.zeroTerminated === true;
    const recordDelimiterByte = zeroTerminated ? 0x00 : 0x0a;
    const text = context.text();
    let exitCode = 0;

    const inputFiles = parsed.positionals.length === 0 ? ['-'] : parsed.positionals;

    for (const file of inputFiles) {
      if (file === undefined) continue;

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
              outputDelimiter,
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
