import { defineArgvCatalog, defineArgvHelpPresentation, parseStandardArgv, type ArgvOptionDefinition, type StandardArgvAction, type StandardArgvPolicy, HELP_EARLY_EXIT_OPTIONS, stopArgvAtFirstEarlyExit, formatArgvOptionHelp, formatArgvUsageSummary } from '@/features/wesh/argv-v2';
import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/features/wesh/types';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage-output';
import { basenamePath } from '@/features/wesh/commands/_shared/path';

const basenameHelpOption = {
  semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
  forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<never>>;
const basenameMultipleOption = {
  semantic: { kind: 'effects', effects: [{ key: 'multiple', value: true }] },
  forms: [
    { kind: 'short', name: 'a', value: { kind: 'none' } },
    { kind: 'long', name: 'multiple', value: { kind: 'none' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<never>>;
const basenameSuffixOption = {
  semantic: { kind: 'required-value', key: 'suffix', parse: undefined },
  forms: [
    { kind: 'short', name: 's', value: { kind: 'required-attached-or-following', missingValueName: 'SUFFIX' } },
    { kind: 'long', name: 'suffix', value: { kind: 'required', missingValueName: 'SUFFIX' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<never>>;
const basenameZeroOption = {
  semantic: { kind: 'effects', effects: [{ key: 'zero', value: true }] },
  forms: [
    { kind: 'short', name: 'z', value: { kind: 'none' } },
    { kind: 'long', name: 'zero', value: { kind: 'none' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<never>>;
const basenameArgvCatalog = defineArgvCatalog<StandardArgvAction<never>>({
  nonExecutableLongOptions: ['version'],
  definitions: [basenameHelpOption, basenameMultipleOption, basenameSuffixOption, basenameZeroOption],
});
const basenameArgvHelp = defineArgvHelpPresentation({
  catalog: basenameArgvCatalog,
  rows: [
    { forms: basenameMultipleOption.forms, summary: 'support multiple arguments and treat each as NAME', category: 'common' },
    { forms: basenameSuffixOption.forms, summary: 'remove a trailing SUFFIX; implies -a', valueName: 'SUFFIX', category: 'common' },
    { forms: basenameZeroOption.forms, summary: 'end each output line with NUL, not newline', category: 'common' },
    { forms: basenameHelpOption.forms, summary: 'display this help and exit', category: 'common' },
  ],
});
const basenameArgvPolicy: StandardArgvPolicy = {
  longNameMatch: 'unique-prefix',
  optionBoundary: 'first-positional',
  occurrenceRetention: 'none',
};

export const basenameCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'basename',
    description: 'Strip directory and suffix from filenames',
    usage: 'basename [OPTION]... NAME...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: stopArgvAtFirstEarlyExit({
        args: context.args,
        catalog: basenameArgvCatalog,
        policy: basenameArgvPolicy,
        earlyExitOptions: HELP_EARLY_EXIT_OPTIONS,
      }),
      catalog: basenameArgvCatalog,
      policy: basenameArgvPolicy,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'basename',
        message: `basename: ${diagnostic.message}`,
        usageSummary: formatArgvUsageSummary({ presentation: basenameArgvHelp }),
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'basename',
        optionLines: formatArgvOptionHelp({ presentation: basenameArgvHelp }),
      });
      return { exitCode: 0 };
    }

    const suffixValue = typeof parsed.optionValues.suffix === 'string' ? parsed.optionValues.suffix : undefined;
    const multiple = parsed.optionValues.multiple === true || suffixValue !== undefined;
    const zero = parsed.optionValues.zero === true;
    const separator = zero ? '\0' : '\n';
    const text = context.text();

    if (parsed.positionals.length === 0) {
      await writeCommandUsageError({
        context,
        command: 'basename',
        message: 'basename: missing operand',
        usageSummary: formatArgvUsageSummary({ presentation: basenameArgvHelp }),
      });
      return { exitCode: 1 };
    }

    if (!multiple && parsed.positionals.length > 2) {
      await writeCommandUsageError({
        context,
        command: 'basename',
        message: 'basename: extra operand',
        usageSummary: formatArgvUsageSummary({ presentation: basenameArgvHelp }),
      });
      return { exitCode: 1 };
    }

    const suffix = suffixValue ?? (multiple ? undefined : parsed.positionals[1]);
    const names = multiple ? parsed.positionals : [parsed.positionals[0]!];

    for (const name of names) {
      await text.print({
        text: `${basenamePath({ path: name, suffix })}${separator}`,
      });
    }

    return { exitCode: 0 };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
