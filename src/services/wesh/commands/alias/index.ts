import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/services/wesh/types';
import { formatAliasDefinition, isValidAliasName } from '@/services/wesh/commands/_shared/alias';
import { isStandaloneCommandHelpRequest, writeCommandHelp } from '@/services/wesh/commands/_shared/usage';

export const aliasCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'alias',
    description: 'Define or display shell aliases',
    usage: 'alias [name[=value] ...]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    if (isStandaloneCommandHelpRequest({
      args: context.args,
      acceptedForms: [['--help']],
    })) {
      await writeCommandHelp({
        context,
        command: 'alias',
      });
      return { exitCode: 0 };
    }

    if (context.args.length === 0) {
      for (const alias of context.getAliases()) {
        await context.text().print({
          text: formatAliasDefinition({
            name: alias.name,
            value: alias.value,
          }),
        });
      }
      return { exitCode: 0 };
    }

    let exitCode = 0;
    for (const arg of context.args) {
      const equalsIndex = arg.indexOf('=');
      if (equalsIndex >= 0) {
        const name = arg.slice(0, equalsIndex);
        const value = arg.slice(equalsIndex + 1);
        if (!isValidAliasName({ name })) {
          await context.text().error({ text: `alias: ${name}: invalid alias name\n` });
          exitCode = 1;
          continue;
        }
        context.setAlias({ name, value });
        continue;
      }

      const existing = context.getAliases().find((entry) => entry.name === arg);
      if (existing === undefined) {
        await context.text().error({ text: `alias: ${arg}: not found\n` });
        exitCode = 1;
        continue;
      }

      await context.text().print({
        text: formatAliasDefinition({
          name: existing.name,
          value: existing.value,
        }),
      });
    }

    return { exitCode };
  },
};
