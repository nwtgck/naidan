import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseStandardArgv } from '@/services/wesh/argv';
import { writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import { handleToStream } from '@/services/wesh/utils/fs';

function parseLineCount({
  value,
}: {
  value: string;
}): { ok: true; value: string } | { ok: false; message: string } {
  if (!/^[+-]?\d+$/.test(value)) {
    return { ok: false, message: `invalid number of lines: '${value}'` };
  }
  return { ok: true, value };
}

export const tailCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'tail',
    description: 'Output the last part of files',
    usage: 'tail [file...] [-n lines]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: {
        options: [
          {
            kind: 'value',
            short: 'n',
            long: 'lines',
            key: 'lines',
            valueName: 'lines',
            allowAttachedValue: true,
            parseValue: ({ value }) => parseLineCount({ value }),
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
      },
    });

    const text = context.text();
    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'tail',
        message: `tail: ${diagnostic.message}`,
      });
      return { exitCode: 1 };
    }

    const rawLineCount = typeof parsed.optionValues.lines === 'string' ? parsed.optionValues.lines : '10';
    const lineCount = parseInt(rawLineCount, 10);
    const countFromStart = rawLineCount.startsWith('+');

    const processStream = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      let content = '';
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        content += decoder.decode(value, { stream: true });
      }
      content += decoder.decode();

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
      for (const f of parsed.positionals) {
        if (f === undefined) continue;
        try {
          const fullPath = f.startsWith('/') ? f : `${context.cwd}/${f}`;
          const handle = await context.kernel.open({
            path: fullPath,
            flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' }
          });
          await processStream(handleToStream({ handle }));
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          await text.error({ text: `tail: ${f}: ${message}\n` });
        }
      }
    }

    return { exitCode: 0 };
  },
};
