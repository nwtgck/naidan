import { parseStandardArgv, type StandardArgvParserSpec } from '@/features/wesh/argv';
import {
  findFirstStandardSemanticIssue,
  STANDARD_HELP_EARLY_EXIT_OPTIONS,
  standardSemanticIssuePrecedesDiagnostic,
  stopStandardArgvAtFirstEarlyExit,
} from '@/features/wesh/commands/_shared/argv';
import { stripLeadingCLocaleWhitespace } from '@/features/wesh/commands/_shared/numeric-whitespace';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import { resolvePath } from '@/features/wesh/path';
import type {
  WeshCommandContext,
  WeshCommandDefinition,
  WeshCommandResult,
  WeshFileHandle,
} from '@/features/wesh/types';
import { openFileReadStream, openHandleReadStream } from '@/features/wesh/utils/fs';
import { iterateReadableStreamChunks } from '@/features/wesh/utils/stream';
import { iterateUtf8RecordEntries } from '@/features/wesh/utils/text-records';

const NEWLINE_BYTE = 0x0a;
const NUL_BYTE = 0x00;
const OUTPUT_BUFFER_SIZE = 16 * 1024;
const UINTMAX_VALUE = (1n << 64n) - 1n;
const UINT64_VALUE_COUNT = 1n << 64n;
const MAX_MATERIALIZED_RANGE_COUNT = 1_000_000n;

type ShufInputRange = {
  readonly lower: bigint,
  readonly upper: bigint,
};

function shuffleInPlace<T>({
  items,
}: {
  items: T[],
}): T[] {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    const value = items[index];
    items[index] = items[swapIndex]!;
    items[swapIndex] = value!;
  }
  return items;
}

function parseCount({
  value,
}: {
  value: string,
}): { ok: true, value: string } | { ok: false, message: string } {
  const numericText = stripLeadingCLocaleWhitespace({ value });
  if (!/^\+?\d+$/u.test(numericText)) {
    return { ok: false, message: `invalid count '${value}'` };
  }
  return { ok: true, value: numericText };
}

function parseInputRange({
  value,
}: {
  value: string,
}): { ok: true, value: ShufInputRange } | { ok: false, message: string } {
  const match = /^([\t\n\v\f\r ]*\+?\d+)-([\t\n\v\f\r ]*\+?\d+)$/u.exec(value);
  if (match === null) {
    return { ok: false, message: `invalid input range '${value}'` };
  }

  const lower = BigInt(match[1]!);
  const upper = BigInt(match[2]!);
  if (lower > UINTMAX_VALUE || upper > UINTMAX_VALUE || lower > upper + 1n) {
    return { ok: false, message: `invalid input range '${value}'` };
  }

  return { ok: true, value: { lower, upper } };
}

function randomUint64(): bigint {
  const high = BigInt(Math.floor(Math.random() * 0x1_0000_0000));
  const low = BigInt(Math.floor(Math.random() * 0x1_0000_0000));
  return (high << 32n) | low;
}

function randomBigIntBelow({
  upperExclusive,
}: {
  upperExclusive: bigint,
}): bigint {
  if (upperExclusive <= 0n || upperExclusive > UINT64_VALUE_COUNT) {
    throw new RangeError('random BigInt bound is outside the uint64 range');
  }

  const acceptanceLimit = UINT64_VALUE_COUNT - (UINT64_VALUE_COUNT % upperExclusive);
  while (true) {
    const candidate = randomUint64();
    if (candidate < acceptanceLimit) {
      return candidate % upperExclusive;
    }
  }
}

function sampleRangeWithoutReplacement({
  inputRange,
  count,
}: {
  inputRange: ShufInputRange,
  count: bigint,
}): bigint[] {
  const available = inputRange.upper < inputRange.lower
    ? 0n
    : inputRange.upper - inputRange.lower + 1n;
  if (count < 0n || count > available || count > MAX_MATERIALIZED_RANGE_COUNT) {
    throw new RangeError('range sample count is outside the materialization limit');
  }

  if (count === available) {
    const values = Array.from(
      { length: Number(count) },
      (_, index) => inputRange.lower + BigInt(index),
    );
    return shuffleInPlace({ items: values });
  }

  const offsets = new Set<bigint>();
  for (let cursor = available - count; cursor < available; cursor += 1n) {
    const candidate = randomBigIntBelow({ upperExclusive: cursor + 1n });
    offsets.add(offsets.has(candidate) ? cursor : candidate);
  }

  return shuffleInPlace({
    items: [...offsets].map((offset) => inputRange.lower + offset),
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
  while (offset < buffer.byteLength) {
    const { bytesWritten } = await handle.write({
      buffer,
      offset,
      length: buffer.byteLength - offset,
    });
    if (bytesWritten === 0) {
      throw new Error('short write');
    }
    offset += bytesWritten;
  }
}

function createBufferedByteWriter({
  handle,
}: {
  handle: WeshFileHandle,
}) {
  const buffer = new Uint8Array(OUTPUT_BUFFER_SIZE);
  let length = 0;

  const flush = async (): Promise<void> => {
    if (length === 0) return;
    await writeAll({
      handle,
      buffer: buffer.subarray(0, length),
    });
    length = 0;
  };

  return {
    async write({
      bytes,
    }: {
      bytes: Uint8Array,
    }): Promise<void> {
      let offset = 0;
      while (offset < bytes.byteLength) {
        if (length === buffer.byteLength) {
          await flush();
        }

        if (length === 0 && bytes.byteLength - offset >= buffer.byteLength) {
          await writeAll({
            handle,
            buffer: bytes.subarray(offset),
          });
          return;
        }

        const writableLength = Math.min(
          buffer.byteLength - length,
          bytes.byteLength - offset,
        );
        buffer.set(bytes.subarray(offset, offset + writableLength), length);
        length += writableLength;
        offset += writableLength;
      }
    },
    flush,
  };
}

async function readInputRecords({
  context,
  path,
  delimiterByte,
}: {
  context: WeshCommandContext,
  path: string,
  delimiterByte: number,
}): Promise<Uint8Array[]> {
  const stream = path === '-'
    ? openHandleReadStream({ handle: context.stdin })
    : await openFileReadStream({
      files: context.files,
      path: resolvePath({ cwd: context.cwd, path }),
    });
  const records: Uint8Array[] = [];

  for await (const record of iterateUtf8RecordEntries({
    chunks: iterateReadableStreamChunks({ stream }),
    delimiterByte,
    stripTrailingCarriageReturn: false,
    includeBytes: true,
  })) {
    records.push(record.bytes === undefined
      ? new Uint8Array(0)
      : new Uint8Array(record.bytes));
  }

  return records;
}

async function openOutputHandle({
  context,
  outputPath,
}: {
  context: WeshCommandContext,
  outputPath: string | undefined,
}): Promise<{ handle: WeshFileHandle, close: boolean }> {
  if (outputPath === undefined) {
    return { handle: context.stdout, close: false };
  }

  return {
    handle: await context.files.open({
      path: resolvePath({ cwd: context.cwd, path: outputPath }),
      flags: {
        access: 'write',
        creation: 'if-needed',
        truncate: 'truncate',
        append: 'preserve',
      },
    }),
    close: true,
  };
}

const shufArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: 'e', long: 'echo', effects: [{ key: 'echo', value: true }], help: { summary: 'treat each ARG as an input line', category: 'common' } },
    { kind: 'flag', short: 'r', long: 'repeat', effects: [{ key: 'repeat', value: true }], help: { summary: 'output lines can be repeated', category: 'common' } },
    {
      kind: 'value',
      short: 'i',
      long: 'input-range',
      key: 'inputRange',
      valueName: 'LO-HI',
      allowAttachedValue: true,
      parseValue: undefined,
      help: { summary: 'treat each number LO through HI as an input line', valueName: 'LO-HI', category: 'common' },
    },
    {
      kind: 'value',
      short: 'n',
      long: 'head-count',
      key: 'count',
      valueName: 'COUNT',
      allowAttachedValue: true,
      parseValue: ({ value }) => parseCount({ value }),
      help: { summary: 'output at most COUNT lines', valueName: 'COUNT', category: 'common' },
    },
    {
      kind: 'value',
      short: 'o',
      long: 'output',
      key: 'outputPath',
      valueName: 'FILE',
      allowAttachedValue: true,
      parseValue: undefined,
      help: { summary: 'write result to FILE instead of standard output', valueName: 'FILE', category: 'common' },
    },
    { kind: 'flag', short: 'z', long: 'zero-terminated', effects: [{ key: 'zeroTerminated', value: true }], help: { summary: 'line delimiter is NUL, not newline', category: 'common' } },
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

type ShufPreHelpSemanticIssue =
  | { readonly kind: 'multiple-output' }
  | { readonly kind: 'input-range', readonly message: string };

function findShufPreHelpSemanticIssue({
  parsed,
}: {
  parsed: ReturnType<typeof parseStandardArgv>,
}): ShufPreHelpSemanticIssue | undefined {
  const outputPaths = new Set(parsed.occurrences.flatMap((occurrence) => (
    occurrence.kind === 'value' && occurrence.key === 'outputPath' && typeof occurrence.value === 'string'
      ? [occurrence.value]
      : []
  )));
  if (outputPaths.size > 1) return { kind: 'multiple-output' };

  const inputRangeCount = parsed.occurrences.filter((occurrence) => (
    occurrence.kind === 'value' && occurrence.key === 'inputRange'
  )).length;
  if (inputRangeCount > 1) {
    return { kind: 'input-range', message: 'multiple -i options specified' };
  }

  const range = parsed.optionValues.inputRange;
  if (typeof range !== 'string') return undefined;
  const result = parseInputRange({ value: range });
  return result.ok ? undefined : { kind: 'input-range', message: result.message };
}

export const shufCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'shuf',
    description: 'Randomly shuffle lines',
    usage: 'shuf [OPTION]... [FILE]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsedArgs = stopStandardArgvAtFirstEarlyExit({
      args: context.args,
      spec: shufArgvSpec,
      earlyExitOptions: STANDARD_HELP_EARLY_EXIT_OPTIONS,
    });
    const parsed = parseStandardArgv({ args: parsedArgs, spec: shufArgvSpec });

    const diagnostic = parsed.diagnostics[0];
    const firstPreHelpSemanticIssue = findFirstStandardSemanticIssue({
      args: parsedArgs,
      spec: shufArgvSpec,
      parsed,
      findSemanticIssue: findShufPreHelpSemanticIssue,
    });
    const semanticIssuePrecedesDiagnostic = standardSemanticIssuePrecedesDiagnostic({
      args: parsedArgs,
      spec: shufArgvSpec,
      parsed,
      findSemanticIssue: findShufPreHelpSemanticIssue,
    });
    if (diagnostic !== undefined && !semanticIssuePrecedesDiagnostic) {
      await writeCommandUsageError({
        context,
        command: 'shuf',
        message: `shuf: ${diagnostic.message}`,
        argvSpec: shufArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (firstPreHelpSemanticIssue !== undefined) {
      switch (firstPreHelpSemanticIssue.kind) {
      case 'multiple-output':
        await context.text().error({ text: 'shuf: multiple output files specified\n' });
        return { exitCode: 1 };
      case 'input-range':
        await writeCommandUsageError({
          context,
          command: 'shuf',
          message: `shuf: ${firstPreHelpSemanticIssue.message}`,
          argvSpec: shufArgvSpec,
        });
        return { exitCode: 1 };
      default: {
        const _ex: never = firstPreHelpSemanticIssue;
        throw new Error(`Unhandled shuf pre-help semantic issue: ${JSON.stringify(_ex)}`);
      }
      }
    }

    const inputRangeValue = parsed.optionValues.inputRange;
    const parsedInputRange = typeof inputRangeValue === 'string'
      ? parseInputRange({ value: inputRangeValue })
      : undefined;
    if (parsedInputRange !== undefined && !parsedInputRange.ok) {
      throw new Error(`shuf pre-help validation missed input range: ${parsedInputRange.message}`);
    }
    const inputRange = parsedInputRange?.ok === true
      ? parsedInputRange.value
      : undefined;

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'shuf',
        argvSpec: shufArgvSpec,
      });
      return { exitCode: 0 };
    }

    const echoArguments = parsed.optionValues.echo === true;
    if (!echoArguments && parsed.positionals.length > 1) {
      await writeCommandUsageError({
        context,
        command: 'shuf',
        message: `shuf: extra operand '${parsed.positionals[1] ?? ''}'`,
        argvSpec: shufArgvSpec,
      });
      return { exitCode: 1 };
    }

    const countValue = parsed.optionValues.count;
    const count = typeof countValue === 'string' ? BigInt(countValue) : undefined;
    const repeat = parsed.optionValues.repeat === true;
    if (inputRange !== undefined && parsed.positionals.length > 0) {
      await writeCommandUsageError({
        context,
        command: 'shuf',
        message: `shuf: extra operand '${parsed.positionals[0] ?? ''}'`,
        argvSpec: shufArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (repeat && count === undefined) {
      await context.text().error({ text: 'shuf: unbounded repeat is not supported; specify -n\n' });
      return { exitCode: 1 };
    }

    const zeroTerminated = parsed.optionValues.zeroTerminated === true;
    const delimiterByte = zeroTerminated ? NUL_BYTE : NEWLINE_BYTE;
    const encoder = new TextEncoder();
    const records: Uint8Array[] = [];
    let rangeOutputValues: bigint[] | undefined;
    const inputPath = parsed.positionals[0] ?? '-';

    try {
      if (inputRange !== undefined) {
        const available = inputRange.upper < inputRange.lower
          ? 0n
          : inputRange.upper - inputRange.lower + 1n;
        if (!repeat) {
          const outputCount = count === undefined || count > available ? available : count;
          if (outputCount > MAX_MATERIALIZED_RANGE_COUNT) {
            await context.text().error({
              text: `shuf: input range would require more than ${MAX_MATERIALIZED_RANGE_COUNT} unique output values; use a smaller --head-count\n`,
            });
            return { exitCode: 1 };
          }
          rangeOutputValues = sampleRangeWithoutReplacement({
            inputRange,
            count: outputCount,
          });
        } else if (available === 0n && (count ?? 0n) > 0n) {
          await context.text().error({ text: 'shuf: no lines to repeat\n' });
          return { exitCode: 1 };
        }
      } else if (echoArguments) {
        for (const argument of parsed.positionals) {
          records.push(encoder.encode(argument));
        }
      } else {
        const inputRecords = await readInputRecords({
          context,
          path: inputPath,
          delimiterByte,
        });
        for (const record of inputRecords) records.push(record);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await context.text().error({ text: `shuf: ${inputPath}: ${message}\n` });
      return { exitCode: 1 };
    }

    if (inputRange === undefined && repeat && records.length === 0 && (count ?? 0n) > 0n) {
      await context.text().error({ text: 'shuf: no lines to repeat\n' });
      return { exitCode: 1 };
    }

    if (inputRange === undefined && !repeat) {
      shuffleInPlace({ items: records });
    }

    const outputPathValue = parsed.optionValues.outputPath;
    const outputPath = typeof outputPathValue === 'string' ? outputPathValue : undefined;
    let output: Awaited<ReturnType<typeof openOutputHandle>>;
    try {
      output = await openOutputHandle({ context, outputPath });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await context.text().error({ text: `shuf: ${outputPath ?? 'write error'}: ${message}\n` });
      return { exitCode: 1 };
    }

    const writer = createBufferedByteWriter({ handle: output.handle });
    const delimiter = Uint8Array.of(delimiterByte);
    try {
      if (inputRange !== undefined && repeat) {
        const available = inputRange.upper - inputRange.lower + 1n;
        for (let outputIndex = 0n; outputIndex < (count ?? 0n); outputIndex += 1n) {
          const value = inputRange.lower + randomBigIntBelow({ upperExclusive: available });
          await writer.write({ bytes: encoder.encode(String(value)) });
          await writer.write({ bytes: delimiter });
        }
      } else if (inputRange !== undefined) {
        for (const value of rangeOutputValues ?? []) {
          await writer.write({ bytes: encoder.encode(String(value)) });
          await writer.write({ bytes: delimiter });
        }
      } else if (repeat) {
        for (let outputIndex = 0n; outputIndex < (count ?? 0n); outputIndex += 1n) {
          const record = records[Math.floor(Math.random() * records.length)]!;
          await writer.write({ bytes: record });
          await writer.write({ bytes: delimiter });
        }
      } else {
        const outputLength = count === undefined || count >= BigInt(records.length)
          ? records.length
          : Number(count);
        for (let index = 0; index < outputLength; index += 1) {
          await writer.write({ bytes: records[index]! });
          await writer.write({ bytes: delimiter });
        }
      }
      await writer.flush();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await context.text().error({ text: `shuf: ${outputPath ?? 'write error'}: ${message}\n` });
      return { exitCode: 1 };
    } finally {
      if (output.close) {
        await output.handle.close();
      }
    }

    return { exitCode: 0 };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
