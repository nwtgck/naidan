import { describe, expect, it, vi } from 'vitest';
import type { StorageBinaryObjectReadHandle } from '@/00-storage/service/binary-object-io';
import { createInMemoryStorageRoot } from '@/00-storage/service/storage-file-system/test-support/in-memory-storage-file-system';
import type { WeshOpenFlags } from '@/features/wesh/types';
import type { StorageFileHandle } from '@/00-storage/service/storage-file-system/types';
import { RemoteStorageDirectoryWeshProvider } from './provider';
import { createWeshStorageDirectoryRemoteForMounts, OpenStorageFile } from './remote';

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
  it.each([
    { label: 'empty', size: 0 },
    { label: 'smaller than the preview chunk', size: 31 },
    { label: 'at the preview chunk boundary', size: 64 * 1024 },
    { label: 'larger than the preview chunk', size: 64 * 1024 + 17 },
  ])('clamps $label reads to the current logical file size', async ({ size }) => {
    const bytes = Uint8Array.from({ length: size }, (_unused, index) => index & 0xff);
    const read = vi.fn(async ({ buffer, length, offset, position }: {
      buffer: Uint8Array;
      length: number;
      offset: number;
      position: number;
      signal: AbortSignal | undefined;
    }) => {
      if (position > bytes.byteLength || length > bytes.byteLength - position) {
        throw new RangeError('file read range exceeds file size');
      }
      buffer.set(bytes.subarray(position, position + length), offset);
      return { bytesRead: length };
    });
    const fileHandle: StorageFileHandle = {
      kind: 'file',
      name: 'preview.bin',
      stat: vi.fn(async () => ({ createdAt: undefined, modifiedAt: undefined, size })),
      openReadable: vi.fn(async ({ mimeType }: { mimeType: string }): Promise<StorageBinaryObjectReadHandle> => ({
        backing: { type: 'reader_only' },
        close: vi.fn(async () => undefined),
        mimeType,
        read,
        size,
        stream: vi.fn(({ end: _end, signal: _signal, start: _start }: {
          end: number | undefined;
          signal: AbortSignal | undefined;
          start: number;
        }) => new ReadableStream<Uint8Array>()),
      })),
      createWritable: vi.fn(),
    };
    const handle = new OpenStorageFile({ fileHandle, flags: READ_ONLY_FLAGS });
    await handle.initialize();
    const first = new Uint8Array(64 * 1024);
    const firstResult = await handle.read({ buffer: first });
    const second = new Uint8Array(64 * 1024);
    const secondResult = await handle.read({ buffer: second });

    expect(firstResult.bytesRead).toBe(Math.min(size, first.byteLength));
    expect(secondResult.bytesRead).toBe(Math.max(0, size - first.byteLength));
    expect(read.mock.calls.every(([request]) => request.position + request.length <= size)).toBe(true);
    await handle.close();
  });

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
