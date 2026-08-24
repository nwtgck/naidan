import type { GitIndexEntry } from './index-file';
import { sortGitPaths } from './path-order';

export interface GitTreeMergeConflict {
  path: string,
  base: GitIndexEntry | undefined,
  ours: GitIndexEntry | undefined,
  theirs: GitIndexEntry | undefined,
}

export interface GitTreeMergeResult {
  entries: GitIndexEntry[],
  conflicts: GitTreeMergeConflict[],
}

function entryEquals({ left, right }: {
  left: GitIndexEntry | undefined,
  right: GitIndexEntry | undefined,
}): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.objectId === right.objectId && left.mode === right.mode;
}

function entryMap({ entries }: { entries: readonly GitIndexEntry[] }): Map<string, GitIndexEntry> {
  const result = new Map<string, GitIndexEntry>();
  for (const entry of entries) {
    if (entry.stage !== 0) throw new Error(`three-tree merge requires stage-0 entries: ${entry.path}`);
    result.set(entry.path, entry);
  }
  return result;
}

export function mergeThreeTrees({ baseEntries, oursEntries, theirsEntries }: {
  baseEntries: readonly GitIndexEntry[],
  oursEntries: readonly GitIndexEntry[],
  theirsEntries: readonly GitIndexEntry[],
}): GitTreeMergeResult {
  const base = entryMap({ entries: baseEntries });
  const ours = entryMap({ entries: oursEntries });
  const theirs = entryMap({ entries: theirsEntries });
  const result: GitIndexEntry[] = [];
  const conflicts: GitTreeMergeConflict[] = [];
  const paths = sortGitPaths({ paths: new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]) });
  for (const path of paths) {
    const baseEntry = base.get(path);
    const oursEntry = ours.get(path);
    const theirsEntry = theirs.get(path);
    let selected: GitIndexEntry | undefined;
    if (entryEquals({ left: oursEntry, right: theirsEntry })) selected = oursEntry;
    else if (entryEquals({ left: oursEntry, right: baseEntry })) selected = theirsEntry;
    else if (entryEquals({ left: theirsEntry, right: baseEntry })) selected = oursEntry;
    else {
      conflicts.push({ path, base: baseEntry, ours: oursEntry, theirs: theirsEntry });
      continue;
    }
    if (selected !== undefined) result.push({ ...selected, stage: 0 });
  }
  return { entries: result, conflicts };
}

export const TEST_ONLY = {
  entryEquals,
};
