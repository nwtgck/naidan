import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';

export const unsetCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'unset',
    description: 'Unset environment variables',
    usage: 'unset name...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    if (context.args.length === 0) {
      await writeCommandUsageError({
        context,
        command: 'unset',
        message: 'unset: missing operand',
      });
      return { exitCode: 1 };
    }

    for (const name of context.args) {
      context.unsetEnv({ key: name });
    }

    return { exitCode: 0 };
  },
};
