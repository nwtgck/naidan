import { parseStandardArgv } from '@/services/wesh/argv';
import type { StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/services/wesh/types';
import { handleToStream } from '@/services/wesh/utils/fs';

type CutMode = 'bytes' | 'characters' | 'fields';

interface CutRange {
  start: number | undefined;
  end: number | undefined;
}

interface CutLine {
  text: string;
  hadNewline: boolean;
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

function normalizeCutRanges({
  ranges,
  length,
}: {
  ranges: CutRange[];
  length: number;
}): Set<number> {
  const selected = new Set<number>();

  for (const range of ranges) {
    const start = range.start ?? 1;
    const end = range.end ?? length;
    for (let index = start; index <= end; index++) {
      if (index <= length) {
        selected.add(index);
      }
    }
  }

  return selected;
}

function splitLines({
  text,
}: {
  text: string;
}): CutLine[] {
  const lines: CutLine[] = [];
  let start = 0;

  while (start < text.length) {
    const newlineIndex = text.indexOf('\n', start);
    if (newlineIndex === -1) break;

    const lineEnd = newlineIndex > start && text[newlineIndex - 1] === '\r'
      ? newlineIndex - 1
      : newlineIndex;

    lines.push({
      text: text.slice(start, lineEnd),
      hadNewline: true,
    });
    start = newlineIndex + 1;
  }

  if (start < text.length) {
    const last = text.slice(start);
    lines.push({
      text: last.endsWith('\r') ? last.slice(0, -1) : last,
      hadNewline: false,
    });
  }

  return lines;
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

function selectBytes({
  line,
  ranges,
  complement,
}: {
  line: string;
  ranges: CutRange[];
  complement: boolean;
}): string {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const bytes = encoder.encode(line);
  const selected = normalizeCutRanges({ ranges, length: bytes.length });
  const result: number[] = [];

  for (let index = 0; index < bytes.length; index++) {
    const position = index + 1;
    const isSelected = selected.has(position);
    if (complement ? !isSelected : isSelected) {
      result.push(bytes[index]!);
    }
  }

  return decoder.decode(new Uint8Array(result));
}

function selectCharacters({
  line,
  ranges,
  complement,
}: {
  line: string;
  ranges: CutRange[];
  complement: boolean;
}): string {
  const characters = Array.from(line);
  const selected = normalizeCutRanges({ ranges, length: characters.length });
  const result: string[] = [];

  for (let index = 0; index < characters.length; index++) {
    const position = index + 1;
    const isSelected = selected.has(position);
    if (complement ? !isSelected : isSelected) {
      result.push(characters[index]!);
    }
  }

  return result.join('');
}

function selectFields({
  line,
  delimiter,
  outputDelimiter,
  ranges,
  complement,
  suppressNoDelimiterLines,
}: {
  line: string;
  delimiter: string;
  outputDelimiter: string;
  ranges: CutRange[];
  complement: boolean;
  suppressNoDelimiterLines: boolean;
}): string | undefined {
  if (!line.includes(delimiter)) {
    return suppressNoDelimiterLines ? undefined : line;
  }

  const fields = line.split(delimiter);
  const selected = normalizeCutRanges({ ranges, length: fields.length });
  const result: string[] = [];

  for (let index = 0; index < fields.length; index++) {
    const position = index + 1;
    const isSelected = selected.has(position);
    if (complement ? !isSelected : isSelected) {
      result.push(fields[index]!);
    }
  }

  return result.join(outputDelimiter);
}

function selectLine({
  line,
  mode,
  ranges,
  fieldDelimiter,
  outputDelimiter,
  complement,
  suppressNoDelimiterLines,
}: {
  line: string;
  mode: CutMode;
  ranges: CutRange[];
  fieldDelimiter: string | undefined;
  outputDelimiter: string | undefined;
  complement: boolean;
  suppressNoDelimiterLines: boolean;
}): string | undefined {
  switch (mode) {
  case 'bytes':
    return selectBytes({ line, ranges, complement });
  case 'characters':
    return selectCharacters({ line, ranges, complement });
  case 'fields':
    return selectFields({
      line,
      delimiter: fieldDelimiter ?? '\t',
      outputDelimiter: outputDelimiter ?? fieldDelimiter ?? '\t',
      ranges,
      complement,
      suppressNoDelimiterLines,
    });
  default: {
    const _ex: never = mode;
    throw new Error(`Unhandled cut mode: ${_ex}`);
  }
  }
}

function createInputStream({
  context,
}: {
  context: WeshCommandContext;
}): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async pull(controller) {
      const buffer = new Uint8Array(4096);
      const { bytesRead } = await context.stdin.read({ buffer });
      if (bytesRead === 0) {
        controller.close();
        return;
      }
      controller.enqueue(buffer.subarray(0, bytesRead));
    },
  });
}

async function readTextStream({
  stream,
}: {
  stream: ReadableStream<Uint8Array>;
}): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }

  return text;
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
    const processText = async ({
      text,
    }: {
      text: string;
    }): Promise<string> => {
      const lines = splitLines({ text });
      const output: string[] = [];

      for (const line of lines) {
        const selected = selectLine({
          line: line.text,
          mode,
          ranges: parsedList.value,
          fieldDelimiter,
          outputDelimiter,
          complement,
          suppressNoDelimiterLines: suppress && mode === 'fields',
        });

        if (selected === undefined) {
          continue;
        }

        output.push(line.hadNewline ? `${selected}\n` : selected);
      }

      return output.join('');
    };

    const text = context.text();
    let exitCode = 0;

    const inputFiles = parsed.positionals.length === 0 ? ['-'] : parsed.positionals;
    let stdinText: string | undefined;

    for (const file of inputFiles) {
      if (file === undefined) continue;

      try {
        const content = file === '-'
          ? stdinText ??= await readTextStream({ stream: createInputStream({ context }) })
          : await (async () => {
            const fullPath = resolvePath({ cwd: context.cwd, path: file });
            const handle = await context.kernel.open({
              path: fullPath,
              flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' },
            });
            return readTextStream({ stream: handleToStream({ handle }) });
          })();
        await text.print({ text: await processText({ text: content }) });
      } catch (error: unknown) {
        exitCode = 1;
        const message = error instanceof Error ? error.message : String(error);
        await text.error({ text: `cut: ${file}: ${message}\n` });
      }
    }

    return { exitCode };
  },
};
