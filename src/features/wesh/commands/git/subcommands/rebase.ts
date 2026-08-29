import { GitUsageError } from '@/features/wesh/commands/git/errors';
import { getConfigValue, readEffectiveConfig } from '@/features/wesh/commands/git/config';
import type { WeshCommandContext, WeshCommandResult } from "@/features/wesh/types";
import { readCommit } from "@/features/wesh/commands/git/commits";
import { findMergeBases, isAncestor } from "@/features/wesh/commands/git/graph";
import { readMergeState } from "@/features/wesh/commands/git/merge-state";
import { branchNameFromHead, readHead, readRef } from "@/features/wesh/commands/git/refs";
import { discoverRepositoryFromContext } from "@/features/wesh/commands/git/repository";
import { resolveCommitRevision } from "@/features/wesh/commands/git/revision";
import { readRebaseState } from "@/features/wesh/commands/git/rebase-state";
import { readReplayState } from "@/features/wesh/commands/git/replay-state";
import { abortRebase, checkoutRebaseTargetBranch, continueRebase, skipRebase, startRebaseSequence, validateRebaseStartWorktree } from "@/features/wesh/commands/git/rebase-operation";
import { assertSupportedRepositoryContentPolicy } from "@/features/wesh/commands/git/content-policy";


type RebaseStartArguments = {
  upstreamExpression: string | undefined;
  ontoExpression: string | undefined;
  branchExpression: string | undefined;
  explicitOnto: boolean;
};

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
    if (parsingOptions && arg === '--onto') {
      const value = args[index + 1];
      if (value === undefined)
        throw new GitUsageError({ message: 'usage: git rebase --onto <newbase> <upstream> [<branch>]', prefix: 'none' });
      ontoExpression = value;
      index += 1;
      continue;
    }
    if (parsingOptions && arg.startsWith('--onto=')) {
      ontoExpression = arg.slice('--onto='.length);
      continue;
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
  if (args.length === 1 && args[0] === '--continue')
    return continueRebase({ context });
  if (args.length === 1 && args[0] === '--abort')
    return abortRebase({ context });
  if (args.length === 1 && args[0] === '--skip')
    return skipRebase({ context });
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
  if (!explicitOnto && await isAncestor({
    files: context.files,
    repository,
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
