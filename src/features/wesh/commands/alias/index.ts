import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/features/wesh/types';
import { formatAliasDefinition, isValidAliasName } from '@/features/wesh/commands/_shared/alias';
import { isStandaloneCommandHelpRequest, writeCommandHelp } from '@/features/wesh/commands/_shared/usage';

async function printAliases({ context }: { context: WeshCommandContext }): Promise<void> {
  for (const alias of context.getAliases()) {
    await context.text().print({
      text: formatAliasDefinition({
        name: alias.name,
        value: alias.value,
      }),
    });
  }
}

export const aliasCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'alias',
    description: 'Define or display shell aliases',
    usage: 'alias [-p] [name[=value] ...]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    if (isStandaloneCommandHelpRequest({
      args: context.args,
      acceptedForms: [['--help']],
    })) {
      await writeCommandHelp({ context, command: 'alias' });
      return { exitCode: 0 };
    }

    let printAll = false;
    let optionsEnded = false;
    let operandIndex = 0;
    while (operandIndex < context.args.length) {
      const arg = context.args[operandIndex];
      if (arg === undefined || optionsEnded) {
        break;
      }
      if (arg === '--') {
        optionsEnded = true;
        operandIndex += 1;
        break;
      }
      if (arg === '-p') {
        printAll = true;
        operandIndex += 1;
        continue;
      }
      if (arg.startsWith('-') && arg !== '-') {
        await context.text().error({ text: `alias: ${arg}: invalid option\n` });
        await context.text().error({ text: 'alias: usage: alias [-p] [name[=value] ...]\n' });
        return { exitCode: 2 };
      }
      break;
    }

    const aliasesBeforeOperands = context.getAliases();
    if (printAll) {
      await printAliases({ context });
      // Bash skips every remaining operand when `-p` is used with an empty alias table.
      if (aliasesBeforeOperands.length === 0) {
        return { exitCode: 0 };
      }
    }

    const operands = context.args.slice(operandIndex);
    if (operands.length === 0) {
      if (!printAll) {
        await printAliases({ context });
      }
      return { exitCode: 0 };
    }

    let exitCode = 0;
    for (const arg of operands) {
      const equalsIndex = arg.indexOf('=');
      if (equalsIndex >= 0) {
        const name = arg.slice(0, equalsIndex);
        const value = arg.slice(equalsIndex + 1);
        if (!isValidAliasName({ name, allowLeadingHyphen: optionsEnded })) {
          await context.text().error({ text: `alias: ${name}: invalid alias name\n` });
          exitCode = 1;
          continue;
        }
        context.setAlias({ name, value });
        continue;
      }

      const existing = context.getAliases().find(entry => entry.name === arg);
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

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
