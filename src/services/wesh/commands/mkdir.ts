import type { CommandDefinition, CommandResult, CommandContext } from '../types';
import { parseFlags } from '../utils/args';

export const mkdir: CommandDefinition = {
  meta: {
    name: 'mkdir',
    description: 'Create directories',
    usage: 'mkdir [-p] path...',
  },
  fn: async ({ context }: { context: CommandContext }): Promise<CommandResult> => {
    const { flags, positional } = parseFlags({
      args: context.args,
      booleanFlags: ['p'],
      stringFlags: [],
    });

    if (positional.length === 0) {
      const text = context.text();
      await text.error({ text: 'mkdir: missing operand\n' });
      return { exitCode: 1, data: undefined, error: 'missing operand' };
    }

    const recursive = !!flags.p;
    const text = context.text();

    for (const p of positional) {
      try {
        const fullPath = p.startsWith('/') ? p : `${context.cwd}/${p}`;
        await context.vfs.mkdir({ path: fullPath, recursive });
      } catch (e: any) {
        await text.error({ text: `mkdir: cannot create directory '${p}': ${e.message}\n` });
      }
    }

    return { exitCode: 0, data: undefined, error: undefined };
  },
};
