import { defineArgvCatalog, defineArgvHelpPresentation, formatArgvOptionHelp, formatArgvUsageSummary, parseStandardArgv, type StandardArgvAction, type StandardArgvPolicy } from '@/features/wesh/argv-v2';
import { isStandaloneCommandHelpRequest, writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage-output';
import type { WeshShellBuiltinFunction } from '@/features/wesh/types';


const execOptions = [
  {
    semantic: { kind: 'effects', effects: [{ key: 'clearEnvironment', value: true }] },
    forms: [{ kind: 'short', name: 'c', value: { kind: 'none' } }],
    summary: 'execute command with an empty environment',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'loginShellArgv0', value: true }] },
    forms: [{ kind: 'short', name: 'l', value: { kind: 'none' } }],
    summary: 'prefix argv[0] with a dash',
    category: 'common',
  },
  {
    semantic: { kind: 'required-value', key: 'argv0', parse: undefined },
    forms: [{ kind: 'short', name: 'a', value: { kind: 'required-attached-or-following', missingValueName: 'NAME' } }],
    summary: 'pass NAME as argv[0]',
    category: 'common',
    valueName: 'NAME',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
    forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
    summary: 'display this help and exit',
    category: 'common',
  },
] as const;

const execArgvCatalog = defineArgvCatalog<StandardArgvAction<never>>({
  definitions: execOptions,
  nonExecutableLongOptions: [],
});
const execArgvHelp = defineArgvHelpPresentation({ catalog: execArgvCatalog, rows: execOptions });
const execArgvPolicy: StandardArgvPolicy = {
  longNameMatch: 'exact',
  optionBoundary: 'first-positional',
  occurrenceRetention: 'none',
};

export const execCommandImplementation = {
  fn: async ({ context, shell }) => {
    if (isStandaloneCommandHelpRequest({
      args: context.args,
      acceptedForms: [['--help']],
    })) {
      await writeCommandHelp({
        context,
        command: 'exec',
        optionLines: formatArgvOptionHelp({ presentation: execArgvHelp }),
      });
      return { exitCode: 0 };
    }

    const parsed = parseStandardArgv({
      args: context.args,
      catalog: execArgvCatalog,
      policy: execArgvPolicy,
    });
    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'exec',
        message: `exec: ${diagnostic.message}`,
        usageSummary: formatArgvUsageSummary({ presentation: execArgvHelp }),
      });
      return { exitCode: 2 };
    }

    const [command, ...args] = parsed.positionals;
    if (command === undefined) {
      await shell.persistFileDescriptors();
      return { exitCode: 0 };
    }
    const { optionValues } = parsed;
    return shell.exec({
      command,
      args,
      argv0: typeof optionValues.argv0 === 'string' ? optionValues.argv0 : undefined,
      login: optionValues.loginShellArgv0 === true,
      clearEnvironment: optionValues.clearEnvironment === true,
    });
  },
} satisfies { readonly fn: WeshShellBuiltinFunction<'exec' | 'persistFileDescriptors'> };

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
