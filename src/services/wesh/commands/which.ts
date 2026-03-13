import type { CommandDefinition, CommandResult, CommandContext } from '@/services/wesh/types';

export const which: CommandDefinition = {
  meta: {
    name: 'which',
    description: 'Locate a command',
    usage: 'which command...',
  },
  fn: async ({ context }: { context: CommandContext }): Promise<CommandResult> => {
    const text = context.text();
    let foundAll = true;

    for (const name of context.args) {
      const meta = context.getCommandMeta({ name });
      if (meta) {
        await text.print({ text: `${name}: builtin command\n` });
      } else {
        await text.error({ text: `${name} not found\n` });
        foundAll = false;
      }
    }

    return { exitCode: foundAll ? 0 : 1, data: undefined, error: undefined };
  },
};
