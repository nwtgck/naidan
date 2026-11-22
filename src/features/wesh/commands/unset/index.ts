import { defineArgvCatalog, defineArgvHelpPresentation, formatArgvOptionHelp, formatArgvUsageSummary, parseStandardArgv, type StandardArgvAction } from '@/features/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage-output';
import { WeshReadonlyVariableError } from '@/features/wesh/shell/variables';
import type { WeshShellBuiltinFunction, WeshCommandResult } from '@/features/wesh/types';

const unsetOptions = [
  {
    forms: [{ kind: 'short', name: 'v', value: { kind: 'none' } }],
    semantic: { kind: 'effects', effects: [{ key: 'variables', value: true }] },
    summary: 'unset shell variables',
  },
  {
    forms: [{ kind: 'short', name: 'f', value: { kind: 'none' } }],
    semantic: { kind: 'effects', effects: [{ key: 'functions', value: true }] },
    summary: 'unset shell functions',
  },
  {
    forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
    semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
    summary: 'display this help and exit',
    category: 'common',
  },
] as const;

const unsetArgvCatalog = defineArgvCatalog<StandardArgvAction<never>>({ definitions: unsetOptions, nonExecutableLongOptions: [] });
const unsetArgvHelp = defineArgvHelpPresentation({ catalog: unsetArgvCatalog, rows: unsetOptions });

export const unsetCommandImplementation = {
  fn: async ({ context, shell }): Promise<WeshCommandResult> => {
    const { variables } = shell;
    const parsed = parseStandardArgv({
      args: context.args,
      catalog: unsetArgvCatalog,
      policy: { longNameMatch: 'exact', optionBoundary: 'first-positional', occurrenceRetention: 'none' },
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'unset',
        message: `unset: ${diagnostic.message}`,
        usageSummary: formatArgvUsageSummary({ presentation: unsetArgvHelp }),
      });
      return { exitCode: 2 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'unset',
        optionLines: formatArgvOptionHelp({ presentation: unsetArgvHelp }),
      });
      return { exitCode: 0 };
    }

    const unsetVariables = parsed.optionValues.variables === true;
    const unsetFunctions = parsed.optionValues.functions === true;
    if (unsetVariables && unsetFunctions) {
      await context.text().error({
        text: 'unset: cannot simultaneously unset a variable and a function\n',
      });
      return { exitCode: 1 };
    }

    if (unsetFunctions) {
      await context.text().error({
        text: 'unset: -f requires Wesh core function-state support\n',
      });
      return { exitCode: 1 };
    }

    let exitCode = 0;
    for (const name of parsed.positionals) {
      try {
        variables.unset({ name });
      } catch (error: unknown) {
        if (!(error instanceof WeshReadonlyVariableError)) {
          throw error;
        }
        await context.text().error({ text: `unset: ${name}: cannot unset: readonly variable\n` });
        exitCode = 1;
      }
    }

    return { exitCode };
  },
} satisfies { readonly fn: WeshShellBuiltinFunction<'variables'> };

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
