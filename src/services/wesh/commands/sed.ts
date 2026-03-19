import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseFlags } from '@/services/wesh/utils/args';
import { handleToStream } from '@/services/wesh/utils/fs';

export const sedCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'sed',
    description: 'Stream editor for filtering and transforming text',
    usage: 'sed [flags] command [file...]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const { flags, positional, unknown } = parseFlags({
      args: context.args,
      booleanFlags: ['n', 'e', 'r', 'E'],
      stringFlags: ['i'],
    });

    if (unknown.length > 0) {
      await context.text().error({ text: `sed: invalid option -- '${unknown[0]}'\n` });
      return { exitCode: 2 };
    }

    const text = context.text();
    if (positional.length === 0) {
      await text.error({ text: 'sed: missing expression\n' });
      return { exitCode: 1 };
    }

    const expression = positional[0]!;
    const files = positional.slice(1);

    // Basic sed command parsing (only supports s/regex/replacement/g)
    const match = expression.match(/^s([|/])((?:(?=(\\?))\3.)*?)\1((?:(?=(\\?))\5.)*?)\1([g]?)$/);
    if (!match) {
      await text.error({ text: `sed: invalid expression '${expression}'\n` });
      return { exitCode: 1 };
    }

    const regexStr = match[2];
    const replacement = match[4];
    const globalFlag = match[6] === 'g';
    const regex = new RegExp(regexStr, globalFlag ? 'g' : undefined);

    const processStream = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      const reader = stream.getReader();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const transformed = line.replace(regex, replacement);
          if (!flags.n) {
            await text.print({ text: `${transformed}\n` });
          }
        }
      }
      if (buffer) {
        const transformed = buffer.replace(regex, replacement);
        if (!flags.n) {
          await text.print({ text: `${transformed}\n` });
        }
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
          await processStream(handleToStream({ handle }));
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          await text.error({ text: `sed: ${f}: ${message}\n` });
        }
      }
    }

    return { exitCode: 0 };
  },
};
