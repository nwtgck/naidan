import { parseStandardArgv } from '@/services/wesh/argv';
import type { StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult, WeshFileHandle } from '@/services/wesh/types';
import { openFileAsStream } from '@/services/wesh/utils/fs';

type CutMode = 'bytes' | 'characters' | 'fields';

interface CutRange {
  start: number | undefined;
  end: number | undefined;
}

interface CutTextLine {
  text: string;
  hadNewline: boolean;
}

interface CutByteLine {
  bytes: Uint8Array;
  hadNewline: boolean;
}

interface CutInterval {
  start: number;
  end: number | undefined;
}

interface CutSegment {
  start: number;
  end: number;
}

function parsePositiveInteger({
  value,
  label,
}: {
  value: string;
  label: string;
}): { ok: true; value: number } | { ok: false; message: string } {
  if (!/^[1-9]\d*$/.test(value)) {
    return { ok: false, message: `invalid ${label}: '${value}'` };
  }

  return { ok: true, value: parseInt(value, 10) };
}

function parseCutRange({
  token,
}: {
  token: string;
}): { ok: true; value: CutRange } | { ok: false; message: string } {
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
  value: string;
}): { ok: true; value: CutRange[] } | { ok: false; message: string } {
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
  ranges: CutRange[];
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
  cwd: string;
  path: string;
}): string {
  return path.startsWith('/') ? path : `${cwd}/${path}`;
}

function buildSelectedSegments({
  intervals,
  length,
  complement,
}: {
  intervals: CutInterval[];
  length: number;
  complement: boolean;
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
  intervals: CutInterval[];
  complement: boolean;
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
    }
  };
}

function selectBytes({
  line,
  intervals,
  complement,
}: {
  line: Uint8Array;
  intervals: CutInterval[];
  complement: boolean;
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

function selectCharacters({
  line,
  intervals,
  complement,
}: {
  line: string;
  intervals: CutInterval[];
  complement: boolean;
}): string {
  const characters = Array.from(line);
  const segments = buildSelectedSegments({
    intervals,
    length: characters.length,
    complement,
  });
  const selected: string[] = [];

  for (const segment of segments) {
    selected.push(characters.slice(segment.start, segment.end).join(''));
  }

  return selected.join('');
}

function selectFields({
  line,
  delimiter,
  outputDelimiter,
  intervals,
  complement,
  suppressNoDelimiterLines,
}: {
  line: string;
  delimiter: string;
  outputDelimiter: string;
  intervals: CutInterval[];
  complement: boolean;
  suppressNoDelimiterLines: boolean;
}): string | undefined {
  if (!line.includes(delimiter)) {
    return suppressNoDelimiterLines ? undefined : line;
  }

  const result: string[] = [];
  const tracker = createCutRangeTracker({
    intervals,
    complement,
  });
  let fieldStart = 0;
  let fieldNumber = 1;

  for (let index = 0; index <= line.length; index++) {
    if (index < line.length && line[index] !== delimiter) {
      continue;
    }

    if (tracker.isSelected({ position: fieldNumber })) {
      result.push(line.slice(fieldStart, index));
    }

    fieldStart = index + 1;
    fieldNumber++;
  }

  return result.join(outputDelimiter);
}

function selectLine({
  line,
  mode,
  intervals,
  fieldDelimiter,
  outputDelimiter,
  complement,
  suppressNoDelimiterLines,
}: {
  line: string;
  mode: CutMode;
  intervals: CutInterval[];
  fieldDelimiter: string | undefined;
  outputDelimiter: string | undefined;
  complement: boolean;
  suppressNoDelimiterLines: boolean;
}): string | undefined {
  switch (mode) {
  case 'bytes':
    throw new Error('Byte mode must use the byte-oriented selection path');
  case 'characters':
    return selectCharacters({ line, intervals, complement });
  case 'fields':
    return selectFields({
      line,
      delimiter: fieldDelimiter ?? '\t',
      outputDelimiter: outputDelimiter ?? fieldDelimiter ?? '\t',
      intervals,
      complement,
      suppressNoDelimiterLines,
    });
  default: {
    const _ex: never = mode;
    throw new Error(`Unhandled cut mode: ${_ex}`);
  }
  }
}

function createStdinStream({
  handle,
}: {
  handle: WeshFileHandle;
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
  handle: WeshFileHandle;
  buffer: Uint8Array;
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
  context: WeshCommandContext;
  file: string;
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
  return await openFileAsStream({
    files: context.files,
    path,
  });
}

async function *readTextLines({
  stream,
}: {
  stream: ReadableStream<Uint8Array>;
}): AsyncGenerator<CutTextLine> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        break;
      }
      if (value === undefined) {
        continue;
      }

      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const newlineIndex = buffer.indexOf('\n');
        if (newlineIndex === -1) {
          break;
        }

        const lineEnd = newlineIndex > 0 && buffer[newlineIndex - 1] === '\r'
          ? newlineIndex - 1
          : newlineIndex;
        yield {
          text: buffer.slice(0, lineEnd),
          hadNewline: true,
        };
        buffer = buffer.slice(newlineIndex + 1);
      }
    }

    if (buffer.length > 0) {
      yield {
        text: buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer,
        hadNewline: false,
      };
    }
  } finally {
    reader.releaseLock();
  }
}

async function *readByteLines({
  stream,
}: {
  stream: ReadableStream<Uint8Array>;
}): AsyncGenerator<CutByteLine> {
  const reader = stream.getReader();
  let lineChunks: Uint8Array[] = [];
  let lineLength = 0;

  const flushLine = ({ hadNewline }: { hadNewline: boolean }): CutByteLine => {
    const line = new Uint8Array(lineLength);
    let offset = 0;
    for (const chunk of lineChunks) {
      line.set(chunk, offset);
      offset += chunk.length;
    }
    lineChunks = [];
    lineLength = 0;
    return {
      bytes: line,
      hadNewline,
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
      for (let index = 0; index < value.length; index++) {
        if (value[index] !== 0x0a) {
          continue;
        }

        if (index > start) {
          const chunk = value.subarray(start, index);
          lineChunks.push(chunk);
          lineLength += chunk.length;
        }
        yield flushLine({ hadNewline: true });
        start = index + 1;
      }

      if (start < value.length) {
        const chunk = value.subarray(start);
        lineChunks.push(chunk);
        lineLength += chunk.length;
      }
    }

    if (lineLength > 0) {
      yield flushLine({ hadNewline: false });
    }
  } finally {
    reader.releaseLock();
  }
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

    const parsed = parseStandardArgv({
      args: context.args,
      spec: cutArgvSpec,
    });

    if (parsed.diagnostics.length > 0) {
      await writeCommandUsageError({
        context,
        command: 'cut',
        message: `cut: ${parsed.diagnostics[0]!.message}`,
        argvSpec: cutArgvSpec,
      });
      return { exitCode: 1 };
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

    const delimiterValue = typeof parsed.optionValues.delimiter === 'string'
      ? parsed.optionValues.delimiter
      : undefined;
    const fieldDelimiter = delimiterValue !== undefined ? delimiterValue.charAt(0) : undefined;
    if (mode === 'fields' && delimiterValue !== undefined && fieldDelimiter === '') {
      await writeCommandUsageError({
        context,
        command: 'cut',
        message: 'cut: empty delimiter',
        argvSpec: cutArgvSpec,
      });
      return { exitCode: 1 };
    }

    const outputDelimiter = typeof parsed.optionValues.outputDelimiter === 'string'
      ? parsed.optionValues.outputDelimiter
      : undefined;
    const complement = parsed.optionValues.complement === true;
    const suppress = parsed.optionValues.suppress === true;

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
          for await (const line of readByteLines({ stream })) {
            const selected = selectBytes({
              line: line.bytes,
              intervals,
              complement,
            });
            if (selected.length > 0) {
              await writeAll({
                handle: context.stdout,
                buffer: selected,
              });
            }
            if (line.hadNewline) {
              await writeAll({
                handle: context.stdout,
                buffer: new Uint8Array([0x0a]),
              });
            }
          }
          break;
        case 'characters':
        case 'fields':
          for await (const line of readTextLines({ stream })) {
            const selected = selectLine({
              line: line.text,
              mode,
              intervals,
              fieldDelimiter,
              outputDelimiter,
              complement,
              suppressNoDelimiterLines: suppress && mode === 'fields',
            });
            if (selected === undefined) {
              continue;
            }

            await text.print({
              text: line.hadNewline ? `${selected}\n` : selected,
            });
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
