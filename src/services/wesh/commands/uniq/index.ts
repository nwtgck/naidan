import { parseStandardArgv } from '@/services/wesh/argv';
import type { StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import type {
  WeshCommandContext,
  WeshCommandDefinition,
  WeshCommandResult,
  WeshEfficientFileWriter,
  WeshFileHandle,
} from '@/services/wesh/types';
import { openHandleReadStream, openFileReadStream } from '@/services/wesh/utils/fs';

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

async function openUniqInputStream({
  context,
  inputPath,
}: {
  context: WeshCommandContext;
  inputPath: string | undefined;
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
  stream: ReadableStream<Uint8Array>;
  delimiter: UniqDelimiter;
}): AsyncGenerator<UniqRecord> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        text += decoder.decode();
        break;
      }
      if (value === undefined) continue;

      text += decoder.decode(value, { stream: true });
      let delimiterIndex = text.indexOf(delimiter);
      while (delimiterIndex !== -1) {
        yield {
          text: text.slice(0, delimiterIndex),
          endedWithDelimiter: true,
        };
        text = text.slice(delimiterIndex + 1);
        delimiterIndex = text.indexOf(delimiter);
      }
    }

    if (text.length > 0) {
      yield {
        text,
        endedWithDelimiter: false,
      };
    }
  } finally {
    reader.releaseLock();
  }
}

type UniqOutputTarget =
  | { kind: 'stdout'; handle: WeshFileHandle }
  | { kind: 'writer'; writer: WeshEfficientFileWriter }
  | { kind: 'handle'; handle: WeshFileHandle };

async function openUniqOutputTarget({
  context,
  outputPath,
}: {
  context: WeshCommandContext;
  outputPath: string | undefined;
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
    case 'fallback-required':
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
  target: UniqOutputTarget;
  buffer: Uint8Array;
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
  target: UniqOutputTarget;
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
  target: UniqOutputTarget;
  record: UniqRecord;
  count: number;
  showCount: boolean;
  delimiter: UniqDelimiter;
}): Promise<void> {
  const data = formatRecord({
    record,
    count,
    showCount,
    delimiter,
  });
  await writeUniqOutput({
    target,
    buffer: new TextEncoder().encode(data),
  });
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

    try {
      const inputStream = await openUniqInputStream({
        context,
        inputPath,
      });
      const outputTarget = await openUniqOutputTarget({
        context,
        outputPath,
      });

      try {
        let groupRecord: UniqRecord | undefined;
        let groupCount = 0;
        let groupKey: string | undefined;

        const flush = async () => {
          if (groupRecord === undefined || !shouldEmitGroup({ mode, count: groupCount })) {
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
            line: record.text,
            options: comparisonOptions,
          });

          if (groupRecord === undefined) {
            groupRecord = record;
            groupCount = 1;
            groupKey = key;
            continue;
          }

          if (key === groupKey) {
            groupCount += 1;
            continue;
          }

          await flush();
          groupRecord = record;
          groupCount = 1;
          groupKey = key;
        }

        await flush();
      } finally {
        await closeUniqOutputTarget({
          target: outputTarget,
        });
      }
      return { exitCode: 0 };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const target = inputPath === undefined ? '-' : inputPath;
      await context.text().error({ text: `uniq: ${target}: ${message}\n` });
      return { exitCode: 1 };
    }
  },
};
