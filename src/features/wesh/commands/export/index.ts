import type { WeshCommandImplementation, WeshCommandResult, WeshCommandContext } from '@/features/wesh/types';
import { parseStandardArgv } from '@/features/wesh/argv';
import type { StandardArgvParserSpec } from '@/features/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import { compareAsciiStrings } from '@/features/wesh/commands/_shared/ascii-order';
import { stopStandardOptionParsingAtFirstPositional } from '@/features/wesh/commands/_shared/argv';

const exportArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
    { kind: 'flag', short: 'p', long: undefined, effects: [{ key: 'print', value: true }], help: { summary: 'show exported names and values in a reusable format', category: 'common' } },
    { kind: 'flag', short: 'n', long: undefined, effects: [{ key: 'unexport', value: true }], help: { summary: 'remove the export attribute from each name', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

async function printExportedVariables({ context }: { context: WeshCommandContext }): Promise<void> {
  for (const [key, value] of [...context.env.entries()].sort(([left], [right]) => compareAsciiStrings({ left, right }))) {
    const declaration = `export ${key}='${value.replaceAll("'", "'\\''")}'`;
    await context.text().print({ text: `${declaration}\n` });
  }
}

export const exportCmdCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: stopStandardOptionParsingAtFirstPositional({ args: context.args, spec: exportArgvSpec }),
      spec: exportArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'export',
        message: `export: ${diagnostic.message}`,
        argvSpec: exportArgvSpec,
      });
      return { exitCode: 2 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'export',
        argvSpec: exportArgvSpec,
      });
      return { exitCode: 0 };
    }

    const printVariables = parsed.optionValues.print === true || parsed.positionals.length === 0;
    if (printVariables) {
      await printExportedVariables({ context });
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
      if (unexport) {
        if (value !== undefined) {
          context.setEnv({ key, value });
        }
        await context.text().error({
          text: 'export: -n requires Wesh core export-state support\n',
        });
        exitCode = 1;
      } else if (value !== undefined) {
        context.setEnv({ key, value });
      }
    }

    return { exitCode };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
