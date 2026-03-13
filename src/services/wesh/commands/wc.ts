import type { CommandDefinition, CommandResult, CommandContext } from '@/services/wesh/types';
import { parseFlags } from '@/services/wesh/utils/args';

export const wc: CommandDefinition = {
  meta: {
    name: 'wc',
    description: 'Print newline, word, and byte counts for each file',
    usage: 'wc [-l] [-w] [-c] [file...]',
  },
  fn: async ({ context }: { context: CommandContext }): Promise<CommandResult> => {
    const { flags, positional } = parseFlags({
      args: context.args,
      booleanFlags: ['l', 'w', 'c'],
      stringFlags: [],
    });

    const showAll = !flags.l && !flags.w && !flags.c;
    const text = context.text();

    const process = async ({
      input,
      label
    }: {
      input: AsyncIterable<string>,
      label?: string
    }) => {
      let lines = 0;
      let words = 0;
      let bytes = 0;

      for await (const line of input) {
        lines++;
        words += line.trim().split(/\s+/).filter(w => w).length;
        bytes += new TextEncoder().encode(line + '\n').length;
      }

      let out = '';
      if (showAll || flags.l) out += lines.toString().padStart(8);
      if (showAll || flags.w) out += words.toString().padStart(8);
      if (showAll || flags.c) out += bytes.toString().padStart(8);
      if (label) out += ` ${label}`;
      await text.print({ text: out + '\n' });
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
          await process({ input: lineReader, label: f });
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          await text.error({ text: `wc: ${f}: ${message}\n` });
        }
      }
    }

    return { exitCode: 0, data: undefined, error: undefined };
  },
};
