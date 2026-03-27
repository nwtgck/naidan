import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import { handleToStream, openFileAsStream } from '@/services/wesh/utils/fs';

function parseSignedCount({
  value,
  label,
}: {
  value: string;
  label: string;
}): { ok: true; value: string } | { ok: false; message: string } {
  if (!/^[+-]?\d+$/.test(value)) {
    return { ok: false, message: `invalid number of ${label}: '${value}'` };
  }
  return { ok: true, value };
}

async function writeBytes({
  handle,
  data,
}: {
  handle: WeshCommandContext['stdout'];
  data: Uint8Array<ArrayBufferLike>;
}): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await handle.write({
      buffer: data,
      offset,
      length: data.length - offset,
    });
    if (bytesWritten === 0) {
      break;
    }
    offset += bytesWritten;
  }
}

function resolvePath({ cwd, path }: { cwd: string; path: string }): string {
  if (path.startsWith('/')) {
    return path;
  }
  return cwd === '/' ? `/${path}` : `${cwd}/${path}`;
}

function appendTailBytes({
  tailBytes,
  chunk,
  maxBytes,
}: {
  tailBytes: Uint8Array<ArrayBufferLike>;
  chunk: Uint8Array<ArrayBufferLike>;
  maxBytes: number;
}): Uint8Array<ArrayBufferLike> {
  if (maxBytes === 0) {
    return new Uint8Array(0);
  }

  if (chunk.length >= maxBytes) {
    return Uint8Array.from(chunk.subarray(chunk.length - maxBytes));
  }

  const keepFromExisting = Math.max(maxBytes - chunk.length, 0);
  const existingStart = Math.max(tailBytes.length - keepFromExisting, 0);
  const retainedExisting = tailBytes.subarray(existingStart);
  const next = new Uint8Array(retainedExisting.length + chunk.length);
  next.set(retainedExisting);
  next.set(chunk, retainedExisting.length);
  return next;
}

function pushTailLine({
  lines,
  line,
  maxLines,
}: {
  lines: string[];
  line: string;
  maxLines: number;
}): void {
  if (maxLines === 0) {
    return;
  }
  lines.push(line);
  if (lines.length > maxLines) {
    lines.shift();
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
      if (!/^[+-]\d+$/.test(token)) return undefined;
      return {
        kind: 'matched',
        consumeCount: 1,
        effects: [{ key: 'lines', value: token }],
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
    const parsed = parseStandardArgv({
      args: context.args,
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

    const rawLineCount = typeof parsed.optionValues.lines === 'string' ? parsed.optionValues.lines : '10';
    const rawByteCount = typeof parsed.optionValues.bytes === 'string' ? parsed.optionValues.bytes : undefined;
    const lineCount = parseInt(rawLineCount, 10);
    const countFromStart = rawLineCount.startsWith('+');
    const byteCount = rawByteCount === undefined ? undefined : parseInt(rawByteCount, 10);
    const byteCountFromStart = rawByteCount?.startsWith('+') === true;
    const headerMode = parsed.optionValues.headerMode === 'always'
      ? 'always'
      : parsed.optionValues.headerMode === 'never'
        ? 'never'
        : 'auto';
    let hadError = false;

    const processStream = async ({ stream }: { stream: ReadableStream<Uint8Array> }) => {
      const reader = stream.getReader();
      try {
        if (byteCount !== undefined) {
          if (byteCountFromStart) {
            let bytesToSkip = Math.max(byteCount - 1, 0);
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                break;
              }

              if (bytesToSkip >= value.length) {
                bytesToSkip -= value.length;
                continue;
              }

              const output = bytesToSkip === 0 ? value : value.subarray(bytesToSkip);
              bytesToSkip = 0;
              await writeBytes({
                handle: context.stdout,
                data: output,
              });
            }
            return;
          }

          const maxBytes = Math.max(Math.abs(byteCount), 0);
          let tailBytes: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            tailBytes = appendTailBytes({
              tailBytes,
              chunk: value,
              maxBytes,
            });
          }

          await writeBytes({
            handle: context.stdout,
            data: tailBytes,
          });
          return;
        }

        const decoder = new TextDecoder();
        let buffer = '';

        if (countFromStart) {
          let currentLineNumber = 1;
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }

            buffer += decoder.decode(value, { stream: true });
            while (true) {
              const newlineIndex = buffer.indexOf('\n');
              if (newlineIndex === -1) {
                break;
              }
              const line = buffer.slice(0, newlineIndex + 1);
              buffer = buffer.slice(newlineIndex + 1);
              if (currentLineNumber >= lineCount) {
                await text.print({ text: line });
              }
              currentLineNumber += 1;
            }
          }

          buffer += decoder.decode();
          if (buffer.length > 0 && currentLineNumber >= lineCount) {
            await text.print({ text: buffer });
          }
          return;
        }

        const maxLines = Math.max(Math.abs(lineCount), 0);
        const tailLines: string[] = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          while (true) {
            const newlineIndex = buffer.indexOf('\n');
            if (newlineIndex === -1) {
              break;
            }
            const line = buffer.slice(0, newlineIndex + 1);
            buffer = buffer.slice(newlineIndex + 1);
            pushTailLine({
              lines: tailLines,
              line,
              maxLines,
            });
          }
        }

        buffer += decoder.decode();
        if (buffer.length > 0) {
          pushTailLine({
            lines: tailLines,
            line: buffer,
            maxLines,
          });
        }

        for (const line of tailLines) {
          await text.print({ text: line });
        }
      } finally {
        reader.releaseLock();
      }
    };

    if (parsed.positionals.length === 0) {
      await processStream({
        stream: handleToStream({ handle: context.stdin }),
      });
    } else {
      for (const [index, f] of parsed.positionals.entries()) {
        try {
          const showHeader = headerMode === 'always' || (headerMode === 'auto' && parsed.positionals.length > 1);
          if (showHeader) {
            if (index > 0) {
              await text.print({ text: '\n' });
            }
            await text.print({ text: `==> ${f === '-' ? 'standard input' : f} <==\n` });
          }

          if (f === '-') {
            await processStream({
              stream: handleToStream({ handle: context.stdin }),
            });
            continue;
          }

          await processStream({
            stream: await openFileAsStream({
              files: context.files,
              path: resolvePath({ cwd: context.cwd, path: f }),
            }),
          });
        } catch (e: unknown) {
          hadError = true;
          const message = e instanceof Error ? e.message : String(e);
          await text.error({ text: `tail: ${f}: ${message}\n` });
        }
      }
    }

    return { exitCode: hadError ? 1 : 0 };
  },
};
