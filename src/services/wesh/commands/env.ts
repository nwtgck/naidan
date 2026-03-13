import type { CommandDefinition, CommandResult, CommandContext } from '@/services/wesh/types';

export const env: CommandDefinition = {
  meta: {
    name: 'env',
    description: 'Print environment variables',
    usage: 'env [name]',
  },
  fn: async ({ context }: { context: CommandContext }): Promise<CommandResult> => {
    const text = context.text();
    const name = context.args[0];

    if (name) {
      const val = context.env[name];
      if (val !== undefined) {
        await text.print({ text: val + '\n' });
      }
    } else {
      for (const [key, val] of Object.entries(context.env)) {
        await text.print({ text: `${key}=${val}\n` });
      }
    }

    return { exitCode: 0, data: context.env, error: undefined };
  },
};
