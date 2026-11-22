import { createWeshOwnedBytes } from '@/features/wesh/types';
import type { WeshCommandImplementation, WeshCommandResult, WeshCommandContext } from '@/features/wesh/types';
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
import { getPathErrorReason } from '@/features/wesh/commands/_shared/path-errors';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage-output';
import {
  lineOrByteCountArgvAction,
  selectLastLineOrByteCount,
} from '@/features/wesh/commands/_shared/line-byte-count-selection';
import { openHandleReadStream, openFileReadStream } from '@/features/wesh/utils/fs';
import { iterateReadableStreamChunks } from '@/features/wesh/utils/stream';
import {
  iterateByteRecordEntries,
  materializeByteRecord,
  type WeshByteRecord,
} from '@/features/wesh/utils/text-records';

function normalizeLeadingLegacyCount({ args }: { args: readonly string[] }): readonly string[] {
  const first = args[0];
  if (first === undefined || !/^[+-]\d+$/.test(first)) {
    return args;
  }

  const rest = args.slice(1);
  const explicitOperandBoundary = rest[0] === '--';
  const operands = explicitOperandBoundary ? rest.slice(1) : rest;
  const hasOption = !explicitOperandBoundary && rest.some(
    token => token !== '-' && token.startsWith('-'),
  );

  if (hasOption || operands.length > 1) {
    return args;
  }

  const count = first.startsWith('-') ? first.slice(1) : first;
  return ['-n', count, ...rest];
}

async function writeOwnedBytes({
  handle,
  data,
}: {
  handle: WeshCommandContext['stdout'],
  data: Uint8Array<ArrayBufferLike>,
}): Promise<void> {
  if (data.byteLength === 0) {
    return;
  }
  if (handle.writeOwned !== undefined) {
    await handle.writeOwned({
      chunk: createWeshOwnedBytes({ bytes: data }),
    });
    return;
  }

  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await handle.write({
      buffer: data,
      offset,
      length: data.length - offset,
    });
    if (bytesWritten === 0) {
      return;
    }
    offset += bytesWritten;
  }
}

function resolvePath({ cwd, path }: { cwd: string, path: string }): string {
  if (path.startsWith('/')) {
    return path;
  }
  return cwd === '/' ? `/${path}` : `${cwd}/${path}`;
}

function quoteInputPath({ path }: { path: string }): string {
  if (path.includes("'") && !/["$`\\]/u.test(path)) {
    return `"${path}"`;
  }
  return `'${path.replaceAll("'", "'\\''")}'`;
}

interface TailByteQueue {
  chunks: Uint8Array<ArrayBufferLike>[],
  headIndex: number,
  headOffset: number,
  byteLength: number,
}

function appendTailByteChunk({
  queue,
  chunk,
  maxBytes,
}: {
  queue: TailByteQueue,
  chunk: Uint8Array<ArrayBufferLike>,
  maxBytes: number,
}): void {
  if (maxBytes === 0 || chunk.byteLength === 0) {
    return;
  }

  queue.chunks.push(chunk);
  queue.byteLength += chunk.byteLength;
  let excess = queue.byteLength - maxBytes;
  while (excess > 0 && queue.headIndex < queue.chunks.length) {
    const head = queue.chunks[queue.headIndex]!;
    const available = head.byteLength - queue.headOffset;
    if (excess < available) {
      queue.headOffset += excess;
      queue.byteLength -= excess;
      excess = 0;
      break;
    }
    queue.headIndex += 1;
    queue.headOffset = 0;
    queue.byteLength -= available;
    excess -= available;
  }

  if (queue.headIndex >= 32 && queue.headIndex * 2 >= queue.chunks.length) {
    queue.chunks = queue.chunks.slice(queue.headIndex);
    queue.headIndex = 0;
  }
}

async function writeTailByteQueue({
  queue,
  handle,
}: {
  queue: TailByteQueue,
  handle: WeshCommandContext['stdout'],
}): Promise<void> {
  for (let index = queue.headIndex; index < queue.chunks.length; index++) {
    const chunk = queue.chunks[index]!;
    const data = index === queue.headIndex && queue.headOffset > 0
      ? chunk.subarray(queue.headOffset)
      : chunk;
    await writeOwnedBytes({ handle, data });
  }
}

async function writeTailRecordsFromStart({
  chunks,
  recordsToSkip,
  delimiterByte,
  handle,
}: {
  chunks: AsyncIterable<Uint8Array>,
  recordsToSkip: number,
  delimiterByte: number,
  handle: WeshCommandContext['stdout'],
}): Promise<void> {
  let remainingRecordsToSkip = Math.max(recordsToSkip, 0);

  for await (const chunk of chunks) {
    if (remainingRecordsToSkip === 0) {
      await writeOwnedBytes({ handle, data: chunk });
      continue;
    }

    let outputOffset = chunk.byteLength;
    for (let index = 0; index < chunk.byteLength; index += 1) {
      if (chunk[index] !== delimiterByte) {
        continue;
      }
      remainingRecordsToSkip -= 1;
      if (remainingRecordsToSkip === 0) {
        outputOffset = index + 1;
        break;
      }
    }

    if (remainingRecordsToSkip === 0 && outputOffset < chunk.byteLength) {
      await writeOwnedBytes({
        handle,
        data: chunk.subarray(outputOffset),
      });
    }
  }
}

interface TailLineQueue {
  records: Uint8Array[],
  headIndex: number,
}

function appendTailLine({
  queue,
  record,
  maxLines,
}: {
  queue: TailLineQueue,
  record: Uint8Array,
  maxLines: number,
}): void {
  if (maxLines === 0) {
    return;
  }

  queue.records.push(record);
  if (queue.records.length - queue.headIndex > maxLines) {
    queue.headIndex += 1;
  }
  if (queue.headIndex >= 1024 && queue.headIndex * 2 >= queue.records.length) {
    queue.records = queue.records.slice(queue.headIndex);
    queue.headIndex = 0;
  }
}

const tailOptions = [
  {
    semantic: { kind: 'effects', effects: [{ key: 'headerMode', value: 'never' }] },
    forms: [
      { kind: 'short', name: 'q', value: { kind: 'none' } },
      { kind: 'long', name: 'quiet', value: { kind: 'none' } },
      { kind: 'long', name: 'silent', value: { kind: 'none' } },
    ],
    summary: 'never print headers with file names',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'headerMode', value: 'always' }] },
    forms: [
      { kind: 'short', name: 'v', value: { kind: 'none' } },
      { kind: 'long', name: 'verbose', value: { kind: 'none' } },
    ],
    summary: 'always print headers with file names',
    category: 'common',
  },
  {
    semantic: lineOrByteCountArgvAction({ unit: 'lines' }),
    forms: [
      { kind: 'short', name: 'n', value: { kind: 'required-attached-or-following', missingValueName: 'lines' } },
      { kind: 'long', name: 'lines', value: { kind: 'required', missingValueName: 'lines' } },
    ],
    summary: 'output the last NUM lines, or start at line NUM with +NUM',
    valueName: 'NUM',
    category: 'common',
  },
  {
    semantic: lineOrByteCountArgvAction({ unit: 'bytes' }),
    forms: [
      { kind: 'short', name: 'c', value: { kind: 'required-attached-or-following', missingValueName: 'bytes' } },
      { kind: 'long', name: 'bytes', value: { kind: 'required', missingValueName: 'bytes' } },
    ],
    summary: 'output the last NUM bytes, or start at byte NUM with +NUM',
    valueName: 'NUM',
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
  {
    semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
    forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
    summary: 'display this help and exit',
    category: 'common',
  },
] as const;

const tailArgvCatalog = defineArgvCatalog<StandardArgvAction<never>>({
  definitions: tailOptions,
  nonExecutableLongOptions: ['-disable-inotify', '-presume-input-pipe', 'follow', 'max-unchanged-stats', 'pid', 'retry', 'sleep-interval', 'version'],
});
const tailArgvHelp = defineArgvHelpPresentation({ catalog: tailArgvCatalog, rows: tailOptions });
const tailArgvPolicy: StandardArgvPolicy = {
  longNameMatch: 'unique-prefix',
  optionBoundary: 'continue',
  occurrenceRetention: 'all',
};

export const tailCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const normalizedArgs = normalizeLeadingLegacyCount({
      args: context.args,
    });
    const parsed = parseStandardArgv({
      args: stopArgvAtFirstEarlyExit({
        args: normalizedArgs,
        catalog: tailArgvCatalog,
        policy: tailArgvPolicy,
        earlyExitOptions: HELP_EARLY_EXIT_OPTIONS,
      }),
      catalog: tailArgvCatalog,
      policy: tailArgvPolicy,
    });

    const text = context.text();
    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      if (diagnostic.kind === 'unknown_short_option' && /^-\d$/.test(diagnostic.option)) {
        await text.error({ text: `tail: option used in invalid context -- ${diagnostic.option.slice(1)}\n` });
        return { exitCode: 1 };
      }
      await writeCommandUsageError({
        context,
        command: 'tail',
        message: `tail: ${diagnostic.message}`,
        usageSummary: formatArgvUsageSummary({ presentation: tailArgvHelp }),
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'tail',
        optionLines: formatArgvOptionHelp({ presentation: tailArgvHelp }),
      });
      return { exitCode: 0 };
    }

    const countSelection = selectLastLineOrByteCount({
      parsed,
      defaultLineCount: '10',
    });
    const { rawLineCount, rawByteCount } = (() => {
      switch (countSelection.kind) {
      case 'lines':
        return { rawLineCount: countSelection.value, rawByteCount: undefined };
      case 'bytes':
        return { rawLineCount: '10', rawByteCount: countSelection.value };
      default: {
        const _ex: never = countSelection;
        throw new Error(
          `Unhandled tail count selection: ${((_ex satisfies never) as { readonly kind: string }).kind}`,
        );
      }
      }
    })();
    const lineCount = parseInt(rawLineCount, 10);
    const countFromStart = rawLineCount.startsWith('+');
    const byteCount = rawByteCount === undefined ? undefined : parseInt(rawByteCount, 10);
    const byteCountFromStart = rawByteCount?.startsWith('+') === true;
    const headerMode = parsed.optionValues.headerMode === 'always'
      ? 'always'
      : parsed.optionValues.headerMode === 'never'
        ? 'never'
        : 'auto';
    const zeroTerminated = parsed.optionValues.zeroTerminated === true;
    const recordDelimiterByte = zeroTerminated ? 0 : 0x0a;
    const suppressesAllOutput = byteCount === undefined
      ? !countFromStart && Math.abs(lineCount) === 0
      : !byteCountFromStart && Math.abs(byteCount) === 0;
    let hadError = false;

    if (suppressesAllOutput) {
      return { exitCode: 0 };
    }

    const iterateRecords = ({
      chunks,
    }: {
      chunks: AsyncIterable<Uint8Array>,
    }): AsyncIterable<WeshByteRecord> => iterateByteRecordEntries({
      chunks,
      delimiterByte: recordDelimiterByte,
    });

    const processStream = async ({ stream }: { stream: ReadableStream<Uint8Array> }) => {
      const chunks = iterateReadableStreamChunks({ stream });
      if (byteCount !== undefined) {
        if (byteCountFromStart) {
          let bytesToSkip = Math.max(byteCount - 1, 0);
          for await (const chunk of chunks) {
            if (bytesToSkip >= chunk.byteLength) {
              bytesToSkip -= chunk.byteLength;
              continue;
            }

            const output = bytesToSkip === 0 ? chunk : chunk.subarray(bytesToSkip);
            bytesToSkip = 0;
            await writeOwnedBytes({
              handle: context.stdout,
              data: output,
            });
          }
          return;
        }

        const maxBytes = Math.max(Math.abs(byteCount), 0);
        const queue: TailByteQueue = {
          chunks: [],
          headIndex: 0,
          headOffset: 0,
          byteLength: 0,
        };
        for await (const chunk of chunks) {
          appendTailByteChunk({
            queue,
            chunk,
            maxBytes,
          });
        }
        await writeTailByteQueue({
          queue,
          handle: context.stdout,
        });
        return;
      }

      if (countFromStart) {
        await writeTailRecordsFromStart({
          chunks,
          recordsToSkip: Math.max(lineCount - 1, 0),
          delimiterByte: recordDelimiterByte,
          handle: context.stdout,
        });
        return;
      }

      const maxLines = Math.max(Math.abs(lineCount), 0);
      const queue: TailLineQueue = {
        records: [],
        headIndex: 0,
      };
      for await (const record of iterateRecords({ chunks })) {
        appendTailLine({
          queue,
          record: materializeByteRecord({
            record,
            delimiterByte: recordDelimiterByte,
          }),
          maxLines,
        });
      }
      for (let index = queue.headIndex; index < queue.records.length; index++) {
        await writeOwnedBytes({
          handle: context.stdout,
          data: queue.records[index]!,
        });
      }
    };

    if (parsed.positionals.length === 0) {
      switch (headerMode) {
      case 'always':
        await text.print({ text: '==> standard input <==\n' });
        break;
      case 'auto':
      case 'never':
        break;
      default: {
        const _ex: never = headerMode;
        throw new Error(`Unhandled tail header mode: ${_ex}`);
      }
      }
      await processStream({
        stream: openHandleReadStream({ handle: context.stdin }),
      });
    } else {
      const showHeader = headerMode === 'always'
        || (headerMode === 'auto' && parsed.positionals.length > 1);
      let printedHeaderCount = 0;
      for (const operand of parsed.positionals) {
        const path = operand === '-' ? undefined : resolvePath({ cwd: context.cwd, path: operand });
        let pendingStream: ReadableStream<Uint8Array> | undefined;
        try {
          if (path !== undefined) {
            const entry = await context.files.resolveEntry({ path, finalSymlinkTreatment: 'follow' });
            switch (entry.type) {
            case 'directory':
              break;
            case 'file':
            case 'fifo':
            case 'chardev':
            case 'symlink':
              pendingStream = await openFileReadStream({ files: context.files, path });
              break;
            default: {
              const _ex: never = entry;
              throw new Error(`Unhandled entry type: ${_ex}`);
            }
            }
          }
        } catch (error: unknown) {
          hadError = true;
          const reason = getPathErrorReason({ error })
            ?? (error instanceof Error ? error.message : String(error));
          await text.error({ text: `tail: cannot open ${quoteInputPath({ path: operand })} for reading: ${reason}\n` });
          continue;
        }

        try {
          if (showHeader) {
            if (printedHeaderCount > 0) {
              await text.print({ text: '\n' });
            }
            await text.print({ text: `==> ${operand === '-' ? 'standard input' : operand} <==\n` });
            printedHeaderCount += 1;
          }

          // GNU tail prints the header for an existing directory before its read fails.
          if (path !== undefined && pendingStream === undefined) {
            hadError = true;
            await text.error({ text: `tail: error reading ${quoteInputPath({ path: operand })}: Is a directory\n` });
            if (byteCount !== undefined || countFromStart) {
              break;
            }
            continue;
          }

          const stream = pendingStream ?? openHandleReadStream({ handle: context.stdin });
          pendingStream = undefined;
          await processStream({ stream });
        } catch (error: unknown) {
          await pendingStream?.cancel().catch(() => undefined);
          hadError = true;
          const reason = getPathErrorReason({ error })
            ?? (error instanceof Error ? error.message : String(error));
          await text.error({ text: `tail: ${operand}: ${reason}\n` });
        }
      }
    }

    return { exitCode: hadError ? 1 : 0 };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  writeTailRecordsFromStart,
};
