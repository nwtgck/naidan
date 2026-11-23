import { defineArgvCatalog, defineArgvHelpPresentation, formatArgvOptionHelp, formatArgvUsageSummary, parseStandardArgv, type StandardArgvAction } from '@/features/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage-output';
import { resolvePath } from '@/features/wesh/path';
import type { WeshCommandContext, WeshCommandImplementation, WeshCommandResult } from '@/features/wesh/types';

const envOptions = [
  {
    forms: [
      { kind: 'long', name: 'help', value: { kind: 'none' } },
    ],
    semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
    summary: 'display this help and exit',
    category: 'common',
  },
  {
    forms: [
      { kind: 'short', name: 'i', value: { kind: 'none' } },
      { kind: 'long', name: 'ignore-environment', value: { kind: 'none' } },
    ],
    semantic: { kind: 'effects', effects: [{ key: 'ignoreEnvironment', value: true }] },
    summary: 'start with an empty environment',
    category: 'common',
  },
  {
    forms: [
      { kind: 'short', name: '0', value: { kind: 'none' } },
      { kind: 'long', name: 'null', value: { kind: 'none' } },
    ],
    semantic: { kind: 'effects', effects: [{ key: 'nullOutput', value: true }] },
    summary: 'end each output line with NUL, not newline',
    category: 'common',
  },
  {
    forms: [
      { kind: 'short', name: 'u', value: { kind: 'required-attached-or-following', missingValueName: 'NAME' } },
      { kind: 'long', name: 'unset', value: { kind: 'required', missingValueName: 'NAME' } },
    ],
    semantic: { kind: 'required-value', key: 'unset', parse: undefined },
    summary: 'remove variable from the environment',
    category: 'common',
  },
  {
    forms: [
      { kind: 'short', name: 'C', value: { kind: 'required-attached-or-following', missingValueName: 'DIR' } },
      { kind: 'long', name: 'chdir', value: { kind: 'required', missingValueName: 'DIR' } },
    ],
    semantic: { kind: 'required-value', key: 'chdir', parse: undefined },
    summary: 'change working directory to DIR',
    category: 'common',
  },
] as const;

const envArgvCatalog = defineArgvCatalog<StandardArgvAction<never>>({ definitions: envOptions, nonExecutableLongOptions: [] });
const envArgvHelp = defineArgvHelpPresentation({ catalog: envArgvCatalog, rows: envOptions });

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
  const parsed = parseStandardArgv({
    args,
    catalog: envArgvCatalog,
    policy: { longNameMatch: 'exact', optionBoundary: 'first-positional', occurrenceRetention: 'all' },
  });
  const occurrences = parsed.occurrences ?? [];
  const diagnostic = parsed.diagnostics[0];
  const help = occurrences.find(occurrence => args[occurrence.argvIndex] === '--help');
  if (help !== undefined && (diagnostic === undefined || help.argvIndex < diagnostic.argvIndex)) {
    return { kind: 'help' };
  }
  if (diagnostic !== undefined) {
    const message = (() => {
      switch (diagnostic.kind) {
      case 'missing_option_value':
        return `option '${diagnostic.option}' requires an argument`;
      case 'unexpected_option_value':
        return `unrecognized option '${args[diagnostic.argvIndex]}'`;
      case 'unknown_long_option':
      case 'unknown_short_option':
      case 'ambiguous_long_option':
      case 'invalid_option_value':
        return diagnostic.message;
      default: {
        const _ex: never = diagnostic;
        throw new Error(`Unhandled env argument diagnostic: ${JSON.stringify(_ex)}`);
      }
      }
    })();
    return { kind: 'error', message: `env: ${message}`, showUsage: true };
  }

  const unsetNames: string[] = [];
  for (const { semantic, value } of occurrences) {
    if (semantic.kind === 'required-value' && semantic.key === 'unset' && value.kind !== 'none') {
      unsetNames.push(value.rawValue);
    }
  }

  const operands = parsed.positionals;
  // The operand suffix omits the option delimiter. An option can also consume '--' as its value.
  const beforeOperands = args.length - operands.length - 1;
  const usesSingleDash = operands[0] === '-' && (
    args[beforeOperands] !== '--'
    || occurrences.some(({ value }) => value.kind === 'next-argv' && value.argvIndex === beforeOperands)
  );
  let index = usesSingleDash ? 1 : 0;

  const assignments: Array<{ name: string, value: string }> = [];
  while (index < operands.length) {
    const argument = operands[index]!;
    const equalsIndex = argument.indexOf('=');
    if (equalsIndex < 0) {
      break;
    }
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

  const command = operands[index];
  return {
    kind: 'run',
    ignoreEnvironment: parsed.optionValues.ignoreEnvironment === true || usesSingleDash,
    nullOutput: parsed.optionValues.nullOutput === true,
    unsetNames,
    changeDirectory: typeof parsed.optionValues.chdir === 'string' ? parsed.optionValues.chdir : undefined,
    assignments,
    command,
    commandArgs: command === undefined ? [] : operands.slice(index + 1),
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
        optionLines: formatArgvOptionHelp({ presentation: envArgvHelp }),
      });
      return { exitCode: 0 };
    case 'error':
      if (parsed.showUsage) {
        await writeCommandUsageError({
          context,
          command: 'env',
          message: parsed.message,
          usageSummary: formatArgvUsageSummary({ presentation: envArgvHelp }),
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
        usageSummary: formatArgvUsageSummary({ presentation: envArgvHelp }),
      });
      return { exitCode: 125 };
    }

    const env = new Map(parsed.ignoreEnvironment ? undefined : context.env);
    for (const name of parsed.unsetNames) {
      env.delete(name);
    }
    for (const { name, value } of parsed.assignments) {
      env.set(name, value);
    }

    const text = context.text();
    let cwd = context.cwd;

    if (parsed.changeDirectory !== undefined) {
      try {
        if (parsed.changeDirectory.length === 0) {
          throw new Error('No such file or directory');
        }
        const target = resolvePath({ cwd, path: parsed.changeDirectory });
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
        cwd = resolved.fullPath;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        await text.error({
          text: `env: cannot change directory to '${parsed.changeDirectory}': ${message}\n`,
        });
        return { exitCode: 125 };
      }
    }

    if (parsed.command === undefined) {
      for (const [key, value] of env) {
        await text.print({ text: `${key}=${value}${parsed.nullOutput ? '\0' : '\n'}` });
      }
      return { exitCode: 0 };
    }

    const isBuiltinCommand = !parsed.command.includes('/')
      && context.getWeshCommandMeta({ name: parsed.command }) !== undefined;
    const isShellEntrypoint = parsed.command === 'sh' || parsed.command === 'bash';
    const commandForExecution = !parsed.command.includes('/')
      && (isShellEntrypoint || (!env.has('PATH') && !isBuiltinCommand))
      ? `/bin/${parsed.command}`
      : parsed.command;
    try {
      return await context.executeCommand({
        command: commandForExecution,
        args: parsed.commandArgs,
        stdin: context.stdin,
        cwd,
        env,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== `Command not found: ${commandForExecution}`) {
        throw error;
      }
      await text.error({
        text: `env: '${parsed.command}': No such file or directory\n`,
      });
      return { exitCode: 127 };
    }
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  parseEnvArguments,
};
