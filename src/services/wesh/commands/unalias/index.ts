import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/services/wesh/types';
import { isStandaloneCommandHelpRequest, writeCommandHelp } from '@/services/wesh/commands/_shared/usage';

export const unaliasCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'unalias',
    description: 'Remove shell aliases',
    usage: 'unalias [-a] name [name ...]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    if (isStandaloneCommandHelpRequest({
      args: context.args,
      acceptedForms: [['--help']],
    })) {
      await writeCommandHelp({
        context,
        command: 'unalias',
      });
      return { exitCode: 0 };
    }

    if (context.args.length === 1 && context.args[0] === '-a') {
      for (const alias of context.getAliases()) {
        context.unsetAlias({ name: alias.name });
      }
      return { exitCode: 0 };
    }

    if (context.args.length === 0) {
      await context.text().error({ text: 'unalias: usage: unalias [-a] name [name ...]\n' });
      return { exitCode: 1 };
    }

    let exitCode = 0;
    for (const arg of context.args) {
      if (arg.startsWith('-')) {
        await context.text().error({ text: `unalias: ${arg}: invalid option\n` });
        exitCode = 2;
        continue;
      }

      const existing = context.getAliases().find((entry) => entry.name === arg);
      if (existing === undefined) {
        await context.text().error({ text: `unalias: ${arg}: not found\n` });
        exitCode = 1;
        continue;
      }

      context.unsetAlias({ name: arg });
    }

    return { exitCode };
  },
};
