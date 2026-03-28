import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OPFS_TMP_DIR, OPFS_TMP_PENDING_OWNER_CLEANUPS_KEY } from '@/models/constants';

class MockFileSystemDirectoryHandle {
  kind = 'directory' as const;
  entries = new Map<string, MockFileSystemDirectoryHandle>();

  constructor(public name: string) {}

  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    if (!this.entries.has(name)) {
      if (options?.create) {
        this.entries.set(name, new MockFileSystemDirectoryHandle(name));
      } else {
        const error = new Error(`Directory not found: ${name}`);
        error.name = 'NotFoundError';
        throw error;
      }
    }

    const entry = this.entries.get(name);
    if (!entry) {
      throw new Error(`Directory not found: ${name}`);
    }
    return entry;
  }

  async removeEntry(name: string, _options?: { recursive?: boolean }) {
    if (!this.entries.has(name)) {
      const error = new Error(`Directory not found: ${name}`);
      error.name = 'NotFoundError';
      throw error;
    }
    this.entries.delete(name);
  }
}

describe('OPFSTmpManager', () => {
  const mockOpfsRoot = new MockFileSystemDirectoryHandle('opfs-root');

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    localStorage.clear();
    mockOpfsRoot.entries.clear();
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: vi.fn().mockResolvedValue(mockOpfsRoot),
      },
    });
  });

  it('creates tmp directories under an owner-scoped directory', async () => {
    vi.doMock('@/utils/id', () => ({
      generateId: vi.fn()
        .mockReturnValueOnce('owner-scope-a')
        .mockReturnValueOnce('tmp-dir-a'),
    }));

    const { OPFSTmpManager } = await import('./opfs-tmp-manager');
    const manager = new OPFSTmpManager();

    const tmpHandle = await manager.createTmpDirectory({ prefix: 'chat-1' });

    expect(tmpHandle.name).toBe('chat-1-tmp-dir-a');
    const tmpRoot = mockOpfsRoot.entries.get(OPFS_TMP_DIR);
    expect(tmpRoot?.entries.has('owner-scope-a')).toBe(true);
    const ownerRoot = tmpRoot?.entries.get('owner-scope-a');
    expect(ownerRoot?.entries.has('chat-1-tmp-dir-a')).toBe(true);

    manager.dispose();
  });

  it('queues its owner scope for cleanup and a later manager flushes it', async () => {
    vi.doMock('@/utils/id', () => ({
      generateId: vi.fn()
        .mockReturnValueOnce('owner-scope-a')
        .mockReturnValueOnce('tmp-dir-a')
        .mockReturnValueOnce('owner-scope-b'),
    }));

    const { OPFSTmpManager } = await import('./opfs-tmp-manager');
    const managerA = new OPFSTmpManager();
    await managerA.createTmpDirectory({ prefix: 'chat-1' });

    window.dispatchEvent(new Event('beforeunload'));

    expect(localStorage.getItem(OPFS_TMP_PENDING_OWNER_CLEANUPS_KEY)).toBe(JSON.stringify({
      ownerScopeIds: ['owner-scope-a'],
    }));

    const managerB = new OPFSTmpManager();
    await managerB.flushPendingScopeCleanups();

    const tmpRoot = mockOpfsRoot.entries.get(OPFS_TMP_DIR);
    expect(tmpRoot?.entries.has('owner-scope-a')).toBe(false);
    expect(localStorage.getItem(OPFS_TMP_PENDING_OWNER_CLEANUPS_KEY)).toBe(JSON.stringify({
      ownerScopeIds: [],
    }));

    managerA.dispose();
    managerB.dispose();
  });
});
