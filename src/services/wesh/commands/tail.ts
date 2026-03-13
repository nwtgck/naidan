import type { CommandDefinition, CommandResult, CommandContext } from '../types';
import { parseFlags } from '../utils/args';

export const tail: CommandDefinition = {
  meta: {
    name: 'tail',
    description: 'Output the last part of files',
    usage: 'tail [-n number] [file...]',
  },
  fn: async ({ context }: { context: CommandContext }): Promise<CommandResult> => {
    const { flags, positional } = parseFlags({
      args: context.args,
      booleanFlags: [],
      stringFlags: ['n'],
    });

    const numLines = parseInt((flags.n as string) || '10', 10);
    const text = context.text();

    const process = async ({ input }: { input: AsyncIterable<string> }) => {
      const buffer: string[] = [];
      for await (const line of input) {
        buffer.push(line);
        if (buffer.length > numLines) buffer.shift();
      }
      for (const line of buffer) {
        await text.print({ text: line + '\n' });
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
        } catch (e: any) {
          await text.error({ text: `tail: ${f}: ${e.message}\n` });
        }
      }
    }

    return { exitCode: 0, data: undefined, error: undefined };
  },
};
