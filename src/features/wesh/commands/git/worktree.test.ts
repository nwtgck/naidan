import { describe, expect, it } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import { WeshVFS } from '@/features/wesh/vfs';
import { pathExists, readFileText, writeFileText } from './files';
import { writeObject } from './objects';
import type { GitRepository } from './repository';
import { replaceTrackedWorktree } from './worktree';

const encoder = new TextEncoder();

describe('wesh git worktree mutation preflight', () => {
  it('does not mutate earlier paths when a later target object is missing', async () => {
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    const files = new WeshVFS({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    const repository: GitRepository = {
      worktreePath: '/repo',
      gitDirPath: '/repo/.git',
      commonDirPath: '/repo/.git',
    };
    await files.mkdir({ path: '/repo/.git/objects', recursive: true });
    const oldObjectId = await writeObject({ files, repository, type: 'blob', body: encoder.encode('old\n') });
    const newObjectId = await writeObject({ files, repository, type: 'blob', body: encoder.encode('new\n') });
    await writeFileText({ files, path: '/repo/a', text: 'old\n' });

    await expect(replaceTrackedWorktree({
      files,
      repository,
      previousEntries: [{ path: 'a', objectId: oldObjectId, mode: 0o100644, size: 4, stage: 0 }],
      targetEntries: [
        { path: 'a', objectId: newObjectId, mode: 0o100644, size: 4, stage: 0 },
        { path: 'b', objectId: 'ffffffffffffffffffffffffffffffffffffffff', mode: 0o100644, size: 1, stage: 0 },
      ],
      contentConfig: { autoCrlf: 'false', eol: 'lf' },
    })).rejects.toThrow('Object not found: ffffffffffffffffffffffffffffffffffffffff');

    expect(await readFileText({ files, path: '/repo/a' })).toBe('old\n');
    expect(await pathExists({ files, path: '/repo/b' })).toBe(false);
  });
});
