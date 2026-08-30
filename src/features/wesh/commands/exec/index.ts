import { parseStandardArgv, type StandardArgvParserSpec } from '@/features/wesh/argv';
import { stopStandardOptionParsingAtFirstPositional } from '@/features/wesh/commands/_shared/argv';
import { isStandaloneCommandHelpRequest, writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import type { WeshCommandContext, WeshCommandImplementation, WeshCommandResult } from '@/features/wesh/types';


const execArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: 'c', long: undefined, effects: [{ key: 'clearEnvironment', value: true }], help: { summary: 'execute command with an empty environment', category: 'common' } },
    { kind: 'flag', short: 'l', long: undefined, effects: [{ key: 'loginShellArgv0', value: true }], help: { summary: 'prefix argv[0] with a dash', category: 'common' } },
    { kind: 'value', short: 'a', long: undefined, key: 'argv0', valueName: 'NAME', allowAttachedValue: true, parseValue: undefined, help: { summary: 'pass NAME as argv[0]', valueName: 'NAME', category: 'common' } },
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

export const execCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    if (isStandaloneCommandHelpRequest({
      args: context.args,
      acceptedForms: [['--help']],
    })) {
      await writeCommandHelp({
        context,
        command: 'exec',
        argvSpec: execArgvSpec,
      });
      return { exitCode: 0 };
    }

    const parsed = parseStandardArgv({
      args: stopStandardOptionParsingAtFirstPositional({ args: context.args, spec: execArgvSpec }),
      spec: execArgvSpec,
    });
    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'exec',
        message: `exec: ${diagnostic.message}`,
        argvSpec: execArgvSpec,
      });
      return { exitCode: 2 };
    }

    if (parsed.positionals.length === 0) {
      for (const [fd, handle] of context.getFileDescriptors()) {
        await context.setFileDescriptor({ fd, handle, persist: true });
      }
      return { exitCode: 0 };
    }

    await context.text().error({
      text: 'exec: replacing the shell requires Wesh core exit control-flow support\n',
    });
    return { exitCode: 1 };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
