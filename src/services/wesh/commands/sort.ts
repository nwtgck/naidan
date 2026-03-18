import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseFlags } from '@/services/wesh/utils/args';
import { handleToStream } from '@/services/wesh/utils/fs';

export const sortCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'sort',
    description: 'Sort lines of text files',
    usage: 'sort [file...]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const { positional } = parseFlags({
      args: context.args,
      booleanFlags: [],
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
          const handle = await context.kernel.open({
            path: fullPath,
            flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' }
          });
          const stream = handleToStream({ handle });
          const decoder = new TextDecoder();
          const reader = stream.getReader();
          let buffer = '';
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lns = buffer.split(/\r?\n/);
            buffer = lns.pop() || '';
            for (const l of lns) lines.push(l);
          }
          if (buffer) lines.push(buffer);
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          await text.error({ text: `sort: ${f}: ${message}\n` });
        }
      }
    }

    lines.sort();
    for (const line of lines) {
      await text.print({ text: line + '\n' });
    }

    return { exitCode: 0 };
  },
};
