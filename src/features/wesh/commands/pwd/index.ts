import { defineArgvCatalog, defineArgvHelpPresentation, formatArgvOptionHelp, formatArgvUsageSummary, parseStandardArgv, type ArgvOptionDefinition, type StandardArgvAction, type StandardArgvPolicy } from '@/features/wesh/argv-v2';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage-output';
import { canonicalizeExistingPath } from '@/features/wesh/path';
import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/features/wesh/types';


const pwdLogicalOption = {
  semantic: { kind: 'effects', effects: [{ key: 'mode', value: 'logical' }] },
  forms: [
    { kind: 'short', name: 'L', value: { kind: 'none' } },
    { kind: 'long', name: 'logical', value: { kind: 'none' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<never>>;
const pwdPhysicalOption = {
  semantic: { kind: 'effects', effects: [{ key: 'mode', value: 'physical' }] },
  forms: [
    { kind: 'short', name: 'P', value: { kind: 'none' } },
    { kind: 'long', name: 'physical', value: { kind: 'none' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<never>>;
const pwdHelpOption = {
  semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
  forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<never>>;

const pwdArgvCatalog = defineArgvCatalog<StandardArgvAction<never>>({
  nonExecutableLongOptions: [],
  definitions: [pwdLogicalOption, pwdPhysicalOption, pwdHelpOption],
});
const pwdArgvHelp = defineArgvHelpPresentation({
  catalog: pwdArgvCatalog,
  rows: [
    { forms: pwdLogicalOption.forms, summary: 'use the logical current directory' },
    { forms: pwdPhysicalOption.forms, summary: 'avoid symbolic links in the current directory' },
    { forms: pwdHelpOption.forms, summary: 'display this help and exit' },
  ],
});

const pwdArgvPolicy: StandardArgvPolicy = {
  longNameMatch: 'exact',
  optionBoundary: 'first-positional',
  occurrenceRetention: 'none',
};

export const pwdCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'pwd',
    description: 'Print name of current/working directory',
    usage: 'pwd [-LP]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      catalog: pwdArgvCatalog,
      policy: pwdArgvPolicy,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'pwd',
        message: `pwd: ${diagnostic.message}`,
        usageSummary: formatArgvUsageSummary({ presentation: pwdArgvHelp }),
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'pwd',
        optionLines: formatArgvOptionHelp({ presentation: pwdArgvHelp }),
      });
      return { exitCode: 0 };
    }

    const pathMode = (parsed.optionValues.mode ?? 'logical') as 'logical' | 'physical';
    const text = context.text();
    let path: string;
    try {
      path = await (async (): Promise<string> => {
        switch (pathMode) {
        case 'logical':
          return context.cwd;
        case 'physical':
          return canonicalizeExistingPath({ context, path: context.cwd });
        default: {
          const _ex: never = pathMode;
          throw new Error(`Unhandled pwd path mode: ${_ex}`);
        }
        }
      })();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await text.error({ text: `pwd: ${message}\n` });
      return { exitCode: 1 };
    }

    await text.print({ text: path + '\n' });
    return { exitCode: 0 };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
