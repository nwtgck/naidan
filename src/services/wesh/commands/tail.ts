import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseFlags } from '@/services/wesh/utils/args';
import { handleToStream } from '@/services/wesh/utils/fs';

export const tailCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'tail',
    description: 'Output the last part of files',
    usage: 'tail [file...] [-n lines]',
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
      let content = '';
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        content += decoder.decode(value, { stream: true });
      }
      content += decoder.decode();

      const lines = content.split('\n');
      if (lines[lines.length - 1] === '') lines.pop();

      const lastLines = lines.slice(-n);
      for (const line of lastLines) {
        await text.print({ text: line + '\n' });
      }
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
          await text.error({ text: `tail: ${f}: ${message}\n` });
        }
      }
    }

    return { exitCode: 0 };
  },
};
