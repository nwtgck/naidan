import { describe, expect, it } from 'vitest';
import { findExactRenames } from '@/features/wesh/commands/git/renames';

describe('wesh git exact rename matching', () => {
  it('matches regular-file executable-bit changes without crossing file types', () => {
    const objectId = '1111111111111111111111111111111111111111';
    expect(findExactRenames({
      deleted: [{ path: 'old', objectId, mode: 0o100644 }],
      added: [{ path: 'new', objectId, mode: 0o100755 }],
    })).toEqual([{
      sourcePath: 'old',
      destinationPath: 'new',
      objectId,
      sourceMode: 0o100644,
      destinationMode: 0o100755,
    }]);

    expect(findExactRenames({
      deleted: [{ path: 'old', objectId, mode: 0o100644 }],
      added: [{ path: 'new', objectId, mode: 0o120000 }],
    })).toEqual([]);
  });
});
