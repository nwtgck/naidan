import { loadWorktreeAttributes } from './attributes';
import type { GitWorktreeContentConfig } from './config';
import type { GitFiles } from './files';
import { pathExists } from './files';
import type { GitIndexEntry } from './index-file';
import type { GitRepository } from './repository';
import { hashWorktreeEntry, worktreeAbsolutePath } from './worktree';

function regularFileModeFromEntry({ entry }: {
  entry: GitIndexEntry | undefined,
}): 0o100644 | 0o100755 | undefined {
  if (entry === undefined) return undefined;
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

export async function stageWorktreePaths({ files, repository, currentEntries, paths, trackedOnly, contentConfig }: {
  files: GitFiles,
  repository: GitRepository,
  currentEntries: readonly GitIndexEntry[],
  paths: Iterable<string>,
  trackedOnly: boolean,
  contentConfig: GitWorktreeContentConfig,
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
  for (const path of selectedPaths) {
    const existing = existingByPath.get(path);
    if (trackedOnly && existing === undefined) continue;
    const absolutePath = worktreeAbsolutePath({ repository, path });
    if (!await pathExists({ files, path: absolutePath })) continue;
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
  }
  return result;
}

export const TEST_ONLY = {
};
