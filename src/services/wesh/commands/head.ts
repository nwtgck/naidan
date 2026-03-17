import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseFlags } from '@/services/wesh/utils/args';
import { handleToStream } from '@/services/wesh/utils/fs';

export const headCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'head',
    description: 'Output the first part of files',
    usage: 'head [file...] [-n lines]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const { flags, positional } = parseFlags({
      args: context.args,
      booleanFlags: [],
      stringFlags: ['n'],
    });

    const text = context.text();
    const n = parseInt(flags.n || '10', 10);

    const processStream = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      let linesProcessed = 0;
      let buffer = '';

      const reader = stream.getReader();
      while (linesProcessed < n) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n');
        while (parts.length > 1 && linesProcessed < n) {
          const line = parts.shift();
          await text.print({ text: line + '\n' });
          linesProcessed++;
        }
        buffer = parts.join('\n');
      }
      if (linesProcessed < n && buffer !== '') {
        await text.print({ text: buffer + '\n' });
      }
      reader.releaseLock();
    };

    if (positional.length === 0) {
      const input = new ReadableStream({
        async pull(controller) {
          const buf = new Uint8Array(4096);
          const { bytesRead } = await context.stdin.read({ buffer: buf });
          if (bytesRead === 0) {
            controller.close();
            return;
          }
          controller.enqueue(buf.subarray(0, bytesRead));
        }
      });
      await processStream(input);
    } else {
      for (const f of positional) {
        if (f === undefined) continue;
        try {
          const fullPath = f.startsWith('/') ? f : `${context.cwd}/${f}`;
          const handle = await context.kernel.open({
            path: fullPath,
            flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' }
          });
          await processStream(handleToStream({ handle }));
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          await text.error({ text: `head: ${f}: ${message}\n` });
        }
      }
    }

    return { exitCode: 0 };
  },
};
