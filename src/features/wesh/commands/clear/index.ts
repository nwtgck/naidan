import { parseStandardArgv, type StandardArgvParserSpec } from '@/features/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/features/wesh/types';

const clearArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: 'x', long: undefined, effects: [{ key: 'keepScrollback', value: true }], help: { summary: 'do not try to clear scrollback', category: 'common' } },
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

export const clearCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'clear',
    description: 'Clear the terminal screen',
    usage: 'clear',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: clearArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'clear',
        message: `clear: ${diagnostic.message}`,
        argvSpec: clearArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'clear',
        argvSpec: clearArgvSpec,
      });
      return { exitCode: 0 };
    }

    if (parsed.positionals.length > 0) {
      await writeCommandUsageError({
        context,
        command: 'clear',
        message: 'clear: too many arguments',
        argvSpec: clearArgvSpec,
      });
      return { exitCode: 1 };
    }

    const text = context.text();
    const eraseDisplay = '\x1b[H\x1b[2J';
    const eraseScrollback = parsed.optionValues.keepScrollback === true ? '' : '\x1b[3J';
    await text.print({ text: eraseDisplay + eraseScrollback });
    return { exitCode: 0 };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
