import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';

export const catCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'cat',
    description: 'Concatenate files and print on the standard output',
    usage: 'cat [file...]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const files = context.args;
    const text = context.text();

    if (files.length === 0) {
      for await (const line of text.input) {
        await text.print({ text: line + '\n' });
      }
      return { exitCode: 0, data: undefined, error: undefined };
    }

    for (const f of files) {
      if (f === undefined || f === '') continue;
      if (f === '-') {
        for await (const line of text.input) {
          await text.print({ text: line + '\n' });
        }
        continue;
      }
      
      try {
        const path = f.startsWith('/') ? f : `${context.cwd}/${f}`;
        const stream = await context.vfs.readFile({ path });
        await stream.pipeTo(context.stdout, { preventClose: true });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        await text.error({ text: `cat: ${f}: ${message}\n` });
      }
    }

    return { exitCode: 0, data: undefined, error: undefined };
  },
};
