import { defineArgvCatalog, defineArgvHelpPresentation, formatArgvOptionHelp, formatArgvUsageSummary, parseStandardArgv, type StandardArgvAction } from '@/features/wesh/argv-v2';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage-output';
import type { WeshShellBuiltinFunction } from '@/features/wesh/types';

const evalOptions = [
  {
    forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
    semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
    summary: 'display this help and exit',
    category: 'common',
  },
] as const;

const evalArgvCatalog = defineArgvCatalog<StandardArgvAction<never>>({ definitions: evalOptions, nonExecutableLongOptions: [] });
const evalArgvHelp = defineArgvHelpPresentation({ catalog: evalArgvCatalog, rows: evalOptions });

export const evalCommandImplementation = {
  fn: async ({ context, shell }) => {
    const parsed = parseStandardArgv({
      args: context.args,
      catalog: evalArgvCatalog,
      policy: { longNameMatch: 'exact', optionBoundary: 'first-positional', occurrenceRetention: 'none' },
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'eval',
        message: `eval: ${diagnostic.message}`,
        usageSummary: formatArgvUsageSummary({ presentation: evalArgvHelp }),
      });
      return { exitCode: 2 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'eval',
        optionLines: formatArgvOptionHelp({ presentation: evalArgvHelp }),
      });
      return { exitCode: 2 };
    }

    if (parsed.positionals.length === 0) {
      return { exitCode: 0 };
    }

    return shell.evaluateSource({ script: parsed.positionals.join(' ') });
  },
} satisfies { readonly fn: WeshShellBuiltinFunction<'evaluateSource'> };

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
