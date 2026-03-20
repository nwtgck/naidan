import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/services/wesh/types';

const execArgvSpec: StandardArgvParserSpec = {
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

export const execCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'exec',
    description: 'Replace the shell command context or persist file-descriptor changes',
    usage: 'exec [command [arg...]]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
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
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'exec',
        argvSpec: execArgvSpec,
      });
      return { exitCode: 0 };
    }

    if (parsed.positionals.length === 0) {
      for (const [fd, handle] of context.getFileDescriptors()) {
        await context.setFileDescriptor({ fd, handle, persist: true });
      }
      return { exitCode: 0 };
    }

    const [command, ...args] = parsed.positionals;
    if (command === undefined) {
      return { exitCode: 0 };
    }

    return context.executeCommand({
      command,
      args,
    });
  },
};
