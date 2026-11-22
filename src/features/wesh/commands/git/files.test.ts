import { describe, expect, it, vi } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import { WeshVFS } from '@/features/wesh/vfs';
import { pathExists, readFileText, replaceTextViaLock, writeFileText } from './files';
import { appendReflog } from './reflog';
import type { GitRepository } from './repository';
import { createRef, deleteRef, moveHeadReference, readHead, readRef, renameBranch, updateHead, updateRef, writeRef } from './refs';

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

  it('keeps the old ref when its reflog replacement fails', async () => {
    const files = createFiles();
    const repository = await prepareRepository({ files });
    const refName = 'refs/heads/main';
    const oldObjectId = '1111111111111111111111111111111111111111';
    const newObjectId = '2222222222222222222222222222222222222222';
    await writeRef({ files, repository, refName, objectId: oldObjectId });
    const originalPublish = files.publishEntries.bind(files);
    using _publish = vi.spyOn(files, 'publishEntries').mockImplementation(async args => {
      if (args.changes.find(change => change.operation === 'rename')?.path === '/repo/.git/logs/refs/heads/main') {
        throw new Error('injected reflog rename failure');
      }
      await originalPublish(args);
    });

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

  it('does not publish a new ref when its reflog replacement fails', async () => {
    const files = createFiles();
    const repository = await prepareRepository({ files });
    const refName = 'refs/heads/topic';
    const originalPublish = files.publishEntries.bind(files);
    using _publish = vi.spyOn(files, 'publishEntries').mockImplementation(async args => {
      if (args.changes.find(change => change.operation === 'rename')?.path === '/repo/.git/logs/refs/heads/topic') {
        throw new Error('injected reflog rename failure');
      }
      await originalPublish(args);
    });

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

  it('keeps a symbolic HEAD update and both reflogs unpublished when HEAD reflog replacement fails', async () => {
    const files = createFiles();
    const repository = await prepareRepository({ files });
    const refName = 'refs/heads/main';
    const oldObjectId = '1111111111111111111111111111111111111111';
    const newObjectId = '2222222222222222222222222222222222222222';
    await writeFileText({ files, path: '/repo/.git/HEAD', text: `ref: ${refName}\n` });
    await writeRef({ files, repository, refName, objectId: oldObjectId });
    const originalPublish = files.publishEntries.bind(files);
    using _publish = vi.spyOn(files, 'publishEntries').mockImplementation(async args => {
      if (args.changes.find(change => change.operation === 'rename')?.path === '/repo/.git/logs/HEAD') {
        throw new Error('injected HEAD reflog rename failure');
      }
      await originalPublish(args);
    });

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

  it('keeps the old HEAD when moving HEAD fails while writing its reflog', async () => {
    const files = createFiles();
    const repository = await prepareRepository({ files });
    const refName = 'refs/heads/main';
    const oldObjectId = '1111111111111111111111111111111111111111';
    await writeFileText({ files, path: '/repo/.git/HEAD', text: `ref: ${refName}\n` });
    await writeRef({ files, repository, refName, objectId: oldObjectId });
    const originalPublish = files.publishEntries.bind(files);
    using _publish = vi.spyOn(files, 'publishEntries').mockImplementation(async args => {
      if (args.changes.find(change => change.operation === 'rename')?.path === '/repo/.git/logs/HEAD') {
        throw new Error('injected HEAD reflog rename failure');
      }
      await originalPublish(args);
    });

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

  it('preserves the old ref and reflog when the branch rename cannot publish', async () => {
    const files = createFiles();
    const repository = await prepareRepository({ files });
    const oldRefName = 'refs/heads/old';
    const newRefName = 'refs/heads/new';
    const objectId = '1111111111111111111111111111111111111111';
    const oldLogPath = '/repo/.git/logs/refs/heads/old';
    const oldLog = `0000000000000000000000000000000000000000 ${objectId} Tester <tester@example.com> 981173106 +0000\tbranch: Created from HEAD\n`;
    await writeFileText({ files, path: '/repo/.git/HEAD', text: 'ref: refs/heads/master\n' });
    await writeRef({ files, repository, refName: oldRefName, objectId });
    await files.mkdir({ path: '/repo/.git/logs/refs/heads', recursive: true });
    await writeFileText({ files, path: oldLogPath, text: oldLog });
    using _publish = vi.spyOn(files, 'publishEntries').mockRejectedValueOnce(new Error('injected branch reflog move failure'));

    await expect(renameBranch({
      files,
      repository,
      oldName: 'old',
      newName: 'new',
      config: new Map(),
      env: new Map(),
    })).rejects.toThrow('injected branch reflog move failure');

    expect(await readRef({ files, repository, refName: oldRefName })).toBe(objectId);
    expect(await readRef({ files, repository, refName: newRefName })).toBeUndefined();
    expect(await readFileText({ files, path: oldLogPath })).toBe(oldLog);
    expect(await pathExists({ files, path: '/repo/.git/logs/refs/heads/new' })).toBe(false);
  });

  it('keeps a competing new name when a branch rename cannot create it', async () => {
    const files = createFiles();
    const repository = await prepareRepository({ files });
    const oldRefName = 'refs/heads/old';
    const newRefName = 'refs/heads/new';
    const objectId = '1'.repeat(40);
    const competingId = '2'.repeat(40);
    await writeFileText({ files, path: '/repo/.git/HEAD', text: 'ref: refs/heads/master\n' });
    await writeRef({ files, repository, refName: oldRefName, objectId });
    const acquire = files.createTemporaryFile.bind(files);
    using _compete = vi.spyOn(files, 'createTemporaryFile').mockImplementation(async args => {
      if (args.path === '/repo/.git/refs/heads/new.lock') {
        await writeFileText({ files, path: '/repo/.git/refs/heads/new', text: `${competingId}\n` });
      }
      return acquire(args);
    });

    await expect(renameBranch({ files, repository, oldName: 'old', newName: 'new', config: new Map(), env: new Map() }))
      .rejects.toThrow("a branch named 'new' already exists");
    await expect(readRef({ files, repository, refName: newRefName })).resolves.toBe(competingId);
    await expect(readRef({ files, repository, refName: oldRefName })).resolves.toBe(objectId);
  });

  it('preserves the loose ref when packed-refs removal fails', async () => {
    const files = createFiles();
    const repository = await prepareRepository({ files });
    const refName = 'refs/heads/main';
    const packedObjectId = '1111111111111111111111111111111111111111';
    const looseObjectId = '2222222222222222222222222222222222222222';
    const packedRefs = `# pack-refs with: peeled fully-peeled sorted \n${packedObjectId} ${refName}\n`;
    await writeFileText({ files, path: '/repo/.git/packed-refs', text: packedRefs });
    await writeRef({ files, repository, refName, objectId: looseObjectId });
    vi.spyOn(files, 'publishEntries').mockRejectedValueOnce(new Error('injected packed-refs rename failure'));

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

  it('checks a new reference again after acquiring its lock', async () => {
    const files = createFiles();
    const repository = await prepareRepository({ files });
    const refName = 'refs/heads/topic';
    const acquire = files.createTemporaryFile.bind(files);
    const waiting = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    using _release = {
      [Symbol.dispose]() {
        proceed.resolve();
      },
    };
    using _acquire = vi.spyOn(files, 'createTemporaryFile').mockImplementationOnce(async args => {
      waiting.resolve();
      await proceed.promise;
      return acquire(args);
    });
    const first = createRef({ files, repository, refName, objectId: '1'.repeat(40) });
    await waiting.promise;

    const winningObjectId = '2'.repeat(40);
    await createRef({ files, repository, refName, objectId: winningObjectId });
    const rejected = expect(first).rejects.toThrow(`reference already exists: ${refName}`);
    proceed.resolve();
    await rejected;
    expect(await readRef({ files, repository, refName })).toBe(winningObjectId);
  });

  it('reads the latest reflog entry after acquiring the log lock', async () => {
    const files = createFiles();
    await files.mkdir({ path: '/logs', recursive: true });
    const path = '/logs/main';
    const append = ({ id, message }: { id: string, message: string }) => appendReflog({
      files,
      path,
      oldObjectId: undefined,
      newObjectId: id.repeat(40),
      identity: { name: 'Tester', email: 'tester@example.com' },
      timestamp: '981173166 +0000',
      message,
    });
    const acquire = files.createTemporaryFile.bind(files);
    const waiting = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    using _release = {
      [Symbol.dispose]() {
        proceed.resolve();
      },
    };
    using _acquire = vi.spyOn(files, 'createTemporaryFile').mockImplementationOnce(async args => {
      waiting.resolve();
      await proceed.promise;
      return acquire(args);
    });
    const deferred = append({ id: '1', message: 'appended second' });
    await waiting.promise;
    await append({ id: '2', message: 'appended first' });
    proceed.resolve();
    await deferred;

    const lines = (await readFileText({ files, path })).trimEnd().split('\n');
    expect(lines.map(line => line.split('\t')[1])).toEqual(['appended first', 'appended second']);
  });

  it('keeps both branch refs locked while moving symbolic HEAD', async () => {
    const files = createFiles();
    const repository = await prepareRepository({ files });
    const oldName = 'refs/heads/main';
    const newName = 'refs/heads/topic';
    const expected = '2'.repeat(40);
    await writeFileText({ files, path: '/repo/.git/HEAD', text: `ref: ${oldName}\n` });
    await writeRef({ files, repository, refName: oldName, objectId: '1'.repeat(40) });
    await writeRef({ files, repository, refName: newName, objectId: expected });
    const publish = files.publishEntries.bind(files);
    using _publish = vi.spyOn(files, 'publishEntries').mockImplementationOnce(async args => {
      await expect(deleteRef({ files, repository, refName: oldName })).rejects.toThrow('File exists');
      await expect(deleteRef({ files, repository, refName: newName })).rejects.toThrow('File exists');
      await publish(args);
    });

    await moveHeadReference({
      files,
      repository,
      target: { type: 'symbolic', refName: newName, objectId: expected },
      reflog: {
        identity: { name: 'Tester', email: 'tester@example.com' },
        timestamp: '981173166 +0000',
        message: 'checkout: moving from main to topic',
      },
    });

    expect(await readHead({ files, repository })).toEqual({ symbolicRef: newName, objectId: expected });
    await expect(readRef({ files, repository, refName: oldName })).resolves.toBe('1'.repeat(40));
  });
});
