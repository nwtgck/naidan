import { describe, expect, it, vi } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import { WeshVFS } from '@/features/wesh/vfs';
import { TEST_ONLY } from './local-transport';
import type { GitRepository } from './repository';
import { readRef, writeRef } from './refs';

describe('git local transport ref transactions', () => {
  function createFiles(): WeshVFS {
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    return new WeshVFS({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
  }

  async function createRepository({ files, path }: { files: WeshVFS, path: string }): Promise<GitRepository> {
    const repository = { worktreePath: path, gitDirPath: `${path}/.git`, commonDirPath: `${path}/.git` };
    await files.mkdir({ path: `${path}/.git/refs/heads`, recursive: true });
    return repository;
  }

  it('rolls earlier refs back when a later ref update fails', async () => {
    const files = createFiles();
    const repository = await createRepository({ files, path: '/repo' });
    const firstRef = 'refs/heads/first';
    const secondRef = 'refs/heads/second';
    const oldObjectId = '1111111111111111111111111111111111111111';
    await writeRef({ files, repository, refName: firstRef, objectId: oldObjectId });
    const originalRename = files.rename.bind(files);
    vi.spyOn(files, 'rename')
      .mockImplementationOnce(args => originalRename(args))
      .mockRejectedValueOnce(new Error('injected second ref failure'));

    await expect(TEST_ONLY.applyLocalRefMutationsWithRollback({
      files,
      mutations: [
        { repository, refName: firstRef, objectId: '2222222222222222222222222222222222222222' },
        { repository, refName: secondRef, objectId: '3333333333333333333333333333333333333333' },
      ],
    })).rejects.toThrow('injected second ref failure');

    expect(await readRef({ files, repository, refName: firstRef })).toBe(oldObjectId);
    expect(await readRef({ files, repository, refName: secondRef })).toBeUndefined();
  });

  it('rolls all refs back when finalization fails after their updates', async () => {
    const files = createFiles();
    const repository = await createRepository({ files, path: '/repo' });
    const firstRef = 'refs/heads/first';
    const secondRef = 'refs/heads/second';
    const firstOld = '1111111111111111111111111111111111111111';
    const secondOld = '2222222222222222222222222222222222222222';
    await writeRef({ files, repository, refName: firstRef, objectId: firstOld });
    await writeRef({ files, repository, refName: secondRef, objectId: secondOld });

    await expect(TEST_ONLY.applyLocalRefMutationsWithRollback({
      files,
      mutations: [
        { repository, refName: firstRef, objectId: '3333333333333333333333333333333333333333' },
        { repository, refName: secondRef, objectId: undefined },
      ],
      finalize: async () => {
        throw new Error('injected FETCH_HEAD failure');
      },
    })).rejects.toThrow('injected FETCH_HEAD failure');

    expect(await readRef({ files, repository, refName: firstRef })).toBe(firstOld);
    expect(await readRef({ files, repository, refName: secondRef })).toBe(secondOld);
  });
});
