import type { CommandDefinition, CommandResult, CommandContext } from '@/services/wesh/types';

export const sleep: CommandDefinition = {
  meta: {
    name: 'sleep',
    description: 'Delay for a specified amount of time',
    usage: 'sleep number',
  },
  fn: async ({ context }: { context: CommandContext }): Promise<CommandResult> => {
    const seconds = parseFloat(context.args[0] || '0');
    if (isNaN(seconds)) {
      const text = context.text();
      await text.error({ text: `sleep: invalid time interval '${context.args[0]}'\n` });
      return { exitCode: 1, data: undefined, error: 'invalid interval' };
    }

    await new Promise(resolve => setTimeout(resolve, seconds * 1000));
    return { exitCode: 0, data: undefined, error: undefined };
  },
};
