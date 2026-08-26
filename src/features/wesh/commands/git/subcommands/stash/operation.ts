import type { GitConfig, GitWorktreeContentConfig } from '@/features/wesh/commands/git/config';
import { resolveWorktreeContentConfig } from '@/features/wesh/commands/git/config';
import { commitSubject, createCommit, readCommit } from '@/features/wesh/commands/git/commits';
import { applyCheckoutTreePlan, planCheckoutTree } from '@/features/wesh/commands/git/checkout';
import type { GitFiles } from '@/features/wesh/commands/git/files';
import { pathExists, replaceTextViaLock } from '@/features/wesh/commands/git/files';
import { loadIgnoreMatcher } from '@/features/wesh/commands/git/ignore';
import type { GitIndexEntry } from '@/features/wesh/commands/git/index-file';
import { readIndex, writeIndex } from '@/features/wesh/commands/git/index-file';
import { resolveGitReflogIdentity, resolveGitTimestamp } from '@/features/wesh/commands/git/identity';
import type { GitReflogEntry } from '@/features/wesh/commands/git/reflog';
import { readReflog } from '@/features/wesh/commands/git/reflog';
import { mergeThreeTrees } from '@/features/wesh/commands/git/merge-tree';
import { compareGitPaths } from '@/features/wesh/commands/git/path-order';
import { branchNameFromHead, deleteRef, readHead, readRef, updateRef } from '@/features/wesh/commands/git/refs';
import type { GitRepository } from '@/features/wesh/commands/git/repository';
import { joinPath } from '@/features/wesh/commands/git/repository';
import { stageWorktreePaths } from '@/features/wesh/commands/git/stage';
import { autoMergeTextConflicts } from '@/features/wesh/commands/git/text-merge';
import { readTreeIntoIndex, writeTreeFromIndex } from '@/features/wesh/commands/git/tree';
import { listWorktreeEntries, removeWorktreePaths, replaceTrackedWorktree, replaceTrackedWorktreePaths, worktreeAbsolutePath } from '@/features/wesh/commands/git/worktree';

const STASH_REF = 'refs/stash';

function stashLogPath({ repository }: { repository: GitRepository }): string {
  return joinPath({ base: repository.commonDirPath, child: 'logs/refs/stash' });
}

function assertStageZeroIndex({ entries }: { entries: readonly GitIndexEntry[] }): void {
  const unmerged = entries.find(entry => entry.stage !== 0);
  if (unmerged !== undefined) {
    throw new Error(`cannot save the working tree with unmerged index entry: ${unmerged.path}`);
  }
}

function entriesEquivalent({ left, right }: {
  left: readonly GitIndexEntry[],
  right: readonly GitIndexEntry[],
}): boolean {
  if (left.length !== right.length) return false;
  const normalize = ({ entries }: { entries: readonly GitIndexEntry[] }) => [...entries]
    .map(entry => `${entry.path}\0${entry.mode}\0${entry.objectId}\0${entry.stage}`)
    .sort();
  const a = normalize({ entries: left });
  const b = normalize({ entries: right });
  return a.every((value, index) => value === b[index]);
}

function branchDescription({ branchName }: { branchName: string | undefined }): string {
  return branchName ?? '(no branch)';
}

export interface GitCreatedStash {
  objectId: string,
  subject: string,
  untrackedPaths: string[],
}

export async function createStash({ files, repository, config, env, message, includeUntracked }: {
  files: GitFiles,
  repository: GitRepository,
  config: GitConfig,
  env: Map<string, string>,
  message: string | undefined,
  includeUntracked: boolean,
}): Promise<GitCreatedStash | undefined> {
  const contentConfig = resolveWorktreeContentConfig({ config });
  const head = await readHead({ files, repository });
  if (head.objectId === undefined) throw new Error('You do not have the initial commit yet');
  const headCommit = await readCommit({ files, repository, objectId: head.objectId });
  const headEntries = await readTreeIntoIndex({ files, repository, treeObjectId: headCommit.treeObjectId });
  const indexEntries = await readIndex({ files, repository });
  assertStageZeroIndex({ entries: indexEntries });

  const trackedPaths = new Set(indexEntries.map(entry => entry.path));
  const worktreeEntries = await stageWorktreePaths({
    files,
    repository,
    currentEntries: indexEntries,
    paths: trackedPaths,
    trackedOnly: true,
    contentConfig,
  });

  const ignoreMatcher = await loadIgnoreMatcher({ files, repository });
  const untrackedPaths = includeUntracked
    ? (await listWorktreeEntries({ files, repository })).filter(path => !trackedPaths.has(path)
      && !ignoreMatcher.isIgnored({ path, isDirectory: false }))
    : [];
  const untrackedEntries = untrackedPaths.length === 0
    ? []
    : await stageWorktreePaths({
      files,
      repository,
      currentEntries: [],
      paths: untrackedPaths,
      trackedOnly: false,
      contentConfig,
    });

  if (entriesEquivalent({ left: headEntries, right: indexEntries })
    && entriesEquivalent({ left: indexEntries, right: worktreeEntries })
    && untrackedEntries.length === 0) return undefined;

  const branch = branchDescription({ branchName: branchNameFromHead({ head }) });
  const shortHead = head.objectId.slice(0, 7);
  const headSubject = commitSubject({ commit: headCommit });
  const baseDescription = `${branch}: ${shortHead} ${headSubject}`;
  const indexTreeObjectId = await writeTreeFromIndex({ files, repository, entries: indexEntries });
  const indexCommit = await createCommit({
    files,
    repository,
    config,
    env,
    treeObjectId: indexTreeObjectId,
    parentObjectIds: [head.objectId],
    message: `index on ${baseDescription}`,
    authorOverride: undefined,
  });

  let untrackedCommitObjectId: string | undefined;
  if (untrackedEntries.length > 0) {
    const untrackedTreeObjectId = await writeTreeFromIndex({ files, repository, entries: untrackedEntries });
    const untrackedCommit = await createCommit({
      files,
      repository,
      config,
      env,
      treeObjectId: untrackedTreeObjectId,
      parentObjectIds: [],
      message: `untracked files on ${baseDescription}`,
      authorOverride: undefined,
    });
    untrackedCommitObjectId = untrackedCommit.objectId;
  }

  const worktreeTreeObjectId = await writeTreeFromIndex({ files, repository, entries: worktreeEntries });
  const subject = message === undefined ? `WIP on ${baseDescription}` : `On ${branch}: ${message}`;
  const stashCommit = await createCommit({
    files,
    repository,
    config,
    env,
    treeObjectId: worktreeTreeObjectId,
    parentObjectIds: [
      head.objectId,
      indexCommit.objectId,
      ...(untrackedCommitObjectId === undefined ? [] : [untrackedCommitObjectId]),
    ],
    message: subject,
    authorOverride: undefined,
  });

  await updateRef({
    files,
    repository,
    refName: STASH_REF,
    objectId: stashCommit.objectId,
    reflog: {
      identity: resolveGitReflogIdentity({ env, config }),
      timestamp: resolveGitTimestamp({ env, role: 'COMMITTER' }),
      message: subject,
    },
  });

  await replaceTrackedWorktree({
    files,
    repository,
    previousEntries: indexEntries,
    targetEntries: headEntries,
    attributeEntries: headEntries,
    contentConfig,
  });
  await writeIndex({ files, repository, entries: headEntries });
  if (includeUntracked) await removeWorktreePaths({ files, repository, paths: untrackedPaths });
  return { objectId: stashCommit.objectId, subject, untrackedPaths };
}

export interface GitStashEntry {
  index: number,
  objectId: string,
  message: string,
}

export async function listStashes({ files, repository }: {
  files: GitFiles,
  repository: GitRepository,
}): Promise<GitStashEntry[]> {
  const entries = await readReflog({ files, path: stashLogPath({ repository }) });
  return [...entries].reverse().map((entry, index) => ({
    index,
    objectId: entry.newObjectId,
    message: entry.message,
  }));
}

export function parseStashIndex({ expression }: { expression: string | undefined }): number {
  if (expression === undefined || expression === 'stash' || expression === 'stash@{0}') return 0;
  const match = /^stash@\{([0-9]+)\}$/u.exec(expression);
  if (match === null) throw new Error(`${expression} is not a valid reference`);
  return Number.parseInt(match[1]!, 10);
}

export async function resolveStash({ files, repository, expression }: {
  files: GitFiles,
  repository: GitRepository,
  expression: string | undefined,
}): Promise<GitStashEntry> {
  const index = parseStashIndex({ expression });
  const stashes = await listStashes({ files, repository });
  const entry = stashes[index];
  if (entry === undefined) throw new Error(`log for 'refs/stash' only has ${stashes.length} entries`);
  return entry;
}

function renderReflogEntry({ entry }: { entry: GitReflogEntry }): string {
  return `${entry.oldObjectId} ${entry.newObjectId} ${entry.identity} ${entry.timestamp}\t${entry.message}\n`;
}

export async function dropStash({ files, repository, index }: {
  files: GitFiles,
  repository: GitRepository,
  index: number,
}): Promise<GitStashEntry> {
  const path = stashLogPath({ repository });
  const chronological = await readReflog({ files, path });
  const chronologicalIndex = chronological.length - 1 - index;
  const dropped = chronological[chronologicalIndex];
  if (dropped === undefined) throw new Error(`log for 'refs/stash' only has ${chronological.length} entries`);
  chronological.splice(chronologicalIndex, 1);
  if (chronological.length === 0) {
    await deleteRef({ files, repository, refName: STASH_REF });
    if (await pathExists({ files, path })) await files.unlink({ path });
  } else {
    const newest = chronological[chronological.length - 1]!;
    await updateRef({ files, repository, refName: STASH_REF, objectId: newest.newObjectId, reflog: undefined });
    await replaceTextViaLock({ files, path, text: chronological.map(entry => renderReflogEntry({ entry })).join('') });
  }
  return { index, objectId: dropped.newObjectId, message: dropped.message };
}

export async function clearStashes({ files, repository }: {
  files: GitFiles,
  repository: GitRepository,
}): Promise<void> {
  await deleteRef({ files, repository, refName: STASH_REF });
  const path = stashLogPath({ repository });
  if (await pathExists({ files, path })) await files.unlink({ path });
}

function entryMap({ entries }: { entries: readonly GitIndexEntry[] }): Map<string, GitIndexEntry> {
  const result = new Map<string, GitIndexEntry>();
  for (const entry of entries) {
    if (entry.stage !== 0) throw new Error(`stash operation requires stage-0 entries: ${entry.path}`);
    result.set(entry.path, entry);
  }
  return result;
}

function entryEquals({ left, right }: {
  left: GitIndexEntry | undefined,
  right: GitIndexEntry | undefined,
}): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.objectId === right.objectId && left.mode === right.mode;
}

async function mergeStashTrees({ files, repository, baseEntries, oursEntries, theirsEntries }: {
  files: GitFiles,
  repository: GitRepository,
  baseEntries: readonly GitIndexEntry[],
  oursEntries: readonly GitIndexEntry[],
  theirsEntries: readonly GitIndexEntry[],
}): Promise<GitIndexEntry[]> {
  const treeMerge = mergeThreeTrees({ baseEntries, oursEntries, theirsEntries });
  if (treeMerge.conflicts.length === 0) return treeMerge.entries;
  const textMerge = await autoMergeTextConflicts({
    files,
    repository,
    conflicts: treeMerge.conflicts,
  });
  if (textMerge.conflicts.length > 0) {
    throw new Error(`stash apply conflict in ${textMerge.conflicts[0]!.path}`);
  }
  return [...treeMerge.entries, ...textMerge.entries].sort((left, right) => compareGitPaths({ left: left.path, right: right.path }));
}

function defaultAppliedIndex({ currentEntries, baseEntries, stashIndexEntries }: {
  currentEntries: readonly GitIndexEntry[],
  baseEntries: readonly GitIndexEntry[],
  stashIndexEntries: readonly GitIndexEntry[],
}): GitIndexEntry[] {
  const current = entryMap({ entries: currentEntries });
  const base = entryMap({ entries: baseEntries });
  const stashed = entryMap({ entries: stashIndexEntries });
  for (const [path, stashedEntry] of stashed) {
    if (base.has(path)) continue;
    const currentEntry = current.get(path);
    if (currentEntry !== undefined && !entryEquals({ left: currentEntry, right: stashedEntry })) {
      throw new Error(`stash apply conflict in ${path}`);
    }
    current.set(path, { ...stashedEntry, stage: 0 });
  }
  return [...current.values()].sort((left, right) => compareGitPaths({ left: left.path, right: right.path }));
}

async function assertUntrackedCanMaterialize({ files, repository, entries }: {
  files: GitFiles,
  repository: GitRepository,
  entries: readonly GitIndexEntry[],
}): Promise<void> {
  for (const entry of entries) {
    const absolutePath = worktreeAbsolutePath({ repository, path: entry.path });
    if (await pathExists({ files, path: absolutePath })) {
      throw new Error(`could not restore untracked files from stash: ${entry.path} already exists`);
    }
    const parts = entry.path.split('/');
    for (let count = 1; count < parts.length; count += 1) {
      const parentRelative = parts.slice(0, count).join('/');
      const parentAbsolute = worktreeAbsolutePath({ repository, path: parentRelative });
      if (!await pathExists({ files, path: parentAbsolute })) continue;
      const stat = await files.lstat({ path: parentAbsolute });
      switch (stat.type) {
      case 'directory':
        break;
      case 'file':
      case 'fifo':
      case 'chardev':
      case 'symlink':
        throw new Error(`could not restore untracked files from stash: ${parentRelative} is not a directory`);
      default: {
        const _ex: never = stat.type;
        throw new Error(`Unhandled stash parent type: ${_ex}`);
      }
      }
    }
  }
}

export async function applyStash({ files, repository, expression, restoreIndex, contentConfig }: {
  files: GitFiles,
  repository: GitRepository,
  expression: string | undefined,
  restoreIndex: boolean,
  contentConfig: GitWorktreeContentConfig,
}): Promise<GitStashEntry> {
  const stashEntry = await resolveStash({ files, repository, expression });
  const stashCommit = await readCommit({ files, repository, objectId: stashEntry.objectId });
  const baseObjectId = stashCommit.parentObjectIds[0];
  const indexObjectId = stashCommit.parentObjectIds[1];
  if (baseObjectId === undefined || indexObjectId === undefined) throw new Error('stash commit has invalid parents');

  const head = await readHead({ files, repository });
  if (head.objectId === undefined) throw new Error('cannot apply a stash on an unborn branch');
  const currentHeadCommit = await readCommit({ files, repository, objectId: head.objectId });
  const baseCommit = await readCommit({ files, repository, objectId: baseObjectId });
  const indexCommit = await readCommit({ files, repository, objectId: indexObjectId });
  const baseEntries = await readTreeIntoIndex({ files, repository, treeObjectId: baseCommit.treeObjectId });
  const currentHeadEntries = await readTreeIntoIndex({ files, repository, treeObjectId: currentHeadCommit.treeObjectId });
  const stashIndexEntries = await readTreeIntoIndex({ files, repository, treeObjectId: indexCommit.treeObjectId });
  const stashWorktreeEntries = await readTreeIntoIndex({ files, repository, treeObjectId: stashCommit.treeObjectId });
  const currentIndexEntries = await readIndex({ files, repository });
  assertStageZeroIndex({ entries: currentIndexEntries });

  const targetWorktreeEntries = await mergeStashTrees({
    files,
    repository,
    baseEntries,
    oursEntries: currentHeadEntries,
    theirsEntries: stashWorktreeEntries,
  });
  const targetIndexEntries = restoreIndex
    ? await mergeStashTrees({
      files,
      repository,
      baseEntries,
      oursEntries: currentIndexEntries,
      theirsEntries: stashIndexEntries,
    })
    : defaultAppliedIndex({ currentEntries: currentIndexEntries, baseEntries, stashIndexEntries });

  const plan = await planCheckoutTree({
    files,
    repository,
    currentHeadEntries,
    currentIndexEntries,
    targetEntries: targetWorktreeEntries,
    contentConfig,
  });
  if (plan.conflicts.length > 0) throw new Error(`stash apply conflict in ${plan.conflicts[0]!.path}`);

  const untrackedParent = stashCommit.parentObjectIds[2];
  const untrackedEntries = untrackedParent === undefined
    ? []
    : await readTreeIntoIndex({
      files,
      repository,
      treeObjectId: (await readCommit({ files, repository, objectId: untrackedParent })).treeObjectId,
    });
  await assertUntrackedCanMaterialize({ files, repository, entries: untrackedEntries });

  await applyCheckoutTreePlan({ files, repository, currentIndexEntries, plan, contentConfig });
  await writeIndex({ files, repository, entries: targetIndexEntries });
  if (untrackedEntries.length > 0) {
    await replaceTrackedWorktreePaths({
      files,
      repository,
      previousEntries: [],
      targetEntries: untrackedEntries,
      paths: new Set(untrackedEntries.map(entry => entry.path)),
      contentConfig,
    });
  }
  return stashEntry;
}

export async function currentStashRef({ files, repository }: {
  files: GitFiles,
  repository: GitRepository,
}): Promise<string | undefined> {
  return readRef({ files, repository, refName: STASH_REF });
}

export const TEST_ONLY = {
  entriesEquivalent,
};
