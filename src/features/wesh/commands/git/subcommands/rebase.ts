import { GitUsageError } from '@/features/wesh/commands/git/errors';
import { analyzeArgvLongForm, defineArgvCatalog } from '@/features/wesh/argv-v2';
import { getConfigValue, readEffectiveConfig } from '@/features/wesh/commands/git/config';
import type { WeshCommandContext, WeshCommandResult } from "@/features/wesh/types";
import { readCommit } from "@/features/wesh/commands/git/commits";
import { createGitCommitGraphCache, findMergeBases, isAncestor } from "@/features/wesh/commands/git/graph";
import { readMergeState } from "@/features/wesh/commands/git/merge-state";
import { branchNameFromHead, readHead, readRef } from "@/features/wesh/commands/git/refs";
import { discoverRepositoryFromContext } from "@/features/wesh/commands/git/repository";
import { resolveCommitRevision } from "@/features/wesh/commands/git/revision";
import { readRebaseState } from "@/features/wesh/commands/git/rebase-state";
import { readReplayState } from "@/features/wesh/commands/git/replay-state";
import { abortRebase, checkoutRebaseTargetBranch, continueRebase, skipRebase, startRebaseSequence, validateRebaseStartWorktree } from "@/features/wesh/commands/git/rebase-operation";
import { assertSupportedRepositoryContentPolicy } from "@/features/wesh/commands/git/content-policy";


type RebaseControlAction = 'continue' | 'abort' | 'skip';

type RebaseStartArguments = {
  upstreamExpression: string | undefined;
  ontoExpression: string | undefined;
  branchExpression: string | undefined;
  explicitOnto: boolean;
};

const REBASE_START_ARGV_CATALOG = defineArgvCatalog<'onto'>({
  nonExecutableLongOptions: [],
  definitions: [{
    semantic: 'onto',
    forms: [{ kind: 'long', name: 'onto', value: { kind: 'required', missingValueName: 'newbase' } }],
  }],
});

function resolveRebaseControlAction({ token }: { token: string }): RebaseControlAction | undefined {
  if (!token.startsWith('--') || token.includes('=')) return undefined;
  const name = token.slice(2);
  if (name.length >= 3 && 'continue'.startsWith(name)) return 'continue';
  if (name.length >= 2 && 'abort'.startsWith(name)) return 'abort';
  if (name.length >= 2 && 'skip'.startsWith(name)) return 'skip';
  return undefined;
}

function parseRebaseStartArguments({ args }: { args: readonly string[] }): RebaseStartArguments {
  let parsingOptions = true;
  let ontoExpression: string | undefined;
  const operands: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (parsingOptions && arg === '--') {
      parsingOptions = false;
      continue;
    }
    if (parsingOptions && arg.startsWith('--')) {
      const analysis = analyzeArgvLongForm({
        token: arg,
        catalog: REBASE_START_ARGV_CATALOG,
        longNameMatch: 'unique-prefix',
      });
      switch (analysis.kind) {
      case 'matched':
        switch (analysis.semantic) {
        case 'onto':
          switch (analysis.value.kind) {
          case 'inline':
            ontoExpression = analysis.value.rawValue;
            break;
          case 'following-required': {
            const value = args[index + 1];
            if (value === undefined)
              throw new GitUsageError({ message: "option `onto' requires a value" });
            ontoExpression = value;
            index += 1;
            break;
          }
          case 'none':
          case 'unexpected-inline':
            throw new Error(`Unexpected rebase --onto argv-v2 value analysis: ${JSON.stringify(analysis.value)}`);
          default: {
            const _ex: never = analysis.value;
            throw new Error(`Unhandled rebase --onto argv-v2 value analysis: ${JSON.stringify(_ex)}`);
          }
          }
          continue;
        default: {
          const _ex: never = analysis.semantic;
          throw new Error(`Unhandled rebase argv-v2 semantic: ${_ex}`);
        }
        }
      case 'unknown':
        throw new GitUsageError({ message: `unknown option: ${arg}` });
      case 'ambiguous':
        throw new GitUsageError({ message: `ambiguous option: ${arg}` });
      default: {
        const _ex: never = analysis;
        throw new Error(`Unhandled rebase argv-v2 analysis: ${JSON.stringify(_ex)}`);
      }
      }
    }
    if (parsingOptions && arg.startsWith('-'))
      throw new GitUsageError({ message: `unknown option: ${arg}` });
    operands.push(arg);
  }
  if (operands.length > 2 || (ontoExpression !== undefined && operands.length === 0)) {
    throw new GitUsageError({ message: 'usage: git rebase [--onto <newbase>] [<upstream> [<branch>]]', prefix: 'none' });
  }
  const upstreamExpression = operands[0];
  return {
    upstreamExpression,
    ontoExpression: ontoExpression ?? upstreamExpression,
    branchExpression: operands[1],
    explicitOnto: ontoExpression !== undefined,
  };
}

export async function runRebase({ context, args }: {
    context: WeshCommandContext;
    args: readonly string[];
}): Promise<WeshCommandResult> {
  await assertSupportedRepositoryContentPolicy({ context });
  const controlAction = args.length === 1 ? resolveRebaseControlAction({ token: args[0]! }) : undefined;
  switch (controlAction) {
  case 'continue':
    return continueRebase({ context });
  case 'abort':
    return abortRebase({ context });
  case 'skip':
    return skipRebase({ context });
  case undefined:
    break;
  default: {
    const _ex: never = controlAction;
    throw new Error(`Unhandled rebase control action: ${_ex}`);
  }
  }
  const parsed = parseRebaseStartArguments({ args });
  let upstreamExpression = parsed.upstreamExpression;
  let ontoExpression = parsed.ontoExpression;
  const { branchExpression, explicitOnto } = parsed;
  const repository = await discoverRepositoryFromContext({ context });
  if (await readRebaseState({ files: context.files, repository }) !== undefined) {
    await context.text().error({ text: 'fatal: It seems that there is already a rebase-merge directory\n' });
    return { exitCode: 128 };
  }
  if (await readMergeState({ files: context.files, repository }) !== undefined
        || await readReplayState({ files: context.files, repository }) !== undefined) {
    await context.text().error({ text: 'fatal: cannot rebase while another Git operation is in progress\n' });
    return { exitCode: 128 };
  }
  const currentHead = await readHead({ files: context.files, repository });
  if (currentHead.objectId === undefined)
    throw new Error('rebase requires HEAD to reference a commit');
  let headRefName: string;
  let origHeadObjectId: string;
  let branchDisplay: string;
  if (branchExpression === undefined) {
    if (currentHead.symbolicRef === undefined || !currentHead.symbolicRef.startsWith('refs/heads/')) {
      throw new Error('rebase requires an attached branch unless a branch operand is specified');
    }
    headRefName = currentHead.symbolicRef;
    origHeadObjectId = currentHead.objectId;
    branchDisplay = branchNameFromHead({ head: currentHead }) ?? 'HEAD';
  } else {
    headRefName = branchExpression.startsWith('refs/heads/') ? branchExpression : `refs/heads/${branchExpression}`;
    const branchObjectId = await readRef({ files: context.files, repository, refName: headRefName });
    if (branchObjectId === undefined)
      throw new Error(`invalid branch: ${branchExpression}`);
    await readCommit({ files: context.files, repository, objectId: branchObjectId });
    origHeadObjectId = branchObjectId;
    branchDisplay = headRefName.slice('refs/heads/'.length);
  }
  if (upstreamExpression === undefined) {
    const branchName = branchNameFromHead({ head: currentHead });
    if (branchName === undefined) {
      await context.text().print({
        text: `You are not currently on a branch.\nPlease specify which branch you want to rebase against.\nSee git-rebase(1) for details.\n\n    git rebase '<branch>'\n\n`,
      });
      return { exitCode: 1 };
    }
    const config = await readEffectiveConfig({
      files: context.files,
      repository,
      homePath: context.env.get('HOME') ?? '/',
      cwd: context.cwd,
      env: context.env,
    });
    const remoteName = getConfigValue({ config, key: `branch.${branchName}.remote` });
    const mergeRefName = getConfigValue({ config, key: `branch.${branchName}.merge` });
    if (remoteName === undefined || mergeRefName?.startsWith('refs/heads/') !== true) {
      await context.text().print({
        text: `There is no tracking information for the current branch.\nPlease specify which branch you want to rebase against.\nSee git-rebase(1) for details.\n\n    git rebase '<branch>'\n\nIf you wish to set tracking information for this branch you can do so with:\n\n    git branch --set-upstream-to=<remote>/<branch> ${branchName}\n\n`,
      });
      return { exitCode: 1 };
    }
    const upstreamBranchName = mergeRefName.slice('refs/heads/'.length);
    upstreamExpression = remoteName === '.' ? mergeRefName : `refs/remotes/${remoteName}/${upstreamBranchName}`;
    ontoExpression = upstreamExpression;
  }

  const preflightFailure = await validateRebaseStartWorktree({ context, repository, headObjectId: currentHead.objectId });
  if (preflightFailure !== undefined)
    return preflightFailure;

  const upstreamObjectId = await resolveCommitRevision({ files: context.files, repository, expression: upstreamExpression });
  await readCommit({ files: context.files, repository, objectId: upstreamObjectId });
  if (ontoExpression === undefined) throw new Error('rebase onto expression was not resolved');
  const ontoObjectId = await resolveCommitRevision({ files: context.files, repository, expression: ontoExpression });
  await readCommit({ files: context.files, repository, objectId: ontoObjectId });
  const graphCache = createGitCommitGraphCache();
  if (!explicitOnto && await isAncestor({
    files: context.files,
    repository,
    cache: graphCache,
    ancestorObjectId: upstreamObjectId,
    descendantObjectId: origHeadObjectId,
  })) {
    if (currentHead.symbolicRef !== headRefName || currentHead.objectId !== origHeadObjectId) {
      const checkoutFailure = await checkoutRebaseTargetBranch({
        context,
        repository,
        currentHeadObjectId: currentHead.objectId,
        targetRefName: headRefName,
        targetObjectId: origHeadObjectId,
        branchDisplay,
      });
      if (checkoutFailure !== undefined)
        return checkoutFailure;
    }
    await context.text().print({ text: `Current branch ${branchDisplay} is up to date.\n` });
    return { exitCode: 0 };
  }
  let replayBaseObjectId: string;
  if (explicitOnto) {
    replayBaseObjectId = upstreamObjectId;
  } else {
    const bases = await findMergeBases({
      files: context.files,
      repository,
      cache: graphCache,
      leftObjectId: origHeadObjectId,
      rightObjectId: upstreamObjectId,
    });
    if (bases.length !== 1)
      throw new Error(`rebase expected one merge base, found ${bases.length}`);
    replayBaseObjectId = upstreamObjectId;
  }
  return startRebaseSequence({
    context,
    repository,
    graphCache,
    headRefName,
    origHeadObjectId,
    checkoutHeadObjectId: currentHead.objectId,
    ontoObjectId,
    replayBaseObjectId,
    ontoDisplay: ontoExpression,
    reflogAction: 'rebase',
  });
}

export const TEST_ONLY = {
};
