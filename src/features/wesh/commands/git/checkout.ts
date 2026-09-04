import type { GitAttributesMatcher } from './attributes';
import { loadIndexAttributes } from './attributes';
import type { GitWorktreeContentConfig } from './config';
import type { GitFiles } from './files';
import { pathExists } from './files';
import type { GitIndexEntry } from './index-file';
import { sortGitPaths } from './path-order';
import { sortByGitUtf8StringKey } from './utf8-order';
import type { GitRepository } from './repository';
import { joinPath } from './repository';
import { hashWorktreeEntry, listWorktreeEntries, replaceTrackedWorktreePaths, worktreeAbsolutePath } from './worktree';

function entryMap({ entries }: { entries: readonly GitIndexEntry[] }): Map<string, GitIndexEntry> {
  const result = new Map<string, GitIndexEntry>();
  for (const entry of entries) {
    if (entry.stage !== 0) throw new Error(`cannot switch branches with unmerged index entry: ${entry.path}`);
    result.set(entry.path, entry);
  }
  return result;
}

function entriesEqual({ left, right }: {
  left: GitIndexEntry | undefined,
  right: GitIndexEntry | undefined,
}): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.objectId === right.objectId && left.mode === right.mode;
}

function regularFileMode({ entry }: { entry: GitIndexEntry }): 0o100644 | 0o100755 | undefined {
  switch (entry.mode) {
  case 0o100644:
  case 0o100755:
    return entry.mode;
  case 0o120000:
  case 0o160000:
    return undefined;
  default:
    return undefined;
  }
}

async function worktreeMatchesIndex({ files, repository, entry, attributes }: {
  files: GitFiles,
  repository: GitRepository,
  entry: GitIndexEntry,
  attributes: GitAttributesMatcher,
}): Promise<boolean> {
  const absolutePath = worktreeAbsolutePath({ repository, path: entry.path });
  if (!await pathExists({ files, path: absolutePath })) return false;
  if (entry.mode === 0o160000) {
    const stat = await files.lstat({ path: absolutePath });
    switch (stat.type) {
    case 'directory':
      if (await pathExists({ files, path: joinPath({ base: absolutePath, child: '.git' }) })) {
        throw new Error(`initialized gitlink worktree is not supported yet: ${entry.path}`);
      }
      return true;
    case 'file':
    case 'fifo':
    case 'chardev':
    case 'symlink':
      return false;
    default: {
      const _ex: never = stat.type;
      throw new Error(`Unhandled gitlink worktree type: ${_ex}`);
    }
    }
  }
  const worktreeEntry = await hashWorktreeEntry({
    files,
    repository,
    path: entry.path,
    write: false,
    regularFileMode: regularFileMode({ entry }),
    attributes,
    indexObjectId: entry.objectId,
  });
  return worktreeEntry.objectId === entry.objectId && worktreeEntry.mode === entry.mode;
}

export interface GitCheckoutConflict {
  type: 'tracked' | 'untracked' | 'untracked-directory',
  path: string,
}

export interface GitCheckoutTreePlan {
  nextIndexEntries: GitIndexEntry[],
  worktreePathsToReplace: Set<string>,
  conflicts: GitCheckoutConflict[],
}

export async function planCheckoutTree({ files, repository, currentHeadEntries, currentIndexEntries, targetEntries, contentConfig }: {
  files: GitFiles,
  repository: GitRepository,
  currentHeadEntries: readonly GitIndexEntry[],
  currentIndexEntries: readonly GitIndexEntry[],
  targetEntries: readonly GitIndexEntry[],
  contentConfig: GitWorktreeContentConfig,
}): Promise<GitCheckoutTreePlan> {
  const headByPath = entryMap({ entries: currentHeadEntries });
  const indexByPath = entryMap({ entries: currentIndexEntries });
  const targetByPath = entryMap({ entries: targetEntries });
  const candidatePaths = new Set(headByPath.keys());
  for (const path of targetByPath.keys()) candidatePaths.add(path);
  const changedPaths = new Set<string>();
  for (const path of candidatePaths) {
    if (!entriesEqual({ left: headByPath.get(path), right: targetByPath.get(path) })) changedPaths.add(path);
  }

  const attributes = await loadIndexAttributes({ files, repository, entries: currentIndexEntries, contentConfig });
  const conflicts: GitCheckoutConflict[] = [];
  const worktreePathsToReplace = new Set<string>();
  const nextIndexByPath = new Map(indexByPath);
  const worktreePaths = new Set(await listWorktreeEntries({ files, repository }));

  for (const path of sortGitPaths({ paths: changedPaths })) {
    const headEntry = headByPath.get(path);
    const indexEntry = indexByPath.get(path);
    const targetEntry = targetByPath.get(path);
    const indexMatchesHead = entriesEqual({ left: indexEntry, right: headEntry });
    const indexMatchesTarget = entriesEqual({ left: indexEntry, right: targetEntry });

    if (!indexMatchesHead && !indexMatchesTarget) {
      conflicts.push({ type: 'tracked', path });
      continue;
    }

    if (indexEntry === undefined) {
      const absolutePath = worktreeAbsolutePath({ repository, path });
      const exists = await pathExists({ files, path: absolutePath });
      if (exists && targetEntry !== undefined) {
        const stat = await files.lstat({ path: absolutePath });
        let hasUntrackedCollision: boolean;
        let collisionType: GitCheckoutConflict['type'];
        switch (stat.type) {
        case 'directory': {
          if (targetEntry.mode === 0o160000) {
            if (await pathExists({ files, path: joinPath({ base: absolutePath, child: '.git' }) })) {
              throw new Error(`initialized gitlink worktree is not supported yet: ${path}`);
            }
            hasUntrackedCollision = false;
          } else {
            const prefix = `${path}/`;
            hasUntrackedCollision = [...worktreePaths]
              .filter(worktreePath => worktreePath.startsWith(prefix))
              .some(worktreePath => !indexByPath.has(worktreePath));
          }
          collisionType = 'untracked-directory';
          break;
        }
        case 'file':
        case 'fifo':
        case 'chardev':
        case 'symlink':
          hasUntrackedCollision = true;
          collisionType = 'untracked';
          break;
        default: {
          const _ex: never = stat.type;
          throw new Error(`Unhandled worktree entry type: ${_ex}`);
        }
        }
        if (hasUntrackedCollision) {
          conflicts.push({ type: collisionType, path });
          continue;
        }
      }
    } else if (!await worktreeMatchesIndex({ files, repository, entry: indexEntry, attributes }) && !indexMatchesTarget) {
      conflicts.push({ type: 'tracked', path });
      continue;
    }

    if (!indexMatchesTarget) worktreePathsToReplace.add(path);
    if (targetEntry === undefined) nextIndexByPath.delete(path);
    else nextIndexByPath.set(path, targetEntry);
  }

  return {
    nextIndexEntries: sortByGitUtf8StringKey({ values: nextIndexByPath.values(), key: ({ value }) => value.path }),
    worktreePathsToReplace,
    conflicts,
  };
}

export async function applyCheckoutTreePlan({ files, repository, currentIndexEntries, plan, contentConfig }: {
  files: GitFiles,
  repository: GitRepository,
  currentIndexEntries: readonly GitIndexEntry[],
  plan: GitCheckoutTreePlan,
  contentConfig: GitWorktreeContentConfig,
}): Promise<void> {
  if (plan.conflicts.length > 0) throw new Error('cannot apply a checkout plan with conflicts');
  await replaceTrackedWorktreePaths({
    files,
    repository,
    previousEntries: currentIndexEntries,
    targetEntries: plan.nextIndexEntries,
    paths: plan.worktreePathsToReplace,
    contentConfig,
  });
}

export const TEST_ONLY = {
};
