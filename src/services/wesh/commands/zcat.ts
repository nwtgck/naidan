import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseFlags } from '@/services/wesh/utils/args';
import { handleToStream } from '@/services/wesh/utils/fs';

export const zcatCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'zcat',
    description: 'Decompress and print files to standard output',
    usage: 'zcat [file...]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const { positional } = parseFlags({
      args: context.args,
      booleanFlags: [],
      stringFlags: [],
    });

    const text = context.text();
    const decoder = new TextDecoder();

    for (const f of positional) {
      if (f === undefined) continue;
      try {
        const fullPath = f.startsWith('/') ? f : `${context.cwd}/${f}`;
        const handle = await context.kernel.open({
          path: fullPath,
          flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' }
        });

        const stream = handleToStream({ handle });
        const decompressor = new DecompressionStream('gzip');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const decompressedStream = stream.pipeThrough(decompressor as any) as ReadableStream<Uint8Array>;

        const reader = decompressedStream.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await text.print({ text: decoder.decode(value, { stream: true }) });
        }
        await text.print({ text: decoder.decode() }); // flush
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        await text.error({ text: `zcat: ${f}: ${message}\n` });
      }
    }

    return { exitCode: 0 };
  },
};
