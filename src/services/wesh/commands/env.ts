import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';

export const envCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'env',
    description: 'Print environment variables',
    usage: 'env [name]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const text = context.text();
    const name = context.args[0];

    if (name) {
      const val = context.env.get(name);
      if (val !== undefined) {
        await text.print({ text: val + '\n' });
      }
    } else {
      for (const [key, val] of context.env) {
        await text.print({ text: `${key}=${val}\n` });
      }
    }

    return { exitCode: 0, data: Object.fromEntries(context.env), error: undefined };
  },
};
