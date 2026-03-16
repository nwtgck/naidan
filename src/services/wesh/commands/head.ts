import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseFlags } from '@/services/wesh/utils/args';

export const headCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'head',
    description: 'Output the first part of files',
    usage: 'head [-n number] [file...]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const { flags, positional } = parseFlags({
      args: context.args,
      booleanFlags: [],
      stringFlags: ['n'],
    });

    const numLines = parseInt((flags.n as string) || '10', 10);
    const text = context.text();

    const process = async ({ input }: { input: AsyncIterable<string> }) => {
      let count = 0;
      for await (const line of input) {
        if (count >= numLines) break;
        await text.print({ text: line + '\n' });
        count++;
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
          await text.error({ text: `head: ${f}: ${message}\n` });
        }
      }
    }

    return { exitCode: 0, data: undefined, error: undefined };
  },
};
