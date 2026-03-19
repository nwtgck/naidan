import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';

export const whoamiCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'whoami',
    description: 'Print the user name associated with the current effective user ID',
    usage: 'whoami',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const user = context.env.get('USER') || 'user';
    const text = context.text();
    await text.print({ text: user + '\n' });
    return { exitCode: 0 };
  },
};
