import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/services/wesh/types';
import { isStandaloneCommandHelpRequest, writeCommandHelp } from '@/services/wesh/commands/_shared/usage';

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
