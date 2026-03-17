import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseFlags } from '@/services/wesh/utils/args';

export const sortCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'sort',
    description: 'Sort lines of text files',
    usage: 'sort [-r] [-n] [file...]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const { flags, positional } = parseFlags({
      args: context.args,
      booleanFlags: ['r', 'n'],
      stringFlags: [],
    });

    const text = context.text();
    const lines: string[] = [];

    const read = async ({ input }: { input: AsyncIterable<string> }) => {
      for await (const line of input) lines.push(line);
    };

    if (positional.length === 0) {
      await read({ input: text.input });
    } else {
      for (const f of positional) {
        if (f === undefined) continue;
        try {
          const fullPath = f.startsWith('/') ? f : `${context.cwd}/${f}`;
          const stream = await context.vfs.readFile({ path: fullPath });
          const decoder = new TextDecoder();
          const reader = stream.getReader();
          let buffer = '';
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lns = buffer.split(/\r?\n/);
              buffer = lns.pop() || '';
              for (const l of lns) lines.push(l);
            }
            if (buffer) lines.push(buffer);
          } finally {
            reader.releaseLock();
          }
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          await text.error({ text: `sort: ${f}: ${message}\n` });
        }
      }
    }

    lines.sort((a, b) => {
      if (flags.n) {
        const na = parseFloat(a);
        const nb = parseFloat(b);
        if (!isNaN(na) && !isNaN(nb)) return na - nb;
      }
      return a.localeCompare(b);
    });

    if (flags.r) lines.reverse();

    for (const line of lines) {
      await text.print({ text: line + '\n' });
    }

    return { exitCode: 0 };
  },
};
