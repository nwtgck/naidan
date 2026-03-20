import { parseStandardArgv } from '@/services/wesh/argv';
import type { StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';

const whichArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

export const whichCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'which',
    description: 'Locate a command',
    usage: 'which command...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: whichArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'which',
        message: `which: ${diagnostic.message}`,
        argvSpec: whichArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'which',
        argvSpec: whichArgvSpec,
      });
      return { exitCode: 0 };
    }

    if (parsed.positionals.length === 0) {
      await writeCommandUsageError({
        context,
        command: 'which',
        message: 'which: missing operand',
        argvSpec: whichArgvSpec,
      });
      return { exitCode: 1 };
    }

    const text = context.text();
    let foundAll = true;

    for (const name of parsed.positionals) {
      const meta = context.getWeshCommandMeta({ name });
      if (meta) {
        await text.print({ text: `${name}: builtin command\n` });
      } else {
        await text.error({ text: `${name} not found\n` });
        foundAll = false;
      }
    }

    return { exitCode: foundAll ? 0 : 1 };
  },
};
