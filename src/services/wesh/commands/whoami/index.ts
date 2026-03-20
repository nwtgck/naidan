import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';

const whoamiArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

export const whoamiCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'whoami',
    description: 'Print the user name associated with the current effective user ID',
    usage: 'whoami',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: whoamiArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'whoami',
        message: `whoami: ${diagnostic.message}`,
        argvSpec: whoamiArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'whoami',
        argvSpec: whoamiArgvSpec,
      });
      return { exitCode: 0 };
    }

    const user = context.env.get('USER') || 'user';
    const text = context.text();
    await text.print({ text: user + '\n' });
    return { exitCode: 0 };
  },
};
