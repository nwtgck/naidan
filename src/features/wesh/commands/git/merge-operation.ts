import type { WeshCommandContext, WeshCommandResult } from "@/features/wesh/types";
import { applyCheckoutTreePlan, planCheckoutTree } from "./checkout";
import { createCommit, readCommit } from "./commits";
import { readEffectiveConfig } from "./config";
import { readFileText } from "./files";
import { sortGitPaths } from "./path-order";
import { findMergeBases } from "./graph";
import { applyMergedIndexWithConflicts } from "./merge-apply";
import { formatPreparedMergeConflict, prepareMergeConflicts } from "./merge-conflict";
import { clearMergeState, readMergeState, writeMergeState } from "./merge-state";
import { mergeThreeTrees } from "./merge-tree";
import { readIndex, writeIndex } from "./index-file";
import { forceReplaceIndexAndWorktree } from "./index-worktree";
import { branchNameFromHead, readHead, updateHead, writeOrigHead } from "./refs";
import { discoverRepository, joinPath, discoverRepositoryFromContext } from "./repository";
import { readTreeIntoIndex, writeTreeFromIndex } from "./tree";
import { autoMergeTextConflicts } from "./text-merge";
import { firstLine } from "./commit-message";
import { resolveContentConfigForContext } from "./content-config";
import { collectStatus } from "./status";
import { printCheckoutConflicts } from "./checkout-like";

export async function continueMerge({ context }: {
    context: WeshCommandContext;
}): Promise<WeshCommandResult> {
  const repository = await discoverRepositoryFromContext({ context });
  const state = await readMergeState({ files: context.files, repository });
  if (state === undefined) {
    await context.text().error({ text: 'fatal: There is no merge in progress (MERGE_HEAD missing).\n' });
    return { exitCode: 128 };
  }
  const entries = await readIndex({ files: context.files, repository });
  const unmergedPaths = sortGitPaths({ paths: new Set(entries.filter(entry => entry.stage !== 0).map(entry => entry.path)) });
  if (unmergedPaths.length > 0) {
    for (const path of unmergedPaths)
      await context.text().print({ text: `U\t${path}\n` });
    await context.text().error({ text: 'error: Committing is not possible because you have unmerged files.\n' });
    await context.text().error({ text: 'fatal: Exiting because of an unresolved conflict.\n' });
    return { exitCode: 128 };
  }
  const head = await readHead({ files: context.files, repository });
  if (head.objectId === undefined)
    throw new Error('cannot continue merge on an unborn branch');
  const treeObjectId = await writeTreeFromIndex({ files: context.files, repository, entries });
  const config = await readEffectiveConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', env: context.env });
  const created = await createCommit({
    files: context.files,
    repository,
    config,
    env: context.env,
    treeObjectId,
    parentObjectIds: [head.objectId, state.mergeHeadObjectId],
    message: state.message,
    authorOverride: undefined,
  });
  await updateHead({
    files: context.files,
    repository,
    objectId: created.objectId,
    reflog: {
      identity: created.committerIdentity,
      timestamp: created.committerTimestamp,
      message: `commit (merge): ${firstLine({ text: state.message })}`,
    },
  });
  await clearMergeState({ files: context.files, repository });
  const updatedHead = await readHead({ files: context.files, repository });
  await context.text().print({
    text: `[${branchNameFromHead({ head: updatedHead }) ?? 'detached HEAD'} ${created.objectId.slice(0, 7)}] ${firstLine({ text: state.message })}\n`,
  });
  return { exitCode: 0 };
}
export async function abortMerge({ context }: {
    context: WeshCommandContext;
}): Promise<WeshCommandResult> {
  const repository = await discoverRepositoryFromContext({ context });
  const state = await readMergeState({ files: context.files, repository });
  if (state === undefined) {
    await context.text().error({ text: 'fatal: There is no merge to abort (MERGE_HEAD missing).\n' });
    return { exitCode: 128 };
  }
  const origHeadText = (await readFileText({
    files: context.files,
    path: joinPath({ base: repository.gitDirPath, child: 'ORIG_HEAD' }),
  })).trim();
  if (!/^[0-9a-f]{40}$/u.test(origHeadText))
    throw new Error('invalid ORIG_HEAD');
  const head = await readHead({ files: context.files, repository });
  if (head.objectId === undefined)
    throw new Error('cannot abort merge on an unborn branch');
  const currentEntries = await readIndex({ files: context.files, repository });
  const origCommit = await readCommit({ files: context.files, repository, objectId: origHeadText });
  const origEntries = await readTreeIntoIndex({ files: context.files, repository, treeObjectId: origCommit.treeObjectId });
  await forceReplaceIndexAndWorktree({
    files: context.files,
    repository,
    currentIndexEntries: currentEntries,
    targetEntries: origEntries,
    contentConfig: await resolveContentConfigForContext({ context, repository }),
  });
  await clearMergeState({ files: context.files, repository });
  return { exitCode: 0 };
}
export async function integrateDivergentMerge({ context, repository, headObjectId, targetObjectId, targetLabel, commitMessage, reflogMessage }: {
    context: WeshCommandContext;
    repository: Awaited<ReturnType<typeof discoverRepository>>;
    headObjectId: string;
    targetObjectId: string;
    targetLabel: string;
    commitMessage: string;
    reflogMessage: string;
}): Promise<WeshCommandResult> {
  const status = await collectStatus({ context });
  const dirtyTracked = status.entries.filter(entry => !(entry.indexStatus === ' ' && entry.worktreeStatus === '?'));
  if (dirtyTracked.length > 0) {
    await context.text().error({ text: 'fatal: local tracked changes must be committed or stashed before merge\n' });
    return { exitCode: 1 };
  }
  const bases = await findMergeBases({
    files: context.files,
    repository,
    leftObjectId: headObjectId,
    rightObjectId: targetObjectId,
  });
  if (bases.length !== 1) {
    await context.text().error({ text: `fatal: expected one merge base, found ${bases.length}\n` });
    return { exitCode: 128 };
  }
  const baseCommit = await readCommit({ files: context.files, repository, objectId: bases[0]! });
  const oursCommit = await readCommit({ files: context.files, repository, objectId: headObjectId });
  const theirsCommit = await readCommit({ files: context.files, repository, objectId: targetObjectId });
  const baseEntries = await readTreeIntoIndex({ files: context.files, repository, treeObjectId: baseCommit.treeObjectId });
  const oursEntries = await readTreeIntoIndex({ files: context.files, repository, treeObjectId: oursCommit.treeObjectId });
  const theirsEntries = await readTreeIntoIndex({ files: context.files, repository, treeObjectId: theirsCommit.treeObjectId });
  const merged = mergeThreeTrees({ baseEntries, oursEntries, theirsEntries });
  const autoMerged = await autoMergeTextConflicts({
    files: context.files,
    repository,
    conflicts: merged.conflicts,
  });
  const mergedEntries = [...merged.entries, ...autoMerged.entries];
  const message = commitMessage;
  if (autoMerged.conflicts.length > 0) {
    let preparedConflicts;
    try {
      preparedConflicts = await prepareMergeConflicts({
        files: context.files,
        repository,
        conflicts: autoMerged.conflicts,
        oursLabel: 'HEAD',
        theirsLabel: targetLabel,
        contentConfig: await resolveContentConfigForContext({ context, repository }),
      });
    } catch (error) {
      await context.text().error({ text: `fatal: ${error instanceof Error ? error.message : String(error)}\n` });
      return { exitCode: 1 };
    }
    const currentIndexEntries = await readIndex({ files: context.files, repository });
    const appliedConflict = await applyMergedIndexWithConflicts({
      files: context.files,
      repository,
      currentHeadEntries: oursEntries,
      currentIndexEntries,
      mergedEntries,
      preparedConflicts,
      contentConfig: await resolveContentConfigForContext({ context, repository }),
    });
    if (appliedConflict.checkoutConflicts.length > 0) {
      await printCheckoutConflicts({ context, conflicts: appliedConflict.checkoutConflicts });
      return { exitCode: 1 };
    }
    await writeOrigHead({ files: context.files, repository, objectId: headObjectId });
    await writeMergeState({
      files: context.files,
      repository,
      mergeHeadObjectId: targetObjectId,
      message,
      conflictPaths: preparedConflicts.map(conflict => conflict.path),
    });
    for (const conflict of preparedConflicts) {
      for (const text of formatPreparedMergeConflict({ conflict, oursLabel: 'HEAD', theirsLabel: targetLabel })) {
        await context.text().print({ text });
      }
    }
    await context.text().print({ text: 'Automatic merge failed; fix conflicts and then commit the result.\n' });
    return { exitCode: 1 };
  }
  for (const entry of autoMerged.entries) {
    await context.text().print({ text: `Auto-merging ${entry.path}\n` });
  }
  const currentIndexEntries = await readIndex({ files: context.files, repository });
  const plan = await planCheckoutTree({
    files: context.files,
    repository,
    currentHeadEntries: oursEntries,
    currentIndexEntries,
    targetEntries: mergedEntries,
    contentConfig: await resolveContentConfigForContext({ context, repository }),
  });
  if (plan.conflicts.length > 0) {
    await printCheckoutConflicts({ context, conflicts: plan.conflicts });
    return { exitCode: 1 };
  }
  await writeOrigHead({ files: context.files, repository, objectId: headObjectId });
  await applyCheckoutTreePlan({
    files: context.files,
    repository,
    currentIndexEntries,
    plan,
    contentConfig: await resolveContentConfigForContext({ context, repository }),
  });
  await writeIndex({ files: context.files, repository, entries: plan.nextIndexEntries });
  const treeObjectId = await writeTreeFromIndex({ files: context.files, repository, entries: plan.nextIndexEntries });
  const config = await readEffectiveConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', env: context.env });
  const created = await createCommit({
    files: context.files,
    repository,
    config,
    env: context.env,
    treeObjectId,
    parentObjectIds: [headObjectId, targetObjectId],
    message,
    authorOverride: undefined,
  });
  await updateHead({
    files: context.files,
    repository,
    objectId: created.objectId,
    reflog: {
      identity: created.committerIdentity,
      timestamp: created.committerTimestamp,
      message: reflogMessage,
    },
  });
  await context.text().print({ text: "Merge made by the 'ort' strategy.\n" });
  return { exitCode: 0 };
}

export const TEST_ONLY = {
};
