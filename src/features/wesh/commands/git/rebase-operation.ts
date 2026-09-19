import type { WeshCommandContext, WeshCommandResult } from "@/features/wesh/types";
import { applyCheckoutTreePlan, planCheckoutTree } from "./checkout";
import { commitSubject, readCommit } from "./commits";
import { readEffectiveConfig } from "./config";
import { sortGitPaths } from "./path-order";
import { collectRebaseCommits } from "./graph";
import type { GitCommitGraphCache } from "./graph";
import { formatPreparedMergeConflict } from "./merge-conflict";
import { resolveGitReflogIdentity, resolveGitTimestamp } from "./identity";
import { collectUnmergedPaths, readIndex, writeIndex } from "./index-file";
import { forceReplaceIndexAndWorktree } from "./index-worktree";
import { moveHeadReference, readHead, updateRef } from "./refs";
import { discoverRepository, discoverRepositoryFromContext } from "./repository";
import { beginRebaseStep, clearRebaseState, clearRebaseStoppedState, readRebaseState, writeRebaseState, writeRebaseStoppedState } from "./rebase-state";
import { readTreeIntoIndex, writeTreeFromIndex } from "./tree";
import type { GitReplayStepResult } from "./replay-operation";
import { applyReplayStep, createReplayCommit } from "./replay-operation";
import { printCheckoutConflicts } from "./checkout-like";
import { resolveContentConfigForContext } from "./content-config";
import { collectStatus } from "./status";

async function finishRebase({ context, repository, reflogAction }: {
    context: WeshCommandContext;
    repository: Awaited<ReturnType<typeof discoverRepository>>;
    reflogAction: string;
}): Promise<WeshCommandResult> {
  const state = await readRebaseState({ files: context.files, repository });
  if (state === undefined)
    throw new Error('no rebase in progress');
  const head = await readHead({ files: context.files, repository });
  if (head.objectId === undefined)
    throw new Error('rebase HEAD is unborn');
  const config = await readEffectiveConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', cwd: context.cwd, env: context.env });
  const identity = resolveGitReflogIdentity({ env: context.env, config });
  const timestamp = resolveGitTimestamp({ env: context.env, role: 'COMMITTER' });
  await updateRef({
    files: context.files,
    repository,
    refName: state.headRefName,
    objectId: head.objectId,
    reflog: {
      identity,
      timestamp,
      message: `${reflogAction} (finish): ${state.headRefName} onto ${state.ontoObjectId}`,
    },
  });
  await moveHeadReference({
    files: context.files,
    repository,
    target: { type: 'symbolic', refName: state.headRefName, objectId: head.objectId },
    reflog: {
      identity,
      timestamp,
      message: `${reflogAction} (finish): returning to ${state.headRefName}`,
    },
  });
  await clearRebaseState({ files: context.files, repository });
  await context.text().error({ text: `Successfully rebased and updated ${state.headRefName}.\n` });
  return { exitCode: 0 };
}
export async function executeRemainingRebaseSteps({ context, repository, reflogAction }: {
    context: WeshCommandContext;
    repository: Awaited<ReturnType<typeof discoverRepository>>;
    reflogAction: string;
}): Promise<WeshCommandResult> {
  while (true) {
    const step = await beginRebaseStep({ files: context.files, repository });
    if (step === undefined)
      return finishRebase({ context, repository, reflogAction });
    let result: GitReplayStepResult;
    try {
      result = await applyReplayStep({
        context,
        repository,
        kind: 'cherry-pick',
        sourceObjectId: step.objectId,
        reflogPrefix: `${reflogAction} (pick)`,
      });
    } catch (error) {
      await context.text().error({ text: `fatal: ${error instanceof Error ? error.message : String(error)}\n` });
      return { exitCode: 1 };
    }
    switch (result.type) {
    case 'checkout-conflict':
      await printCheckoutConflicts({ context, conflicts: result.conflicts });
      return { exitCode: 1 };
    case 'conflicted':
      await writeRebaseStoppedState({
        files: context.files,
        repository,
        sourceObjectId: step.objectId,
        message: result.replay.message,
        conflictPaths: result.preparedConflicts.map(conflict => conflict.path),
      });
      for (const path of result.replay.autoMergedPaths)
        await context.text().print({ text: `Auto-merging ${path}\n` });
      for (const conflict of result.preparedConflicts) {
        for (const text of formatPreparedMergeConflict({ conflict, oursLabel: 'HEAD', theirsLabel: result.replay.theirsLabel })) {
          await context.text().print({ text });
        }
      }
      await context.text().error({
        text: `error: could not apply ${step.objectId.slice(0, 7)}... ${step.subject}\n`,
      });
      await context.text().error({
        text: `Could not apply ${step.objectId.slice(0, 7)}... ${step.subject}\n`,
      });
      return { exitCode: 1 };
    case 'committed':
      continue;
    default: {
      const _ex: never = result;
      throw new Error(`Unhandled rebase replay result: ${String(_ex)}`);
    }
    }
  }
}
export async function continueRebase({ context }: {
    context: WeshCommandContext;
}): Promise<WeshCommandResult> {
  const repository = await discoverRepositoryFromContext({ context });
  const state = await readRebaseState({ files: context.files, repository });
  if (state === undefined || state.stoppedObjectId === undefined || state.message === undefined) {
    await context.text().error({ text: 'fatal: no rebase in progress\n' });
    return { exitCode: 128 };
  }
  const entries = await readIndex({ files: context.files, repository });
  const unmergedPaths = sortGitPaths({ paths: collectUnmergedPaths({ entries }) });
  if (unmergedPaths.length > 0) {
    await context.text().error({ text: `\
You must edit all merge conflicts and then
mark them as resolved using git add
` });
    return { exitCode: 1 };
  }
  const created = await createReplayCommit({
    context,
    repository,
    kind: 'cherry-pick',
    sourceObjectId: state.stoppedObjectId,
    message: state.message,
    reflogPrefix: 'rebase (continue)',
  });
  await clearRebaseStoppedState({ files: context.files, repository });
  await context.text().print({ text: `[detached HEAD ${created.objectId.slice(0, 7)}] ${created.subject}\n` });
  return executeRemainingRebaseSteps({ context, repository, reflogAction: 'rebase' });
}
export async function skipRebase({ context }: {
    context: WeshCommandContext;
}): Promise<WeshCommandResult> {
  const repository = await discoverRepositoryFromContext({ context });
  const state = await readRebaseState({ files: context.files, repository });
  if (state === undefined || state.stoppedObjectId === undefined) {
    await context.text().error({ text: 'fatal: no rebase in progress\n' });
    return { exitCode: 128 };
  }
  const head = await readHead({ files: context.files, repository });
  if (head.objectId === undefined)
    throw new Error('rebase HEAD is unborn');
  const headCommit = await readCommit({ files: context.files, repository, objectId: head.objectId });
  const headEntries = await readTreeIntoIndex({ files: context.files, repository, treeObjectId: headCommit.treeObjectId });
  await forceReplaceIndexAndWorktree({
    files: context.files,
    repository,
    currentIndexEntries: await readIndex({ files: context.files, repository }),
    targetEntries: headEntries,
    contentConfig: await resolveContentConfigForContext({ context, repository }),
  });
  await clearRebaseStoppedState({ files: context.files, repository });
  return executeRemainingRebaseSteps({ context, repository, reflogAction: 'rebase' });
}
export async function abortRebase({ context }: {
    context: WeshCommandContext;
}): Promise<WeshCommandResult> {
  const repository = await discoverRepositoryFromContext({ context });
  const state = await readRebaseState({ files: context.files, repository });
  if (state === undefined) {
    await context.text().error({ text: 'fatal: no rebase in progress\n' });
    return { exitCode: 128 };
  }
  const origCommit = await readCommit({ files: context.files, repository, objectId: state.origHeadObjectId });
  const origEntries = await readTreeIntoIndex({ files: context.files, repository, treeObjectId: origCommit.treeObjectId });
  await forceReplaceIndexAndWorktree({
    files: context.files,
    repository,
    currentIndexEntries: await readIndex({ files: context.files, repository }),
    targetEntries: origEntries,
    contentConfig: await resolveContentConfigForContext({ context, repository }),
  });
  const config = await readEffectiveConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', cwd: context.cwd, env: context.env });
  await moveHeadReference({
    files: context.files,
    repository,
    target: { type: 'symbolic', refName: state.headRefName, objectId: state.origHeadObjectId },
    reflog: {
      identity: resolveGitReflogIdentity({ env: context.env, config }),
      timestamp: resolveGitTimestamp({ env: context.env, role: 'COMMITTER' }),
      message: `rebase (abort): returning to ${state.headRefName}`,
    },
  });
  await clearRebaseState({ files: context.files, repository });
  return { exitCode: 0 };
}
export async function validateRebaseStartWorktree({ context, repository, headObjectId }: {
    context: WeshCommandContext;
    repository: Awaited<ReturnType<typeof discoverRepository>>;
    headObjectId: string;
}): Promise<WeshCommandResult | undefined> {
  const currentIndexEntries = await readIndex({ files: context.files, repository });
  const headCommit = await readCommit({ files: context.files, repository, objectId: headObjectId });
  const currentIndexTreeObjectId = await writeTreeFromIndex({ files: context.files, repository, entries: currentIndexEntries });
  if (currentIndexTreeObjectId !== headCommit.treeObjectId) {
    await context.text().error({ text: 'error: cannot rebase: Your index contains uncommitted changes.\n' });
    return { exitCode: 1 };
  }
  const status = await collectStatus({ context });
  const dirtyTracked = status.entries.filter(entry => entry.worktreeStatus !== ' ' && entry.worktreeStatus !== '?');
  if (dirtyTracked.length > 0) {
    await context.text().error({ text: 'error: cannot rebase: You have unstaged changes.\n' });
    return { exitCode: 1 };
  }
  return undefined;
}
export async function checkoutRebaseTargetBranch({ context, repository, currentHeadObjectId, targetRefName, targetObjectId, branchDisplay }: {
    context: WeshCommandContext;
    repository: Awaited<ReturnType<typeof discoverRepository>>;
    currentHeadObjectId: string;
    targetRefName: string;
    targetObjectId: string;
    branchDisplay: string;
}): Promise<WeshCommandResult | undefined> {
  const currentIndexEntries = await readIndex({ files: context.files, repository });
  const currentCommit = await readCommit({ files: context.files, repository, objectId: currentHeadObjectId });
  const targetCommit = await readCommit({ files: context.files, repository, objectId: targetObjectId });
  const currentHeadEntries = await readTreeIntoIndex({ files: context.files, repository, treeObjectId: currentCommit.treeObjectId });
  const targetEntries = await readTreeIntoIndex({ files: context.files, repository, treeObjectId: targetCommit.treeObjectId });
  const plan = await planCheckoutTree({
    files: context.files,
    repository,
    currentHeadEntries,
    currentIndexEntries,
    targetEntries,
    contentConfig: await resolveContentConfigForContext({ context, repository }),
  });
  if (plan.conflicts.length > 0) {
    await printCheckoutConflicts({ context, conflicts: plan.conflicts });
    return { exitCode: 1 };
  }
  await applyCheckoutTreePlan({
    files: context.files,
    repository,
    currentIndexEntries,
    plan,
    contentConfig: await resolveContentConfigForContext({ context, repository }),
  });
  await writeIndex({ files: context.files, repository, entries: plan.nextIndexEntries });
  const config = await readEffectiveConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', cwd: context.cwd, env: context.env });
  await moveHeadReference({
    files: context.files,
    repository,
    target: { type: 'symbolic', refName: targetRefName, objectId: targetObjectId },
    reflog: {
      identity: resolveGitReflogIdentity({ env: context.env, config }),
      timestamp: resolveGitTimestamp({ env: context.env, role: 'COMMITTER' }),
      message: `rebase: checkout ${branchDisplay}`,
    },
  });
  return undefined;
}
export async function startRebaseSequence({ context, repository, graphCache, headRefName, origHeadObjectId, checkoutHeadObjectId, ontoObjectId, replayBaseObjectId, ontoDisplay, reflogAction }: {
    context: WeshCommandContext;
    repository: Awaited<ReturnType<typeof discoverRepository>>;
    graphCache: GitCommitGraphCache;
    headRefName: string;
    origHeadObjectId: string;
    checkoutHeadObjectId: string;
    ontoObjectId: string;
    replayBaseObjectId: string;
    ontoDisplay: string;
    reflogAction: string;
}): Promise<WeshCommandResult> {
  const currentIndexEntries = await readIndex({ files: context.files, repository });
  const replayObjectIds = await collectRebaseCommits({
    files: context.files,
    repository,
    cache: graphCache,
    upstreamObjectId: replayBaseObjectId,
    descendantObjectId: origHeadObjectId,
  });
  const todo = [];
  for (const objectId of replayObjectIds) {
    const commit = await readCommit({
      files: context.files,
      repository,
      objectId,
      objectReadCache: graphCache.objectReadCache,
    });
    todo.push({ objectId, subject: commitSubject({ commit }) });
  }
  const ontoCommit = await readCommit({
    files: context.files,
    repository,
    objectId: ontoObjectId,
    objectReadCache: graphCache.objectReadCache,
  });
  const ontoEntries = await readTreeIntoIndex({
    files: context.files,
    repository,
    treeObjectId: ontoCommit.treeObjectId,
    objectReadCache: graphCache.objectReadCache,
  });
  const checkoutHeadCommit = await readCommit({
    files: context.files,
    repository,
    objectId: checkoutHeadObjectId,
    objectReadCache: graphCache.objectReadCache,
  });
  const currentHeadEntries = await readTreeIntoIndex({
    files: context.files,
    repository,
    treeObjectId: checkoutHeadCommit.treeObjectId,
    objectReadCache: graphCache.objectReadCache,
  });
  const plan = await planCheckoutTree({
    files: context.files,
    repository,
    currentHeadEntries,
    currentIndexEntries,
    targetEntries: ontoEntries,
    contentConfig: await resolveContentConfigForContext({ context, repository }),
  });
  if (plan.conflicts.length > 0) {
    await printCheckoutConflicts({ context, conflicts: plan.conflicts });
    return { exitCode: 1 };
  }
  await writeRebaseState({
    files: context.files,
    repository,
    headRefName,
    origHeadObjectId,
    ontoObjectId,
    todo,
  });
  await applyCheckoutTreePlan({
    files: context.files,
    repository,
    currentIndexEntries,
    plan,
    contentConfig: await resolveContentConfigForContext({ context, repository }),
  });
  await writeIndex({ files: context.files, repository, entries: plan.nextIndexEntries });
  const config = await readEffectiveConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', cwd: context.cwd, env: context.env });
  await moveHeadReference({
    files: context.files,
    repository,
    target: { type: 'detached', objectId: ontoObjectId },
    reflog: {
      identity: resolveGitReflogIdentity({ env: context.env, config }),
      timestamp: resolveGitTimestamp({ env: context.env, role: 'COMMITTER' }),
      message: `${reflogAction} (start): checkout ${ontoDisplay}`,
    },
  });
  return executeRemainingRebaseSteps({ context, repository, reflogAction });
}

export const TEST_ONLY = {
};
