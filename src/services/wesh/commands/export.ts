import type { CommandDefinition, CommandResult, CommandContext } from '@/services/wesh/types';
import { parseFlags } from '@/services/wesh/utils/args';

export const exportCmdCommandDefinition: CommandDefinition = {
  meta: {
    name: 'export',
    description: 'Set environment variables',
    usage: 'export [-p] name=value...',
  },
  fn: async ({ context }: { context: CommandContext }): Promise<CommandResult> => {
    const { flags, positional } = parseFlags({
      args: context.args,
      booleanFlags: ['p'],
      stringFlags: [],
    });

    const text = context.text();
    if (flags.p) {
      for (const [key, val] of Object.entries(context.env)) {
        await text.print({ text: `export ${key}='${val}'\n` });
      }
      return { exitCode: 0, data: undefined, error: undefined };
    }

    for (const p of positional) {
      const idx = p.indexOf('=');
      if (idx !== -1) {
        const key = p.slice(0, idx);
        const value = p.slice(idx + 1);
        context.setEnv({ key, value });
      }
    }

    return { exitCode: 0, data: undefined, error: undefined };
  },
};
