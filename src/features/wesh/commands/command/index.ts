import type { WeshCommandImplementation, WeshCommandResult, WeshCommandContext } from '@/features/wesh/types';
import { parseStandardArgv, type StandardArgvParserSpec } from '@/features/wesh/argv';
import { formatResolvedCommand, hasShellFunction, resolveCommand, shellControlFlowBuiltinNames } from '@/features/wesh/command-resolution';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import { stopStandardOptionParsingAtFirstPositional } from '@/features/wesh/commands/_shared/argv';

const WESH_STANDARD_COMMAND_PATH = '/bin:/usr/bin';

const commandArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: 'p', long: undefined, effects: [{ key: 'standardPath', value: true }], help: { summary: 'use a standard utility search path' } },
    { kind: 'flag', short: 'v', long: undefined, effects: [{ key: 'verbose', value: true }], help: { summary: 'print the resolved command name and stop' } },
    { kind: 'flag', short: 'V', long: undefined, effects: [{ key: 'describe', value: true }], help: { summary: 'print a description of the resolved command and stop' } },
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: false,
  specialTokenParsers: [],
};

export const commandCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: stopStandardOptionParsingAtFirstPositional({ args: context.args, spec: commandArgvSpec }),
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
      return { exitCode: 2 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'command',
        argvSpec: commandArgvSpec,
      });
      return { exitCode: 0 };
    }

    const previousPath = context.env.get('PATH');
    const useStandardPath = parsed.optionValues.standardPath === true;
    if (useStandardPath) {
      context.setEnv({ key: 'PATH', value: WESH_STANDARD_COMMAND_PATH });
    }

    try {
      if (parsed.positionals.length === 0) return { exitCode: 0 };

      if (parsed.optionValues.verbose === true || parsed.optionValues.describe === true) {
        let foundAny = false;
        const formatMode = parsed.optionValues.describe === true ? 'command-V' : 'command-v';

        for (const name of parsed.positionals) {
          if (shellControlFlowBuiltinNames.has(name)) {
            const formattedControlBuiltin = (() => {
              switch (formatMode) {
              case 'command-v':
                return name;
              case 'command-V':
                return `${name} is a shell builtin`;
              default: {
                const _ex: never = formatMode;
                throw new Error(`Unhandled command format mode: ${_ex}`);
              }
              }
            })();
            await text.print({ text: `${formattedControlBuiltin}\n` });
            foundAny = true;
            continue;
          }
          if (hasShellFunction({ context, name })) {
            const formattedFunction = (() => {
              switch (formatMode) {
              case 'command-v':
                return name;
              case 'command-V':
                return `${name} is a function`;
              default: {
                const _ex: never = formatMode;
                throw new Error(`Unhandled command format mode: ${_ex}`);
              }
              }
            })();
            await text.print({ text: `${formattedFunction}\n` });
            foundAny = true;
            continue;
          }

          const resolved = await resolveCommand({
            context,
            name,
          });
          const formatted = formatResolvedCommand({
            resolved,
            mode: formatMode,
          });

          if (formatted === undefined) {
            switch (formatMode) {
            case 'command-v':
              break;
            case 'command-V':
              await text.error({ text: `command: ${name}: not found\n` });
              break;
            default: {
              const _ex: never = formatMode;
              throw new Error(`Unhandled command format mode: ${_ex}`);
            }
            }
            continue;
          }

          await text.print({ text: `${formatted}\n` });
          foundAny = true;
        }

        return { exitCode: foundAny ? 0 : 1 };
      }

      const cmdName = parsed.positionals[0]!;
      if (shellControlFlowBuiltinNames.has(cmdName)) {
        return context.executeCommand({
          command: cmdName,
          args: parsed.positionals.slice(1),
          stdin: context.stdin,
          stdout: context.stdout,
          stderr: context.stderr,
          ignoreAliases: true,
        });
      }
      const resolved = await resolveCommand({
        context,
        name: cmdName,
      });

      switch (resolved.kind) {
      case 'builtin':
      case 'file':
        return context.executeCommand({
          command: cmdName,
          args: parsed.positionals.slice(1),
          stdin: context.stdin,
          stdout: context.stdout,
          stderr: context.stderr,
          ignoreAliases: true,
        });
      case 'not_found':
        await text.error({ text: `command: ${cmdName} not found\n` });
        return { exitCode: 127 };
      default: {
        const _ex: never = resolved;
        throw new Error(`Unhandled resolved command: ${JSON.stringify(_ex)}`);
      }
      }
    } finally {
      if (useStandardPath) {
        if (previousPath === undefined) {
          context.unsetEnv({ key: 'PATH' });
        } else {
          context.setEnv({ key: 'PATH', value: previousPath });
        }
      }
    }
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
