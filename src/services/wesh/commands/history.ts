import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';

export const historyCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'history',
    description: 'Display the command history list',
    usage: 'history',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const text = context.text();
    const historyList = context.getHistory();
    for (let i = 0; i < historyList.length; i++) {
      const line = `${(i + 1).toString().padStart(5)}  ${historyList[i]}\n`;
      await text.print({ text: line });
    }
    return { exitCode: 0, data: historyList, error: undefined };
  },
};
