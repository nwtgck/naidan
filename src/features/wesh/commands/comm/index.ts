import { STANDARD_HELP_EARLY_EXIT_OPTIONS, stopStandardArgvAtFirstEarlyExit } from '@/features/wesh/commands/_shared/argv';
import { parseStandardArgv, type StandardArgvParserSpec } from '@/features/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import { resolvePath } from '@/features/wesh/path';
import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/features/wesh/types';
import { openFileReadStream, openHandleReadStream, writeAllBytesToHandle } from '@/features/wesh/utils/fs';
import { iterateReadableStreamChunks } from '@/features/wesh/utils/stream';

const NEWLINE_BYTE = 0x0a;
const NUL_BYTE = 0x00;
const TAB_BYTE = 0x09;
const OUTPUT_BUFFER_SIZE = 16 * 1024;

type OrderCheckMode = 'default' | 'always' | 'never';

type CommRecord = {
  readonly bytes: Uint8Array,
};

type OrderedCommRecord = {
  readonly record: CommRecord,
  readonly disorderWithPrevious: boolean,
};

class CommOrderError extends Error {}

function collectRecordBytes({
  fragments,
  fragmentsByteLength,
  finalFragment,
}: {
  fragments: readonly Uint8Array[],
  fragmentsByteLength: number,
  finalFragment: Uint8Array,
}): Uint8Array {
  if (fragments.length === 0) {
    return finalFragment;
  }

  const bytes = new Uint8Array(fragmentsByteLength + finalFragment.byteLength);
  let offset = 0;
  for (const fragment of fragments) {
    bytes.set(fragment, offset);
    offset += fragment.byteLength;
  }
  bytes.set(finalFragment, offset);
  return bytes;
}

async function* iterateByteRecords({
  chunks,
  delimiterByte,
}: {
  chunks: AsyncIterable<Uint8Array>,
  delimiterByte: number,
}): AsyncIterable<CommRecord> {
  let fragments: Uint8Array[] = [];
  let fragmentsByteLength = 0;

  for await (const chunk of chunks) {
    let recordStart = 0;
    for (let index = 0; index < chunk.byteLength; index += 1) {
      if (chunk[index] !== delimiterByte) {
        continue;
      }
      yield {
        bytes: collectRecordBytes({
          fragments,
          fragmentsByteLength,
          finalFragment: chunk.subarray(recordStart, index),
        }),
      };
      fragments = [];
      fragmentsByteLength = 0;
      recordStart = index + 1;
    }

    if (recordStart < chunk.byteLength) {
      const fragment = chunk.subarray(recordStart);
      fragments.push(fragment);
      fragmentsByteLength += fragment.byteLength;
    }
  }

  if (fragments.length > 0) {
    yield {
      bytes: collectRecordBytes({
        fragments,
        fragmentsByteLength,
        finalFragment: new Uint8Array(0),
      }),
    };
  }
}

function compareRecords({
  left,
  right,
}: {
  left: Uint8Array,
  right: Uint8Array,
}): number {
  const sharedLength = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < sharedLength; index += 1) {
    const leftByte = left[index]!;
    const rightByte = right[index]!;
    if (leftByte < rightByte) {
      return -1;
    }
    if (leftByte > rightByte) {
      return 1;
    }
  }
  if (left.byteLength < right.byteLength) {
    return -1;
  }
  if (left.byteLength > right.byteLength) {
    return 1;
  }
  return 0;
}

async function openCommRecordIterator({
  context,
  path,
  delimiterByte,
}: {
  context: WeshCommandContext,
  path: string,
  delimiterByte: number,
}): Promise<AsyncIterator<CommRecord>> {
  const stream = path === '-'
    ? openHandleReadStream({ handle: context.stdin })
    : await openFileReadStream({
      files: context.files,
      path: resolvePath({
        cwd: context.cwd,
        path,
      }),
    });
  return iterateByteRecords({
    chunks: iterateReadableStreamChunks({ stream }),
    delimiterByte,
  })[Symbol.asyncIterator]();
}

type OrderedRecordReader = {
  readonly next: () => Promise<IteratorResult<OrderedCommRecord>>,
  readonly reportUnpairableDisorder: ({ current }: { current: OrderedCommRecord }) => Promise<void>,
  readonly foundDisorder: () => boolean,
};

function createOrderedRecordReader({
  context,
  fileNumber,
  iterator,
  orderCheckMode,
}: {
  context: WeshCommandContext,
  fileNumber: 1 | 2,
  iterator: AsyncIterator<CommRecord>,
  orderCheckMode: OrderCheckMode,
}): OrderedRecordReader {
  let previous: Uint8Array | undefined;
  let disorderFound = false;

  const reportDisorder = async (): Promise<void> => {
    if (disorderFound) {
      return;
    }
    disorderFound = true;
    await context.text().error({
      text: `comm: file ${fileNumber} is not in sorted order
`,
    });
  };

  return {
    next: async (): Promise<IteratorResult<OrderedCommRecord>> => {
      const result = await iterator.next();
      if (result.done) {
        return result;
      }
      const disorderWithPrevious = previous !== undefined
        && compareRecords({ left: previous, right: result.value.bytes }) > 0;
      previous = result.value.bytes;

      if (disorderWithPrevious && orderCheckMode === 'always') {
        await reportDisorder();
        throw new CommOrderError();
      }
      return {
        done: false,
        value: {
          record: result.value,
          disorderWithPrevious,
        },
      };
    },
    reportUnpairableDisorder: async ({ current }: { current: OrderedCommRecord }): Promise<void> => {
      if (orderCheckMode === 'default' && current.disorderWithPrevious) {
        await reportDisorder();
      }
    },
    foundDisorder: (): boolean => disorderFound,
  };
}

function createBufferedByteWriter({
  context,
}: {
  context: WeshCommandContext,
}): {
  readonly write: ({ chunks }: { chunks: readonly Uint8Array[] }) => Promise<void>,
  readonly flush: () => Promise<void>,
} {
  let bufferedChunks: Uint8Array[] = [];
  let bufferedLength = 0;

  const flush = async (): Promise<void> => {
    if (bufferedLength === 0) {
      return;
    }

    const combined = new Uint8Array(bufferedLength);
    let offset = 0;
    for (const chunk of bufferedChunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    bufferedChunks = [];
    bufferedLength = 0;
    await writeAllBytesToHandle({
      handle: context.stdout,
      data: combined,
    });
  };

  return {
    write: async ({ chunks }: { chunks: readonly Uint8Array[] }): Promise<void> => {
      for (const chunk of chunks) {
        if (chunk.byteLength === 0) {
          continue;
        }
        bufferedChunks.push(chunk);
        bufferedLength += chunk.byteLength;
      }
      if (bufferedLength >= OUTPUT_BUFFER_SIZE) {
        await flush();
      }
    },
    flush,
  };
}

function encodeOutputDelimiter({
  configuredOutputDelimiter,
  encoder,
}: {
  configuredOutputDelimiter: boolean | string | number | undefined,
  encoder: TextEncoder,
}): Uint8Array {
  if (typeof configuredOutputDelimiter !== 'string') {
    return Uint8Array.of(TAB_BYTE);
  }
  if (configuredOutputDelimiter.length === 0) {
    return Uint8Array.of(NUL_BYTE);
  }
  return encoder.encode(configuredOutputDelimiter);
}

function repeatBytes({
  bytes,
  count,
}: {
  bytes: Uint8Array,
  count: number,
}): Uint8Array {
  if (count === 0 || bytes.byteLength === 0) {
    return new Uint8Array(0);
  }
  const repeated = new Uint8Array(bytes.byteLength * count);
  for (let index = 0; index < count; index += 1) {
    repeated.set(bytes, index * bytes.byteLength);
  }
  return repeated;
}

function visibleColumnsBefore({
  column,
  suppress1,
  suppress2,
  suppress3,
}: {
  column: 1 | 2 | 3,
  suppress1: boolean,
  suppress2: boolean,
  suppress3: boolean,
}): number {
  return [
    !suppress1,
    !suppress2,
    !suppress3,
  ].slice(0, column - 1).filter(Boolean).length;
}

const commArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: '1', long: undefined, effects: [{ key: 'suppress1', value: true }], help: { summary: 'suppress column 1', category: 'common' } },
    { kind: 'flag', short: '2', long: undefined, effects: [{ key: 'suppress2', value: true }], help: { summary: 'suppress column 2', category: 'common' } },
    { kind: 'flag', short: '3', long: undefined, effects: [{ key: 'suppress3', value: true }], help: { summary: 'suppress column 3', category: 'common' } },
    { kind: 'flag', short: 'z', long: 'zero-terminated', effects: [{ key: 'zeroTerminated', value: true }], help: { summary: 'line delimiter is NUL, not newline', category: 'common' } },
    { kind: 'flag', short: undefined, long: 'check-order', effects: [{ key: 'orderCheckMode', value: 'always' }], help: { summary: 'check that the input is correctly sorted', category: 'advanced' } },
    { kind: 'flag', short: undefined, long: 'nocheck-order', effects: [{ key: 'orderCheckMode', value: 'never' }], help: { summary: 'do not check that the input is correctly sorted', category: 'advanced' } },
    { kind: 'value', short: undefined, long: 'output-delimiter', key: 'outputDelimiter', valueName: 'STR', allowAttachedValue: false, parseValue: undefined, help: { summary: 'separate columns with STR', valueName: 'STR', category: 'advanced' } },
    { kind: 'flag', short: undefined, long: 'total', effects: [{ key: 'total', value: true }], help: { summary: 'output a summary', category: 'advanced' } },
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

export const commCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'comm',
    description: 'Compare two sorted files line by line',
    usage: 'comm [OPTION]... FILE1 FILE2',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: stopStandardArgvAtFirstEarlyExit({ args: context.args, spec: commArgvSpec, earlyExitOptions: STANDARD_HELP_EARLY_EXIT_OPTIONS }),
      spec: commArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'comm',
        message: `comm: ${diagnostic.message}`,
        argvSpec: commArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'comm',
        argvSpec: commArgvSpec,
      });
      return { exitCode: 0 };
    }

    const outputDelimiterCount = parsed.occurrences.filter((occurrence) => (
      occurrence.kind === 'value'
      && occurrence.key === 'outputDelimiter'
    )).length;
    if (outputDelimiterCount > 1) {
      await context.text().error({ text: 'comm: multiple output delimiters specified\n' });
      return { exitCode: 1 };
    }

    if (parsed.positionals.length < 2) {
      await writeCommandUsageError({
        context,
        command: 'comm',
        message: 'comm: missing operand',
        argvSpec: commArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.positionals.length > 2) {
      await writeCommandUsageError({
        context,
        command: 'comm',
        message: `comm: extra operand '${parsed.positionals[2] ?? ''}'`,
        argvSpec: commArgvSpec,
      });
      return { exitCode: 1 };
    }

    const leftPath = parsed.positionals[0]!;
    const rightPath = parsed.positionals[1]!;
    const suppress1 = parsed.optionValues.suppress1 === true;
    const suppress2 = parsed.optionValues.suppress2 === true;
    const suppress3 = parsed.optionValues.suppress3 === true;
    const zeroTerminated = parsed.optionValues.zeroTerminated === true;
    const orderCheckModeValue = parsed.optionValues.orderCheckMode;
    const orderCheckMode: OrderCheckMode = orderCheckModeValue === 'always'
      || orderCheckModeValue === 'never'
      ? orderCheckModeValue
      : 'default';
    const encoder = new TextEncoder();
    const outputDelimiterBytes = encodeOutputDelimiter({
      configuredOutputDelimiter: parsed.optionValues.outputDelimiter,
      encoder,
    });
    const recordTerminatorBytes = Uint8Array.of(zeroTerminated ? NUL_BYTE : NEWLINE_BYTE);
    const inputDelimiterByte = zeroTerminated ? NUL_BYTE : NEWLINE_BYTE;
    const includeTotal = parsed.optionValues.total === true;
    const prefix1 = repeatBytes({
      bytes: outputDelimiterBytes,
      count: visibleColumnsBefore({ column: 1, suppress1, suppress2, suppress3 }),
    });
    const prefix2 = repeatBytes({
      bytes: outputDelimiterBytes,
      count: visibleColumnsBefore({ column: 2, suppress1, suppress2, suppress3 }),
    });
    const prefix3 = repeatBytes({
      bytes: outputDelimiterBytes,
      count: visibleColumnsBefore({ column: 3, suppress1, suppress2, suppress3 }),
    });
    const prefixes: Readonly<Record<1 | 2 | 3, Uint8Array>> = {
      1: prefix1,
      2: prefix2,
      3: prefix3,
    };
    let count1 = 0;
    let count2 = 0;
    let count3 = 0;
    let leftIterator: AsyncIterator<CommRecord> | undefined;
    let rightIterator: AsyncIterator<CommRecord> | undefined;
    let currentInputPath = leftPath;
    const writer = createBufferedByteWriter({ context });

    const writeRecord = async ({
      column,
      record,
    }: {
      column: 1 | 2 | 3,
      record: CommRecord,
    }): Promise<void> => {
      await writer.write({
        chunks: [prefixes[column], record.bytes, recordTerminatorBytes],
      });
    };

    try {
      leftIterator = await openCommRecordIterator({
        context,
        path: leftPath,
        delimiterByte: inputDelimiterByte,
      });
      const leftReader = createOrderedRecordReader({
        context,
        fileNumber: 1,
        iterator: leftIterator,
        orderCheckMode,
      });
      const inputsShareStdin = leftPath === '-' && rightPath === '-';
      currentInputPath = rightPath;
      rightIterator = inputsShareStdin
        ? leftIterator
        : await openCommRecordIterator({
          context,
          path: rightPath,
          delimiterByte: inputDelimiterByte,
        });
      const rightReader = createOrderedRecordReader({
        context,
        fileNumber: 2,
        iterator: rightIterator,
        orderCheckMode,
      });
      let left = await leftReader.next();
      let right = await rightReader.next();

      while (!left.done || !right.done) {
        if (!left.done && !right.done) {
          const compared = compareRecords({
            left: left.value.record.bytes,
            right: right.value.record.bytes,
          });
          if (compared === 0) {
            count3 += 1;
            if (!suppress3) {
              await writeRecord({ column: 3, record: left.value.record });
            }
            left = await leftReader.next();
            right = await rightReader.next();
            continue;
          }

          if (compared < 0) {
            await leftReader.reportUnpairableDisorder({ current: left.value });
            count1 += 1;
            if (!suppress1) {
              await writeRecord({ column: 1, record: left.value.record });
            }
            left = await leftReader.next();
            continue;
          }

          await rightReader.reportUnpairableDisorder({ current: right.value });
          count2 += 1;
          if (!suppress2) {
            await writeRecord({ column: 2, record: right.value.record });
          }
          right = await rightReader.next();
          continue;
        }

        if (!left.done) {
          await leftReader.reportUnpairableDisorder({ current: left.value });
          count1 += 1;
          if (!suppress1) {
            await writeRecord({ column: 1, record: left.value.record });
          }
          left = await leftReader.next();
          continue;
        }

        if (!right.done) {
          await rightReader.reportUnpairableDisorder({ current: right.value });
          count2 += 1;
          if (!suppress2) {
            await writeRecord({ column: 2, record: right.value.record });
          }
          right = await rightReader.next();
        }
      }
      const inputIsDisordered = leftReader.foundDisorder() || rightReader.foundDisorder();
      if (inputIsDisordered) {
        await context.text().error({ text: 'comm: input is not in sorted order\n' });
      }
      if (inputsShareStdin) {
        await context.text().error({ text: 'comm: -: Bad file descriptor\n' });
        return { exitCode: 1 };
      }
      if (includeTotal) {
        await writer.write({
          chunks: [
            encoder.encode(String(count1)),
            outputDelimiterBytes,
            encoder.encode(String(count2)),
            outputDelimiterBytes,
            encoder.encode(String(count3)),
            outputDelimiterBytes,
            encoder.encode('total'),
            recordTerminatorBytes,
          ],
        });
      }
      return { exitCode: inputIsDisordered ? 1 : 0 };
    } catch (error: unknown) {
      if (error instanceof CommOrderError) {
        return { exitCode: 1 };
      }
      const message = error instanceof Error ? error.message : String(error);
      await context.text().error({ text: `comm: ${currentInputPath}: ${message}\n` });
      return { exitCode: 1 };
    } finally {
      await writer.flush();
      await leftIterator?.return?.();
      await rightIterator?.return?.();
    }
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
