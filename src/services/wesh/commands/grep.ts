import type { CommandDefinition, CommandResult, CommandContext } from '@/services/wesh/types';
import { parseFlags } from '@/services/wesh/utils/args';

export const grepCommandDefinition: CommandDefinition = {
  meta: {
    name: 'grep',
    description: 'Print lines matching a pattern',
    usage: 'grep [-i] [-v] [-n] pattern [file...]',
  },
  fn: async ({ context }: { context: CommandContext }): Promise<CommandResult> => {
    const { flags, positional } = parseFlags({
      args: context.args,
      booleanFlags: ['i', 'v', 'n'],
      stringFlags: [],
    });

    const text = context.text();
    if (positional.length === 0) {
      await text.error({ text: 'grep: pattern is required\n' });
      return { exitCode: 1, data: undefined, error: 'pattern required' };
    }

    const patternStr = positional[0]!;
    const files = positional.slice(1);
    const regex = new RegExp(patternStr, flags.i ? 'i' : '');
    const invert = !!flags.v;
    const showLineNumber = !!flags.n;

    const processStream = async ({
      input,
      label
    }: {
      input: AsyncIterable<string>;
      label: string | undefined;
    }) => {
      let lineNum = 0;
      for await (const line of input) {
        lineNum++;
        const matches = regex.test(line);
        if (matches !== invert) {
          let output = '';
          if (label) output += `${label}:`;
          if (showLineNumber) output += `${lineNum}:`;
          output += line + '\n';
          await text.print({ text: output });
        }
      }
    };

    if (files.length === 0) {
      await processStream({ input: text.input, label: undefined });
    } else {
      for (const f of files) {
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

          await processStream({
            input: lineReader,
            label: files.length > 1 ? f : undefined
          });
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          await text.error({ text: `grep: ${f}: ${message}\n` });
        }
      }
    }

    return { exitCode: 0, data: undefined, error: undefined };
  },
};
