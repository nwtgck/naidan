import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';

export const unsetCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'unset',
    description: 'Unset environment variables',
    usage: 'unset name...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const text = context.text();
    if (context.args.length === 0) {
      await text.error({ text: 'unset: missing operand\n' });
      return { exitCode: 1 };
    }

    for (const name of context.args) {
      context.unsetEnv({ key: name });
    }

    return { exitCode: 0 };
  },
};
