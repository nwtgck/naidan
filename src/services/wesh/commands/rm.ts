import type { CommandDefinition, CommandResult, CommandContext } from '@/services/wesh/types';
import { parseFlags } from '@/services/wesh/utils/args';

export const rmCommandDefinition: CommandDefinition = {
  meta: {
    name: 'rm',
    description: 'Remove files or directories',
    usage: 'rm [-r] [-f] path...',
  },
  fn: async ({ context }: { context: CommandContext }): Promise<CommandResult> => {
    const { flags, positional } = parseFlags({
      args: context.args,
      booleanFlags: ['r', 'f'],
      stringFlags: [],
    });

    const text = context.text();
    if (positional.length === 0) {
      await text.error({ text: 'rm: missing operand\n' });
      return { exitCode: 1, data: undefined, error: 'missing operand' };
    }

    const recursive = !!flags.r;
    const force = !!flags.f;

    for (const p of positional) {
      try {
        const fullPath = p.startsWith('/') ? p : `${context.cwd}/${p}`;
        await context.vfs.rm({ path: fullPath, recursive });
      } catch (e: unknown) {
        if (!force) {
          const message = e instanceof Error ? e.message : String(e);
          await text.error({ text: `rm: cannot remove '${p}': ${message}\n` });
        }
      }
    }

    return { exitCode: 0, data: undefined, error: undefined };
  },
};
