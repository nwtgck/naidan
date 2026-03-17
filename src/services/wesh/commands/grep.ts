import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseFlags } from '@/services/wesh/utils/args';
import { handleToStream } from '@/services/wesh/utils/fs';

export const grepCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'grep',
    description: 'Search for patterns in files',
    usage: 'grep pattern [file...]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const { positional } = parseFlags({
      args: context.args,
      booleanFlags: [],
      stringFlags: [],
    });

    const text = context.text();
    if (positional.length === 0) {
      await text.error({ text: 'grep: missing pattern operand\n' });
      return { exitCode: 1 };
    }

    const pattern = positional[0]!;
    const regex = new RegExp(pattern);
    const files = positional.slice(1);

    const processStream = async (stream: ReadableStream<Uint8Array>, name?: string) => {
      const decoder = new TextDecoder();
      let buffer = '';
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (regex.test(line)) {
            await text.print({ text: (name ? `${name}:` : '') + line + '\n' });
          }
        }
      }
      if (buffer && regex.test(buffer)) {
        await text.print({ text: (name ? `${name}:` : '') + buffer + '\n' });
      }
    };

    if (files.length === 0) {
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
      for (const f of files) {
        if (f === undefined) continue;
        try {
          const fullPath = f.startsWith('/') ? f : `${context.cwd}/${f}`;
          const handle = await context.kernel.open({
            path: fullPath,
            flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' }
          });
          await processStream(handleToStream({ handle }), files.length > 1 ? f : undefined);
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          await text.error({ text: `grep: ${f}: ${message}\n` });
        }
      }
    }

    return { exitCode: 0 };
  },
};
