import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OPFS_TMP_PENDING_OWNER_CLEANUPS_KEY } from '@/constants';

const mocks = vi.hoisted(() => ({
  openOpfsSpecialFileSystemDirectory: vi.fn(),
  removeOpfsSpecialFileSystemEntry: vi.fn(),
}));

vi.mock('@/00-storage/service', () => ({
  storageService: {
    openOpfsSpecialFileSystemDirectory: mocks.openOpfsSpecialFileSystemDirectory,
    removeOpfsSpecialFileSystemEntry: mocks.removeOpfsSpecialFileSystemEntry,
  },
}));

describe('OPFSTmpManager', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    localStorage.clear();
    mocks.openOpfsSpecialFileSystemDirectory.mockResolvedValue({
      type: 'direct_directory',
      handle: { name: 'tmp-directory' } as FileSystemDirectoryHandle,
    });
    mocks.removeOpfsSpecialFileSystemEntry.mockResolvedValue(undefined);
  });

  it('creates tmp directories under an owner-scoped directory', async () => {
    vi.doMock('@/01-models/id', () => ({
      generateId: vi.fn()
        .mockReturnValueOnce('owner-scope-a')
        .mockReturnValueOnce('tmp-dir-a'),
    }));

    const { TEST_ONLY: { OPFSTmpManager } } = await import('./opfs-tmp-manager');
    const manager = new OPFSTmpManager();

    const access = await manager.createTmpDirectory({ prefix: 'chat-1' });

    expect(access).toMatchObject({
      type: 'direct_directory',
      handle: { name: 'tmp-directory' },
    });
    expect(mocks.openOpfsSpecialFileSystemDirectory).toHaveBeenCalledWith({
      type: 'tmp',
      path: '/owner-scope-a/chat-1-tmp-dir-a',
      create: true,
    });

    manager.dispose();
  });

  it('queues its owner scope for cleanup and a later manager flushes it', async () => {
    vi.doMock('@/01-models/id', () => ({
      generateId: vi.fn()
        .mockReturnValueOnce('owner-scope-a')
        .mockReturnValueOnce('tmp-dir-a')
        .mockReturnValueOnce('owner-scope-b'),
    }));

    const { TEST_ONLY: { OPFSTmpManager } } = await import('./opfs-tmp-manager');
    const managerA = new OPFSTmpManager();
    await managerA.createTmpDirectory({ prefix: 'chat-1' });

    window.dispatchEvent(new Event('beforeunload'));

    expect(localStorage.getItem(OPFS_TMP_PENDING_OWNER_CLEANUPS_KEY)).toBe(JSON.stringify({
      ownerScopeIds: ['owner-scope-a'],
    }));

    const managerB = new OPFSTmpManager();
    await managerB.flushPendingScopeCleanups();

    expect(mocks.removeOpfsSpecialFileSystemEntry).toHaveBeenCalledWith({
      type: 'tmp',
      path: '/owner-scope-a',
      recursive: true,
    });
    expect(localStorage.getItem(OPFS_TMP_PENDING_OWNER_CLEANUPS_KEY)).toBe(JSON.stringify({
      ownerScopeIds: [],
    }));

    managerA.dispose();
    managerB.dispose();
  });
});
