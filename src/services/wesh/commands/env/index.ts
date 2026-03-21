import { parseStandardArgv } from '@/services/wesh/argv';
import type { StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';

const envArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

export const envCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'env',
    description: 'Print environment variables',
    usage: 'env [name]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: envArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'env',
        message: `env: ${diagnostic.message}`,
        argvSpec: envArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'env',
        argvSpec: envArgvSpec,
      });
      return { exitCode: 0 };
    }

    const text = context.text();
    const name = parsed.positionals[0];

    if (name) {
      const val = context.env.get(name);
      if (val !== undefined) {
        await text.print({ text: val + '\n' });
      }
    } else {
      for (const [key, val] of context.env) {
        await text.print({ text: `${key}=${val}\n` });
      }
    }

    return { exitCode: 0 };
  },
};
