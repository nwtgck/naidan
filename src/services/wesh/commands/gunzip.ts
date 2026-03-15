import type { CommandDefinition, CommandResult, CommandContext } from '@/services/wesh/types';
import { parseFlags } from '@/services/wesh/utils/args';

export const gunzipCommandDefinition: CommandDefinition = {
  meta: {
    name: 'gunzip',
    description: 'Decompress files',
    usage: 'gunzip [file...]',
  },
  fn: async ({ context }: { context: CommandContext }): Promise<CommandResult> => {
    const { positional } = parseFlags({
      args: context.args,
      booleanFlags: [],
      stringFlags: [],
    });

    const text = context.text();
    if (positional.length === 0) {
      await text.error({ text: 'gunzip: missing file operand\n' });
      return { exitCode: 1, data: undefined, error: 'missing operand' };
    }

    for (const f of positional) {
      if (f === undefined) continue;
      try {
        const fullPath = f.startsWith('/') ? f : `${context.cwd}/${f}`;
        if (!fullPath.endsWith('.gz')) {
          await text.error({ text: `gunzip: ${f}: unknown suffix -- ignored\n` });
          continue;
        }

        const input = await context.vfs.readFile({ path: fullPath });
        const decompressor = new DecompressionStream('gzip');
        // @ts-expect-error - CompressionStream/DecompressionStream typing mismatch in some environments
        const decompressedStream = input.pipeThrough(decompressor) as ReadableStream<Uint8Array>;

        const originalPath = fullPath.slice(0, -3);
        await context.vfs.writeFile({ path: originalPath, stream: decompressedStream });
        await context.vfs.rm({ path: fullPath, recursive: false });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        await text.error({ text: `gunzip: ${f}: ${message}\n` });
      }
    }

    return { exitCode: 0, data: undefined, error: undefined };
  },
};
