import { defineArgvCatalog, defineArgvHelpPresentation, parseStandardArgv, type ArgvOptionDefinition, type StandardArgvAction, type StandardArgvPolicy, HELP_VERSION_EARLY_EXIT_OPTIONS, stopArgvAtFirstEarlyExit, formatArgvOptionHelp, formatArgvUsageSummary } from '@/features/wesh/argv-v2';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage-output';
import type { WeshCommandImplementation, WeshCommandResult, WeshCommandContext } from '@/features/wesh/types';


const whoamiHelpOption = {
  semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
  forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<never>>;
const whoamiVersionOption = {
  semantic: { kind: 'effects', effects: [{ key: 'version', value: true }] },
  forms: [{ kind: 'long', name: 'version', value: { kind: 'none' } }],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<never>>;

const whoamiArgvCatalog = defineArgvCatalog<StandardArgvAction<never>>({
  nonExecutableLongOptions: [],
  definitions: [whoamiHelpOption, whoamiVersionOption],
});
const whoamiArgvHelp = defineArgvHelpPresentation({
  catalog: whoamiArgvCatalog,
  rows: [
    { forms: whoamiHelpOption.forms, summary: 'display this help and exit' },
    { forms: whoamiVersionOption.forms, summary: 'output version information and exit', category: 'advanced' },
  ],
});

const whoamiArgvPolicy: StandardArgvPolicy = {
  longNameMatch: 'unique-prefix',
  optionBoundary: 'continue',
  occurrenceRetention: 'none',
};

export const whoamiCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: stopArgvAtFirstEarlyExit({
        args: context.args,
        catalog: whoamiArgvCatalog,
        policy: whoamiArgvPolicy,
        earlyExitOptions: HELP_VERSION_EARLY_EXIT_OPTIONS,
      }),
      catalog: whoamiArgvCatalog,
      policy: whoamiArgvPolicy,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'whoami',
        message: `whoami: ${diagnostic.message}`,
        usageSummary: formatArgvUsageSummary({ presentation: whoamiArgvHelp }),
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'whoami',
        optionLines: formatArgvOptionHelp({ presentation: whoamiArgvHelp }),
      });
      return { exitCode: 0 };
    }

    if (parsed.optionValues.version === true) {
      await context.text().print({ text: 'whoami (Wesh coreutils) 1.0\n' });
      return { exitCode: 0 };
    }

    if (parsed.positionals.length > 0) {
      await writeCommandUsageError({
        context,
        command: 'whoami',
        message: 'whoami: too many arguments',
        usageSummary: formatArgvUsageSummary({ presentation: whoamiArgvHelp }),
      });
      return { exitCode: 1 };
    }

    const user = context.env.get('USER') || 'user';
    const text = context.text();
    await text.print({ text: user + '\n' });
    return { exitCode: 0 };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
