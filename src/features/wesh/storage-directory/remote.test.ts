import { describe, expect, it } from 'vitest';
import { createInMemoryStorageRoot } from '@/00-storage/service/storage-file-system/test-support/in-memory-storage-file-system';
import type { WeshOpenFlags } from '@/features/wesh/types';
import { RemoteStorageDirectoryWeshProvider } from './provider';
import { createWeshStorageDirectoryRemoteForMounts } from './remote';

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

async function createMountedStorageDirectory({ readOnly = false }: {
  readOnly?: boolean;
} = {}) {
  const root = createInMemoryStorageRoot({ name: 'storage-root' });
  const remote = createWeshStorageDirectoryRemoteForMounts({
    mounts: [{
      type: 'storage_directory',
      path: MOUNT_PATH,
      handle: root,
      readOnly,
    }],
    storageDirectoryExecution: 'ui_remote',
  });
  if (remote === undefined) {
    throw new Error('Expected storage directory remote');
  }
  return {
    root,
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
  it('publishes multiple Wesh writes only when the storage writable closes', async () => {
    const { provider, remote } = await createMountedStorageDirectory();
    const handle = await provider.open({
      path: `${MOUNT_PATH}/value.txt`,
      flags: READ_WRITE_CREATE_FLAGS,
    });

    await handle.write({
      buffer: new TextEncoder().encode('abcdef'),
      position: 0,
    });
    await handle.write({
      buffer: new TextEncoder().encode('XY'),
      position: 2,
    });
    await handle.truncate({ size: 5 });

    expect(await provider.stat({ path: `${MOUNT_PATH}/value.txt` })).toMatchObject({
      type: 'file',
      size: 0,
    });
    expect(await handle.stat()).toMatchObject({ size: 5 });

    await handle.close();
    await expect(readAll({
      provider,
      path: `${MOUNT_PATH}/value.txt`,
    })).resolves.toBe('abXYe');

    await remote.dispose();
  });

  it('supports recursive directories, cross-directory rename, and symbolic links', async () => {
    const { provider, remote } = await createMountedStorageDirectory();
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
    expect(entries).toHaveLength(2);
    expect(entries).toEqual(expect.arrayContaining([
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
    ]));

    await remote.dispose();
  });

  it('enforces read-only mounts for all mutation entry points', async () => {
    const { provider, remote } = await createMountedStorageDirectory({ readOnly: true });
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
  });

  it('aborts uncommitted writers when the remote is disposed', async () => {
    const { provider, remote, root } = await createMountedStorageDirectory();
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
        handle: root,
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
  });
});
