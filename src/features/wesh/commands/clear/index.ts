import { defineArgvCatalog, defineArgvHelpPresentation, parseStandardArgv, type ArgvOptionDefinition, type StandardArgvAction, type StandardArgvPolicy, formatArgvOptionHelp, formatArgvUsageSummary } from '@/features/wesh/argv-v2';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage-output';
import type { WeshCommandImplementation, WeshCommandResult, WeshCommandContext } from '@/features/wesh/types';

const clearKeepScrollbackOption = {
  semantic: { kind: 'effects', effects: [{ key: 'keepScrollback', value: true }] },
  forms: [{ kind: 'short', name: 'x', value: { kind: 'none' } }],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<never>>;
const clearHelpOption = {
  semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
  forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<never>>;

const clearArgvCatalog = defineArgvCatalog<StandardArgvAction<never>>({
  nonExecutableLongOptions: [],
  definitions: [clearKeepScrollbackOption, clearHelpOption],
});
const clearArgvHelp = defineArgvHelpPresentation({
  catalog: clearArgvCatalog,
  rows: [
    { forms: clearKeepScrollbackOption.forms, summary: 'do not try to clear scrollback', category: 'common' },
    { forms: clearHelpOption.forms, summary: 'display this help and exit' },
  ],
});

const clearArgvPolicy: StandardArgvPolicy = {
  longNameMatch: 'exact',
  optionBoundary: 'continue',
  occurrenceRetention: 'none',
};

export const clearCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      catalog: clearArgvCatalog,
      policy: clearArgvPolicy,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'clear',
        message: `clear: ${diagnostic.message}`,
        usageSummary: formatArgvUsageSummary({ presentation: clearArgvHelp }),
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'clear',
        optionLines: formatArgvOptionHelp({ presentation: clearArgvHelp }),
      });
      return { exitCode: 0 };
    }

    if (parsed.positionals.length > 0) {
      await writeCommandUsageError({
        context,
        command: 'clear',
        message: 'clear: too many arguments',
        usageSummary: formatArgvUsageSummary({ presentation: clearArgvHelp }),
      });
      return { exitCode: 1 };
    }

    const text = context.text();
    const eraseDisplay = '\x1b[H\x1b[2J';
    const eraseScrollback = parsed.optionValues.keepScrollback === true ? '' : '\x1b[3J';
    await text.print({ text: eraseDisplay + eraseScrollback });
    return { exitCode: 0 };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
