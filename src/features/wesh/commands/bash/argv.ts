import type {
  ShellExecutionOptions,
  ShellInvocationMode,
  ShellOptionOverride,
} from '@/features/wesh/shell/invocation';

export type BashInvocationSource =
  | {
      kind: 'command-string',
      script: string,
    }
  | {
      kind: 'stdin',
    }
  | {
      kind: 'file',
      path: string,
    };

export interface BashInvocationPlan {
  readonly kind: 'run',
  readonly source: BashInvocationSource,
  readonly argv0: string,
  readonly positionalArgs: readonly string[],
  readonly executionOptions: ShellExecutionOptions,
  readonly shellOptionOverrides: readonly ShellOptionOverride[],
  readonly mode: ShellInvocationMode,
}

export type BashArgvResult =
  | BashInvocationPlan
  | { kind: 'help' }
  | { kind: 'error', message: string, exitCode: 1 | 2 };

/**
 * Parse the Bash compatibility entrypoint argv without performing I/O or
 * invoking the shell engine. This deliberately models only the invocation
 * surface already supported by Wesh; compatibility expansion belongs in this
 * command-local parser rather than in shell core.
 */
export function parseBashArgv({ args }: {
  args: readonly string[],
}): BashArgvResult {
  let argumentIndex = 0;
  let mode: ShellInvocationMode = 'execute';
  let sourceMode: 'automatic' | 'stdin' = 'automatic';
  let commandStringMode = false;
  let shortOptionParsingStarted = false;
  let errexit = false;
  let nounset = false;
  let pipefail = false;
  const shellOptionOverrides = new Map<ShellOptionOverride['name'], boolean>();
  const currentShellOptionOverrides = (): ShellOptionOverride[] => [...shellOptionOverrides]
    .map(([name, enabled]) => ({ name, enabled }));
  const currentExecutionOptions = (): ShellExecutionOptions => ({
    errexit,
    nounset,
    pipefail,
  });

  const basicOptionErrorExitCode = (): 1 | 2 => errexit ? 1 : 2;
  const invalidOption = ({ argument }: { argument: string }): BashArgvResult => ({
    kind: 'error',
    message: `bash: ${argument}: invalid option\n`,
    exitCode: basicOptionErrorExitCode(),
  });

  while (argumentIndex < args.length) {
    const argument = args[argumentIndex]!;

    if (argument === '--') {
      argumentIndex += 1;
      break;
    }
    if (!shortOptionParsingStarted) {
      if (argument === '--help') {
        return { kind: 'help' };
      }
      if (argument === '--noprofile' || argument === '--norc') {
        argumentIndex += 1;
        continue;
      }
    }
    if (argument.startsWith('--')) {
      return invalidOption({
        argument: shortOptionParsingStarted ? '--' : argument,
      });
    }
    if (argument === '-') {
      argumentIndex += 1;
      break;
    }
    if (argument === '+') {
      argumentIndex += 1;
      shortOptionParsingStarted = true;
      continue;
    }
    if (!argument.startsWith('-') && !argument.startsWith('+')) {
      break;
    }

    shortOptionParsingStarted = true;
    const enabled = argument[0] === '-';
    const pendingValueOptions: Array<{ option: 'O' | 'o', enabled: boolean }> = [];
    for (const option of argument.slice(1)) {
      switch (option) {
      case 'e':
        errexit = enabled;
        break;
      case 'u':
        nounset = enabled;
        break;
      case 'n':
        mode = enabled ? 'parse-only' : 'execute';
        break;
      case 'c':
        commandStringMode = true;
        break;
      case 's':
        sourceMode = 'stdin';
        break;
      case 'O':
      case 'o':
        pendingValueOptions.push({ option, enabled });
        break;
      default:
        return invalidOption({ argument: `${argument[0]}${option}` });
      }
    }

    for (const pending of pendingValueOptions) {
      const optionName = args[argumentIndex + 1];
      if (optionName === undefined) {
        return {
          kind: 'error',
          message: `bash: option requires an argument -- '${pending.option}'\n`,
          exitCode: 2,
        };
      }
      switch (pending.option) {
      case 'O':
        switch (optionName) {
        case 'dotglob':
        case 'extglob':
        case 'failglob':
        case 'globstar':
        case 'nullglob':
          shellOptionOverrides.set(optionName, pending.enabled);
          break;
        default:
          return {
            kind: 'error',
            message: `bash: line 0: ${optionName}: invalid shell option name\n`,
            exitCode: 2,
          };
        }
        break;
      case 'o':
        if (optionName !== 'pipefail') {
          return {
            kind: 'error',
            message: `bash: line 0: bash: ${optionName}: invalid option name\n`,
            exitCode: 2,
          };
        }
        pipefail = pending.enabled;
        break;
      default: {
        const _ex: never = pending.option;
        throw new Error(`Unhandled Bash value option: ${_ex}`);
      }
      }
      argumentIndex += 1;
    }

    argumentIndex += 1;
    switch (sourceMode) {
    case 'stdin':
    case 'automatic':
      break;
    default: {
      const _ex: never = sourceMode;
      throw new Error(`Unhandled Bash source mode: ${_ex}`);
    }
    }
  }

  if (commandStringMode) {
    const script = args[argumentIndex];
    if (script === undefined) {
      return {
        kind: 'error',
        message: 'bash: -c: option requires an argument\n',
        exitCode: basicOptionErrorExitCode(),
      };
    }
    return {
      kind: 'run',
      source: {
        kind: 'command-string',
        script,
      },
      argv0: args[argumentIndex + 1] ?? 'bash',
      positionalArgs: args.slice(argumentIndex + 2),
      executionOptions: currentExecutionOptions(),
      shellOptionOverrides: currentShellOptionOverrides(),
      mode,
    };
  }

  switch (sourceMode) {
  case 'stdin':
    return {
      kind: 'run',
      source: { kind: 'stdin' },
      argv0: 'bash',
      positionalArgs: args.slice(argumentIndex),
      executionOptions: currentExecutionOptions(),
      shellOptionOverrides: currentShellOptionOverrides(),
      mode,
    };
  case 'automatic':
    break;
  default: {
    const _ex: never = sourceMode;
    throw new Error(`Unhandled Bash source mode: ${_ex}`);
  }
  }

  const scriptPath = args[argumentIndex];
  if (scriptPath === undefined) {
    return {
      kind: 'run',
      source: { kind: 'stdin' },
      argv0: 'bash',
      positionalArgs: [],
      executionOptions: currentExecutionOptions(),
      shellOptionOverrides: currentShellOptionOverrides(),
      mode,
    };
  }

  return {
    kind: 'run',
    source: {
      kind: 'file',
      path: scriptPath,
    },
    argv0: scriptPath,
    positionalArgs: args.slice(argumentIndex + 1),
    executionOptions: currentExecutionOptions(),
    shellOptionOverrides: currentShellOptionOverrides(),
    mode,
  };
}

export const TEST_ONLY = {
};
