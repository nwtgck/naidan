import {
  analyzeArgvLongForm,
  analyzeArgvShortForm,
  defineArgvCatalog,
  type ArgvOptionDefinition,
} from '@/features/wesh/argv-v2';
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

interface BashStartupEnvironmentResult {
  readonly plan: BashInvocationPlan,
  readonly warnings: readonly string[],
}

interface MutableBashInvocationState {
  mode: ShellInvocationMode,
  errexit: boolean,
  nounset: boolean,
  pipefail: boolean,
  readonly shellOptionOverrides: Map<ShellOptionOverride['name'], boolean>,
}

const BASH_VALID_SHELLOPT_NAMES = [
  'allexport',
  'braceexpand',
  'emacs',
  'errexit',
  'errtrace',
  'functrace',
  'hashall',
  'histexpand',
  'history',
  'ignoreeof',
  'interactive-comments',
  'keyword',
  'monitor',
  'noclobber',
  'noexec',
  'noglob',
  'nolog',
  'notify',
  'nounset',
  'onecmd',
  'physical',
  'pipefail',
  'posix',
  'privileged',
  'verbose',
  'vi',
  'xtrace',
] as const;

type BashValidShellOptionName = typeof BASH_VALID_SHELLOPT_NAMES[number];

const BASH_VALID_SHELLOPT_NAME_SET: ReadonlySet<string> = new Set(BASH_VALID_SHELLOPT_NAMES);

function isBashValidShellOptionName(optionName: string): optionName is BashValidShellOptionName {
  return BASH_VALID_SHELLOPT_NAME_SET.has(optionName);
}

function extractBashColonUnits({ value }: {
  value: string,
}): string[] {
  const units: string[] = [];
  let index = 0;

  while (index < value.length) {
    let unitStart = index;
    if (index > 0 && value[index] === ':') {
      unitStart += 1;
    }

    let unitEnd = unitStart;
    while (unitEnd < value.length && value[unitEnd] !== ':') {
      unitEnd += 1;
    }

    if (unitEnd === unitStart) {
      if (unitEnd < value.length) {
        index = unitEnd + 1;
      } else {
        index = unitEnd;
      }
      units.push('');
      continue;
    }

    index = unitEnd;
    units.push(value.slice(unitStart, unitEnd));
  }

  return units;
}

function applyValidBashShellOption({ state, optionName, enabled }: {
  state: MutableBashInvocationState,
  optionName: BashValidShellOptionName,
  enabled: boolean,
}): boolean {
  switch (optionName) {
  case 'errexit':
    state.errexit = enabled;
    return true;
  case 'nounset':
    state.nounset = enabled;
    return true;
  case 'noexec':
    state.mode = enabled ? 'parse-only' : 'execute';
    return true;
  case 'pipefail':
    state.pipefail = enabled;
    return true;
  case 'nolog':
    // GNU Bash documents nolog as accepted but currently ignored.
    return true;
  case 'allexport':
  case 'braceexpand':
  case 'emacs':
  case 'errtrace':
  case 'functrace':
  case 'hashall':
  case 'histexpand':
  case 'history':
  case 'ignoreeof':
  case 'interactive-comments':
  case 'keyword':
  case 'monitor':
  case 'noclobber':
  case 'noglob':
  case 'notify':
  case 'onecmd':
  case 'physical':
  case 'posix':
  case 'privileged':
  case 'verbose':
  case 'vi':
  case 'xtrace':
    return false;
  default: {
    const _ex: never = optionName;
    throw new Error(`Unhandled Bash shell option: ${_ex}`);
  }
  }
}

function applyRepresentableBashShoptOption({ state, optionName, enabled }: {
  state: MutableBashInvocationState,
  optionName: string,
  enabled: boolean,
}): boolean {
  switch (optionName) {
  case 'dotglob':
  case 'extglob':
  case 'failglob':
  case 'globstar':
  case 'nullglob':
    state.shellOptionOverrides.set(optionName, enabled);
    return true;
  default:
    return false;
  }
}

function createBashInvocationPlan({ state, source, argv0, positionalArgs }: {
  state: MutableBashInvocationState,
  source: BashInvocationSource,
  argv0: string,
  positionalArgs: readonly string[],
}): BashInvocationPlan {
  return {
    kind: 'run',
    source,
    argv0,
    positionalArgs,
    executionOptions: {
      errexit: state.errexit,
      nounset: state.nounset,
      pipefail: state.pipefail,
    },
    shellOptionOverrides: Array.from(
      state.shellOptionOverrides,
      ([name, enabled]) => ({ name, enabled }),
    ),
    mode: state.mode,
  };
}


// Bash owns invocation phase and argv-cursor semantics; argv-v2 owns only the
// frozen token spelling/value-claim mechanics. In particular, this must remain
// a direct token-local analyzer consumer rather than a parseStandardArgv wrapper.
type BashArgvOptionSemantic =
  | 'errexit'
  | 'nounset'
  | 'parse-only'
  | 'command-string'
  | 'stdin'
  | 'shopt'
  | 'shell-option'
  | 'help'
  | 'debug-noop'
  | 'no-profile'
  | 'no-rc'
  | 'no-editing'
  | 'rc-file'
  | 'init-file';

const BASH_ARGV_OPTION_DEFINITIONS = [
  {
    semantic: 'errexit',
    forms: [
      { kind: 'short', name: 'e', value: { kind: 'none' } },
      { kind: 'plus-short', name: 'e', value: { kind: 'none' } },
    ],
  },
  {
    semantic: 'nounset',
    forms: [
      { kind: 'short', name: 'u', value: { kind: 'none' } },
      { kind: 'plus-short', name: 'u', value: { kind: 'none' } },
    ],
  },
  {
    semantic: 'parse-only',
    forms: [
      { kind: 'short', name: 'n', value: { kind: 'none' } },
      { kind: 'plus-short', name: 'n', value: { kind: 'none' } },
    ],
  },
  {
    semantic: 'command-string',
    forms: [
      { kind: 'short', name: 'c', value: { kind: 'none' } },
      { kind: 'plus-short', name: 'c', value: { kind: 'none' } },
    ],
  },
  {
    semantic: 'stdin',
    forms: [
      { kind: 'short', name: 's', value: { kind: 'none' } },
      { kind: 'plus-short', name: 's', value: { kind: 'none' } },
    ],
  },
  {
    semantic: 'shopt',
    // `optional-following` is the Bash lexical shape: -Oe must analyze O and e
    // before command-owned semantics consumes the following shopt operand.
    forms: [
      { kind: 'short', name: 'O', value: { kind: 'optional-following' } },
      { kind: 'plus-short', name: 'O', value: { kind: 'optional-following' } },
    ],
  },
  {
    semantic: 'shell-option',
    // Keep the same cluster/cursor rule for -o/+o as for -O/+O.
    forms: [
      { kind: 'short', name: 'o', value: { kind: 'optional-following' } },
      { kind: 'plus-short', name: 'o', value: { kind: 'optional-following' } },
    ],
  },
  {
    semantic: 'help',
    forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
  },
  {
    semantic: 'debug-noop',
    // GNU Bash 5.2's --debug sets an otherwise unused internal flag. This is
    // distinct from --debugger, which has real debugger/startup semantics.
    forms: [{ kind: 'long', name: 'debug', value: { kind: 'none' } }],
  },
  {
    semantic: 'no-profile',
    forms: [{ kind: 'long', name: 'noprofile', value: { kind: 'none' } }],
  },
  {
    semantic: 'no-rc',
    forms: [{ kind: 'long', name: 'norc', value: { kind: 'none' } }],
  },
  {
    semantic: 'no-editing',
    // Wesh's Bash entrypoint is non-interactive; GNU Bash's --noediting only
    // disables interactive Readline editing, so accepting it is a true no-op here.
    forms: [{ kind: 'long', name: 'noediting', value: { kind: 'none' } }],
  },
  {
    semantic: 'rc-file',
    // GNU Bash ignores rcfile/init-file in non-interactive execution but still
    // consumes exactly one following argv value. Revisit if -i is implemented.
    forms: [{ kind: 'long', name: 'rcfile', value: { kind: 'required', missingValueName: 'rcfile' } }],
  },
  {
    semantic: 'init-file',
    forms: [{ kind: 'long', name: 'init-file', value: { kind: 'required', missingValueName: 'init-file' } }],
  },
] as const satisfies readonly ArgvOptionDefinition<BashArgvOptionSemantic>[];

const BASH_ARGV_CATALOG = defineArgvCatalog<BashArgvOptionSemantic>({
  definitions: BASH_ARGV_OPTION_DEFINITIONS,
  nonExecutableLongOptions: [],
});

type BashShortFormAnalysis = ReturnType<typeof analyzeArgvShortForm<BashArgvOptionSemantic>>;
type BashShortValueClaim = Extract<BashShortFormAnalysis, { kind: 'matched' }>['value'];

function assertNoBashShortValue({ value, option }: {
  value: BashShortValueClaim,
  option: string,
}): void {
  switch (value.kind) {
  case 'none':
    return;
  case 'inline':
  case 'following-required':
  case 'following-optional':
    throw new Error(`Unexpected value claim for Bash option ${option}`);
  default: {
    const _ex: never = value;
    throw new Error(`Unhandled Bash short value claim: ${JSON.stringify(_ex)}`);
  }
  }
}

function assertFollowingBashShortValue({ value, option }: {
  value: BashShortValueClaim,
  option: string,
}): void {
  switch (value.kind) {
  case 'following-optional':
    return;
  case 'none':
  case 'inline':
  case 'following-required':
    throw new Error(`Unexpected value claim for Bash option ${option}`);
  default: {
    const _ex: never = value;
    throw new Error(`Unhandled Bash short value claim: ${JSON.stringify(_ex)}`);
  }
  }
}

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
  let sourceMode: 'automatic' | 'stdin' = 'automatic';
  let commandStringMode = false;
  let helpRequested = false;
  let shortOptionParsingStarted = false;
  const state: MutableBashInvocationState = {
    mode: 'execute',
    errexit: false,
    nounset: false,
    pipefail: false,
    shellOptionOverrides: new Map(),
  };
  const pendingShoptValueOptions: Array<{ enabled: boolean, optionName: string }> = [];

  const basicOptionErrorExitCode = (): 1 | 2 => state.errexit ? 1 : 2;
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
    // GNU Bash performs an exact long-name pre-pass before ordinary short-option
    // parsing. That pre-pass accepts both --norc and the historical -norc spelling;
    // an unknown single-dash word falls through to short-cluster parsing instead.
    const initialLongToken = !shortOptionParsingStarted
      ? argument.startsWith('--')
        ? argument
        : argument.startsWith('-') && argument.length > 2 && !argument.includes('=')
          ? `-${argument}`
          : undefined
      : undefined;
    if (initialLongToken !== undefined) {
      const analysis = analyzeArgvLongForm({
        token: initialLongToken,
        catalog: BASH_ARGV_CATALOG,
        longNameMatch: 'exact',
      });
      switch (analysis.kind) {
      case 'unknown':
      case 'ambiguous':
        if (argument.startsWith('--')) return invalidOption({ argument });
        break;
      case 'matched':
        switch (analysis.semantic) {
        case 'rc-file':
        case 'init-file': {
          switch (analysis.value.kind) {
          case 'following-required':
            if (args[argumentIndex + 1] === undefined) {
              return {
                kind: 'error',
                message: `bash: ${analysis.value.valueName}: option requires an argument\n`,
                exitCode: 2,
              };
            }
            argumentIndex += 2;
            continue;
          case 'inline':
          case 'unexpected-inline':
            return invalidOption({ argument });
          case 'none':
            throw new Error(`Unexpected Bash startup-file value claim for ${argument}`);
          default: {
            const _ex: never = analysis.value;
            throw new Error(`Unhandled Bash startup-file value claim: ${JSON.stringify(_ex)}`);
          }
          }
        }
        case 'help':
          switch (analysis.value.kind) {
          case 'none':
            helpRequested = true;
            argumentIndex += 1;
            continue;
          case 'inline':
          case 'following-required':
          case 'unexpected-inline':
            return invalidOption({ argument });
          default: {
            const _ex: never = analysis.value;
            throw new Error(`Unhandled Bash help value claim: ${JSON.stringify(_ex)}`);
          }
          }
        case 'debug-noop':
        case 'no-profile':
        case 'no-rc':
        case 'no-editing':
          switch (analysis.value.kind) {
          case 'none':
            argumentIndex += 1;
            continue;
          case 'inline':
          case 'following-required':
          case 'unexpected-inline':
            return invalidOption({ argument });
          default: {
            const _ex: never = analysis.value;
            throw new Error(`Unhandled Bash no-op long value claim: ${JSON.stringify(_ex)}`);
          }
          }
        case 'errexit':
        case 'nounset':
        case 'parse-only':
        case 'command-string':
        case 'stdin':
        case 'shopt':
        case 'shell-option':
          throw new Error(`Unexpected Bash short option semantic for ${argument}`);
        default: {
          const _ex: never = analysis.semantic;
          throw new Error(`Unhandled Bash argv semantic: ${_ex}`);
        }
        }
      default: {
        const _ex: never = analysis;
        throw new Error(`Unhandled Bash long-option analysis: ${JSON.stringify(_ex)}`);
      }
      }
    }
    if (helpRequested) {
      return { kind: 'help' };
    }
    if (argument.startsWith('--')) {
      return invalidOption({ argument: '--' });
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
    const prefix: '-' | '+' = argument[0] === '-' ? '-' : '+';
    const enabled = prefix === '-';
    const pendingMissingValueOptions: Array<{ option: 'O' | 'o' }> = [];
    let followingValueOffset = 1;
    let bodyOffset = 1;
    while (bodyOffset < argument.length) {
      const analysis = analyzeArgvShortForm({
        token: argument,
        bodyOffset,
        prefix,
        catalog: BASH_ARGV_CATALOG,
      });
      switch (analysis.kind) {
      case 'unknown':
        return invalidOption({ argument: analysis.option });
      case 'matched':
        switch (analysis.semantic) {
        case 'errexit':
          assertNoBashShortValue({ value: analysis.value, option: analysis.option });
          state.errexit = enabled;
          break;
        case 'nounset':
          assertNoBashShortValue({ value: analysis.value, option: analysis.option });
          state.nounset = enabled;
          break;
        case 'parse-only':
          assertNoBashShortValue({ value: analysis.value, option: analysis.option });
          state.mode = enabled ? 'parse-only' : 'execute';
          break;
        case 'command-string':
          assertNoBashShortValue({ value: analysis.value, option: analysis.option });
          commandStringMode = true;
          break;
        case 'stdin':
          assertNoBashShortValue({ value: analysis.value, option: analysis.option });
          sourceMode = 'stdin';
          break;
        case 'shopt': {
          assertFollowingBashShortValue({ value: analysis.value, option: analysis.option });
          const optionName = args[argumentIndex + followingValueOffset];
          followingValueOffset += 1;
          // Bash claims following argv slots for -O/+O immediately, but defers
          // shopt-name validation until the invocation option scan has finished.
          if (optionName === undefined) {
            pendingMissingValueOptions.push({ option: 'O' });
          } else {
            pendingShoptValueOptions.push({ enabled, optionName });
          }
          break;
        }
        case 'shell-option': {
          assertFollowingBashShortValue({ value: analysis.value, option: analysis.option });
          const optionName = args[argumentIndex + followingValueOffset];
          followingValueOffset += 1;
          if (optionName === undefined) {
            // Preserve the existing incomplete bare -o/+o behavior for now, but
            // let a later invalid short option win just as Bash does.
            pendingMissingValueOptions.push({ option: 'o' });
            break;
          }
          if (
            !isBashValidShellOptionName(optionName)
            || !applyValidBashShellOption({ state, optionName, enabled })
          ) {
            return {
              kind: 'error',
              message: `bash: line 0: bash: ${optionName}: invalid option name\n`,
              exitCode: 2,
            };
          }
          break;
        }
        case 'help':
        case 'debug-noop':
        case 'no-profile':
        case 'no-rc':
        case 'no-editing':
        case 'rc-file':
        case 'init-file':
          throw new Error(`Unexpected Bash long option semantic for ${analysis.option}`);
        default: {
          const _ex: never = analysis.semantic;
          throw new Error(`Unhandled Bash argv semantic: ${_ex}`);
        }
        }
        bodyOffset = analysis.nextBodyOffset;
        break;
      default: {
        const _ex: never = analysis;
        throw new Error(`Unhandled Bash short-option analysis: ${JSON.stringify(_ex)}`);
      }
      }
    }

    const nextArgumentIndex = argumentIndex + followingValueOffset;
    // Bash may print a bare -o/-O option listing while scanning, but if -c has
    // no command string its missing-command diagnostic wins over deferred -O
    // validation and over the otherwise-blocked bare listing behavior.
    if (commandStringMode && args[nextArgumentIndex] === undefined) {
      return {
        kind: 'error',
        message: 'bash: -c: option requires an argument\n',
        exitCode: basicOptionErrorExitCode(),
      };
    }

    for (const pending of pendingMissingValueOptions) {
      return {
        kind: 'error',
        message: `bash: option requires an argument -- '${pending.option}'\n`,
        exitCode: 2,
      };
    }

    argumentIndex = nextArgumentIndex;
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

  if (helpRequested) {
    return { kind: 'help' };
  }

  const applyPendingShoptValueOptions = (): BashArgvResult | undefined => {
    for (const { enabled, optionName } of pendingShoptValueOptions) {
      if (!applyRepresentableBashShoptOption({ state, optionName, enabled })) {
        return {
          kind: 'error',
          message: `bash: line 0: ${optionName}: invalid shell option name\n`,
          exitCode: 2,
        };
      }
    }
    return undefined;
  };

  if (commandStringMode) {
    const script = args[argumentIndex];
    if (script === undefined) {
      return {
        kind: 'error',
        message: 'bash: -c: option requires an argument\n',
        exitCode: basicOptionErrorExitCode(),
      };
    }
    const pendingShoptError = applyPendingShoptValueOptions();
    if (pendingShoptError !== undefined) return pendingShoptError;
    return createBashInvocationPlan({
      state,
      source: {
        kind: 'command-string',
        script,
      },
      argv0: args[argumentIndex + 1] ?? 'bash',
      positionalArgs: args.slice(argumentIndex + 2),
    });
  }

  const pendingShoptError = applyPendingShoptValueOptions();
  if (pendingShoptError !== undefined) return pendingShoptError;

  switch (sourceMode) {
  case 'stdin':
    return createBashInvocationPlan({
      state,
      source: { kind: 'stdin' },
      argv0: 'bash',
      positionalArgs: args.slice(argumentIndex),
    });
  case 'automatic':
    break;
  default: {
    const _ex: never = sourceMode;
    throw new Error(`Unhandled Bash source mode: ${_ex}`);
  }
  }

  const scriptPath = args[argumentIndex];
  if (scriptPath === undefined) {
    return createBashInvocationPlan({
      state,
      source: { kind: 'stdin' },
      argv0: 'bash',
      positionalArgs: [],
    });
  }

  return createBashInvocationPlan({
    state,
    source: {
      kind: 'file',
      path: scriptPath,
    },
    argv0: scriptPath,
    positionalArgs: args.slice(argumentIndex + 1),
  });
}

/**
 * Apply the startup option state Bash imports from SHELLOPTS/BASHOPTS after
 * successful argv parsing. GNU Bash applies these environment values after
 * command-line option processing, so an imported enabled option wins over a
 * preceding +e/+u/+n/+o/+O disable. Unsupported-but-valid options stay
 * command/core compatibility gaps rather than being misreported as invalid.
 */
export function applyBashStartupEnvironmentOptions({ plan, shellopts, bashopts }: {
  plan: BashInvocationPlan,
  shellopts: string | undefined,
  bashopts: string | undefined,
}): BashStartupEnvironmentResult {
  const state: MutableBashInvocationState = {
    mode: plan.mode,
    errexit: plan.executionOptions.errexit,
    nounset: plan.executionOptions.nounset,
    pipefail: plan.executionOptions.pipefail,
    shellOptionOverrides: new Map(
      plan.shellOptionOverrides.map(({ name, enabled }) => [name, enabled]),
    ),
  };
  const warnings: string[] = [];

  if (shellopts !== undefined && shellopts.length > 0) {
    for (const optionName of extractBashColonUnits({ value: shellopts })) {
      if (!isBashValidShellOptionName(optionName)) {
        warnings.push(`bash: line 0: ${optionName}: invalid option name\n`);
        continue;
      }
      // Valid Bash options whose runtime semantics are not represented by the
      // current Wesh shell invocation state remain ignored rather than warned.
      applyValidBashShellOption({ state, optionName, enabled: true });
    }
  }

  if (bashopts !== undefined && bashopts.length > 0) {
    for (const optionName of extractBashColonUnits({ value: bashopts })) {
      // GNU Bash silently ignores unknown BASHOPTS names. Valid but currently
      // unsupported shopt names likewise remain outside this invocation model.
      applyRepresentableBashShoptOption({ state, optionName, enabled: true });
    }
  }

  return {
    plan: createBashInvocationPlan({
      state,
      source: plan.source,
      argv0: plan.argv0,
      positionalArgs: plan.positionalArgs,
    }),
    warnings,
  };
}

export const TEST_ONLY = {
};
