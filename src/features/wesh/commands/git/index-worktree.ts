import type { GitWorktreeContentConfig } from './config';
import type { GitFiles } from './files';
import type { GitIndexEntry } from './index-file';
import { writeIndex } from './index-file';
import { compareGitPaths } from './path-order';
import type { GitRepository } from './repository';
import { replaceTrackedWorktree } from './worktree';

function representativeTrackedEntries({ entries }: {
  entries: readonly GitIndexEntry[],
}): GitIndexEntry[] {
  const byPath = new Map<string, GitIndexEntry>();
  for (const entry of entries) {
    const current = byPath.get(entry.path);
    if (current === undefined || entry.stage === 0 || (entry.stage === 2 && current.stage !== 0)) {
      byPath.set(entry.path, { ...entry, stage: 0 });
    }
  }
  return [...byPath.values()].sort((left, right) => compareGitPaths({ left: left.path, right: right.path }));
}

export async function forceReplaceIndexAndWorktree({ files, repository, currentIndexEntries, targetEntries, contentConfig }: {
  files: GitFiles,
  repository: GitRepository,
  currentIndexEntries: readonly GitIndexEntry[],
  targetEntries: readonly GitIndexEntry[],
  contentConfig: GitWorktreeContentConfig,
}): Promise<void> {
  await replaceTrackedWorktree({
    files,
    repository,
    previousEntries: representativeTrackedEntries({ entries: currentIndexEntries }),
    targetEntries,
    contentConfig,
  });
  await writeIndex({ files, repository, entries: targetEntries });
}

export const TEST_ONLY = {
  representativeTrackedEntries,
};
