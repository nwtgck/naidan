import type { CommandDefinition, CommandResult, CommandContext } from '../types';
import { parseFlags } from '../utils/args';

export const echo: CommandDefinition = {
  meta: {
    name: 'echo',
    description: 'Display a line of text',
    usage: 'echo [-n] [string...]',
  },
  fn: async ({ context }: { context: CommandContext }): Promise<CommandResult> => {
    const { flags, positional } = parseFlags({
      args: context.args,
      booleanFlags: ['n'],
      stringFlags: [],
    });

    const text = context.text();
    await text.print({ text: positional.join(' ') });
    
    if (!flags.n) {
      await text.print({ text: '\n' });
    }

    return { exitCode: 0, data: undefined, error: undefined };
  },
};
