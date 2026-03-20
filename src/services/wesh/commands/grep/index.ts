import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import { parseFlags } from '@/services/wesh/utils/args';
import { handleToStream } from '@/services/wesh/utils/fs';

export const grepCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'grep',
    description: 'Search for patterns in files',
    usage: 'grep [flags] pattern [file...]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const { flags, positional, unknown } = parseFlags({
      args: context.args,
      booleanFlags: ['i', 'v', 'n', 'w', 'F', 'I'],
      stringFlags: ['A', 'B', 'C'],
    });

    if (unknown.length > 0) {
      await writeCommandUsageError({
        context,
        command: 'grep',
        message: `grep: invalid option -- '${unknown[0]}'`,
      });
      return { exitCode: 2 };
    }

    const text = context.text();
    if (positional.length === 0) {
      await writeCommandUsageError({
        context,
        command: 'grep',
        message: 'grep: missing pattern operand',
      });
      return { exitCode: 1 };
    }

    const pattern = flags.F ? positional[0]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : positional[0]!;
    const regex = new RegExp(flags.w ? `\\b${pattern}\\b` : pattern, flags.i ? 'i' : undefined);
    const files = positional.slice(1);

    const before = parseInt(flags.B as string) || parseInt(flags.C as string) || 0;
    const contextAfter = parseInt(flags.A as string) || parseInt(flags.C as string) || 0;

    const processStream = async ({
      stream,
      name,
    }: {
      stream: ReadableStream<Uint8Array>;
      name?: string;
    }) => {
      const decoder = new TextDecoder();
      let buffer = '';
      const reader = stream.getReader();
      const allLines: string[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        if (flags.I) {
          const isBinary = value.some(byte => byte === 0);
          if (isBinary) return;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        allLines.push(...lines);
      }
      if (buffer) allLines.push(buffer);

      const matches = new Array(allLines.length).fill(false);
      for (let i = 0; i < allLines.length; i++) {
        const match = regex.test(allLines[i]!);
        matches[i] = flags.v ? !match : match;
      }

      for (let i = 0; i < allLines.length; i++) {
        if (matches[i]) {
          const start = Math.max(0, i - before);
          const end = Math.min(allLines.length - 1, i + contextAfter);

          for (let j = start; j <= end; j++) {
            let output = '';
            if (name) output += `${name}:`;
            if (flags.n) output += `${j + 1}:`;
            output += allLines[j] + '\n';
            await text.print({ text: output });
          }
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
      await processStream({ stream: input });
    } else {
      for (const f of files) {
        if (f === undefined) continue;
        try {
          const fullPath = f.startsWith('/') ? f : `${context.cwd}/${f}`;
          const handle = await context.kernel.open({
            path: fullPath,
            flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' }
          });
          await processStream({
            stream: handleToStream({ handle }),
            name: files.length > 1 ? f : undefined
          });
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          await text.error({ text: `grep: ${f}: ${message}\n` });
        }
      }
    }

    return { exitCode: 0 };
  },
};
