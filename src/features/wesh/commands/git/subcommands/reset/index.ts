import type { WeshCommandContext, WeshCommandResult } from "@/features/wesh/types";
import { commitSubject, readCommit } from "@/features/wesh/commands/git/commits";
import { readEffectiveConfig } from "@/features/wesh/commands/git/config";
import { matchRepositoryPaths } from "@/features/wesh/commands/git/pathspec";
import { resolveGitReflogIdentity, resolveGitTimestamp } from "@/features/wesh/commands/git/identity";
import type { GitIndexEntry } from "@/features/wesh/commands/git/index-file";
import { readIndex, writeIndex } from "@/features/wesh/commands/git/index-file";
import { readHead, updateHead, writeOrigHead } from "@/features/wesh/commands/git/refs";
import { discoverRepositoryFromContext } from "@/features/wesh/commands/git/repository";
import { resolveCommitRevision } from "@/features/wesh/commands/git/revision";
import { readTreeIntoIndex } from "@/features/wesh/commands/git/tree";
import { parseResetArguments } from "./arguments";
import { readCommitIndex } from "@/features/wesh/commands/git/commit-index";
import { collectStatus } from "@/features/wesh/commands/git/status";
import { resolveContentConfigForContext } from "@/features/wesh/commands/git/content-config";
import { assertSupportedRepositoryContentPolicy } from "@/features/wesh/commands/git/content-policy";
import { forceReplaceIndexAndWorktree } from "@/features/wesh/commands/git/index-worktree";
import { clearMergeState, readMergeState } from "@/features/wesh/commands/git/merge-state";

export async function runReset({ context, args }: {
    context: WeshCommandContext;
    args: readonly string[];
}): Promise<WeshCommandResult> {
  await assertSupportedRepositoryContentPolicy({ context });
  const repository = await discoverRepositoryFromContext({ context });
  const { mode, revisionExpression, pathOperands } = parseResetArguments({ args });
  const mergeState = pathOperands === undefined
    ? await readMergeState({ files: context.files, repository })
    : undefined;
  if (mergeState !== undefined && mode === 'soft') {
    await context.text().error({ text: 'fatal: Cannot do a soft reset in the middle of a merge.\n' });
    return { exitCode: 128 };
  }
  if (pathOperands !== undefined) {
    const currentIndex = await readIndex({ files: context.files, repository });
    const sourceEntries = await readCommitIndex({ context, repository, revisionExpression });
    const matches = matchRepositoryPaths({
      repository,
      cwd: context.cwd,
      operands: pathOperands,
      availablePaths: [...currentIndex.map(entry => entry.path), ...sourceEntries.map(entry => entry.path)],
    });
    const selectedPaths = new Set<string>();
    for (const paths of matches.values())
      for (const path of paths)
        selectedPaths.add(path);
    const sourceByPath = new Map(sourceEntries.map(entry => [entry.path, entry]));
    const nextEntries = currentIndex.filter(entry => !selectedPaths.has(entry.path));
    for (const path of selectedPaths) {
      const sourceEntry = sourceByPath.get(path);
      if (sourceEntry !== undefined)
        nextEntries.push(sourceEntry);
    }
    await writeIndex({ files: context.files, repository, entries: nextEntries });
    const status = await collectStatus({ context });
    const unstaged = status.entries.filter(entry => entry.worktreeStatus === 'M' || entry.worktreeStatus === 'D');
    if (unstaged.length > 0) {
      await context.text().print({ text: 'Unstaged changes after reset:\n' });
      for (const entry of unstaged)
        await context.text().print({ text: `${entry.worktreeStatus}\t${entry.path}\n` });
    }
    return { exitCode: 0 };
  }
  const oldHead = await readHead({ files: context.files, repository });
  if (oldHead.objectId === undefined)
    throw new Error('ambiguous argument HEAD: unknown revision');
  const targetObjectId = await resolveCommitRevision({
    files: context.files,
    repository,
    expression: revisionExpression,
  });
  const targetCommit = await readCommit({ files: context.files, repository, objectId: targetObjectId });
  let previousIndex: GitIndexEntry[];
  let targetIndex: GitIndexEntry[];
  switch (mode) {
  case 'soft':
    previousIndex = [];
    targetIndex = [];
    break;
  case 'mixed':
  case 'hard':
    previousIndex = await readIndex({ files: context.files, repository });
    targetIndex = await readTreeIntoIndex({
      files: context.files,
      repository,
      treeObjectId: targetCommit.treeObjectId,
    });
    break;
  default: {
    const _ex: never = mode;
    throw new Error(`Unhandled reset mode: ${_ex}`);
  }
  }
  const config = await readEffectiveConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', env: context.env });
  const identity = resolveGitReflogIdentity({ env: context.env, config });
  const timestamp = resolveGitTimestamp({ env: context.env, role: 'COMMITTER' });
  switch (mode) {
  case 'hard':
    await forceReplaceIndexAndWorktree({
      files: context.files,
      repository,
      currentIndexEntries: previousIndex,
      targetEntries: targetIndex,
      contentConfig: await resolveContentConfigForContext({ context, repository }),
    });
    break;
  case 'soft':
  case 'mixed':
    break;
  default: {
    const _ex: never = mode;
    throw new Error(`Unhandled reset mode before ref update: ${_ex}`);
  }
  }
  await writeOrigHead({ files: context.files, repository, objectId: oldHead.objectId });
  await updateHead({
    files: context.files,
    repository,
    objectId: targetObjectId,
    reflog: {
      identity,
      timestamp,
      message: `reset: moving to ${revisionExpression}`,
    },
  });
  switch (mode) {
  case 'soft':
    return { exitCode: 0 };
  case 'mixed': {
    await writeIndex({ files: context.files, repository, entries: targetIndex });
    if (mergeState !== undefined)
      await clearMergeState({ files: context.files, repository });
    const status = await collectStatus({ context });
    const unstaged = status.entries.filter(entry => entry.worktreeStatus === 'M' || entry.worktreeStatus === 'D');
    if (unstaged.length > 0) {
      await context.text().print({ text: 'Unstaged changes after reset:\n' });
      for (const entry of unstaged) {
        await context.text().print({ text: `${entry.worktreeStatus}\t${entry.path}\n` });
      }
    }
    return { exitCode: 0 };
  }
  case 'hard':
    await clearMergeState({ files: context.files, repository });
    await context.text().print({
      text: `HEAD is now at ${targetObjectId.slice(0, 7)} ${commitSubject({ commit: targetCommit })}\n`,
    });
    return { exitCode: 0 };
  default: {
    const _ex: never = mode;
    throw new Error(`Unhandled reset mode: ${_ex}`);
  }
  }
}

export const TEST_ONLY = {
};
