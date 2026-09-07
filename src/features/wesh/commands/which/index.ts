import { defineArgvCatalog, defineArgvHelpPresentation, parseStandardArgv, type ArgvOptionDefinition, type StandardArgvAction, type StandardArgvPolicy, formatArgvOptionHelp, formatArgvUsageSummary } from '@/features/wesh/argv-v2';
import { formatResolvedCommand, resolveCommands } from '@/features/wesh/command-resolution';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage-output';

import type { WeshCommandContext, WeshCommandImplementation, WeshCommandResult } from '@/features/wesh/types';

const whichAllOption = {
  semantic: { kind: 'effects', effects: [{ key: 'all', value: true }] },
  forms: [{ kind: 'short', name: 'a', value: { kind: 'none' } }],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<never>>;
const whichSilentOption = {
  semantic: { kind: 'effects', effects: [{ key: 'silent', value: true }] },
  forms: [{ kind: 'short', name: 's', value: { kind: 'none' } }],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<never>>;
const whichHelpOption = {
  semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
  forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<never>>;
const whichArgvCatalog = defineArgvCatalog<StandardArgvAction<never>>({
  nonExecutableLongOptions: [],
  definitions: [whichAllOption, whichSilentOption, whichHelpOption],
});
const whichArgvHelp = defineArgvHelpPresentation({
  catalog: whichArgvCatalog,
  rows: [
    { forms: whichAllOption.forms, summary: 'print all matching command locations', category: 'common' },
    { forms: whichSilentOption.forms, summary: 'return status only without printing locations', category: 'common' },
    { forms: whichHelpOption.forms, summary: 'display this help and exit', category: 'common' },
  ],
});
const whichArgvPolicy: StandardArgvPolicy = {
  longNameMatch: 'exact',
  optionBoundary: 'first-positional',
  occurrenceRetention: 'none',
};

export const whichCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      catalog: whichArgvCatalog,
      policy: whichArgvPolicy,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'which',
        message: `which: ${diagnostic.message}`,
        usageSummary: formatArgvUsageSummary({ presentation: whichArgvHelp }),
      });
      return { exitCode: 2 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'which',
        optionLines: formatArgvOptionHelp({ presentation: whichArgvHelp }),
      });
      return { exitCode: 0 };
    }

    if (parsed.positionals.length === 0) {
      return { exitCode: 1 };
    }

    const text = context.text();
    const includeAll = parsed.optionValues.all === true;
    const silent = parsed.optionValues.silent === true;
    let foundAll = true;

    for (const name of parsed.positionals) {
      const matches = (await resolveCommands({
        context,
        name,
      })).filter(resolved => resolved.kind !== 'file' || resolved.executable);
      if (matches.length === 0) {
        foundAll = false;
        continue;
      }

      if (silent) {
        continue;
      }

      const selectedMatches = includeAll ? matches : matches.slice(0, 1);
      for (const resolved of selectedMatches) {
        const formatted = formatResolvedCommand({
          resolved,
          mode: 'which',
        });
        if (formatted !== undefined) {
          await text.print({ text: `${formatted}\n` });
        }
      }
    }

    return { exitCode: foundAll ? 0 : 1 };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
