import type { CommandDefinition, CommandResult, CommandContext } from '../types';
import { parseFlags } from '../utils/args';

export const zcat: CommandDefinition = {
  meta: {
    name: 'zcat',
    description: 'Decompress files and print on the standard output',
    usage: 'zcat [file...]',
  },
  fn: async ({ context }: { context: CommandContext }): Promise<CommandResult> => {
    const { positional } = parseFlags({
      args: context.args,
      booleanFlags: [],
      stringFlags: [],
    });

    const text = context.text();
    if (positional.length === 0) {
      /** zcat usually doesn't read from stdin without - or other flags, 
       * but we'll support it if it's piped.
       */
      try {
        const decompressor = new DecompressionStream('gzip');
        const decompressedStream = context.stdin.pipeThrough(decompressor);
        await decompressedStream.pipeTo(context.stdout, { preventClose: true });
      } catch (e: any) {
        await text.error({ text: `zcat: stdin: ${e.message}\n` });
      }
      return { exitCode: 0, data: undefined, error: undefined };
    }

    for (const f of positional) {
      if (f === undefined) continue;
      try {
        const fullPath = f.startsWith('/') ? f : `${context.cwd}/${f}`;
        const input = await context.vfs.readFile({ path: fullPath });
        const decompressor = new DecompressionStream('gzip');
        const decompressedStream = input.pipeThrough(decompressor);
        await decompressedStream.pipeTo(context.stdout, { preventClose: true });
      } catch (e: any) {
        await text.error({ text: `zcat: ${f}: ${e.message}\n` });
      }
    }

    return { exitCode: 0, data: undefined, error: undefined };
  },
};
