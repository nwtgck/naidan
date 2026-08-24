import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/features/wesh/types';
import { isStandaloneCommandHelpRequest, writeCommandHelp } from '@/features/wesh/commands/_shared/usage';

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
      await writeCommandHelp({ context, command: 'unalias' });
      return { exitCode: 0 };
    }

    let removeAll = false;
    let operandIndex = 0;
    while (operandIndex < context.args.length) {
      const arg = context.args[operandIndex];
      if (arg === undefined) {
        break;
      }
      if (arg === '--') {
        operandIndex += 1;
        break;
      }
      if (arg === '-a') {
        removeAll = true;
        operandIndex += 1;
        continue;
      }
      if (arg.startsWith('-') && arg !== '-') {
        await context.text().error({ text: `unalias: ${arg}: invalid option\n` });
        await context.text().error({ text: 'unalias: usage: unalias [-a] name [name ...]\n' });
        return { exitCode: 2 };
      }
      break;
    }

    if (removeAll) {
      for (const alias of context.getAliases()) {
        context.unsetAlias({ name: alias.name });
      }
      return { exitCode: 0 };
    }

    const operands = context.args.slice(operandIndex);
    if (operands.length === 0) {
      await context.text().error({ text: 'unalias: usage: unalias [-a] name [name ...]\n' });
      return { exitCode: 2 };
    }

    let exitCode = 0;
    for (const name of operands) {
      const existing = context.getAliases().find(entry => entry.name === name);
      if (existing === undefined) {
        await context.text().error({ text: `unalias: ${name}: not found\n` });
        exitCode = 1;
        continue;
      }

      context.unsetAlias({ name });
    }

    return { exitCode };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
