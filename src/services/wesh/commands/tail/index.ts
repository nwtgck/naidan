import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import { handleToStream } from '@/services/wesh/utils/fs';

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
  data: Uint8Array;
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

    const processStream = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      let totalLength = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        totalLength += value.length;
      }
      const contentBytes = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        contentBytes.set(chunk, offset);
        offset += chunk.length;
      }

      if (byteCount !== undefined) {
        const selectedBytes = byteCountFromStart
          ? contentBytes.subarray(Math.max(byteCount - 1, 0))
          : contentBytes.subarray(Math.max(contentBytes.length - Math.abs(byteCount), 0));
        await writeBytes({
          handle: context.stdout,
          data: selectedBytes,
        });
        return;
      }

      const content = new TextDecoder().decode(contentBytes);
      const lines = content.split('\n');
      if (lines[lines.length - 1] === '') lines.pop();

      const selectedLines = countFromStart
        ? lines.slice(Math.max(lineCount - 1, 0))
        : lines.slice(-Math.abs(lineCount));

      for (const line of selectedLines) {
        await text.print({ text: line + '\n' });
      }
    };

    if (parsed.positionals.length === 0) {
      const input = new ReadableStream({
        async pull(controller) {
          const buf = new Uint8Array(4096);
          const { bytesRead } = await context.stdin.read({ buffer: buf });
          if (bytesRead === 0) {
            controller.close();
            return;
          }
          controller.enqueue(buf.subarray(0, bytesRead));
        }
      });
      await processStream(input);
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
            const input = new ReadableStream({
              async pull(controller) {
                const buf = new Uint8Array(4096);
                const { bytesRead } = await context.stdin.read({ buffer: buf });
                if (bytesRead === 0) {
                  controller.close();
                  return;
                }
                controller.enqueue(buf.subarray(0, bytesRead));
              }
            });
            await processStream(input);
            continue;
          }

          const fullPath = f.startsWith('/') ? f : (context.cwd === '/' ? `/${f}` : `${context.cwd}/${f}`);
          const handle = await context.files.open({
            path: fullPath,
            flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' }
          });
          await processStream(handleToStream({ handle }));
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
