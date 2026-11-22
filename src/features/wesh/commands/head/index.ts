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
} from '@/features/wesh/argv-v2';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage-output';
import {
  lineOrByteCountArgvAction,
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

function normalizeObsoleteHeadCount({ args }: { args: string[] }): { ok: true, args: string[] } | { ok: false, message: string } {
  const first = args[0];
  const digits = /^-(\d+)/.exec(first ?? '')?.[1];
  if (first === undefined || digits === undefined) {
    return { ok: true, args };
  }

  let countOption = '-n';
  let countSuffix = '';
  const flags: string[] = [];
  for (const modifier of first.slice(1 + digits.length)) {
    switch (modifier) {
    case 'b':
    case 'k':
    case 'm':
      countOption = '-c';
      countSuffix = modifier;
      break;
    case 'c':
      countOption = '-c';
      countSuffix = '';
      break;
    case 'l':
      // Switching back to lines preserves the multiplier already selected.
      countOption = '-n';
      break;
    case 'q':
    case 'v':
    case 'z':
      flags.push(`-${modifier}`);
      break;
    default:
      return { ok: false, message: `invalid trailing option -- ${modifier}` };
    }
  }

  return { ok: true, args: [`${countOption}${digits}${countSuffix}`, ...flags, ...args.slice(1)] };
}

const headOptions = [
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
    summary: 'print the first NUM lines',
    valueName: 'NUM',
    category: 'common',
  },
  {
    semantic: lineOrByteCountArgvAction({ unit: 'bytes' }),
    forms: [
      { kind: 'short', name: 'c', value: { kind: 'required-attached-or-following', missingValueName: 'bytes' } },
      { kind: 'long', name: 'bytes', value: { kind: 'required', missingValueName: 'bytes' } },
    ],
    summary: 'print the first NUM bytes',
    valueName: 'NUM',
    category: 'advanced',
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

const headArgvCatalog = defineArgvCatalog<StandardArgvAction<never>>({
  definitions: headOptions,
  nonExecutableLongOptions: ['-presume-input-pipe', 'version'],
});
const headArgvHelp = defineArgvHelpPresentation({ catalog: headArgvCatalog, rows: headOptions });
const headArgvPolicy: StandardArgvPolicy = {
  longNameMatch: 'unique-prefix',
  optionBoundary: 'continue',
  occurrenceRetention: 'all',
};

export const headCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const textOutput = context.text();
    const normalized = normalizeObsoleteHeadCount({ args: context.args });
    if (!normalized.ok) {
      await writeCommandUsageError({
        context,
        command: 'head',
        message: `head: ${normalized.message}`,
        usageSummary: formatArgvUsageSummary({ presentation: headArgvHelp }),
      });
      return { exitCode: 1 };
    }

    const parsed = parseStandardArgv({
      args: stopArgvAtFirstEarlyExit({
        args: normalized.args,
        catalog: headArgvCatalog,
        policy: headArgvPolicy,
        earlyExitOptions: HELP_EARLY_EXIT_OPTIONS,
      }),
      catalog: headArgvCatalog,
      policy: headArgvPolicy,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      const message = diagnostic.kind === 'unknown_short_option' && /^-\d$/.test(diagnostic.option)
        ? `invalid trailing option -- ${diagnostic.option.slice(1)}`
        : diagnostic.message;
      await writeCommandUsageError({
        context,
        command: 'head',
        message: `head: ${message}`,
        usageSummary: formatArgvUsageSummary({ presentation: headArgvHelp }),
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'head',
        optionLines: formatArgvOptionHelp({ presentation: headArgvHelp }),
      });
      return { exitCode: 0 };
    }

    const countSelection = selectLastLineOrByteCount({
      parsed,
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
