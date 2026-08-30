import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  StorageDirectoryHandle,
  StorageDirectoryWorkerMountGrant,
} from '@/00-storage/service/storage-file-system/types';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import { createWeshWorkerInitRequest } from './init-request';

afterEach(() => {
  vi.unstubAllGlobals();
});

function createGrant(): StorageDirectoryWorkerMountGrant {
  return {
    type: 'storage_directory_worker_mount_grant',
    version: 1,
    implementation: 'hizofs',
    grantId: 'grant-1',
    accessMode: 'read_write',
    opaquePayload: { cloneable: true },
  };
}

describe('createWeshWorkerInitRequest', () => {
  it('awaits Worker-local storage grants for direct transport', async () => {
    const workerGrant = createGrant();
    const createWorkerMountGrant = vi.fn().mockResolvedValue(workerGrant);

    await expect(createWeshWorkerInitRequest({
      rootHandle: 'readonly',
      mounts: [{
        type: 'storage_directory',
        path: '/encrypted',
        handle: { createWorkerMountGrant } as unknown as StorageDirectoryHandle,
        readOnly: false,
      }],
      user: 'user',
      initialEnv: {},
      initialCwd: undefined,
      transport: 'direct',
    })).resolves.toEqual({
      rootHandle: 'readonly',
      mounts: [{
        type: 'storage_directory',
        path: '/encrypted',
        workerGrant,
        readOnly: false,
      }],
      user: 'user',
      initialEnv: {},
      initialCwd: undefined,
    });
    expect(createWorkerMountGrant).toHaveBeenCalledExactlyOnceWith({ accessMode: 'read_write' });
  });

  it('preserves mixed directory and Worker-local storage mounts in OPFS locator fallback', async () => {
    const opfsRoot = new MockFileSystemDirectoryHandle({ name: '' });
    const rootHandle = await opfsRoot.getDirectoryHandle('root', { create: true });
    const directoryHandle = await opfsRoot.getDirectoryHandle('mounted', { create: true });
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: vi.fn().mockResolvedValue(opfsRoot),
      },
    });
    const workerGrant = createGrant();
    const createWorkerMountGrant = vi.fn().mockResolvedValue(workerGrant);

    await expect(createWeshWorkerInitRequest({
      rootHandle: rootHandle as unknown as FileSystemDirectoryHandle,
      mounts: [{
        type: 'directory',
        path: '/mounted',
        handle: directoryHandle as unknown as FileSystemDirectoryHandle,
        readOnly: true,
      }, {
        type: 'storage_directory',
        path: '/encrypted',
        handle: { createWorkerMountGrant } as unknown as StorageDirectoryHandle,
        readOnly: false,
      }],
      user: 'user',
      initialEnv: {},
      initialCwd: undefined,
      transport: 'opfs-locator',
    })).resolves.toEqual({
      rootHandle: {
        kind: 'opfs-directory',
        pathSegments: ['root'],
      },
      mounts: [{
        type: 'directory',
        path: '/mounted',
        handle: {
          kind: 'opfs-directory',
          pathSegments: ['mounted'],
        },
        readOnly: true,
      }, {
        type: 'storage_directory',
        path: '/encrypted',
        workerGrant,
        readOnly: false,
      }],
      user: 'user',
      initialEnv: {},
      initialCwd: undefined,
    });
    expect(createWorkerMountGrant).toHaveBeenCalledExactlyOnceWith({ accessMode: 'read_write' });
  });
});
