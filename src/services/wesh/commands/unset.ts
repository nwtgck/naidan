import type { CommandDefinition, CommandResult, CommandContext } from '@/services/wesh/types';

export const unsetCommandDefinition: CommandDefinition = {
  meta: {
    name: 'unset',
    description: 'Unset environment variables',
    usage: 'unset name...',
  },
  fn: async ({ context }: { context: CommandContext }): Promise<CommandResult> => {
    const text = context.text();
    if (context.args.length === 0) {
      await text.error({ text: 'unset: missing operand\n' });
      return { exitCode: 1, data: undefined, error: 'missing operand' };
    }

    for (const name of context.args) {
      context.unsetEnv({ key: name });
    }

    return { exitCode: 0, data: undefined, error: undefined };
  },
};
