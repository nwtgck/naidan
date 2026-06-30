import { parseStandardArgv } from '@/features/wesh/argv';
import type { StandardArgvParserSpec } from '@/features/wesh/argv';
import { writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import { writeCommandHelp } from '@/features/wesh/commands/_shared/usage';
import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/features/wesh/types';

const unsetArgvSpec: StandardArgvParserSpec = {
  options: [
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
    usage: 'unset name...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
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
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'unset',
        argvSpec: unsetArgvSpec,
      });
      return { exitCode: 0 };
    }

    if (parsed.positionals.length === 0) {
      await writeCommandUsageError({
        context,
        command: 'unset',
        message: 'unset: missing operand',
        argvSpec: unsetArgvSpec,
      });
      return { exitCode: 1 };
    }

    for (const name of parsed.positionals) {
      context.unsetEnv({ key: name });
    }

    return { exitCode: 0 };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
