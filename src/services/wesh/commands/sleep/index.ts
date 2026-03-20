import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import { writeCommandHelp } from '@/services/wesh/commands/_shared/usage';
import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';

const sleepArgvSpec: StandardArgvParserSpec = {
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

export const sleepCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'sleep',
    description: 'Delay for a specified amount of time',
    usage: 'sleep number',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: sleepArgvSpec,
    });

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'sleep',
        argvSpec: sleepArgvSpec,
      });
      return { exitCode: 0 };
    }

    const seconds = parseFloat(context.args[0] || '0');
    if (isNaN(seconds)) {
      await writeCommandUsageError({
        context,
        command: 'sleep',
        message: `sleep: invalid time interval '${context.args[0]}'`,
        argvSpec: sleepArgvSpec,
      });
      return { exitCode: 1 };
    }

    await new Promise(resolve => setTimeout(resolve, seconds * 1000));
    return { exitCode: 0 };
  },
};
