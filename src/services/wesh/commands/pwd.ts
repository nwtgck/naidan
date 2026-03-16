import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';

export const pwdCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'pwd',
    description: 'Print name of current/working directory',
    usage: 'pwd',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const text = context.text();
    await text.print({ text: context.cwd + '\n' });
    return { exitCode: 0, data: context.cwd, error: undefined };
  },
};
