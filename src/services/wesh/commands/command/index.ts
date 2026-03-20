import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';

const commandArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: 'v', long: undefined, effects: [{ key: 'verbose', value: true }], help: { summary: 'print the resolved command name and stop' } },
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: false,
  specialTokenParsers: [],
};

export const commandCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'command',
    description: 'Run command with arguments, ignoring any function or alias',
    usage: 'command [-v] command [argument...]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: commandArgvSpec,
    });

    const text = context.text();
    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'command',
        message: `command: ${diagnostic.message}`,
        argvSpec: commandArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'command',
        argvSpec: commandArgvSpec,
      });
      return { exitCode: 0 };
    }

    if (parsed.positionals.length === 0) return { exitCode: 0 };

    const cmdName = parsed.positionals[0]!;
    const meta = context.getWeshCommandMeta({ name: cmdName });

    if (parsed.optionValues.verbose === true) {
      if (meta) {
        await text.print({ text: `${cmdName}\n` });
        return { exitCode: 0 };
      }
      return { exitCode: 1 };
    }

    if (!meta) {
      await text.error({ text: `command: ${cmdName} not found\n` });
      return { exitCode: 1 };
    }

    return { exitCode: 0 };
  },
};
