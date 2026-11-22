import { loadWorktreeAttributes } from './attributes';
import type { GitWorktreeContentConfig } from './config';
import type { GitFiles } from './files';
import { pathExists } from './files';
import type { GitIndexEntry } from './index-file';
import type { GitRepository } from './repository';
import { hashWorktreeEntry, lstatWorktreePath, worktreeAbsolutePath } from './worktree';
import type { WeshFileType } from '@/features/wesh/types';

function regularFileModeFromEntry({ entry }: {
  entry: GitIndexEntry | undefined,
}): 0o100644 | 0o100755 | undefined {
  if (entry === undefined) {
    return undefined;
  }
  switch (entry.mode) {
  case 0o100644:
  case 0o100755:
    return entry.mode;
  case 0o120000:
  case 0o160000:
    return undefined;
  default:
    throw new Error(`unsupported index mode ${entry.mode.toString(8)}: ${entry.path}`);
  }
}

export async function stageWorktreePaths({ files, repository, currentEntries, paths, trackedOnly, contentConfig, fileDirectoryChanges }: {
  files: GitFiles,
  repository: GitRepository,
  currentEntries: readonly GitIndexEntry[],
  paths: Iterable<string>,
  trackedOnly: boolean,
  contentConfig: GitWorktreeContentConfig,
  fileDirectoryChanges?: 'stage',
}): Promise<GitIndexEntry[]> {
  const selectedPaths = new Set(paths);
  const existingByPath = new Map<string, GitIndexEntry>();
  for (const entry of currentEntries) {
    const existing = existingByPath.get(entry.path);
    if (existing === undefined || entry.stage === 0 || (entry.stage === 2 && existing.stage !== 0)) {
      existingByPath.set(entry.path, entry);
    }
  }

  const result = currentEntries.filter(entry => !selectedPaths.has(entry.path));
  const attributes = await loadWorktreeAttributes({ files, repository, contentConfig });
  const ancestorTypes = new Map<string, WeshFileType | undefined>();
  const stagedPaths = new Set<string>();
  const replacedAncestors = new Set<string>();
  for (const path of selectedPaths) {
    const existing = existingByPath.get(path);
    if (trackedOnly && existing === undefined) {
      continue;
    }
    const absolutePath = worktreeAbsolutePath({ repository, path });
    if (fileDirectoryChanges !== undefined) {
      const lookup = await lstatWorktreePath({ files, repository, path, ancestorTypes });
      switch (lookup.kind) {
      case 'missing':
      case 'leading-symlink':
        continue;
      case 'entry': {
        const { type } = lookup.stat;
        switch (type) {
        case 'directory':
          continue;
        case 'file':
        case 'symlink':
        case 'fifo':
        case 'chardev':
          break;
        default: {
          const _ex: never = type;
          throw new Error(`Unhandled worktree entry type: ${_ex}`);
        }
        }
        break;
      }
      default: {
        const _ex: never = lookup;
        throw new Error(`Unhandled worktree path: ${JSON.stringify(_ex)}`);
      }
      }
    } else if (!await pathExists({ files, path: absolutePath })) {
      continue;
    }
    const worktreeEntry = await hashWorktreeEntry({
      files,
      repository,
      path,
      write: true,
      regularFileMode: regularFileModeFromEntry({ entry: existing }),
      attributes,
      indexObjectId: existing?.objectId,
    });
    result.push({
      path,
      objectId: worktreeEntry.objectId,
      mode: worktreeEntry.mode,
      size: worktreeEntry.size,
      stage: 0,
    });
    if (fileDirectoryChanges !== undefined) {
      stagedPaths.add(path);
      for (let slash = path.indexOf('/'); slash !== -1; slash = path.indexOf('/', slash + 1)) {
        const ancestor = path.slice(0, slash);
        if (existingByPath.has(ancestor)) {
          replacedAncestors.add(ancestor);
        }
      }
    }
  }
  if (stagedPaths.size === 0) {
    return result;
  }
  // The index cannot hold both a file and a descendant of that file.
  return result.filter(({ path }) => {
    if (replacedAncestors.has(path)) {
      return false;
    }
    for (let slash = path.indexOf('/'); slash !== -1; slash = path.indexOf('/', slash + 1)) {
      if (stagedPaths.has(path.slice(0, slash))) {
        return false;
      }
    }
    return true;
  });
}

export const TEST_ONLY = {
};
