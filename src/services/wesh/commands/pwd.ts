import type { CommandDefinition, CommandResult, CommandContext } from '@/services/wesh/types';

export const pwd: CommandDefinition = {
  meta: {
    name: 'pwd',
    description: 'Print name of current/working directory',
    usage: 'pwd',
  },
  fn: async ({ context }: { context: CommandContext }): Promise<CommandResult> => {
    const text = context.text();
    await text.print({ text: context.cwd + '\n' });
    return { exitCode: 0, data: context.cwd, error: undefined };
  },
};
