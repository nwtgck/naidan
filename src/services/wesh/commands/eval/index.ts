import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/services/wesh/types';

const evalArgvSpec: StandardArgvParserSpec = {
  options: [
    {
      kind: 'flag',
      short: undefined,
      long: 'help',
      effects: [{ key: 'help', value: true }],
      help: { summary: 'display this help and exit', category: 'common' },
    },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

export const evalCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'eval',
    description: 'Evaluate arguments as shell code',
    usage: 'eval [arg...]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: evalArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'eval',
        message: `eval: ${diagnostic.message}`,
        argvSpec: evalArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'eval',
        argvSpec: evalArgvSpec,
      });
      return { exitCode: 0 };
    }

    if (parsed.positionals.length === 0) {
      return { exitCode: 0 };
    }

    return context.executeShell({
      script: parsed.positionals.join(' '),
    });
  },
};
