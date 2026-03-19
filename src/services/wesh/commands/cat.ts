import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseFlags } from '@/services/wesh/utils/args';
import { handleToStream } from '@/services/wesh/utils/fs';

export const catCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'cat',
    description: 'Concatenate files and print on the standard output',
    usage: 'cat [flags] [file...]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const { flags, positional, unknown } = parseFlags({
      args: context.args,
      booleanFlags: ['n', 'b', 'E', 'T', 'A', 's'],
      stringFlags: [],
    });

    if (unknown.length > 0) {
      await context.stderr.write({
        buffer: new TextEncoder().encode(`cat: invalid option -- '${unknown[0]}'\n`),
      });
      return { exitCode: 1 };
    }

    const text = context.text();
    const files = positional;
    let lineNumber = 1;
    let lastWasEmpty = false;

    const processStream = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      const reader = stream.getReader();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            const isEmpty = line.length === 0;
            if (flags.s && isEmpty && lastWasEmpty) continue;
            
            let output = '';
            if (flags.n || (flags.b && !isEmpty)) {
              output += `${String(lineNumber++).padStart(6, ' ')}  `;
            }

            let processedLine = line;
            if (flags.T) processedLine = processedLine.replace(/\t/g, '^I');
            if (flags.E) processedLine += '$';
            if (flags.A) {
               processedLine = processedLine
                 .replace(/\t/g, '^I')
                 .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, (c) => '^' + String.fromCharCode(c.charCodeAt(0) + 64));
            }

            await text.print({ text: output + processedLine + '\n' });
            lastWasEmpty = isEmpty;
          }
        }
      } finally {
        reader.releaseLock();
      }
    };

    if (files.length === 0) {
      await processStream(handleToStream({ handle: context.stdin }));
    } else {
      for (const f of files) {
        if (f === undefined) continue;
        try {
          const fullPath = f.startsWith('/') ? f : `${context.cwd}/${f}`;
          const handle = await context.kernel.open({
            path: fullPath,
            flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' }
          });
          try {
            await processStream(handleToStream({ handle }));
          } finally {
            await handle.close();
          }
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          await text.error({ text: `cat: ${f}: ${message}\n` });
          return { exitCode: 1 };
        }
      }
    }

    return { exitCode: 0 };
  },
};
