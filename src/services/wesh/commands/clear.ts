import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';

export const clearCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'clear',
    description: 'Clear the terminal screen',
    usage: 'clear',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const text = context.text();
    /** Standard clear escape code */
    await text.print({ text: '\x1b[2J\x1b[H' });
    return { exitCode: 0 };
  },
};
