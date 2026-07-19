import { describe, expect, it, vi } from 'vitest';

import type {
  StorageDirectoryHandle,
  StorageDirectoryWorkerMountSource,
} from '@/00-storage/service/storage-file-system/types';
import { createWeshStorageDirectoryRemoteForMounts } from './storage-directory/remote';
import { mapWeshMountsToWorkerMounts } from './worker/types';
import { createWeshStorageMount } from './storage-mount';

describe('createWeshStorageMount', () => {
  it('forwards a Worker-reopenable storage directory capability to Wesh', () => {
    const workerSource: StorageDirectoryWorkerMountSource = {
      type: 'hizofs',
      backingDirectory: {} as FileSystemDirectoryHandle,
      fileSystemId: 'filesystem-1',
      rootKey: {} as CryptoKey,
      subvolumeDescriptorObjectId: 'subvolume-descriptor',
      rootDirectoryNodeId: 'directory-1',
    };
    const createWorkerMountSource = vi.fn(() => workerSource);
    const handle = {
      createWorkerMountSource,
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
      workerSource,
      readOnly: false,
    });
    expect(createWorkerMountSource).toHaveBeenCalledTimes(1);
  });

  it('keeps Worker-reopenable mounts remote for File Explorer without forwarding key authority', () => {
    const workerSource: StorageDirectoryWorkerMountSource = {
      type: 'hizofs',
      backingDirectory: {} as FileSystemDirectoryHandle,
      fileSystemId: 'filesystem-1',
      rootKey: {} as CryptoKey,
      subvolumeDescriptorObjectId: 'subvolume-descriptor',
      rootDirectoryNodeId: 'directory-1',
    };
    const handle = {} as StorageDirectoryHandle;
    const mounts = [{
      type: 'storage_directory' as const,
      path: '/encrypted',
      handle,
      workerSource,
      readOnly: false,
    }];

    expect(createWeshStorageDirectoryRemoteForMounts({
      mounts,
      storageDirectoryExecution: 'worker_local',
    })).toBeUndefined();
    expect(createWeshStorageDirectoryRemoteForMounts({
      mounts,
      storageDirectoryExecution: 'ui_remote',
    })).toBeDefined();
    expect(mapWeshMountsToWorkerMounts({
      mounts,
      storageDirectoryExecution: 'ui_remote',
    })).toEqual([{
      type: 'storage_directory',
      path: '/encrypted',
      workerSource: undefined,
      readOnly: false,
    }]);
  });

});
