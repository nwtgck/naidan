import { defineArgvCatalog, defineArgvHelpPresentation, parseStandardArgv, type ArgvOptionDefinition, type StandardArgvAction, type StandardArgvPolicy, HELP_EARLY_EXIT_OPTIONS, stopArgvAtFirstEarlyExit, formatArgvOptionHelp, formatArgvUsageSummary } from '@/features/wesh/argv-v2';
import type { WeshCommandContext, WeshCommandImplementation, WeshCommandResult } from '@/features/wesh/types';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage-output';
import { dirnamePath } from '@/features/wesh/commands/_shared/path';

const dirnameHelpOption = {
  semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
  forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<never>>;
const dirnameZeroOption = {
  semantic: { kind: 'effects', effects: [{ key: 'zero', value: true }] },
  forms: [
    { kind: 'short', name: 'z', value: { kind: 'none' } },
    { kind: 'long', name: 'zero', value: { kind: 'none' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<never>>;
const dirnameArgvCatalog = defineArgvCatalog<StandardArgvAction<never>>({ nonExecutableLongOptions: ['version'], definitions: [dirnameHelpOption, dirnameZeroOption] });
const dirnameArgvHelp = defineArgvHelpPresentation({
  catalog: dirnameArgvCatalog,
  rows: [
    { forms: dirnameZeroOption.forms, summary: 'end each output line with NUL, not newline', category: 'common' },
    { forms: dirnameHelpOption.forms, summary: 'display this help and exit', category: 'common' },
  ],
});
const dirnameArgvPolicy: StandardArgvPolicy = {
  longNameMatch: 'unique-prefix',
  optionBoundary: 'continue',
  occurrenceRetention: 'none',
};

export const dirnameCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: stopArgvAtFirstEarlyExit({
        args: context.args,
        catalog: dirnameArgvCatalog,
        policy: dirnameArgvPolicy,
        earlyExitOptions: HELP_EARLY_EXIT_OPTIONS,
      }),
      catalog: dirnameArgvCatalog,
      policy: dirnameArgvPolicy,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'dirname',
        message: `dirname: ${diagnostic.message}`,
        usageSummary: formatArgvUsageSummary({ presentation: dirnameArgvHelp }),
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'dirname',
        optionLines: formatArgvOptionHelp({ presentation: dirnameArgvHelp }),
      });
      return { exitCode: 0 };
    }

    if (parsed.positionals.length === 0) {
      await writeCommandUsageError({
        context,
        command: 'dirname',
        message: 'dirname: missing operand',
        usageSummary: formatArgvUsageSummary({ presentation: dirnameArgvHelp }),
      });
      return { exitCode: 1 };
    }

    const separator = parsed.optionValues.zero === true ? '\0' : '\n';
    const text = context.text();
    for (const name of parsed.positionals) {
      await text.print({
        text: `${dirnamePath({ path: name })}${separator}`,
      });
    }

    return { exitCode: 0 };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
