import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext, WeshFileHandle } from '@/services/wesh/types';
import { handleToStream } from '@/services/wesh/utils/fs';

type WcField = 'lines' | 'words' | 'bytes' | 'chars' | 'maxLineLength';

interface WcCounts {
  lines: number;
  words: number;
  bytes: number;
  chars: number;
  maxLineLength: number;
}

interface WcEntry {
  name: string | undefined;
  counts: WcCounts;
}

const wcArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
    { kind: 'flag', short: 'l', long: 'lines', effects: [{ key: 'lines', value: true }], help: { summary: 'print newline counts', category: 'common' } },
    { kind: 'flag', short: 'w', long: 'words', effects: [{ key: 'words', value: true }], help: { summary: 'print word counts', category: 'common' } },
    { kind: 'flag', short: 'c', long: 'bytes', effects: [{ key: 'bytes', value: true }], help: { summary: 'print byte counts', category: 'common' } },
    { kind: 'flag', short: 'm', long: 'chars', effects: [{ key: 'chars', value: true }], help: { summary: 'print character counts', category: 'common' } },
    { kind: 'flag', short: 'L', long: 'max-line-length', effects: [{ key: 'maxLineLength', value: true }], help: { summary: 'print the maximum line length', category: 'advanced' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

function isWhitespace({ char }: { char: string }): boolean {
  return char.trim().length === 0;
}

function getSelectedFields({
  optionValues,
}: {
  optionValues: Record<string, boolean | string | number>;
}): WcField[] {
  const fields: WcField[] = [];
  if (optionValues.lines === true) fields.push('lines');
  if (optionValues.words === true) fields.push('words');
  if (optionValues.chars === true) fields.push('chars');
  if (optionValues.bytes === true) fields.push('bytes');
  if (optionValues.maxLineLength === true) fields.push('maxLineLength');

  if (fields.length === 0) {
    return ['lines', 'words', 'bytes'];
  }

  return fields;
}

function getFieldValue({
  counts,
  field,
}: {
  counts: WcCounts;
  field: WcField;
}): number {
  switch (field) {
  case 'lines':
    return counts.lines;
  case 'words':
    return counts.words;
  case 'bytes':
    return counts.bytes;
  case 'chars':
    return counts.chars;
  case 'maxLineLength':
    return counts.maxLineLength;
  default: {
    const _ex: never = field;
    throw new Error(`Unhandled wc field: ${_ex}`);
  }
  }
}

function sumCounts({
  entries,
}: {
  entries: WcEntry[];
}): WcCounts {
  return entries.reduce<WcCounts>((acc, entry) => ({
    lines: acc.lines + entry.counts.lines,
    words: acc.words + entry.counts.words,
    bytes: acc.bytes + entry.counts.bytes,
    chars: acc.chars + entry.counts.chars,
    maxLineLength: Math.max(acc.maxLineLength, entry.counts.maxLineLength),
  }), {
    lines: 0,
    words: 0,
    bytes: 0,
    chars: 0,
    maxLineLength: 0,
  });
}

function computeFieldWidths({
  entries,
  total,
  fields,
}: {
  entries: WcEntry[];
  total: WcCounts | undefined;
  fields: WcField[];
}): Record<WcField, number> {
  const widths: Record<WcField, number> = {
    lines: 8,
    words: 8,
    bytes: 8,
    chars: 8,
    maxLineLength: 8,
  };

  for (const field of fields) {
    for (const entry of entries) {
      widths[field] = Math.max(widths[field], String(getFieldValue({ counts: entry.counts, field })).length);
    }
    if (total !== undefined) {
      widths[field] = Math.max(widths[field], String(getFieldValue({ counts: total, field })).length);
    }
  }

  return widths;
}

function formatCountsLine({
  counts,
  fields,
  widths,
  name,
}: {
  counts: WcCounts;
  fields: WcField[];
  widths: Record<WcField, number>;
  name: string | undefined;
}): string {
  let line = '';
  for (const field of fields) {
    line += String(getFieldValue({ counts, field })).padStart(widths[field]);
  }
  if (name !== undefined) {
    line += ` ${name}`;
  }
  return line;
}

async function readCountsFromStream({
  stream,
}: {
  stream: ReadableStream<Uint8Array>;
}): Promise<WcCounts> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let lines = 0;
  let words = 0;
  let bytes = 0;
  let chars = 0;
  let maxLineLength = 0;
  let currentLineLength = 0;
  let inWord = false;

  const consumeChunk = ({
    chunk,
  }: {
    chunk: string;
  }): void => {
    for (const char of chunk) {
      chars += 1;
      currentLineLength += 1;

      if (char === '\n') {
        lines += 1;
        maxLineLength = Math.max(maxLineLength, currentLineLength - 1);
        currentLineLength = 0;
      }

      if (isWhitespace({ char })) {
        inWord = false;
      } else if (!inWord) {
        inWord = true;
        words += 1;
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    bytes += value.length;
    consumeChunk({ chunk: decoder.decode(value, { stream: true }) });
  }

  consumeChunk({ chunk: decoder.decode() });
  maxLineLength = Math.max(maxLineLength, currentLineLength);
  reader.releaseLock();

  return {
    lines,
    words,
    bytes,
    chars,
    maxLineLength,
  };
}

async function readInputCounts({
  handle,
}: {
  handle: WeshFileHandle;
}): Promise<WcCounts> {
  return await readCountsFromStream({ stream: handleToStream({ handle }) });
}

export const wcCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'wc',
    description: 'Print newline, word, byte, character, and line length counts',
    usage: 'wc [OPTION]... [FILE]...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: wcArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'wc',
        message: `wc: ${diagnostic.message}`,
        argvSpec: wcArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'wc',
        argvSpec: wcArgvSpec,
      });
      return { exitCode: 0 };
    }

    const text = context.text();
    const selectedFields = getSelectedFields({ optionValues: parsed.optionValues });
    const inputNames = parsed.positionals.length === 0 ? [undefined] : parsed.positionals;
    const entries: WcEntry[] = [];
    let hadError = false;

    for (const inputName of inputNames) {
      if (inputName === undefined || inputName === '-') {
        const counts = await readCountsFromStream({ stream: handleToStream({ handle: context.stdin }) });
        entries.push({
          name: inputName,
          counts,
        });
        continue;
      }

      try {
        const fullPath = inputName.startsWith('/') ? inputName : `${context.cwd}/${inputName}`;
        const handle = await context.kernel.open({
          path: fullPath,
          flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' }
        });
        const counts = await readInputCounts({ handle });
        entries.push({
          name: inputName,
          counts,
        });
      } catch (e: unknown) {
        hadError = true;
        const message = e instanceof Error ? e.message : String(e);
        await text.error({ text: `wc: ${inputName}: ${message}\n` });
      }
    }

    const shouldPrintTotal = inputNames.length > 1 && entries.length > 0;
    const total = shouldPrintTotal ? sumCounts({ entries }) : undefined;
    const widths = computeFieldWidths({ entries, total, fields: selectedFields });

    const showNames = parsed.positionals.length > 0;

    for (const entry of entries) {
      await text.print({
        text: `${formatCountsLine({
          counts: entry.counts,
          fields: selectedFields,
          widths,
          name: showNames ? entry.name : undefined,
        })}\n`,
      });
    }

    if (total !== undefined) {
      await text.print({
        text: `${formatCountsLine({
          counts: total,
          fields: selectedFields,
          widths,
          name: 'total',
        })}\n`,
      });
    }

    return { exitCode: hadError ? 1 : 0 };
  },
};
