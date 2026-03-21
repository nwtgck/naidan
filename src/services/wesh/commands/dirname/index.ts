import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/services/wesh/types';
import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import { dirnamePath } from '@/services/wesh/commands/_shared/path';

const dirnameArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
    { kind: 'flag', short: 'z', long: 'zero', effects: [{ key: 'zero', value: true }], help: { summary: 'end each output line with NUL, not newline', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

export const dirnameCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'dirname',
    description: 'Strip last component from file name',
    usage: 'dirname [OPTION]... NAME...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: dirnameArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'dirname',
        message: `dirname: ${diagnostic.message}`,
        argvSpec: dirnameArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'dirname',
        argvSpec: dirnameArgvSpec,
      });
      return { exitCode: 0 };
    }

    if (parsed.positionals.length === 0) {
      await writeCommandUsageError({
        context,
        command: 'dirname',
        message: 'dirname: missing operand',
        argvSpec: dirnameArgvSpec,
      });
      return { exitCode: 1 };
    }

    const separator = parsed.optionValues.zero === true ? '\0' : '\n';
    const text = context.text();
    for (const name of parsed.positionals) {
      await text.print({
        text: `${dirnamePath({ path: name })}${separator}`,
      });
    }

    return { exitCode: 0 };
  },
};
