import type { CommandDefinition, CommandResult, CommandContext } from '@/services/wesh/types';
import { parseFlags } from '@/services/wesh/utils/args';

export const uniq: CommandDefinition = {
  meta: {
    name: 'uniq',
    description: 'Report or omit repeated lines',
    usage: 'uniq [-c] [-d] [-u] [-i] [input]',
  },
  fn: async ({ context }: { context: CommandContext }): Promise<CommandResult> => {
    const { flags, positional } = parseFlags({
      args: context.args,
      booleanFlags: ['c', 'd', 'u', 'i'],
      stringFlags: [],
    });

    const text = context.text();
    let lastLine: string | null = null;
    let count = 0;

    const process = async ({ input }: { input: AsyncIterable<string> }) => {
      for await (const line of input) {
        if (lastLine === null) {
          lastLine = line;
          count = 1;
        } else {
          const equal = flags.i ? line.toLowerCase() === lastLine.toLowerCase() : line === lastLine;
          if (equal) {
            count++;
          } else {
            await outputLine({ line: lastLine, cnt: count });
            lastLine = line;
            count = 1;
          }
        }
      }
      if (lastLine !== null) {
        await outputLine({ line: lastLine, cnt: count });
      }
    };

    const outputLine = async ({ line, cnt }: { line: string, cnt: number }) => {
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
        const stream = await context.vfs.readFile({ path: fullPath });
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

    return { exitCode: 0, data: undefined, error: undefined };
  },
};
