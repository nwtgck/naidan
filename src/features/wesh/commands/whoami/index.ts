import { parseStandardArgv, type StandardArgvParserSpec } from '@/features/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import { STANDARD_HELP_VERSION_EARLY_EXIT_OPTIONS, stopStandardArgvAtFirstEarlyExit } from '@/features/wesh/commands/_shared/argv';
import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/features/wesh/types';

const whoamiArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit' } },
    { kind: 'flag', short: undefined, long: 'version', effects: [{ key: 'version', value: true }], help: { summary: 'output version information and exit', category: 'advanced' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

export const whoamiCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'whoami',
    description: 'Print the user name associated with the current effective user ID',
    usage: 'whoami',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: stopStandardArgvAtFirstEarlyExit({ args: context.args, spec: whoamiArgvSpec, earlyExitOptions: STANDARD_HELP_VERSION_EARLY_EXIT_OPTIONS }),
      spec: whoamiArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'whoami',
        message: `whoami: ${diagnostic.message}`,
        argvSpec: whoamiArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'whoami',
        argvSpec: whoamiArgvSpec,
      });
      return { exitCode: 0 };
    }

    if (parsed.optionValues.version === true) {
      await context.text().print({ text: 'whoami (Wesh coreutils) 1.0\n' });
      return { exitCode: 0 };
    }

    if (parsed.positionals.length > 0) {
      await writeCommandUsageError({
        context,
        command: 'whoami',
        message: 'whoami: too many arguments',
        argvSpec: whoamiArgvSpec,
      });
      return { exitCode: 1 };
    }

    const user = context.env.get('USER') || 'user';
    const text = context.text();
    await text.print({ text: user + '\n' });
    return { exitCode: 0 };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
