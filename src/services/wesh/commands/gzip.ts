import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseFlags } from '@/services/wesh/utils/args';
import { readFile, writeFile } from '@/services/wesh/utils/fs';

export const gzipCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'gzip',
    description: 'Compress files',
    usage: 'gzip [file...]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const { positional } = parseFlags({
      args: context.args,
      booleanFlags: [],
      stringFlags: [],
    });

    const text = context.text();
    if (positional.length === 0) {
      await text.error({ text: 'gzip: missing file operand\n' });
      return { exitCode: 1 };
    }

    for (const f of positional) {
      if (f === undefined) continue;
      try {
        const fullPath = f.startsWith('/') ? f : `${context.cwd}/${f}`;
        const input = await readFile({ kernel: context.kernel, path: fullPath });
        const compressor = new CompressionStream('gzip');
        const inputProvider = new ReadableStream({
          start(controller) {
            controller.enqueue(input);
            controller.close();
          }
        });
        const compressedStream = inputProvider.pipeThrough(compressor);

        const gzPath = `${fullPath}.gz`;
        const chunks: Uint8Array[] = [];
        const reader = compressedStream.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
        const result = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
          result.set(chunk, offset);
          offset += chunk.length;
        }

        await writeFile({ kernel: context.kernel, path: gzPath, data: result });
        await context.kernel.unlink({ path: fullPath });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        await text.error({ text: `gzip: ${f}: ${message}\n` });
      }
    }

    return { exitCode: 0 };
  },
};
