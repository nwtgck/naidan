import { describe, expect, it, vi } from 'vitest';

import type {
  StorageDirectoryHandle,
  StorageDirectoryWorkerMountGrant,
} from '@/00-storage/service/storage-file-system/types';
import { createWeshStorageDirectoryRemoteForMounts } from './storage-directory/remote';
import { createWeshStorageMount } from './storage-mount';
import { mapWeshMountsToWorkerMounts } from './worker/types';

function createGrant({ accessMode }: {
  accessMode: StorageDirectoryWorkerMountGrant['accessMode'];
}): StorageDirectoryWorkerMountGrant {
  return {
    type: 'storage_directory_worker_mount_grant',
    version: 1,
    implementation: 'hizofs',
    grantId: `grant-${accessMode}`,
    accessMode,
    opaquePayload: { opaque: true },
  };
}

describe('createWeshStorageMount', () => {
  it('retains the storage handle without eagerly issuing a Worker grant', () => {
    const createWorkerMountGrant = vi.fn(async () => createGrant({ accessMode: 'read_write' }));
    const handle = {
      createWorkerMountGrant,
    } as unknown as StorageDirectoryHandle;

    expect(createWeshStorageMount({
      path: '/encrypted',
      access: {
        type: 'storage_directory',
        handle,
      },
      readOnly: false,
    })).toEqual({
      type: 'storage_directory',
      path: '/encrypted',
      handle,
      readOnly: false,
    });
    expect(createWorkerMountGrant).not.toHaveBeenCalled();
  });

  it.each([
    { readOnly: false, accessMode: 'read_write' as const },
    { readOnly: true, accessMode: 'read' as const },
  ])('issues an opaque $accessMode grant only for Worker-local execution', async ({ readOnly, accessMode }) => {
    const grant = createGrant({ accessMode });
    const createWorkerMountGrant = vi.fn(async () => grant);
    const handle = {
      createWorkerMountGrant,
    } as unknown as StorageDirectoryHandle;
    const mounts = [createWeshStorageMount({
      path: '/encrypted',
      access: {
        type: 'storage_directory',
        handle,
      },
      readOnly,
    })];

    await expect(mapWeshMountsToWorkerMounts({
      mounts,
      storageDirectoryExecution: 'worker_local',
    })).resolves.toEqual([{
      type: 'storage_directory',
      path: '/encrypted',
      workerGrant: grant,
      readOnly,
    }]);
    expect(createWorkerMountGrant).toHaveBeenCalledExactlyOnceWith({ accessMode });
    expect(createWeshStorageDirectoryRemoteForMounts({
      mounts,
      storageDirectoryExecution: 'worker_local',
    })).toBeUndefined();
  });

  it('keeps storage mounts UI-remote without issuing Worker authority', async () => {
    const createWorkerMountGrant = vi.fn(async () => createGrant({ accessMode: 'read_write' }));
    const handle = {
      createWorkerMountGrant,
    } as unknown as StorageDirectoryHandle;
    const mounts = [createWeshStorageMount({
      path: '/encrypted',
      access: {
        type: 'storage_directory',
        handle,
      },
      readOnly: false,
    })];

    await expect(mapWeshMountsToWorkerMounts({
      mounts,
      storageDirectoryExecution: 'ui_remote',
    })).resolves.toEqual([{
      type: 'storage_directory',
      path: '/encrypted',
      workerGrant: undefined,
      readOnly: false,
    }]);
    expect(createWorkerMountGrant).not.toHaveBeenCalled();
    expect(createWeshStorageDirectoryRemoteForMounts({
      mounts,
      storageDirectoryExecution: 'ui_remote',
    })).toBeDefined();
  });

  it('falls back to the UI remote when a Worker-local handle cannot issue grants', () => {
    const handle = {} as StorageDirectoryHandle;
    const mounts = [createWeshStorageMount({
      path: '/plain',
      access: {
        type: 'storage_directory',
        handle,
      },
      readOnly: false,
    })];

    expect(createWeshStorageDirectoryRemoteForMounts({
      mounts,
      storageDirectoryExecution: 'worker_local',
    })).toBeDefined();
  });
});
