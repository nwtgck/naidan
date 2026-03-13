import type { CommandDefinition, CommandResult, CommandContext } from '../types';
import { parseFlags } from '../utils/args';

export const command: CommandDefinition = {
  meta: {
    name: 'command',
    description: 'Run command with arguments, ignoring any function or alias',
    usage: 'command [-v] command [argument...]',
  },
  fn: async ({ context }: { context: CommandContext }): Promise<CommandResult> => {
    const { flags, positional } = parseFlags({
      args: context.args,
      booleanFlags: ['v'],
      stringFlags: [],
    });

    const text = context.text();
    if (positional.length === 0) return { exitCode: 0, data: undefined, error: undefined };

    const cmdName = positional[0]!;
    const meta = context.getCommandMeta({ name: cmdName });

    if (flags.v) {
      if (meta) {
        await text.print({ text: `${cmdName}\n` });
        return { exitCode: 0, data: undefined, error: undefined };
      }
      return { exitCode: 1, data: undefined, error: 'not found' };
    }

    if (!meta) {
      await text.error({ text: `command: ${cmdName} not found\n` });
      return { exitCode: 1, data: undefined, error: 'not found' };
    }

    return { exitCode: 0, data: undefined, error: undefined };
  },
};
