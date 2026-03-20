import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';

const dateArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: 'u', long: undefined, effects: [{ key: 'utc', value: true }], help: { summary: 'display the time in UTC' } },
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: false,
  specialTokenParsers: [],
};

export const dateCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'date',
    description: 'Print the system date and time',
    usage: 'date [-u]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: dateArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'date',
        message: `date: ${diagnostic.message}`,
        argvSpec: dateArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'date',
        argvSpec: dateArgvSpec,
      });
      return { exitCode: 0 };
    }

    const now = new Date();
    const text = context.text();
    const out = parsed.optionValues.utc === true ? now.toUTCString() : now.toString();
    await text.print({ text: out + '\n' });

    return { exitCode: 0 };
  },
};
