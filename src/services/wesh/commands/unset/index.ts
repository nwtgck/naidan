import { parseStandardArgv } from '@/services/wesh/argv';
import type { StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import { writeCommandHelp } from '@/services/wesh/commands/_shared/usage';
import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';

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
