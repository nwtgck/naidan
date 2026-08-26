import { createWeshOwnedBytes } from '@/features/wesh/types';
import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/features/wesh/types';
import {
  parseStandardArgv,
  type ArgvOptionOccurrence,
  type StandardArgvParserSpec,
} from '@/features/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import { STANDARD_HELP_EARLY_EXIT_OPTIONS, stopStandardArgvAtFirstEarlyExit } from '@/features/wesh/commands/_shared/argv';
import {
  parseCoreutilsLineOrByteCount,
  selectLastLineOrByteCount,
} from '@/features/wesh/commands/_shared/line-byte-count-selection';
import { openHandleReadStream, openFileReadStream } from '@/features/wesh/utils/fs';
import { iterateReadableStreamChunks } from '@/features/wesh/utils/stream';
import {
  iterateByteRecordEntries,
  materializeByteRecord,
  type WeshByteRecord,
} from '@/features/wesh/utils/text-records';

function parseSignedCount({
  value,
  label,
}: {
  value: string,
  label: string,
}): { ok: true, value: string } | { ok: false, message: string } {
  return parseCoreutilsLineOrByteCount({
    value,
    errorPrefix: `invalid number of ${label}`,
  });
}

function normalizeLeadingPositiveLegacyCount({
  args,
}: {
  args: readonly string[],
}): string[] {
  const first = args[0];
  if (first === undefined || !/^\+\d+$/.test(first)) {
    return [...args];
  }

  const rest = args.slice(1);
  const explicitOperandBoundary = rest[0] === '--';
  const operands = explicitOperandBoundary ? rest.slice(1) : rest;
  const hasOption = !explicitOperandBoundary && rest.some(
    token => token !== '-' && token.startsWith('-'),
  );

  if (hasOption || operands.length > 1) {
    return [...args];
  }

  return ['-n', first, ...rest];
}

function findInvalidObsoleteTailCount({
  originalArgs,
  occurrences,
  positionalCount,
}: {
  originalArgs: readonly string[],
  occurrences: readonly ArgvOptionOccurrence[],
  positionalCount: number,
}): string | undefined {
  const obsoleteOccurrence = occurrences.find(
    occurrence => occurrence.kind === 'value' && /^-\d+$/.test(occurrence.option),
  );
  if (obsoleteOccurrence === undefined || obsoleteOccurrence.kind !== 'value') {
    return undefined;
  }

  if (
    originalArgs[0] !== obsoleteOccurrence.option
    || occurrences.length !== 1
    || positionalCount > 1
  ) {
    return obsoleteOccurrence.option.slice(1);
  }

  return undefined;
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

const tailArgvSpec: StandardArgvParserSpec = {
  options: [
    {
      kind: 'flag',
      short: 'q',
      long: 'quiet',
      effects: [{ key: 'headerMode', value: 'never' }],
      help: { summary: 'never print headers with file names', category: 'common' },
    },
    {
      kind: 'flag',
      short: undefined,
      long: 'silent',
      effects: [{ key: 'headerMode', value: 'never' }],
      help: { summary: 'same as --quiet', category: 'advanced' },
    },
    {
      kind: 'flag',
      short: 'v',
      long: 'verbose',
      effects: [{ key: 'headerMode', value: 'always' }],
      help: { summary: 'always print headers with file names', category: 'common' },
    },
    {
      kind: 'value',
      short: 'n',
      long: 'lines',
      key: 'lines',
      valueName: 'lines',
      allowAttachedValue: true,
      parseValue: ({ value }) => parseSignedCount({ value, label: 'lines' }),
      help: { summary: 'output the last NUM lines, or start at line NUM with +NUM', valueName: 'NUM', category: 'common' },
    },
    {
      kind: 'value',
      short: 'c',
      long: 'bytes',
      key: 'bytes',
      valueName: 'bytes',
      allowAttachedValue: true,
      parseValue: ({ value }) => parseSignedCount({ value, label: 'bytes' }),
      help: { summary: 'output the last NUM bytes, or start at byte NUM with +NUM', valueName: 'NUM', category: 'common' },
    },
    {
      kind: 'flag',
      short: 'z',
      long: 'zero-terminated',
      effects: [{ key: 'zeroTerminated', value: true }],
      help: { summary: 'line delimiter is NUL, not newline', category: 'advanced' },
    },
    {
      kind: 'flag',
      short: undefined,
      long: 'help',
      effects: [{ key: 'help', value: true }],
      help: { summary: 'display this help and exit', category: 'common' },
    },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [
    ({ token }) => {
      if (!/^-\d+$/.test(token)) return undefined;
      return {
        kind: 'matched',
        consumeCount: 1,
        effects: [{ key: 'lines', value: token.slice(1) }],
        occurrences: [{ kind: 'value', option: token, key: 'lines', value: token.slice(1) }],
      };
    },
  ],
};

export const tailCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'tail',
    description: 'Output the last part of files',
    usage: 'tail [OPTION]... [FILE]...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const normalizedArgs = normalizeLeadingPositiveLegacyCount({
      args: context.args,
    });
    const parsed = parseStandardArgv({
      args: stopStandardArgvAtFirstEarlyExit({ args: normalizedArgs, spec: tailArgvSpec, earlyExitOptions: STANDARD_HELP_EARLY_EXIT_OPTIONS }),
      spec: tailArgvSpec,
    });

    const text = context.text();
    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'tail',
        message: `tail: ${diagnostic.message}`,
        argvSpec: tailArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'tail',
        argvSpec: tailArgvSpec,
      });
      return { exitCode: 0 };
    }

    const invalidObsoleteCount = findInvalidObsoleteTailCount({
      originalArgs: context.args,
      occurrences: parsed.occurrences,
      positionalCount: parsed.positionals.length,
    });
    if (invalidObsoleteCount !== undefined) {
      await context.text().error({
        text: `tail: option used in invalid context -- ${invalidObsoleteCount}\n`,
      });
      return { exitCode: 1 };
    }

    const countSelection = selectLastLineOrByteCount({
      occurrences: parsed.occurrences,
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
        let currentLineNumber = 1;
        for await (const record of iterateRecords({ chunks })) {
          if (currentLineNumber >= lineCount) {
            await writeOwnedBytes({
              handle: context.stdout,
              data: materializeByteRecord({
                record,
                delimiterByte: recordDelimiterByte,
              }),
            });
          }
          currentLineNumber += 1;
        }
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
      let printedHeaderCount = 0;
      for (const f of parsed.positionals) {
        let stopAfterError = false;
        try {
          const showHeader = headerMode === 'always'
            || (headerMode === 'auto' && parsed.positionals.length > 1);
          const path = f === '-' ? undefined : resolvePath({ cwd: context.cwd, path: f });
          if (path !== undefined) {
            const stat = await context.files.stat({ path });
            stopAfterError = (byteCount !== undefined || countFromStart) && stat.type === 'directory';
          }
          if (showHeader) {
            if (printedHeaderCount > 0) {
              await text.print({ text: '\n' });
            }
            await text.print({ text: `==> ${f === '-' ? 'standard input' : f} <==\n` });
            printedHeaderCount += 1;
          }
          const stream = f === '-'
            ? openHandleReadStream({ handle: context.stdin })
            : await openFileReadStream({
              files: context.files,
              path: path!,
            });
          await processStream({ stream });
        } catch (e: unknown) {
          hadError = true;
          const message = e instanceof Error ? e.message : String(e);
          await text.error({ text: `tail: ${f}: ${message}\n` });
          if (stopAfterError) {
            break;
          }
        }
      }
    }

    return { exitCode: hadError ? 1 : 0 };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
