import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseFlags } from '@/services/wesh/utils/args';

export const dateCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'date',
    description: 'Print the system date and time',
    usage: 'date [-u]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
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
