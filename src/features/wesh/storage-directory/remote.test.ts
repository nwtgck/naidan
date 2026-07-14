import { describe, expect, it } from 'vitest';
import {
  createHizoFS,
  inspectHizoFS,
} from '@/00-storage/service/hizofs/api';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import type { WeshOpenFlags } from '@/features/wesh/types';
import { RemoteStorageDirectoryWeshProvider } from './provider';
import { createWeshStorageDirectoryRemoteForMounts } from './remote';

const ROOT_KEY = new Uint8Array(32).fill(0x41);
const MOUNT_PATH = '/mnt/encrypted';

const READ_ONLY_FLAGS: WeshOpenFlags = {
  access: 'read',
  creation: 'never',
  truncate: 'preserve',
  append: 'preserve',
};

const READ_WRITE_CREATE_FLAGS: WeshOpenFlags = {
  access: 'read-write',
  creation: 'if-needed',
  truncate: 'preserve',
  append: 'preserve',
};

async function createMountedHizoFS({ readOnly = false }: {
  readOnly?: boolean;
} = {}) {
  const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
  const session = await createHizoFS({
    backingDirectory: backing,
    fileSystemRootKey: ROOT_KEY,
  });
  const remote = createWeshStorageDirectoryRemoteForMounts({
    mounts: [{
      type: 'storage_directory',
      path: MOUNT_PATH,
      handle: session.root,
      workerSource: undefined,
      readOnly,
    }],
    storageDirectoryExecution: 'ui_remote',
  });
  if (remote === undefined) {
    throw new Error('Expected storage directory remote');
  }
  return {
    backing,
    session,
    remote,
    provider: new RemoteStorageDirectoryWeshProvider({
      remote,
      mountPath: MOUNT_PATH,
    }),
  };
}

async function readAll({
  provider,
  path,
}: {
  provider: RemoteStorageDirectoryWeshProvider;
  path: string;
}): Promise<string> {
  const handle = await provider.open({ path, flags: READ_ONLY_FLAGS });
  try {
    const stat = await handle.stat();
    const buffer = new Uint8Array(stat.size);
    const result = await handle.read({ buffer });
    return new TextDecoder().decode(buffer.subarray(0, result.bytesRead));
  } finally {
    await handle.close();
  }
}

describe('Wesh StorageDirectoryHandle remote', () => {
  it('commits multiple Wesh writes only when the remote handle closes', async () => {
    const { backing, provider, remote, session } = await createMountedHizoFS();
    const beforeOpen = await inspectHizoFS({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    const handle = await provider.open({
      path: `${MOUNT_PATH}/value.txt`,
      flags: READ_WRITE_CREATE_FLAGS,
    });
    const afterOpen = await inspectHizoFS({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    expect(afterOpen.activeCommit.revision).toBe(beforeOpen.activeCommit.revision + 1);

    await handle.write({
      buffer: new TextEncoder().encode('abcdef'),
      position: 0,
    });
    await handle.write({
      buffer: new TextEncoder().encode('XY'),
      position: 2,
    });
    await handle.truncate({ size: 5 });

    const beforeClose = await inspectHizoFS({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    expect(beforeClose.activeCommit.revision).toBe(afterOpen.activeCommit.revision);
    expect(await provider.stat({ path: `${MOUNT_PATH}/value.txt` })).toMatchObject({
      type: 'file',
      size: 0,
    });
    expect(await handle.stat()).toMatchObject({ size: 5 });

    await handle.close();
    const afterClose = await inspectHizoFS({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    expect(afterClose.activeCommit.revision).toBe(afterOpen.activeCommit.revision + 1);
    await expect(readAll({
      provider,
      path: `${MOUNT_PATH}/value.txt`,
    })).resolves.toBe('abXYe');

    await remote.dispose();
    await session.close();
  });

  it('supports recursive directories, cross-directory rename, and symbolic links', async () => {
    const { provider, remote, session } = await createMountedHizoFS();
    await provider.mkdir?.({
      path: `${MOUNT_PATH}/from/nested`,
      recursive: true,
    });
    await provider.mkdir?.({
      path: `${MOUNT_PATH}/to`,
      recursive: false,
    });
    const file = await provider.open({
      path: `${MOUNT_PATH}/from/nested/before.txt`,
      flags: READ_WRITE_CREATE_FLAGS,
    });
    await file.write({ buffer: new TextEncoder().encode('payload') });
    await file.close();

    await provider.rename?.({
      oldPath: `${MOUNT_PATH}/from/nested/before.txt`,
      newPath: `${MOUNT_PATH}/to/after.txt`,
    });
    await provider.symlink?.({
      path: `${MOUNT_PATH}/to/after-link`,
      targetPath: 'after.txt',
    });

    await expect(provider.lstat({ path: `${MOUNT_PATH}/to/after-link` }))
      .resolves.toMatchObject({ type: 'symlink' });
    await expect(provider.stat({ path: `${MOUNT_PATH}/to/after-link` }))
      .resolves.toMatchObject({ type: 'file', size: 7 });
    await expect(provider.readlink({ path: `${MOUNT_PATH}/to/after-link` }))
      .resolves.toBe('after.txt');
    await expect(readAll({
      provider,
      path: `${MOUNT_PATH}/to/after-link`,
    })).resolves.toBe('payload');

    const entries = [];
    for await (const entry of provider.readDir({ path: `${MOUNT_PATH}/to` })) {
      entries.push(entry);
    }
    expect(entries).toEqual([
      {
        name: 'after-link',
        type: 'symlink',
        fullPath: `${MOUNT_PATH}/to/after-link`,
      },
      {
        name: 'after.txt',
        type: 'file',
        fullPath: `${MOUNT_PATH}/to/after.txt`,
      },
    ]);

    await remote.dispose();
    await session.close();
  });

  it('enforces read-only mounts for all mutation entry points', async () => {
    const { provider, remote, session } = await createMountedHizoFS({ readOnly: true });
    await expect(provider.open({
      path: `${MOUNT_PATH}/new.txt`,
      flags: READ_WRITE_CREATE_FLAGS,
    })).rejects.toThrow('Read-only storage directory mount');
    await expect(provider.mkdir?.({
      path: `${MOUNT_PATH}/new-directory`,
      recursive: false,
    })).rejects.toThrow('Read-only storage directory mount');
    await expect(provider.symlink?.({
      path: `${MOUNT_PATH}/new-link`,
      targetPath: 'target',
    })).rejects.toThrow('Read-only storage directory mount');

    await remote.dispose();
    await session.close();
  });

  it('aborts uncommitted writers when the remote is disposed', async () => {
    const { provider, remote, session } = await createMountedHizoFS();
    const initial = await provider.open({
      path: `${MOUNT_PATH}/existing.txt`,
      flags: READ_WRITE_CREATE_FLAGS,
    });
    await initial.write({ buffer: new TextEncoder().encode('original') });
    await initial.close();

    const pending = await provider.open({
      path: `${MOUNT_PATH}/existing.txt`,
      flags: READ_WRITE_CREATE_FLAGS,
    });
    await pending.write({
      buffer: new TextEncoder().encode('replacement'),
      position: 0,
    });
    await remote.dispose();

    const secondRemote = createWeshStorageDirectoryRemoteForMounts({
      mounts: [{
        type: 'storage_directory',
        path: MOUNT_PATH,
        handle: session.root,
        workerSource: undefined,
        readOnly: false,
      }],
      storageDirectoryExecution: 'ui_remote',
    });
    if (secondRemote === undefined) {
      throw new Error('Expected replacement storage directory remote');
    }
    const secondProvider = new RemoteStorageDirectoryWeshProvider({
      remote: secondRemote,
      mountPath: MOUNT_PATH,
    });
    await expect(readAll({
      provider: secondProvider,
      path: `${MOUNT_PATH}/existing.txt`,
    })).resolves.toBe('original');

    await secondRemote.dispose();
    await session.close();
  });
});
