import type { CommandDefinition, CommandResult, CommandContext } from '@/services/wesh/types';

export const clearCommandDefinition: CommandDefinition = {
  meta: {
    name: 'clear',
    description: 'Clear the terminal screen',
    usage: 'clear',
  },
  fn: async ({ context }: { context: CommandContext }): Promise<CommandResult> => {
    const text = context.text();
    /** Standard clear escape code */
    await text.print({ text: '\x1b[2J\x1b[H' });
    return { exitCode: 0, data: undefined, error: undefined };
  },
};
