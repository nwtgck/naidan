import type { CommandDefinition, CommandResult, CommandContext } from '@/services/wesh/types';
import { parseFlags } from '@/services/wesh/utils/args';

export const date: CommandDefinition = {
  meta: {
    name: 'date',
    description: 'Print the system date and time',
    usage: 'date [-u]',
  },
  fn: async ({ context }: { context: CommandContext }): Promise<CommandResult> => {
    const { flags } = parseFlags({
      args: context.args,
      booleanFlags: ['u'],
      stringFlags: [],
    });

    const now = new Date();
    const text = context.text();
    const out = flags.u ? now.toUTCString() : now.toString();
    await text.print({ text: out + '\n' });

    return { exitCode: 0, data: now.toISOString(), error: undefined };
  },
};
