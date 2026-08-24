import { parseStandardArgv } from '@/features/wesh/argv';
import type { StandardArgvParserSpec } from '@/features/wesh/argv';
import { writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import { getOptionalCoreMethod } from '@/features/wesh/commands/_shared/core-capability';
import { writeCommandHelp } from '@/features/wesh/commands/_shared/usage';
import { stopStandardOptionParsingAtFirstPositional } from '@/features/wesh/commands/_shared/argv';
import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/features/wesh/types';

const unsetArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: 'v', long: undefined, effects: [{ key: 'variables', value: true }], help: { summary: 'unset shell variables' } },
    { kind: 'flag', short: 'f', long: undefined, effects: [{ key: 'functions', value: true }], help: { summary: 'unset shell functions' } },
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

export const unsetCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'unset',
    description: 'Unset environment variables',
    usage: 'unset [-v] [-f] [name ...]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: stopStandardOptionParsingAtFirstPositional({
        args: context.args,
        spec: unsetArgvSpec,
      }),
      spec: unsetArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'unset',
        message: `unset: ${diagnostic.message}`,
        argvSpec: unsetArgvSpec,
      });
      return { exitCode: 2 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'unset',
        argvSpec: unsetArgvSpec,
      });
      return { exitCode: 0 };
    }

    const unsetVariables = parsed.optionValues.variables === true;
    const unsetFunctions = parsed.optionValues.functions === true;
    if (unsetVariables && unsetFunctions) {
      await context.text().error({
        text: 'unset: cannot simultaneously unset a variable and a function\n',
      });
      return { exitCode: 1 };
    }

    const unsetFunction = unsetFunctions
      ? getOptionalCoreMethod<({ name }: { name: string }) => void>({
        object: context,
        name: 'unsetFunction',
      })
      : undefined;
    if (unsetFunctions && unsetFunction === undefined) {
      await context.text().error({
        text: 'unset: -f requires Wesh core function-state support\n',
      });
      return { exitCode: 1 };
    }

    for (const name of parsed.positionals) {
      if (unsetFunction !== undefined) {
        unsetFunction({ name });
      } else {
        context.unsetEnv({ key: name });
      }
    }

    return { exitCode: 0 };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
