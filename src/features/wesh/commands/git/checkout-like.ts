import type { WeshCommandContext, WeshCommandResult } from "@/features/wesh/types";
import { applyCheckoutTreePlan, planCheckoutTree } from "./checkout";
import { commitSubject, readCommit } from "./commits";
import { readEffectiveConfig, shouldCreateBranchReflog } from "./config";
import { resolveGitReflogIdentity, resolveGitTimestamp } from "./identity";
import type { GitIndexEntry } from "./index-file";
import { readIndex, writeIndex } from "./index-file";
import { branchNameFromHead, createRef, moveHeadReference, readHead, readRef } from "./refs";
import { discoverRepository, discoverRepositoryFromContext } from "./repository";
import { resolveCommitRevision } from "./revision";
import { readTreeIntoIndex } from "./tree";
import { collectStatus } from "./status";
import { resolveContentConfigForContext } from "./content-config";
import { branchRefName } from "./branch";

export interface CheckoutLikeArguments {
    createBranchName: string | undefined;
    detach: boolean;
    targetExpression: string;
    missingBranchBehavior: 'resolve-revision' | 'reject';
}
async function readHeadIndex({ context, repository }: {
    context: WeshCommandContext;
    repository: Awaited<ReturnType<typeof discoverRepository>>;
}): Promise<GitIndexEntry[]> {
  const head = await readHead({ files: context.files, repository });
  if (head.objectId === undefined)
    return [];
  const commit = await readCommit({ files: context.files, repository, objectId: head.objectId });
  return readTreeIntoIndex({ files: context.files, repository, treeObjectId: commit.treeObjectId });
}
export async function printCheckoutConflicts({ context, conflicts }: {
    context: WeshCommandContext;
    conflicts: readonly {
        type: 'tracked' | 'untracked' | 'untracked-directory';
        path: string;
    }[];
}): Promise<void> {
  const tracked = conflicts.filter(conflict => conflict.type === 'tracked');
  const untracked = conflicts.filter(conflict => conflict.type === 'untracked');
  const untrackedDirectories = conflicts.filter(conflict => conflict.type === 'untracked-directory');
  if (tracked.length > 0) {
    await context.text().error({ text: 'error: Your local changes to the following files would be overwritten by checkout:\n' });
    for (const conflict of tracked)
      await context.text().error({ text: `\t${conflict.path}\n` });
    await context.text().error({ text: 'Please commit your changes or stash them before you switch branches.\n' });
  }
  if (untracked.length > 0) {
    await context.text().error({ text: 'error: The following untracked working tree files would be overwritten by checkout:\n' });
    for (const conflict of untracked)
      await context.text().error({ text: `\t${conflict.path}\n` });
    await context.text().error({ text: 'Please move or remove them before you switch branches.\n' });
  }
  if (untrackedDirectories.length > 0) {
    await context.text().error({ text: 'error: Updating the following directories would lose untracked files in them:\n' });
    for (const conflict of untrackedDirectories)
      await context.text().error({ text: `\t${conflict.path}\n` });
    await context.text().error({ text: '\n' });
  }
  await context.text().error({ text: 'Aborting\n' });
}
async function printPreservedCheckoutChanges({ context }: {
    context: WeshCommandContext;
}): Promise<void> {
  const status = await collectStatus({ context });
  for (const entry of status.entries) {
    switch (entry.worktreeStatus) {
    case '?':
      continue;
    case ' ':
    case 'M':
    case 'D':
      break;
    case 'U':
      throw new Error(`cannot report preserved checkout changes for unmerged path: ${entry.path}`);
    default: {
      const _ex: never = entry.worktreeStatus;
      throw new Error(`Unhandled worktree status: ${_ex}`);
    }
    }
    let code: 'A' | 'M' | 'D' | ' ';
    switch (entry.indexStatus) {
    case 'A':
    case 'M':
    case 'D':
      code = entry.indexStatus;
      break;
    case ' ':
      code = entry.worktreeStatus;
      break;
    case 'U':
      throw new Error(`cannot report preserved checkout changes for unmerged path: ${entry.path}`);
    default: {
      const _ex: never = entry.indexStatus;
      throw new Error(`Unhandled index status: ${_ex}`);
    }
    }
    switch (code) {
    case 'A':
    case 'M':
    case 'D':
      await context.text().print({ text: `${code}\t${entry.path}\n` });
      break;
    case ' ':
      break;
    default: {
      const _ex: never = code;
      throw new Error(`Unhandled checkout status: ${_ex}`);
    }
    }
  }
}
export async function executeCheckoutLike({ context, parsed }: {
    context: WeshCommandContext;
    parsed: CheckoutLikeArguments;
}): Promise<WeshCommandResult> {
  const repository = await discoverRepositoryFromContext({ context });
  const oldHead = await readHead({ files: context.files, repository });
  if (oldHead.objectId === undefined)
    throw new Error('you are on a branch yet to be born');
  const oldBranch = branchNameFromHead({ head: oldHead });
  let targetObjectId: string;
  let targetBranchName: string | undefined;
  let targetDescription = parsed.targetExpression;
  if (parsed.createBranchName !== undefined) {
    targetObjectId = await resolveCommitRevision({
      files: context.files,
      repository,
      expression: parsed.targetExpression,
    });
    targetBranchName = parsed.createBranchName;
    targetDescription = parsed.createBranchName;
  } else if (!parsed.detach) {
    const localRefName = `refs/heads/${parsed.targetExpression}`;
    const localObjectId = await readRef({ files: context.files, repository, refName: localRefName });
    if (localObjectId !== undefined) {
      targetObjectId = localObjectId;
      targetBranchName = parsed.targetExpression;
    } else {
      switch (parsed.missingBranchBehavior) {
      case 'resolve-revision':
        targetObjectId = await resolveCommitRevision({ files: context.files, repository, expression: parsed.targetExpression });
        break;
      case 'reject':
        throw new Error(`invalid reference: ${parsed.targetExpression}`);
      default: {
        const _ex: never = parsed.missingBranchBehavior;
        throw new Error(`Unhandled missing branch behavior: ${_ex}`);
      }
      }
    }
  } else {
    targetObjectId = await resolveCommitRevision({ files: context.files, repository, expression: parsed.targetExpression });
  }
  const targetCommit = await readCommit({ files: context.files, repository, objectId: targetObjectId });
  const currentHeadEntries = await readHeadIndex({ context, repository });
  const currentIndexEntries = await readIndex({ files: context.files, repository });
  const targetEntries = await readTreeIntoIndex({
    files: context.files,
    repository,
    treeObjectId: targetCommit.treeObjectId,
  });
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
  const config = await readEffectiveConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', cwd: context.cwd, env: context.env });
  const identity = resolveGitReflogIdentity({ env: context.env, config });
  const timestamp = resolveGitTimestamp({ env: context.env, role: 'COMMITTER' });
  if (parsed.createBranchName !== undefined) {
    const refName = branchRefName({ name: parsed.createBranchName });
    if (await readRef({ files: context.files, repository, refName }) !== undefined) {
      throw new Error(`a branch named '${parsed.createBranchName}' already exists`);
    }
    await createRef({
      files: context.files,
      repository,
      refName,
      objectId: targetObjectId,
      reflog: !shouldCreateBranchReflog({ config })
        ? undefined
        : { identity, timestamp, message: `branch: Created from ${parsed.targetExpression}` },
    });
  }
  await applyCheckoutTreePlan({
    files: context.files,
    repository,
    currentIndexEntries,
    plan,
    contentConfig: await resolveContentConfigForContext({ context, repository }),
  });
  await writeIndex({ files: context.files, repository, entries: plan.nextIndexEntries });
  await moveHeadReference({
    files: context.files,
    repository,
    target: targetBranchName === undefined
      ? { type: 'detached', objectId: targetObjectId }
      : { type: 'symbolic', refName: branchRefName({ name: targetBranchName }), objectId: targetObjectId },
    reflog: {
      identity,
      timestamp,
      message: `checkout: moving from ${oldBranch ?? oldHead.objectId.slice(0, 7)} to ${targetDescription}`,
    },
  });
  await printPreservedCheckoutChanges({ context });
  if (targetBranchName !== undefined) {
    await context.text().error({
      text: parsed.createBranchName !== undefined
        ? `Switched to a new branch '${targetBranchName}'\n`
        : `Switched to branch '${targetBranchName}'\n`,
    });
  } else {
    await context.text().error({
      text: `HEAD is now at ${targetObjectId.slice(0, 7)} ${commitSubject({ commit: targetCommit })}\n`,
    });
  }
  return { exitCode: 0 };
}

export const TEST_ONLY = {
};
