import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/features/wesh/types';
import { isStandaloneCommandHelpRequest, writeCommandHelp } from '@/features/wesh/commands/_shared/usage';

export const falseCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'false',
    description: 'Do nothing unsuccessfully',
    usage: 'false [arguments...]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    if (isStandaloneCommandHelpRequest({
      args: context.args,
      acceptedForms: [['--help']],
    })) {
      await writeCommandHelp({
        context,
        command: 'false',
      });
      return { exitCode: 0 };
    }

    return { exitCode: 1 };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
