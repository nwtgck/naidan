import { parseStandardArgv } from '@/services/wesh/argv';
import type { StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';

const historyArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

export const historyCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'history',
    description: 'Display the command history list',
    usage: 'history',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: historyArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'history',
        message: `history: ${diagnostic.message}`,
        argvSpec: historyArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'history',
        argvSpec: historyArgvSpec,
      });
      return { exitCode: 0 };
    }

    const text = context.text();
    const historyList = context.getHistory();
    for (let i = 0; i < historyList.length; i++) {
      const line = `${(i + 1).toString().padStart(5)}  ${historyList[i]}\n`;
      await text.print({ text: line });
    }
    return { exitCode: 0 };
  },
};
