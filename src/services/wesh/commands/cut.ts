import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseFlags } from '@/services/wesh/utils/args';
import { handleToStream } from '@/services/wesh/utils/fs';

export const cutCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'cut',
    description: 'Remove sections from each line of files',
    usage: 'cut [file...] -f fields [-d delimiter]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const { flags, positional } = parseFlags({
      args: context.args,
      booleanFlags: [],
      stringFlags: ['f', 'd'],
    });

    const text = context.text();
    if (!flags.f) {
      await text.error({ text: 'cut: fields must be specified\n' });
      return { exitCode: 1 };
    }

    const fieldIndices = flags.f.split(',').map(f => parseInt(f, 10) - 1);
    const delimiter = flags.d || '\t';

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
          await text.error({ text: `cut: ${f}: ${message}\n` });
        }
      }
    }

    return { exitCode: 0 };
  },
};
