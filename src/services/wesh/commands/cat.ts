import type { CommandDefinition, CommandResult, CommandContext } from '../types';

export const cat: CommandDefinition = {
  meta: {
    name: 'cat',
    description: 'Concatenate files and print on the standard output',
    usage: 'cat [file...]',
  },
  fn: async ({ context }: { context: CommandContext }): Promise<CommandResult> => {
    const files = context.args;
    const text = context.text();

    if (files.length === 0) {
      for await (const line of text.input) {
        await text.print({ text: line + '\n' });
      }
      return { exitCode: 0, data: undefined, error: undefined };
    }

    for (const f of files) {
      if (f === undefined) continue;
      try {
        const stream = await context.vfs.readFile({ path: f.startsWith('/') ? f : `${context.cwd}/${f}` });
        await stream.pipeTo(context.stdout, { preventClose: true });
      } catch (e: any) {
        await text.error({ text: `cat: ${f}: ${e.message}\n` });
      }
    }

    return { exitCode: 0, data: undefined, error: undefined };
  },
};
