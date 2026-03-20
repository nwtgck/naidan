import { parseStandardArgv } from '@/services/wesh/argv';
import type { StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult, WeshFileHandle } from '@/services/wesh/types';
import { readFile, writeFile } from '@/services/wesh/utils/fs';

type UniqMode = 'all' | 'duplicates' | 'unique';
type UniqDelimiter = '\n' | '\0';

interface UniqRecord {
  text: string;
  endedWithDelimiter: boolean;
}

interface UniqComparisonOptions {
  ignoreCase: boolean;
  skipFields: number;
  skipChars: number;
  checkChars: number | undefined;
}

function parseNonNegativeInteger({
  value,
  label,
}: {
  value: string;
  label: string;
}): { ok: true; value: number } | { ok: false; message: string } {
  if (!/^\d+$/.test(value)) {
    return { ok: false, message: `invalid argument to ${label}: ${value}` };
  }

  return { ok: true, value: parseInt(value, 10) };
}

function isBlank({
  char,
}: {
  char: string;
}): boolean {
  return char === ' ' || char === '\t';
}

function skipFields({
  text,
  fieldCount,
}: {
  text: string;
  fieldCount: number;
}): number {
  let index = 0;

  for (let field = 0; field < fieldCount; field++) {
    while (index < text.length && isBlank({ char: text[index] ?? '' })) index++;
    while (index < text.length && !isBlank({ char: text[index] ?? '' })) index++;
  }

  return index;
}

function normalizeForComparison({
  line,
  options,
}: {
  line: string;
  options: UniqComparisonOptions;
}): string {
  let index = skipFields({
    text: line,
    fieldCount: options.skipFields,
  });

  index = Math.min(line.length, index + options.skipChars);
  let comparable = line.slice(index);
  if (options.checkChars !== undefined) {
    comparable = comparable.slice(0, options.checkChars);
  }
  if (options.ignoreCase) {
    comparable = comparable.toLowerCase();
  }

  return comparable;
}

function splitRecords({
  text,
  delimiter,
}: {
  text: string;
  delimiter: UniqDelimiter;
}): UniqRecord[] {
  const records: UniqRecord[] = [];
  let start = 0;

  for (let index = 0; index < text.length; index++) {
    if (text[index] !== delimiter) continue;

    records.push({
      text: text.slice(start, index),
      endedWithDelimiter: true,
    });
    start = index + 1;
  }

  if (start < text.length) {
    records.push({
      text: text.slice(start),
      endedWithDelimiter: false,
    });
  }

  return records;
}

async function readHandleText({
  handle,
}: {
  handle: WeshFileHandle;
}): Promise<string> {
  const decoder = new TextDecoder();
  const buffer = new Uint8Array(4096);
  let text = '';
  while (true) {
    const { bytesRead } = await handle.read({ buffer });
    if (bytesRead === 0) break;
    text += decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
  }
  text += decoder.decode();
  return text;
}

function formatRecord({
  record,
  count,
  showCount,
  delimiter,
}: {
  record: UniqRecord;
  count: number;
  showCount: boolean;
  delimiter: UniqDelimiter;
}): string {
  let output = '';
  if (showCount) {
    output += `${count.toString().padStart(7)} `;
  }
  output += record.text;
  if (record.endedWithDelimiter) {
    output += delimiter;
  }
  return output;
}

function shouldEmitGroup({
  mode,
  count,
}: {
  mode: UniqMode;
  count: number;
}): boolean {
  switch (mode) {
  case 'all':
    return true;
  case 'duplicates':
    return count > 1;
  case 'unique':
    return count === 1;
  default: {
    const _ex: never = mode;
    throw new Error(`Unhandled uniq mode: ${_ex}`);
  }
  }
}

function buildComparisonKey({
  line,
  options,
}: {
  line: string;
  options: UniqComparisonOptions;
}): string {
  return normalizeForComparison({ line, options });
}

function processRecords({
  records,
  mode,
  comparisonOptions,
  showCount,
  delimiter,
}: {
  records: UniqRecord[];
  mode: UniqMode;
  comparisonOptions: UniqComparisonOptions;
  showCount: boolean;
  delimiter: UniqDelimiter;
}): string {
  if (records.length === 0) {
    return '';
  }

  const output: string[] = [];
  let groupRecord = records[0]!;
  let groupCount = 1;
  let groupKey = buildComparisonKey({
    line: groupRecord.text,
    options: comparisonOptions,
  });

  const flush = () => {
    if (!shouldEmitGroup({ mode, count: groupCount })) return;
    output.push(formatRecord({
      record: groupRecord,
      count: groupCount,
      showCount,
      delimiter,
    }));
  };

  for (let index = 1; index < records.length; index++) {
    const record = records[index];
    if (record === undefined) continue;

    const key = buildComparisonKey({
      line: record.text,
      options: comparisonOptions,
    });

    if (key === groupKey) {
      groupCount++;
      continue;
    }

    flush();
    groupRecord = record;
    groupCount = 1;
    groupKey = key;
  }

  flush();
  return output.join('');
}

async function writeOutput({
  context,
  outputPath,
  data,
}: {
  context: WeshCommandContext;
  outputPath: string | undefined;
  data: string;
}): Promise<void> {
  if (outputPath === undefined || outputPath === '-') {
    await context.text().print({ text: data });
    return;
  }

  await writeFile({
    kernel: context.kernel,
    path: outputPath,
    data: new TextEncoder().encode(data),
  });
}

async function readInputText({
  context,
  inputPath,
}: {
  context: WeshCommandContext;
  inputPath: string | undefined;
}): Promise<{ ok: true; value: string } | { ok: false; message: string }> {
  if (inputPath === undefined || inputPath === '-') {
    return { ok: true, value: await readHandleText({ handle: context.stdin }) };
  }

  try {
    const fullPath = inputPath.startsWith('/') ? inputPath : `${context.cwd}/${inputPath}`;
    const bytes = await readFile({ kernel: context.kernel, path: fullPath });
    return { ok: true, value: new TextDecoder().decode(bytes) };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `uniq: ${inputPath}: ${message}` };
  }
}

export const uniqCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'uniq',
    description: 'Report or omit repeated lines',
    usage: 'uniq [OPTION]... [INPUT [OUTPUT]]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const uniqArgvSpec: StandardArgvParserSpec = {
      options: [
        { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
        { kind: 'flag', short: 'c', long: 'count', effects: [{ key: 'count', value: true }], help: { summary: 'prefix lines by the number of occurrences', category: 'common' } },
        { kind: 'flag', short: 'd', long: 'repeated', effects: [{ key: 'duplicatesOnly', value: true }], help: { summary: 'only print duplicate lines', category: 'common' } },
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
      specialTokenParsers: [],
    };

    const parsed = parseStandardArgv({
      args: context.args,
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
    const delimiter: UniqDelimiter = zeroTerminated ? '\0' : '\n';
    const mode: UniqMode = parsed.optionValues.duplicatesOnly === true
      ? 'duplicates'
      : parsed.optionValues.uniqueOnly === true
        ? 'unique'
        : 'all';

    const comparisonOptions: UniqComparisonOptions = {
      ignoreCase: parsed.optionValues.ignoreCase === true,
      skipFields: typeof parsed.optionValues.skipFields === 'number' ? parsed.optionValues.skipFields : 0,
      skipChars: typeof parsed.optionValues.skipChars === 'number' ? parsed.optionValues.skipChars : 0,
      checkChars: typeof parsed.optionValues.checkChars === 'number' ? parsed.optionValues.checkChars : undefined,
    };

    const input = await readInputText({
      context,
      inputPath,
    });
    if (!input.ok) {
      await context.text().error({ text: `${input.message}\n` });
      return { exitCode: 1 };
    }
    const inputText = input.value;

    const records = splitRecords({
      text: inputText,
      delimiter,
    });

    const output = processRecords({
      records,
      mode,
      comparisonOptions,
      showCount: parsed.optionValues.count === true,
      delimiter,
    });

    if (outputPath === undefined) {
      await writeOutput({
        context,
        outputPath: undefined,
        data: output,
      });
      return { exitCode: 0 };
    }

    const resolvedOutputPath = outputPath === undefined || outputPath === '-'
      ? outputPath
      : outputPath.startsWith('/')
        ? outputPath
        : `${context.cwd}/${outputPath}`;
    await writeOutput({
      context,
      outputPath: resolvedOutputPath,
      data: output,
    });

    return { exitCode: 0 };
  },
};
