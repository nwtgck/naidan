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
import { openHandleReadStream, openFileReadStream, writeAllBytesToHandle } from '@/features/wesh/utils/fs';
import { iterateReadableStreamChunks } from '@/features/wesh/utils/stream';
import {
  iterateByteRecordEntries,
  materializeByteRecord,
  type WeshByteRecord,
} from '@/features/wesh/utils/text-records';

function resolvePath({ cwd, path }: { cwd: string, path: string }): string {
  if (path.startsWith('/')) {
    return path;
  }
  return cwd === '/' ? `/${path}` : `${cwd}/${path}`;
}

type HeadCount =
  | { kind: 'first', count: number }
  | { kind: 'omit-last', count: number };

function validateCount({
  value,
  errorPrefix,
}: {
  value: string,
  errorPrefix: string,
}): { ok: true, value: string } | { ok: false, message: string } {
  return parseCoreutilsLineOrByteCount({ value, errorPrefix });
}

function parseHeadCount({ value }: { value: string }): HeadCount {
  if (value.startsWith('-')) {
    return {
      kind: 'omit-last',
      count: parseInt(value.slice(1), 10),
    };
  }

  return {
    kind: 'first',
    count: parseInt(value.startsWith('+') ? value.slice(1) : value, 10),
  };
}

function findInvalidObsoleteHeadCount({
  args,
  occurrences,
}: {
  args: readonly string[],
  occurrences: readonly ArgvOptionOccurrence[],
}): string | undefined {
  let foundObsoleteCount = false;

  for (const [index, occurrence] of occurrences.entries()) {
    if (occurrence.kind !== 'value' || !/^-\d+$/.test(occurrence.option)) {
      continue;
    }

    if (
      foundObsoleteCount
      || index !== 0
      || args[0] !== occurrence.option
    ) {
      return occurrence.option.slice(1);
    }
    foundObsoleteCount = true;
  }

  return undefined;
}

const headArgvSpec: StandardArgvParserSpec = {
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
      parseValue: ({ value }) => validateCount({
        value,
        errorPrefix: 'invalid number of lines',
      }),
      help: { summary: 'print the first NUM lines', valueName: 'NUM', category: 'common' },
    },
    {
      kind: 'value',
      short: 'c',
      long: 'bytes',
      key: 'bytes',
      valueName: 'bytes',
      allowAttachedValue: true,
      parseValue: ({ value }) => validateCount({
        value,
        errorPrefix: 'invalid number of bytes',
      }),
      help: { summary: 'print the first NUM bytes', valueName: 'NUM', category: 'advanced' },
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
      const value = token.slice(1);
      return {
        kind: 'matched',
        consumeCount: 1,
        effects: [{ key: 'lines', value }],
        occurrences: [{ kind: 'value', option: token, key: 'lines', value }],
      };
    },
  ],
};

export const headCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'head',
    description: 'Output the first part of files',
    usage: 'head [OPTION]... [FILE]...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const textOutput = context.text();
    const parsed = parseStandardArgv({
      args: stopStandardArgvAtFirstEarlyExit({ args: context.args, spec: headArgvSpec, earlyExitOptions: STANDARD_HELP_EARLY_EXIT_OPTIONS }),
      spec: headArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'head',
        message: `head: ${diagnostic.message}`,
        argvSpec: headArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'head',
        argvSpec: headArgvSpec,
      });
      return { exitCode: 0 };
    }

    const invalidObsoleteCount = findInvalidObsoleteHeadCount({
      args: context.args,
      occurrences: parsed.occurrences,
    });
    if (invalidObsoleteCount !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'head',
        message: `head: invalid trailing option -- ${invalidObsoleteCount}`,
        argvSpec: headArgvSpec,
      });
      return { exitCode: 1 };
    }

    const countSelection = selectLastLineOrByteCount({
      occurrences: parsed.occurrences,
      defaultLineCount: '10',
    });
    const { lines, bytes } = (() => {
      switch (countSelection.kind) {
      case 'lines':
        return {
          lines: parseHeadCount({ value: countSelection.value }),
          bytes: undefined,
        };
      case 'bytes':
        return {
          lines: parseHeadCount({ value: '10' }),
          bytes: parseHeadCount({ value: countSelection.value }),
        };
      default: {
        const _ex: never = countSelection;
        throw new Error(
          `Unhandled head count selection: ${((_ex satisfies never) as { readonly kind: string }).kind}`,
        );
      }
      }
    })();
    const positional = parsed.positionals;
    const headerMode = parsed.optionValues.headerMode === 'always'
      ? 'always'
      : parsed.optionValues.headerMode === 'never'
        ? 'never'
        : 'auto';
    const zeroTerminated = parsed.optionValues.zeroTerminated === true;
    const recordDelimiterByte = zeroTerminated ? 0 : 0x0a;
    const suppressesInputRead = bytes === undefined
      ? lines.kind === 'first' && lines.count === 0
      : bytes.kind === 'first' && bytes.count === 0;
    let hadError = false;

    const iterateRecords = ({
      stream,
    }: {
      stream: ReadableStream<Uint8Array>,
    }): AsyncIterable<WeshByteRecord> => iterateByteRecordEntries({
      chunks: iterateReadableStreamChunks({ stream }),
      delimiterByte: recordDelimiterByte,
    });

    const processHandleBytePrefix = async ({ count }: { count: number }) => {
      let remaining = count;
      while (remaining > 0) {
        const buffer = new Uint8Array(Math.min(remaining, 64 * 1024));
        const { bytesRead } = await context.stdin.read({ buffer });
        if (bytesRead === 0) {
          break;
        }
        await writeAllBytesToHandle({
          handle: context.stdout,
          data: bytesRead === buffer.byteLength ? buffer : buffer.subarray(0, bytesRead),
        });
        remaining -= bytesRead;
      }
    };

    const processStream = async ({ stream }: { stream: ReadableStream<Uint8Array> }) => {
      if (bytes !== undefined) {
        const reader = stream.getReader();
        try {
          switch (bytes.kind) {
          case 'first': {
            let bytesReadCount = 0;
            let shouldCancel = false;
            while (bytesReadCount < bytes.count) {
              const { done, value } = await reader.read();
              if (done) {
                break;
              }
              const length = Math.min(value.byteLength, bytes.count - bytesReadCount);
              await writeAllBytesToHandle({
                handle: context.stdout,
                data: value.subarray(0, length),
              });
              bytesReadCount += length;
              if (length < value.byteLength || bytesReadCount >= bytes.count) {
                shouldCancel = true;
                break;
              }
            }
            if (shouldCancel) {
              await reader.cancel();
            }
            break;
          }
          case 'omit-last': {
            let retainedTail = new Uint8Array(0);
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                break;
              }

              const combined = new Uint8Array(retainedTail.byteLength + value.byteLength);
              combined.set(retainedTail);
              combined.set(value, retainedTail.byteLength);
              const outputLength = Math.max(0, combined.byteLength - bytes.count);
              if (outputLength > 0) {
                await writeAllBytesToHandle({
                  handle: context.stdout,
                  data: combined.subarray(0, outputLength),
                });
              }
              retainedTail = combined.slice(outputLength);
            }
            break;
          }
          default: {
            const _ex: never = bytes;
            throw new Error(`Unhandled head byte count: ${String(_ex)}`);
          }
          }
        } finally {
          reader.releaseLock();
        }
        return;
      }

      switch (lines.kind) {
      case 'first':
        if (lines.count <= 0) {
          await stream.cancel();
          return;
        }
        break;
      case 'omit-last':
        break;
      default: {
        const _ex: never = lines;
        throw new Error(`Unhandled head line count: ${String(_ex)}`);
      }
      }
      let linesProcessed = 0;
      const retainedTail: Uint8Array[] = [];
      let retainedTailHeadIndex = 0;
      for await (const record of iterateRecords({ stream })) {
        const outputRecord = materializeByteRecord({
          record,
          delimiterByte: recordDelimiterByte,
        });

        switch (lines.kind) {
        case 'omit-last': {
          retainedTail.push(outputRecord);
          if (retainedTail.length - retainedTailHeadIndex > lines.count) {
            await writeAllBytesToHandle({
              handle: context.stdout,
              data: retainedTail[retainedTailHeadIndex]!,
            });
            retainedTailHeadIndex += 1;
          }
          if (
            retainedTailHeadIndex >= 1024
            && retainedTailHeadIndex * 2 >= retainedTail.length
          ) {
            retainedTail.splice(0, retainedTailHeadIndex);
            retainedTailHeadIndex = 0;
          }
          break;
        }
        case 'first':
          await writeAllBytesToHandle({
            handle: context.stdout,
            data: outputRecord,
          });
          linesProcessed += 1;
          if (linesProcessed >= lines.count) {
            return;
          }
          break;
        default: {
          const _ex: never = lines;
          throw new Error(`Unhandled head line count: ${String(_ex)}`);
        }
        }
      }
    };

    if (positional.length === 0) {
      switch (headerMode) {
      case 'always':
        await textOutput.print({ text: '==> standard input <==\n' });
        break;
      case 'auto':
      case 'never':
        break;
      default: {
        const _ex: never = headerMode;
        throw new Error(`Unhandled head header mode: ${_ex}`);
      }
      }
      if (!suppressesInputRead) {
        switch (bytes?.kind) {
        case 'first':
          await processHandleBytePrefix({ count: bytes.count });
          break;
        case 'omit-last':
        case undefined:
          await processStream({
            stream: openHandleReadStream({ handle: context.stdin }),
          });
          break;
        default: {
          const _ex: never = bytes;
          throw new Error(`Unhandled head byte count: ${String(_ex)}`);
        }
        }
      }
    } else {
      let printedHeaderCount = 0;
      for (const f of positional) {
        try {
          const showHeader = headerMode === 'always' || (headerMode === 'auto' && positional.length > 1);
          const path = f === '-' ? undefined : resolvePath({ cwd: context.cwd, path: f });
          if (path !== undefined) {
            await context.files.stat({ path });
          }
          if (showHeader) {
            if (printedHeaderCount > 0) {
              await textOutput.print({ text: '\n' });
            }
            await textOutput.print({ text: `==> ${f === '-' ? 'standard input' : f} <==\n` });
            printedHeaderCount += 1;
          }
          if (suppressesInputRead) {
            continue;
          }
          if (f === '-' && bytes?.kind === 'first') {
            await processHandleBytePrefix({ count: bytes.count });
            continue;
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
          await textOutput.error({ text: `head: ${f}: ${message}\n` });
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
