import { createWeshOwnedBytes } from '@/services/wesh/types';
import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import { openHandleReadStream, openFileReadStream } from '@/services/wesh/utils/fs';
import { createBufferedTextWriter } from '@/services/wesh/utils/io';
import { iterateReadableStreamChunks } from '@/services/wesh/utils/stream';
import { getWeshTextRecordTerminator, iterateUtf8LineRecords } from '@/services/wesh/utils/text-records';

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

async function writeOwnedBytes({
  handle,
  data,
}: {
  handle: WeshCommandContext['stdout'];
  data: Uint8Array<ArrayBufferLike>;
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

function resolvePath({ cwd, path }: { cwd: string; path: string }): string {
  if (path.startsWith('/')) {
    return path;
  }
  return cwd === '/' ? `/${path}` : `${cwd}/${path}`;
}

interface TailByteQueue {
  chunks: Uint8Array<ArrayBufferLike>[];
  headIndex: number;
  headOffset: number;
  byteLength: number;
}

function appendTailByteChunk({
  queue,
  chunk,
  maxBytes,
}: {
  queue: TailByteQueue;
  chunk: Uint8Array<ArrayBufferLike>;
  maxBytes: number;
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
  queue: TailByteQueue;
  handle: WeshCommandContext['stdout'];
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
  lines: string[];
  headIndex: number;
}

function appendTailLine({
  queue,
  line,
  maxLines,
}: {
  queue: TailLineQueue;
  line: string;
  maxLines: number;
}): void {
  if (maxLines === 0) {
    return;
  }

  queue.lines.push(line);
  if (queue.lines.length - queue.headIndex > maxLines) {
    queue.headIndex += 1;
  }
  if (queue.headIndex >= 1024 && queue.headIndex * 2 >= queue.lines.length) {
    queue.lines = queue.lines.slice(queue.headIndex);
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

      const writer = createBufferedTextWriter({
        handle: context.stdout,
        maxBufferLength: 16 * 1024,
      });
      if (countFromStart) {
        let currentLineNumber = 1;
        for await (const record of iterateUtf8LineRecords({ chunks })) {
          if (currentLineNumber >= lineCount) {
            await writer.write({
              text: record.text + getWeshTextRecordTerminator({
                termination: record.termination,
              }),
            });
          }
          currentLineNumber += 1;
        }
        await writer.flush();
        return;
      }

      const maxLines = Math.max(Math.abs(lineCount), 0);
      const queue: TailLineQueue = {
        lines: [],
        headIndex: 0,
      };
      for await (const record of iterateUtf8LineRecords({ chunks })) {
        appendTailLine({
          queue,
          line: record.text + getWeshTextRecordTerminator({
            termination: record.termination,
          }),
          maxLines,
        });
      }
      for (let index = queue.headIndex; index < queue.lines.length; index++) {
        await writer.write({ text: queue.lines[index]! });
      }
      await writer.flush();
    };

    if (parsed.positionals.length === 0) {
      await processStream({
        stream: openHandleReadStream({ handle: context.stdin }),
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
              stream: openHandleReadStream({ handle: context.stdin }),
            });
            continue;
          }

          await processStream({
            stream: await openFileReadStream({
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
