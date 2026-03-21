import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';

const pwdArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

export const pwdCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'pwd',
    description: 'Print name of current/working directory',
    usage: 'pwd',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: pwdArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'pwd',
        message: `pwd: ${diagnostic.message}`,
        argvSpec: pwdArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'pwd',
        argvSpec: pwdArgvSpec,
      });
      return { exitCode: 0 };
    }

    if (parsed.positionals.length > 0) {
      await writeCommandUsageError({
        context,
        command: 'pwd',
        message: 'pwd: too many arguments',
        argvSpec: pwdArgvSpec,
      });
      return { exitCode: 1 };
    }

    const text = context.text();
    await text.print({ text: context.cwd + '\n' });
    return { exitCode: 0 };
  },
};
