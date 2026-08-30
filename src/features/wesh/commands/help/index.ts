import type { StandardArgvParserSpec } from '@/features/wesh/argv';
import { parseStandardArgv } from '@/features/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import { stopStandardOptionParsingAtFirstPositional } from '@/features/wesh/commands/_shared/argv';
import type { WeshCommandImplementation, WeshCommandResult, WeshCommandContext } from '@/features/wesh/types';

const helpArgvSpec: StandardArgvParserSpec = {
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

export const helpCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: stopStandardOptionParsingAtFirstPositional({
        args: context.args,
        spec: helpArgvSpec,
      }),
      spec: helpArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'help',
        message: `help: ${diagnostic.message}`,
        argvSpec: helpArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'help',
        argvSpec: helpArgvSpec,
      });
      return { exitCode: 0 };
    }

    const text = context.text();
    const target = parsed.positionals[0];

    if (target) {
      const meta = context.getWeshCommandMeta({ name: target });
      if (meta === undefined) {
        await text.error({ text: `help: no help topics match '${target}'\n` });
        return { exitCode: 1 };
      }

      await writeCommandHelp({
        context,
        command: target,
      });
      return { exitCode: 0 };
    }

    await text.print({ text: 'Available commands:\n' });
    const names = context.getCommandNames().sort();
    for (const name of names) {
      const meta = context.getWeshCommandMeta({ name });
      const paddedName = name.padEnd(10);
      await text.print({ text: `  ${paddedName} - ${meta?.description || ''}\n` });
    }

    return { exitCode: 0 };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
