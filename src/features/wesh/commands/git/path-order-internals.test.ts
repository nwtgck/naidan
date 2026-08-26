import { describe, expect, it } from 'vitest';
import type { GitIndexEntry } from './index-file';
import { TEST_ONLY as indexWorktreeTestOnly } from './index-worktree';
import { mergeThreeTrees } from './merge-tree';

const bmpPrivateUse = '\uE000';
const supplementary = '\u{10000}';

function entry(path: string, objectId: string): GitIndexEntry {
  return {
    path,
    objectId,
    mode: 0o100644,
    size: 1,
    stage: 0,
  };
}

describe('wesh git internal path ordering', () => {
  it('keeps three-tree merge output in Git UTF-8 byte order', () => {
    const entries = [
      entry(supplementary, '2222222222222222222222222222222222222222'),
      entry(bmpPrivateUse, '1111111111111111111111111111111111111111'),
    ];

    const merged = mergeThreeTrees({ baseEntries: entries, oursEntries: entries, theirsEntries: entries });

    expect(merged.conflicts).toEqual([]);
    expect(merged.entries.map(item => item.path)).toEqual([bmpPrivateUse, supplementary]);
  });

  it('keeps representative index entries in Git UTF-8 byte order', () => {
    const entries = [
      entry(supplementary, '2222222222222222222222222222222222222222'),
      entry(bmpPrivateUse, '1111111111111111111111111111111111111111'),
    ];

    const representative = indexWorktreeTestOnly.representativeTrackedEntries({ entries });

    expect(representative.map(item => item.path)).toEqual([bmpPrivateUse, supplementary]);
  });
});
