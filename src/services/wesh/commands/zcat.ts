import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseFlags } from '@/services/wesh/utils/args';

export const zcatCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'zcat',
    description: 'Decompress files and print on the standard output',
    usage: 'zcat [file...]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
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
        // @ts-expect-error - CompressionStream/DecompressionStream typing mismatch in some environments
        const decompressedStream = context.stdin.pipeThrough(decompressor);
        await decompressedStream.pipeTo(context.stdout, { preventClose: true });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        await text.error({ text: `zcat: stdin: ${message}\n` });
      }
      return { exitCode: 0 };
    }

    for (const f of positional) {
      if (f === undefined) continue;
      try {
        const fullPath = f.startsWith('/') ? f : `${context.cwd}/${f}`;
        const input = await context.vfs.readFile({ path: fullPath });
        const decompressor = new DecompressionStream('gzip');
        // @ts-expect-error - CompressionStream/DecompressionStream typing mismatch in some environments
        const decompressedStream = input.pipeThrough(decompressor);
        await decompressedStream.pipeTo(context.stdout, { preventClose: true });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        await text.error({ text: `zcat: ${f}: ${message}\n` });
      }
    }

    return { exitCode: 0 };
  },
};
