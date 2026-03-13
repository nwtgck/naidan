import type { CommandDefinition, CommandResult, CommandContext } from '@/services/wesh/types';
import { parseFlags } from '@/services/wesh/utils/args';

export const gzip: CommandDefinition = {
  meta: {
    name: 'gzip',
    description: 'Compress files',
    usage: 'gzip [file...]',
  },
  fn: async ({ context }: { context: CommandContext }): Promise<CommandResult> => {
    const { positional } = parseFlags({
      args: context.args,
      booleanFlags: [],
      stringFlags: [],
    });

    const text = context.text();
    if (positional.length === 0) {
      await text.error({ text: 'gzip: missing file operand\n' });
      return { exitCode: 1, data: undefined, error: 'missing operand' };
    }

    for (const f of positional) {
      if (f === undefined) continue;
      try {
        const fullPath = f.startsWith('/') ? f : `${context.cwd}/${f}`;
        const input = await context.vfs.readFile({ path: fullPath });

        /** Use native CompressionStream */
        const compressor = new CompressionStream('gzip');
        // @ts-expect-error - CompressionStream/DecompressionStream typing mismatch in some environments
        const compressedStream = input.pipeThrough(compressor) as ReadableStream<Uint8Array>;

        const gzPath = fullPath + '.gz';
        await context.vfs.writeFile({ path: gzPath, stream: compressedStream });
        await context.vfs.rm({ path: fullPath, recursive: false });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        await text.error({ text: `gzip: ${f}: ${message}\n` });
      }
    }

    return { exitCode: 0, data: undefined, error: undefined };
  },
};
