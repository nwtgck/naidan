import { applyCheckoutTreePlan, planCheckoutTree } from './checkout';
import type { GitCheckoutConflict } from './checkout';
import type { GitWorktreeContentConfig } from './config';
import type { GitFiles } from './files';
import type { GitIndexEntry } from './index-file';
import { writeIndex } from './index-file';
import { materializePreparedMergeConflicts } from './merge-conflict';
import type { GitPreparedMergeConflict } from './merge-conflict';
import { sortByGitUtf8StringKey } from './utf8-order';
import type { GitRepository } from './repository';

function entryByPath({ entries }: { entries: readonly GitIndexEntry[] }): Map<string, GitIndexEntry> {
  return new Map(entries.map(entry => [entry.path, entry]));
}

export async function applyMergedIndexWithConflicts({
  files,
  repository,
  currentHeadEntries,
  currentIndexEntries,
  mergedEntries,
  preparedConflicts,
  contentConfig,
}: {
  files: GitFiles,
  repository: GitRepository,
  currentHeadEntries: readonly GitIndexEntry[],
  currentIndexEntries: readonly GitIndexEntry[],
  mergedEntries: readonly GitIndexEntry[],
  preparedConflicts: readonly GitPreparedMergeConflict[],
  contentConfig: GitWorktreeContentConfig,
}): Promise<{ checkoutConflicts: GitCheckoutConflict[] }> {
  const headByPath = entryByPath({ entries: currentHeadEntries });
  const checkoutTargetEntries = [...mergedEntries];
  for (const conflict of preparedConflicts) {
    const ours = headByPath.get(conflict.path);
    if (ours !== undefined) checkoutTargetEntries.push(ours);
  }
  const sortedCheckoutTargetEntries = sortByGitUtf8StringKey({
    values: checkoutTargetEntries,
    key: ({ value }) => value.path,
  });

  const plan = await planCheckoutTree({
    files,
    repository,
    currentHeadEntries,
    currentIndexEntries,
    targetEntries: sortedCheckoutTargetEntries,
    contentConfig,
  });
  if (plan.conflicts.length > 0) return { checkoutConflicts: plan.conflicts };

  await applyCheckoutTreePlan({ files, repository, currentIndexEntries, plan, contentConfig });
  await writeIndex({
    files,
    repository,
    entries: [...mergedEntries, ...preparedConflicts.flatMap(conflict => conflict.indexEntries)],
  });
  await materializePreparedMergeConflicts({ files, repository, conflicts: preparedConflicts });
  return { checkoutConflicts: [] };
}

export const TEST_ONLY = {
};
