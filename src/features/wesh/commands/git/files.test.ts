import { describe, expect, it, vi } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import { WeshVFS } from '@/features/wesh/vfs';
import { pathExists, readFileText, replaceTextViaLock, writeFileText } from './files';
import { appendReflog } from './reflog';
import type { GitRepository } from './repository';
import { createRef, deleteRef, moveHeadReference, readHead, readRef, renameRef, updateHead, updateRef, writeRef } from './refs';

describe('git file replacement transactions', () => {
  function createFiles(): WeshVFS {
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    return new WeshVFS({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
  }


  function createRepository(): GitRepository {
    return { worktreePath: '/repo', gitDirPath: '/repo/.git', commonDirPath: '/repo/.git' };
  }

  async function prepareRepository({ files }: { files: WeshVFS }): Promise<GitRepository> {
    const repository = createRepository();
    await files.mkdir({ path: '/repo/.git/refs/heads', recursive: true });
    return repository;
  }

  it('rolls an updated ref back when its reflog replacement fails', async () => {
    const files = createFiles();
    const repository = await prepareRepository({ files });
    const refName = 'refs/heads/main';
    const oldObjectId = '1111111111111111111111111111111111111111';
    const newObjectId = '2222222222222222222222222222222222222222';
    await writeRef({ files, repository, refName, objectId: oldObjectId });
    const originalRename = files.rename.bind(files);
    vi.spyOn(files, 'rename')
      .mockImplementationOnce(args => originalRename(args))
      .mockRejectedValueOnce(new Error('injected reflog rename failure'));

    await expect(updateRef({
      files,
      repository,
      refName,
      objectId: newObjectId,
      reflog: {
        identity: { name: 'Tester', email: 'tester@example.com' },
        timestamp: '981173166 +0000',
        message: 'commit: next',
      },
    })).rejects.toThrow('injected reflog rename failure');

    expect(await readRef({ files, repository, refName })).toBe(oldObjectId);
    expect(await pathExists({ files, path: '/repo/.git/logs/refs/heads/main' })).toBe(false);
    expect(await pathExists({ files, path: '/repo/.git/refs/heads/main.lock' })).toBe(false);
  });

  it('removes a newly created ref when its reflog replacement fails', async () => {
    const files = createFiles();
    const repository = await prepareRepository({ files });
    const refName = 'refs/heads/topic';
    const originalRename = files.rename.bind(files);
    vi.spyOn(files, 'rename')
      .mockImplementationOnce(args => originalRename(args))
      .mockRejectedValueOnce(new Error('injected reflog rename failure'));

    await expect(createRef({
      files,
      repository,
      refName,
      objectId: '3333333333333333333333333333333333333333',
      reflog: {
        identity: { name: 'Tester', email: 'tester@example.com' },
        timestamp: '981173166 +0000',
        message: 'branch: Created from HEAD',
      },
    })).rejects.toThrow('injected reflog rename failure');

    expect(await readRef({ files, repository, refName })).toBeUndefined();
    expect(await pathExists({ files, path: '/repo/.git/logs/refs/heads/topic' })).toBe(false);
  });


  it('rolls a symbolic HEAD update and both reflogs back when HEAD reflog replacement fails', async () => {
    const files = createFiles();
    const repository = await prepareRepository({ files });
    const refName = 'refs/heads/main';
    const oldObjectId = '1111111111111111111111111111111111111111';
    const newObjectId = '2222222222222222222222222222222222222222';
    await writeFileText({ files, path: '/repo/.git/HEAD', text: `ref: ${refName}\n` });
    await writeRef({ files, repository, refName, objectId: oldObjectId });
    const originalRename = files.rename.bind(files);
    vi.spyOn(files, 'rename')
      .mockImplementationOnce(args => originalRename(args))
      .mockImplementationOnce(args => originalRename(args))
      .mockRejectedValueOnce(new Error('injected HEAD reflog rename failure'));

    await expect(updateHead({
      files,
      repository,
      objectId: newObjectId,
      reflog: {
        identity: { name: 'Tester', email: 'tester@example.com' },
        timestamp: '981173166 +0000',
        message: 'commit: next',
      },
    })).rejects.toThrow('injected HEAD reflog rename failure');

    expect(await readRef({ files, repository, refName })).toBe(oldObjectId);
    expect(await pathExists({ files, path: '/repo/.git/logs/refs/heads/main' })).toBe(false);
    expect(await pathExists({ files, path: '/repo/.git/logs/HEAD' })).toBe(false);
  });

  it('rolls HEAD itself back when moving HEAD fails while writing its reflog', async () => {
    const files = createFiles();
    const repository = await prepareRepository({ files });
    const refName = 'refs/heads/main';
    const oldObjectId = '1111111111111111111111111111111111111111';
    await writeFileText({ files, path: '/repo/.git/HEAD', text: `ref: ${refName}\n` });
    await writeRef({ files, repository, refName, objectId: oldObjectId });
    const originalRename = files.rename.bind(files);
    vi.spyOn(files, 'rename')
      .mockImplementationOnce(args => originalRename(args))
      .mockRejectedValueOnce(new Error('injected HEAD reflog rename failure'));

    await expect(moveHeadReference({
      files,
      repository,
      target: { type: 'detached', objectId: oldObjectId },
      reflog: {
        identity: { name: 'Tester', email: 'tester@example.com' },
        timestamp: '981173166 +0000',
        message: 'checkout: moving from main to HEAD~0',
      },
    })).rejects.toThrow('injected HEAD reflog rename failure');

    expect(await readHead({ files, repository })).toEqual({ symbolicRef: refName, objectId: oldObjectId });
    expect(await pathExists({ files, path: '/repo/.git/logs/HEAD' })).toBe(false);
  });


  it('rolls a ref rename and its reflogs back when moving the reflog fails', async () => {
    const files = createFiles();
    const repository = await prepareRepository({ files });
    const oldRefName = 'refs/heads/old';
    const newRefName = 'refs/heads/new';
    const objectId = '1111111111111111111111111111111111111111';
    const oldLogPath = '/repo/.git/logs/refs/heads/old';
    const oldLog = `0000000000000000000000000000000000000000 ${objectId} Tester <tester@example.com> 981173106 +0000\tbranch: Created from HEAD\n`;
    await writeRef({ files, repository, refName: oldRefName, objectId });
    await files.mkdir({ path: '/repo/.git/logs/refs/heads', recursive: true });
    await writeFileText({ files, path: oldLogPath, text: oldLog });
    const originalRename = files.rename.bind(files);
    vi.spyOn(files, 'rename')
      .mockImplementationOnce(args => originalRename(args))
      .mockRejectedValueOnce(new Error('injected branch reflog move failure'));

    await expect(renameRef({
      files,
      repository,
      oldRefName,
      newRefName,
      reflog: undefined,
    })).rejects.toThrow('injected branch reflog move failure');

    expect(await readRef({ files, repository, refName: oldRefName })).toBe(objectId);
    expect(await readRef({ files, repository, refName: newRefName })).toBeUndefined();
    expect(await readFileText({ files, path: oldLogPath })).toBe(oldLog);
    expect(await pathExists({ files, path: '/repo/.git/logs/refs/heads/new' })).toBe(false);
  });


  it('restores a loose ref when packed-refs removal fails', async () => {
    const files = createFiles();
    const repository = await prepareRepository({ files });
    const refName = 'refs/heads/main';
    const packedObjectId = '1111111111111111111111111111111111111111';
    const looseObjectId = '2222222222222222222222222222222222222222';
    const packedRefs = `# pack-refs with: peeled fully-peeled sorted \n${packedObjectId} ${refName}\n`;
    await writeFileText({ files, path: '/repo/.git/packed-refs', text: packedRefs });
    await writeRef({ files, repository, refName, objectId: looseObjectId });
    vi.spyOn(files, 'rename').mockRejectedValueOnce(new Error('injected packed-refs rename failure'));

    await expect(deleteRef({ files, repository, refName }))
      .rejects.toThrow('injected packed-refs rename failure');

    expect(await readRef({ files, repository, refName })).toBe(looseObjectId);
    expect(await readFileText({ files, path: '/repo/.git/refs/heads/main' })).toBe(`${looseObjectId}\n`);
    expect(await readFileText({ files, path: '/repo/.git/packed-refs' })).toBe(packedRefs);
  });

  it('keeps the original file and cleans the lock when replacement rename fails', async () => {
    const files = createFiles();
    await writeFileText({ files, path: '/state', text: 'old\n' });
    vi.spyOn(files, 'rename').mockRejectedValueOnce(new Error('injected rename failure'));

    await expect(replaceTextViaLock({ files, path: '/state', text: 'new\n' }))
      .rejects.toThrow('injected rename failure');

    expect(await readFileText({ files, path: '/state' })).toBe('old\n');
    expect(await pathExists({ files, path: '/state.lock' })).toBe(false);
  });

  it('keeps an existing reflog intact when its replacement rename fails', async () => {
    const files = createFiles();
    const path = '/logs/refs/heads/main';
    await files.mkdir({ path: '/logs/refs/heads', recursive: true });
    const original = '0000000000000000000000000000000000000000 1111111111111111111111111111111111111111 Tester <tester@example.com> 981173106 +0000\tcommit: initial\n';
    await writeFileText({ files, path, text: original });
    vi.spyOn(files, 'rename').mockRejectedValueOnce(new Error('injected reflog rename failure'));

    await expect(appendReflog({
      files,
      path,
      oldObjectId: '1111111111111111111111111111111111111111',
      newObjectId: '2222222222222222222222222222222222222222',
      identity: { name: 'Tester', email: 'tester@example.com' },
      timestamp: '981173166 +0000',
      message: 'commit: next',
    })).rejects.toThrow('injected reflog rename failure');

    expect(await readFileText({ files, path })).toBe(original);
    expect(await pathExists({ files, path: `${path}.lock` })).toBe(false);
  });

  it('refuses a pre-existing lock without changing either file', async () => {
    const files = createFiles();
    await writeFileText({ files, path: '/state', text: 'old\n' });
    await writeFileText({ files, path: '/state.lock', text: 'other writer\n' });

    await expect(replaceTextViaLock({ files, path: '/state', text: 'new\n' }))
      .rejects.toThrow('File exists');

    expect(await readFileText({ files, path: '/state' })).toBe('old\n');
    expect(await readFileText({ files, path: '/state.lock' })).toBe('other writer\n');
  });
});
