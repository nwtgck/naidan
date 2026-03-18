import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';

export const whichCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'which',
    description: 'Locate a command',
    usage: 'which command...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const text = context.text();
    let foundAll = true;

    for (const name of context.args) {
      const meta = context.getWeshCommandMeta({ name });
      if (meta) {
        await text.print({ text: `${name}: builtin command\n` });
      } else {
        await text.error({ text: `${name} not found\n` });
        foundAll = false;
      }
    }

    return { exitCode: foundAll ? 0 : 1 };
  },
};
