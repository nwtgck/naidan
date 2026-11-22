import type { WeshBuiltinCommandContext, WeshShellBuiltinFunction, WeshCommandResult } from '@/features/wesh/types';
import { formatAliasDefinition, isValidAliasName } from '@/features/wesh/commands/_shared/alias';
import { isStandaloneCommandHelpRequest, writeCommandHelp } from '@/features/wesh/commands/_shared/usage-output';

async function printAliases({ context, aliases }: {
  context: WeshBuiltinCommandContext,
  aliases: readonly { name: string, value: string }[],
}): Promise<void> {
  for (const alias of aliases) {
    await context.text().print({
      text: formatAliasDefinition({
        name: alias.name,
        value: alias.value,
      }),
    });
  }
}

export const aliasCommandImplementation = {
  fn: async ({ context, shell }): Promise<WeshCommandResult> => {
    if (isStandaloneCommandHelpRequest({
      args: context.args,
      acceptedForms: [['--help']],
    })) {
      await writeCommandHelp({ context, command: 'alias', optionLines: [] });
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

    const aliasesBeforeOperands = shell.getAliases();
    if (printAll) {
      await printAliases({ context, aliases: aliasesBeforeOperands });
      // Bash skips every remaining operand when `-p` is used with an empty alias table.
      if (aliasesBeforeOperands.length === 0) {
        return { exitCode: 0 };
      }
    }

    const operands = context.args.slice(operandIndex);
    if (operands.length === 0) {
      if (!printAll) {
        await printAliases({ context, aliases: aliasesBeforeOperands });
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
        shell.setAlias({ name, value });
        continue;
      }

      const existing = shell.getAliases().find(entry => entry.name === arg);
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
} satisfies { readonly fn: WeshShellBuiltinFunction<'getAliases' | 'setAlias'> };

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
