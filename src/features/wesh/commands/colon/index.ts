import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/features/wesh/types';
import { isStandaloneCommandHelpRequest, writeCommandHelp } from '@/features/wesh/commands/_shared/usage';

export const colonCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: ':',
    description: 'Do nothing',
    usage: ': [arguments...]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    if (isStandaloneCommandHelpRequest({
      args: context.args,
      acceptedForms: [['--help']],
    })) {
      await writeCommandHelp({
        context,
        command: ':',
      });
      return { exitCode: 0 };
    }

    return { exitCode: 0 };
  },
};
