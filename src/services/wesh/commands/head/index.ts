import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import { handleToStream } from '@/services/wesh/utils/fs';

function parseCount({
  value,
  errorPrefix,
}: {
  value: string;
  errorPrefix: string;
}): { ok: true; value: number } | { ok: false; message: string } {
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
      const reader = stream.getReader();
      let shouldCancel = false;

      try {
        if (bytes !== undefined) {
          let bytesReadCount = 0;
          while (bytesReadCount < bytes) {
            const { done, value } = await reader.read();
            if (done) break;

            const toRead = Math.min(value.length, bytes - bytesReadCount);
            await textOutput.print({ text: new TextDecoder().decode(value.subarray(0, toRead)) });
            bytesReadCount += toRead;
            if (bytesReadCount >= bytes) {
              shouldCancel = true;
              break;
            }
          }
        } else {
          const decoder = new TextDecoder();
          let linesProcessed = 0;
          let buffer = '';

          while (linesProcessed < lines) {
            const { done, value } = await reader.read();
            if (done) {
              if (buffer) await textOutput.print({ text: buffer });
              break;
            }

            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split('\n');
            // If the last part isn't complete, keep it in buffer
            buffer = parts.pop() || '';

            for (const line of parts) {
              await textOutput.print({ text: line + '\n' });
              linesProcessed++;
              if (linesProcessed >= lines) {
                shouldCancel = true;
                break;
              }
            }
          }
        }

        if (shouldCancel) {
          await reader.cancel();
          return;
        }
      } finally {
        reader.releaseLock();
      }
    };

    if (positional.length === 0) {
      await processStream({
        stream: handleToStream({ handle: context.stdin }),
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
            ? handleToStream({ handle: context.stdin })
            : handleToStream({
              handle: await context.files.open({
                path: f.startsWith('/') ? f : (context.cwd === '/' ? `/${f}` : `${context.cwd}/${f}`),
                flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' }
              })
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
