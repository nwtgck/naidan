import type { StandardArgvParserSpec } from '@/features/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import { resolvePath } from '@/features/wesh/path';
import type { WeshCommandContext, WeshCommandImplementation, WeshCommandResult } from '@/features/wesh/types';

const envArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
    { kind: 'flag', short: 'i', long: 'ignore-environment', effects: [{ key: 'ignoreEnvironment', value: true }], help: { summary: 'start with an empty environment', category: 'common' } },
    { kind: 'flag', short: '0', long: 'null', effects: [{ key: 'nullOutput', value: true }], help: { summary: 'end each output line with NUL, not newline', category: 'common' } },
    { kind: 'value', short: 'u', long: 'unset', key: 'unset', valueName: 'NAME', allowAttachedValue: true, parseValue: undefined, help: { summary: 'remove variable from the environment', valueName: 'NAME', category: 'common' } },
    { kind: 'value', short: 'C', long: 'chdir', key: 'chdir', valueName: 'DIR', allowAttachedValue: true, parseValue: undefined, help: { summary: 'change working directory to DIR', valueName: 'DIR', category: 'common' } },
  ],
  allowShortFlagBundles: false,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

type ParsedEnvArguments =
  | {
      kind: 'help',
    }
  | {
      kind: 'error',
      message: string,
      showUsage: boolean,
    }
  | {
      kind: 'run',
      ignoreEnvironment: boolean,
      nullOutput: boolean,
      unsetNames: string[],
      changeDirectory: string | undefined,
      assignments: Array<{ name: string, value: string }>,
      command: string | undefined,
      commandArgs: string[],
    };

function parseEnvArguments({ args }: { args: string[] }): ParsedEnvArguments {
  let ignoreEnvironment = false;
  let nullOutput = false;
  const unsetNames: string[] = [];
  let changeDirectory: string | undefined;
  let index = 0;
  let parseOptions = true;

  while (index < args.length && parseOptions) {
    const argument = args[index]!;
    if (argument === '--') {
      parseOptions = false;
      index += 1;
      break;
    }
    if (argument === '-') {
      ignoreEnvironment = true;
      parseOptions = false;
      index += 1;
      break;
    }
    if (argument === '--help') {
      return { kind: 'help' };
    }
    if (argument === '--ignore-environment') {
      ignoreEnvironment = true;
      index += 1;
      continue;
    }
    if (argument === '--null') {
      nullOutput = true;
      index += 1;
      continue;
    }
    if (argument === '--unset') {
      const name = args[index + 1];
      if (name === undefined) {
        return {
          kind: 'error',
          message: `env: option '${argument}' requires an argument`,
          showUsage: true,
        };
      }
      unsetNames.push(name);
      index += 2;
      continue;
    }
    if (argument.startsWith('--unset=')) {
      unsetNames.push(argument.slice('--unset='.length));
      index += 1;
      continue;
    }
    if (argument === '--chdir') {
      const directory = args[index + 1];
      if (directory === undefined) {
        return {
          kind: 'error',
          message: `env: option '${argument}' requires an argument`,
          showUsage: true,
        };
      }
      changeDirectory = directory;
      index += 2;
      continue;
    }
    if (argument.startsWith('--chdir=')) {
      changeDirectory = argument.slice('--chdir='.length);
      index += 1;
      continue;
    }
    if (argument.startsWith('-') && !argument.startsWith('--')) {
      let optionIndex = 1;
      let consumedFollowingArgument = false;
      while (optionIndex < argument.length) {
        const option = argument[optionIndex]!;
        switch (option) {
        case 'i':
          ignoreEnvironment = true;
          optionIndex += 1;
          break;
        case '0':
          nullOutput = true;
          optionIndex += 1;
          break;
        case 'u':
        case 'C': {
          const attachedValue = argument.slice(optionIndex + 1);
          const value = attachedValue.length > 0
            ? attachedValue
            : args[index + 1];
          if (value === undefined) {
            return {
              kind: 'error',
              message: `env: option '-${option}' requires an argument`,
              showUsage: true,
            };
          }
          switch (option) {
          case 'u':
            unsetNames.push(value);
            break;
          case 'C':
            changeDirectory = value;
            break;
          default: {
            const _ex: never = option;
            throw new Error(`Unhandled env value option: ${_ex}`);
          }
          }
          consumedFollowingArgument = attachedValue.length === 0;
          optionIndex = argument.length;
          break;
        }
        default:
          return {
            kind: 'error',
            message: `env: invalid option -- '${option}'`,
            showUsage: true,
          };
        }
      }
      index += consumedFollowingArgument ? 2 : 1;
      continue;
    }
    if (argument.startsWith('-')) {
      return {
        kind: 'error',
        message: `env: unrecognized option '${argument}'`,
        showUsage: true,
      };
    }
    parseOptions = false;
  }

  const assignments: Array<{ name: string, value: string }> = [];
  while (index < args.length) {
    const argument = args[index]!;
    const equalsIndex = argument.indexOf('=');
    if (equalsIndex < 0) break;
    assignments.push({
      name: argument.slice(0, equalsIndex),
      value: argument.slice(equalsIndex + 1),
    });
    index += 1;
  }

  const invalidUnsetName = unsetNames.find(name => name.length === 0 || name.includes('='));
  if (invalidUnsetName !== undefined) {
    return {
      kind: 'error',
      message: `env: cannot unset '${invalidUnsetName}': Invalid argument`,
      showUsage: false,
    };
  }

  const command = args[index];
  return {
    kind: 'run',
    ignoreEnvironment,
    nullOutput,
    unsetNames,
    changeDirectory,
    assignments,
    command,
    commandArgs: command === undefined ? [] : args.slice(index + 1),
  };
}

export const envCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseEnvArguments({ args: context.args });
    switch (parsed.kind) {
    case 'help':
      await writeCommandHelp({
        context,
        command: 'env',
        argvSpec: envArgvSpec,
      });
      return { exitCode: 0 };
    case 'error':
      if (parsed.showUsage) {
        await writeCommandUsageError({
          context,
          command: 'env',
          message: parsed.message,
          argvSpec: envArgvSpec,
        });
      } else {
        await context.text().error({ text: `${parsed.message}\n` });
      }
      return { exitCode: 125 };
    case 'run':
      break;
    default: {
      const _ex: never = parsed;
      throw new Error(`Unhandled env argument result: ${JSON.stringify(_ex)}`);
    }
    }

    if (parsed.nullOutput && parsed.command !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'env',
        message: 'env: cannot specify --null (-0) with command',
        argvSpec: envArgvSpec,
      });
      return { exitCode: 125 };
    }

    const previousEnvironment = new Map(context.env);
    const previousCwd = context.cwd;
    const text = context.text();

    try {
      if (parsed.ignoreEnvironment) {
        const names = new Set<string>(context.env.keys());
        for (const name of names) {
          context.unsetEnv({ key: name });
        }
      }

      for (const name of parsed.unsetNames) {
        context.unsetEnv({ key: name });
      }
      for (const assignment of parsed.assignments) {
        context.setEnv({
          key: assignment.name,
          value: assignment.value,
        });
      }

      if (parsed.changeDirectory !== undefined) {
        try {
          if (parsed.changeDirectory.length === 0) {
            throw new Error('No such file or directory');
          }
          const target = resolvePath({
            cwd: context.cwd,
            path: parsed.changeDirectory,
          });
          const resolved = await context.files.resolve({ path: target });
          switch (resolved.stat.type) {
          case 'directory':
            break;
          case 'file':
          case 'fifo':
          case 'chardev':
          case 'symlink':
            throw new Error('Not a directory');
          default: {
            const _ex: never = resolved.stat.type;
            throw new Error(`Unhandled file type: ${_ex}`);
          }
          }
          context.setCwd({ path: resolved.fullPath });
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          await text.error({
            text: `env: cannot change directory to '${parsed.changeDirectory}': ${message}\n`,
          });
          return { exitCode: 125 };
        }
      }

      if (parsed.command === undefined) {
        for (const [key, value] of context.env) {
          await text.print({ text: `${key}=${value}${parsed.nullOutput ? '\0' : '\n'}` });
        }
        return { exitCode: 0 };
      }

      const isBuiltinCommand = !parsed.command.includes('/')
        && context.getWeshCommandMeta({ name: parsed.command }) !== undefined;
      const isShellEntrypoint = parsed.command === 'sh' || parsed.command === 'bash';
      const commandForExecution = !parsed.command.includes('/')
        && (isShellEntrypoint || (!context.env.has('PATH') && !isBuiltinCommand))
        ? `/bin/${parsed.command}`
        : parsed.command;
      try {
        return await context.executeCommand({
          command: commandForExecution,
          args: parsed.commandArgs,
          stdin: context.stdin,
          stdout: context.stdout,
          stderr: context.stderr,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (message !== `Command not found: ${commandForExecution}`) throw error;
        await text.error({
          text: `env: '${parsed.command}': No such file or directory\n`,
        });
        return { exitCode: 127 };
      }
    } finally {
      if (parsed.changeDirectory !== undefined) {
        context.setCwd({ path: previousCwd });
      }
      for (const key of [...context.env.keys()]) {
        context.unsetEnv({ key });
      }
      for (const [key, value] of previousEnvironment) {
        context.setEnv({ key, value });
      }
    }
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  parseEnvArguments,
};
