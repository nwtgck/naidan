import { analyzeArgvLongForm, analyzeArgvShortForm, defineArgvCatalog } from '@/features/wesh/argv-v2';
import { formatGitAmbiguousLongOption } from '@/features/wesh/commands/git/argv-diagnostics';
import { GitUsageError } from '@/features/wesh/commands/git/errors';
import type { GitReplayRequest } from '@/features/wesh/commands/git/replay-operation';
import type { GitReplayKind } from '@/features/wesh/commands/git/replay-state';

const REPLAY_SHORT_ARGV_CATALOG = defineArgvCatalog<'mainline'>({
  nonExecutableLongOptions: [],
  definitions: [{
    semantic: 'mainline',
    forms: [{ kind: 'short', name: 'm', value: { kind: 'required-attached-or-following', missingValueName: 'parent-number' } }],
  }],
});

type ReplayLongSemantic = 'no-edit' | 'mainline';

const REPLAY_LONG_ARGV_CATALOG = defineArgvCatalog<ReplayLongSemantic>({
  nonExecutableLongOptions: [],
  definitions: [{
    semantic: 'no-edit',
    forms: [{ kind: 'long', name: 'no-edit', value: { kind: 'none' } }],
  }, {
    semantic: 'mainline',
    forms: [{ kind: 'long', name: 'mainline', value: { kind: 'required', missingValueName: 'parent-number' } }],
  }],
});

function parsePositiveParentNumber({ value, option }: {
  value: string,
  option: string,
}): number {
  if (!/^[1-9][0-9]*$/u.test(value))
    throw new GitUsageError({ message: `option '${option}' requires a positive parent number` });
  return Number.parseInt(value, 10);
}

function replayUsage({ kind }: { kind: GitReplayKind }): string {
  switch (kind) {
  case 'cherry-pick':
    return 'usage: git cherry-pick [--no-edit] [-m <parent-number>] <commit>...';
  case 'revert':
    return 'usage: git revert [--no-edit] [-m <parent-number>] <commit>...';
  default: {
    const _ex: never = kind;
    throw new Error(`Unhandled Git replay kind: ${_ex}`);
  }
  }
}

function unsupportedReplayOption({ kind, option }: {
  kind: GitReplayKind,
  option: string,
}): GitUsageError {
  return new GitUsageError({ message: `unsupported ${kind} option: ${option}` });
}

export function parseReplayControlAction({ args }: {
  args: readonly string[];
}): Exclude<GitReplayRequest['action'], 'start'> | undefined {
  let action: Exclude<GitReplayRequest['action'], 'start'> | undefined;
  let hasUnsupportedArgument = false;
  for (const arg of args) {
    let nextAction: Exclude<GitReplayRequest['action'], 'start'> | undefined;
    switch (arg) {
    case '--continue':
      nextAction = 'continue';
      break;
    case '--abort':
      nextAction = 'abort';
      break;
    case '--skip':
      nextAction = 'skip';
      break;
    case '--no-edit':
      continue;
    default:
      hasUnsupportedArgument = true;
      continue;
    }
    if (action !== undefined && action !== nextAction)
      throw new GitUsageError({ message: `options '${arg}' and '--${action}' cannot be used together` });
    action = nextAction;
  }
  if (action !== undefined && hasUnsupportedArgument)
    throw new GitUsageError({ message: `options cannot be combined with '--${action}'` });
  return action;
}

export function parseReplayArguments({ args, kind }: {
  args: readonly string[];
  kind: GitReplayKind;
}): GitReplayRequest {
  const controlAction = parseReplayControlAction({ args });
  if (controlAction !== undefined)
    return { action: controlAction, operands: [], mainlineParentNumber: undefined };

  const operands: string[] = [];
  let parsingOptions = true;
  let mainlineParentNumber: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (parsingOptions && arg === '--') {
      parsingOptions = false;
      continue;
    }
    if (!parsingOptions) {
      operands.push(arg);
      continue;
    }
    if (arg.startsWith('-') && !arg.startsWith('--') && arg.length > 1) {
      const analysis = analyzeArgvShortForm({ token: arg, bodyOffset: 1, prefix: '-', catalog: REPLAY_SHORT_ARGV_CATALOG });
      switch (analysis.kind) {
      case 'unknown':
        throw unsupportedReplayOption({ kind, option: arg });
      case 'matched':
        break;
      default: {
        const _ex: never = analysis;
        throw new Error(`Unhandled replay short analysis: ${JSON.stringify(_ex)}`);
      }
      }
      switch (analysis.semantic) {
      case 'mainline':
        switch (analysis.value.kind) {
        case 'inline':
          mainlineParentNumber = parsePositiveParentNumber({ value: analysis.value.rawValue, option: analysis.option });
          break;
        case 'following-required': {
          const value = args[index + 1];
          if (value === undefined)
            throw new GitUsageError({ message: `option '${analysis.option}' requires a positive parent number` });
          mainlineParentNumber = parsePositiveParentNumber({ value, option: analysis.option });
          index += 1;
          break;
        }
        case 'none':
        case 'following-optional':
          throw new Error(`Replay -m produced invalid value claim: ${analysis.value.kind}`);
        default: {
          const _ex: never = analysis.value;
          throw new Error(`Unhandled replay -m value claim: ${JSON.stringify(_ex)}`);
        }
        }
        break;
      default: {
        const _ex: never = analysis.semantic;
        throw new Error(`Unhandled replay short semantic: ${_ex}`);
      }
      }
      continue;
    }
    if (arg.startsWith('--')) {
      const analysis = analyzeArgvLongForm({ token: arg, catalog: REPLAY_LONG_ARGV_CATALOG, longNameMatch: 'exact' });
      switch (analysis.kind) {
      case 'unknown':
        throw unsupportedReplayOption({ kind, option: arg });
      case 'ambiguous':
        throw new GitUsageError({
          message: formatGitAmbiguousLongOption({
            option: analysis.option,
            candidateOptions: analysis.candidateOptions,
          }),
        });
      case 'matched':
        break;
      default: {
        const _ex: never = analysis;
        throw new Error(`Unhandled replay long analysis: ${JSON.stringify(_ex)}`);
      }
      }
      switch (analysis.semantic) {
      case 'no-edit':
        switch (analysis.value.kind) {
        case 'none':
          break;
        case 'unexpected-inline':
          throw unsupportedReplayOption({ kind, option: arg });
        case 'inline':
        case 'following-required':
          throw new Error(`Replay --no-edit unexpectedly claimed a value: ${analysis.value.kind}`);
        default: {
          const _ex: never = analysis.value;
          throw new Error(`Unhandled replay --no-edit value claim: ${JSON.stringify(_ex)}`);
        }
        }
        break;
      case 'mainline': {
        switch (analysis.value.kind) {
        case 'inline':
          mainlineParentNumber = parsePositiveParentNumber({ value: analysis.value.rawValue, option: analysis.option });
          break;
        case 'following-required': {
          const value = args[index + 1];
          if (value === undefined)
            throw new GitUsageError({ message: `option '${analysis.option}' requires a positive parent number` });
          mainlineParentNumber = parsePositiveParentNumber({ value, option: analysis.option });
          index += 1;
          break;
        }
        case 'none':
        case 'unexpected-inline':
          throw new Error(`Replay --mainline produced invalid value claim: ${analysis.value.kind}`);
        default: {
          const _ex: never = analysis.value;
          throw new Error(`Unhandled replay --mainline value claim: ${JSON.stringify(_ex)}`);
        }
        }
        break;
      }
      default: {
        const _ex: never = analysis.semantic;
        throw new Error(`Unhandled replay long semantic: ${_ex}`);
      }
      }
      continue;
    }
    operands.push(arg);
  }
  if (operands.length === 0)
    throw new GitUsageError({ message: replayUsage({ kind }), prefix: 'none' });
  return { action: 'start', operands, mainlineParentNumber };
}

export const TEST_ONLY = {
  parseReplayControlAction,
};
