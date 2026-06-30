import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/features/wesh/types';
import { parseStandardArgv, type StandardArgvParserSpec } from '@/features/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import { openHandleReadStream, openFileReadStream, writeAllBytesToHandle } from '@/features/wesh/utils/fs';
import { createBufferedTextWriter } from '@/features/wesh/utils/io';
import { iterateReadableStreamChunks } from '@/features/wesh/utils/stream';
import { getWeshTextRecordTerminator, iterateUtf8LineRecords } from '@/features/wesh/utils/text-records';

function resolvePath({ cwd, path }: { cwd: string, path: string }): string {
  if (path.startsWith('/')) {
    return path;
  }
  return cwd === '/' ? `/${path}` : `${cwd}/${path}`;
}

function parseCount({
  value,
  errorPrefix,
}: {
  value: string,
  errorPrefix: string,
}): { ok: true, value: number } | { ok: false, message: string } {
  if (!/^\d+$/.test(value)) {
    return { ok: false, message: `${errorPrefix}: '${value}'` };
  }
  const parsed = parseInt(value, 10);
  return { ok: true, value: parsed };
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
      parseValue: ({ value }) => parseCount({
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
      parseValue: ({ value }) => parseCount({
        value,
        errorPrefix: 'invalid number of bytes',
      }),
      help: { summary: 'print the first NUM bytes', valueName: 'NUM', category: 'advanced' },
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
        effects: [{ key: 'lines', value: parseInt(token.slice(1), 10) }],
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
      args: context.args,
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

    const lines = typeof parsed.optionValues.lines === 'number' ? parsed.optionValues.lines : 10;
    const bytes = typeof parsed.optionValues.bytes === 'number' ? parsed.optionValues.bytes : undefined;
    const positional = parsed.positionals;
    const headerMode = parsed.optionValues.headerMode === 'always'
      ? 'always'
      : parsed.optionValues.headerMode === 'never'
        ? 'never'
        : 'auto';
    let hadError = false;

    const processStream = async ({ stream }: { stream: ReadableStream<Uint8Array> }) => {
      if (bytes !== undefined) {
        const reader = stream.getReader();
        let bytesReadCount = 0;
        let shouldCancel = false;
        try {
          while (bytesReadCount < bytes) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            const length = Math.min(value.byteLength, bytes - bytesReadCount);
            await writeAllBytesToHandle({
              handle: context.stdout,
              data: value.subarray(0, length),
            });
            bytesReadCount += length;
            if (length < value.byteLength || bytesReadCount >= bytes) {
              shouldCancel = true;
              break;
            }
          }
          if (shouldCancel) {
            await reader.cancel();
          }
        } finally {
          reader.releaseLock();
        }
        return;
      }

      if (lines <= 0) {
        await stream.cancel();
        return;
      }
      const writer = createBufferedTextWriter({
        handle: context.stdout,
        maxBufferLength: 16 * 1024,
      });
      let linesProcessed = 0;
      for await (const record of iterateUtf8LineRecords({
        chunks: iterateReadableStreamChunks({ stream }),
      })) {
        await writer.write({
          text: record.text + getWeshTextRecordTerminator({
            termination: record.termination,
          }),
        });
        linesProcessed += 1;
        if (linesProcessed >= lines) {
          break;
        }
      }
      await writer.flush();
    };

    if (positional.length === 0) {
      await processStream({
        stream: openHandleReadStream({ handle: context.stdin }),
      });
    } else {
      for (const [index, f] of positional.entries()) {
        try {
          const showHeader = headerMode === 'always' || (headerMode === 'auto' && positional.length > 1);
          if (showHeader) {
            if (index > 0) {
              await textOutput.print({ text: '\n' });
            }
            await textOutput.print({ text: `==> ${f === '-' ? 'standard input' : f} <==\n` });
          }

          const stream = f === '-'
            ? openHandleReadStream({ handle: context.stdin })
            : await openFileReadStream({
              files: context.files,
              path: resolvePath({ cwd: context.cwd, path: f }),
            });
          await processStream({
            stream,
          });
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
export const TEST_ONLY = {};
