import type { CommandDefinition, CommandResult, CommandContext } from '@/services/wesh/types';
import { parseFlags } from '@/services/wesh/utils/args';

export const cut: CommandDefinition = {
  meta: {
    name: 'cut',
    description: 'Remove sections from each line of files',
    usage: 'cut [-d delimiter] [-f fields] [file...]',
  },
  fn: async ({ context }: { context: CommandContext }): Promise<CommandResult> => {
    const { flags, positional } = parseFlags({
      args: context.args,
      booleanFlags: [],
      stringFlags: ['d', 'f'],
    });

    const delimiter = (flags.d as string) || '\t';
    const fieldsStr = (flags.f as string) || '1';
    const text = context.text();

    /** Simple fields parser: handles "1,3", "1-3", "2-" */
    const fieldIndices = fieldsStr.split(',').flatMap(part => {
      if (part.includes('-')) {
        const [start, end] = part.split('-');
        const s = parseInt(start || '1') || 1;
        const e = parseInt(end || '100') || 100;
        return Array.from({ length: e - s + 1 }, (_, i) => s + i);
      }
      return [parseInt(part)];
    }).map(n => n - 1);

    const process = async ({ input }: { input: AsyncIterable<string> }) => {
      for await (const line of input) {
        const parts = line.split(delimiter);
        const selected = fieldIndices.map(i => parts[i] || '').filter(p => p !== '');
        await text.print({ text: selected.join(delimiter) + '\n' });
      }
    };

    if (positional.length === 0) {
      await process({ input: text.input });
    } else {
      for (const f of positional) {
        if (f === undefined) continue;
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
          await text.error({ text: `cut: ${f}: ${message}\n` });
        }
      }
    }

    return { exitCode: 0, data: undefined, error: undefined };
  },
};
