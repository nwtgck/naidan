import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseFlags } from '@/services/wesh/utils/args';

export const echoCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'echo',
    description: 'Display a line of text',
    usage: 'echo [-n] [string...]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
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

    return { exitCode: 0 };
  },
};
