import type { CommandDefinition, CommandResult, CommandContext } from '../types';

export const whoami: CommandDefinition = {
  meta: {
    name: 'whoami',
    description: 'Print the user name associated with the current effective user ID',
    usage: 'whoami',
  },
  fn: async ({ context }: { context: CommandContext }): Promise<CommandResult> => {
    const user = context.env.USER || 'user';
    const text = context.text();
    await text.print({ text: user + '\n' });
    return { exitCode: 0, data: user, error: undefined };
  },
};
