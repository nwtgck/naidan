import type { WeshShellBuiltinFunction, WeshCommandResult, WeshBuiltinCommandContext } from '@/features/wesh/types';
import { defineArgvCatalog, defineArgvHelpPresentation, formatArgvOptionHelp, formatArgvUsageSummary, parseStandardArgv, type StandardArgvAction, type StandardArgvPolicy } from '@/features/wesh/argv-v2';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage-output';
import { compareAsciiStrings } from '@/features/wesh/commands/_shared/ascii-order';
import { WeshReadonlyVariableError } from '@/features/wesh/shell/variables';

const exportOptions = [
  {
    semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
    forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
    summary: 'display this help and exit',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'print', value: true }] },
    forms: [{ kind: 'short', name: 'p', value: { kind: 'none' } }],
    summary: 'show exported names and values in a reusable format',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'unexport', value: true }] },
    forms: [{ kind: 'short', name: 'n', value: { kind: 'none' } }],
    summary: 'remove the export attribute from each name',
    category: 'common',
  },
] as const;

const exportArgvCatalog = defineArgvCatalog<StandardArgvAction<never>>({
  definitions: exportOptions,
  nonExecutableLongOptions: [],
});
const exportArgvHelp = defineArgvHelpPresentation({ catalog: exportArgvCatalog, rows: exportOptions });
const exportArgvPolicy: StandardArgvPolicy = {
  longNameMatch: 'exact',
  optionBoundary: 'first-positional',
  occurrenceRetention: 'none',
};

async function printExportedVariables({ context, exports }: {
  context: WeshBuiltinCommandContext,
  exports: Iterable<[string, string | undefined]>,
}): Promise<void> {
  for (const [key, value] of [...exports].sort(([left], [right]) => compareAsciiStrings({ left, right }))) {
    const declaration = value === undefined ? `export ${key}` : `export ${key}='${value.replaceAll("'", "'\\''")}'`;
    await context.text().print({ text: `${declaration}\n` });
  }
}

export const exportCmdCommandImplementation = {
  fn: async ({ context, shell }): Promise<WeshCommandResult> => {
    const { variables } = shell;
    const parsed = parseStandardArgv({
      args: context.args,
      catalog: exportArgvCatalog,
      policy: exportArgvPolicy,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'export',
        message: `export: ${diagnostic.message}`,
        usageSummary: formatArgvUsageSummary({ presentation: exportArgvHelp }),
      });
      return { exitCode: 2 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'export',
        optionLines: formatArgvOptionHelp({ presentation: exportArgvHelp }),
      });
      return { exitCode: 0 };
    }

    const printVariables = parsed.optionValues.print === true || parsed.positionals.length === 0;
    if (printVariables) {
      await printExportedVariables({ context, exports: variables.exportDeclarations() });
    }
    if (parsed.positionals.length === 0) {
      return { exitCode: 0 };
    }

    const unexport = parsed.optionValues.unexport === true;
    let exitCode = 0;
    for (const argument of parsed.positionals) {
      const equalsIndex = argument.indexOf('=');
      const key = equalsIndex < 0
        ? argument
        : argument.slice(0, equalsIndex);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
        await context.text().error({
          text: `export: \`${argument}': not a valid identifier\n`,
        });
        exitCode = 1;
        continue;
      }
      const value = equalsIndex < 0
        ? undefined
        : argument.slice(equalsIndex + 1);
      try {
        variables.setExport({ name: key, value, exported: !unexport });
      } catch (error: unknown) {
        if (!(error instanceof WeshReadonlyVariableError)) {
          throw error;
        }
        await context.text().error({ text: `export: ${error.message}\n` });
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
