import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';

const echoArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: 'n', long: undefined, effects: [{ key: 'noNewline', value: true }], help: { summary: 'do not output the trailing newline' } },
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

export const echoCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'echo',
    description: 'Display a line of text',
    usage: 'echo [-n] [string...]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: echoArgvSpec,
    });

    const text = context.text();
    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'echo',
        message: `echo: ${diagnostic.message}`,
        argvSpec: echoArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'echo',
        argvSpec: echoArgvSpec,
      });
      return { exitCode: 0 };
    }

    await text.print({ text: parsed.positionals.join(' ') });

    if (parsed.optionValues.noNewline !== true) {
      await text.print({ text: '\n' });
    }

    return { exitCode: 0 };
  },
};
