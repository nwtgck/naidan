import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseFlags } from '@/services/wesh/utils/args';

export const commandCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'command',
    description: 'Run command with arguments, ignoring any function or alias',
    usage: 'command [-v] command [argument...]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const { flags, positional } = parseFlags({
      args: context.args,
      booleanFlags: ['v'],
      stringFlags: [],
    });

    const text = context.text();
    if (positional.length === 0) return { exitCode: 0 };

    const cmdName = positional[0]!;
    const meta = context.getWeshCommandMeta({ name: cmdName });

    if (flags.v) {
      if (meta) {
        await text.print({ text: `${cmdName}\n` });
        return { exitCode: 0 };
      }
      return { exitCode: 1 };
    }

    if (!meta) {
      await text.error({ text: `command: ${cmdName} not found\n` });
      return { exitCode: 1 };
    }

    return { exitCode: 0 };
  },
};
