import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseFlags } from '@/services/wesh/utils/args';
import { handleToStream } from '@/services/wesh/utils/fs';

export const uniqCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'uniq',
    description: 'Report or omit repeated lines',
    usage: 'uniq [file] [-c] [-d] [-u]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const { flags, positional } = parseFlags({
      args: context.args,
      booleanFlags: ['c', 'd', 'u'],
      stringFlags: [],
    });

    const text = context.text();

    const process = async ({ input }: { input: AsyncIterable<string> }) => {
      let lastLine: string | null = null;
      let count = 0;

      for await (const line of input) {
        if (lastLine === null) {
          lastLine = line;
          count = 1;
        } else if (line === lastLine) {
          count++;
        } else {
          await writeLine(lastLine, count);
          lastLine = line;
          count = 1;
        }
      }
      if (lastLine !== null) {
        await writeLine(lastLine, count);
      }
    };

    const writeLine = async (line: string, cnt: number) => {
      const showLine = (!flags.d || cnt > 1) && (!flags.u || cnt === 1);
      if (showLine) {
        let out = '';
        if (flags.c) out += cnt.toString().padStart(7) + ' ';
        out += line + '\n';
        await text.print({ text: out });
      }
    };

    if (positional.length === 0) {
      await process({ input: text.input });
    } else {
      const f = positional[0]!;
      try {
        const fullPath = f.startsWith('/') ? f : `${context.cwd}/${f}`;
        const handle = await context.kernel.open({
          path: fullPath,
          flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' }
        });
        const stream = handleToStream({ handle });
        const decoder = new TextDecoder();

        const lineReader: AsyncIterable<string> = {
          async *[Symbol.asyncIterator]() {
            const reader = stream.getReader();
            let buffer = '';
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split(/\r?\n/);
                buffer = lines.pop() || '';
                for (const l of lines) yield l;
              }
              if (buffer) yield buffer;
            } finally {
              reader.releaseLock();
            }
          }
        };
        await process({ input: lineReader });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        await text.error({ text: `uniq: ${f}: ${message}\n` });
      }
    }

    return { exitCode: 0 };
  },
};
