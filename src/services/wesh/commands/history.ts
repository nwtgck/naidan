import type { CommandDefinition, CommandResult, CommandContext } from '../types';

export const history: CommandDefinition = {
  meta: {
    name: 'history',
    description: 'Display the command history list',
    usage: 'history',
  },
  fn: async ({ context }: { context: CommandContext }): Promise<CommandResult> => {
    const text = context.text();
    const historyList = context.getHistory();
    for (let i = 0; i < historyList.length; i++) {
      const line = `${(i + 1).toString().padStart(5)}  ${historyList[i]}\n`;
      await text.print({ text: line });
    }
    return { exitCode: 0, data: historyList, error: undefined };
  },
};
