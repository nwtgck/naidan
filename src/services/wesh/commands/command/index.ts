import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { formatResolvedCommand, resolveCommand } from '@/services/wesh/command-resolution';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';

const commandArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: 'v', long: undefined, effects: [{ key: 'verbose', value: true }], help: { summary: 'print the resolved command name and stop' } },
    { kind: 'flag', short: 'V', long: undefined, effects: [{ key: 'describe', value: true }], help: { summary: 'print a description of the resolved command and stop' } },
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
    usage: 'command [-vV] command [argument...]',
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

    if (parsed.optionValues.verbose === true || parsed.optionValues.describe === true) {
      let foundAll = true;
      const formatMode = parsed.optionValues.describe === true ? 'command-V' : 'command-v';

      for (const name of parsed.positionals) {
        const resolved = resolveCommand({
          context,
          name,
        });
        const formatted = formatResolvedCommand({
          resolved,
          mode: formatMode,
        });

        if (formatted === undefined) {
          foundAll = false;
          continue;
        }

        await text.print({ text: `${formatted}\n` });
      }

      return { exitCode: foundAll ? 0 : 1 };
    }

    const cmdName = parsed.positionals[0]!;
    const resolved = resolveCommand({
      context,
      name: cmdName,
    });

    switch (resolved.kind) {
    case 'builtin':
      return context.executeCommand({
        command: cmdName,
        args: parsed.positionals.slice(1),
        stdin: context.stdin,
        stdout: context.stdout,
        stderr: context.stderr,
        ignoreAliases: true,
      });
    case 'not-found':
      await text.error({ text: `command: ${cmdName} not found\n` });
      return { exitCode: 1 };
    default: {
      const _ex: never = resolved;
      throw new Error(`Unhandled resolved command: ${JSON.stringify(_ex)}`);
    }
    }
  },
};
