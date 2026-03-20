import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';

export const sleepCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'sleep',
    description: 'Delay for a specified amount of time',
    usage: 'sleep number',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const seconds = parseFloat(context.args[0] || '0');
    if (isNaN(seconds)) {
      await writeCommandUsageError({
        context,
        command: 'sleep',
        message: `sleep: invalid time interval '${context.args[0]}'`,
      });
      return { exitCode: 1 };
    }

    await new Promise(resolve => setTimeout(resolve, seconds * 1000));
    return { exitCode: 0 };
  },
};
