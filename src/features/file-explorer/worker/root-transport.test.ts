import { afterEach, describe, expect, it, vi } from 'vitest';

import type { StorageDirectoryHandle } from '@/00-storage/service/storage-file-system/types';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  hasFileExplorerFileSystemHandles,
  mapFileExplorerRootToOpfsLocators,
} from './root-transport';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('File Explorer root transport', () => {
  it('maps domain directory handles to Worker locators while preserving UI-remote storage mounts', async () => {
    const opfsRoot = new MockFileSystemDirectoryHandle({ name: '' });
    const directoryHandle = await opfsRoot.getDirectoryHandle('mounted', { create: true });
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: vi.fn().mockResolvedValue(opfsRoot),
      },
    });
    const createWorkerMountGrant = vi.fn();
    const storageHandle = { createWorkerMountGrant } as unknown as StorageDirectoryHandle;
    const root = {
      kind: 'wesh-mounts' as const,
      rootName: 'Files',
      mounts: [{
        type: 'directory' as const,
        path: '/mounted',
        handle: directoryHandle as unknown as FileSystemDirectoryHandle,
        readOnly: true,
      }, {
        type: 'storage_directory' as const,
        path: '/encrypted',
        handle: storageHandle,
        readOnly: false,
      }],
    };

    expect(hasFileExplorerFileSystemHandles({ root })).toBe(true);
    await expect(mapFileExplorerRootToOpfsLocators({ root })).resolves.toEqual({
      kind: 'wesh-mounts',
      rootName: 'Files',
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
        workerGrant: undefined,
        readOnly: false,
      }],
    });
    expect(createWorkerMountGrant).not.toHaveBeenCalled();
  });

  it('keeps storage roots on the UI-owned remote boundary', async () => {
    const handle = {} as StorageDirectoryHandle;
    const root = {
      kind: 'storage-directory' as const,
      rootName: 'Encrypted files',
      handle,
      readOnly: true,
    };

    expect(hasFileExplorerFileSystemHandles({ root })).toBe(false);
    await expect(mapFileExplorerRootToOpfsLocators({ root })).resolves.toEqual({
      kind: 'storage-directory',
      rootName: 'Encrypted files',
      readOnly: true,
    });
  });
});
