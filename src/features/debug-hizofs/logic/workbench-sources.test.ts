import { describe, expect, it, vi } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import type { StorageFileSystemSession } from '@/00-storage/service/storage-file-system/types';
import { createInMemoryStorageRoot } from '@/00-storage/service/storage-file-system/test-support/in-memory-storage-file-system';
import type { HizoFSAuthenticatedInspectionSession } from '@/00-storage/service/hizofs/inspection';
import type { HizoFSDebugWorkspaceAuthority } from './debug-workspace';
import {
  createHizoFSWorkbenchSourceRegistry,
  type ActiveHizoFSWorkbenchSource,
} from './workbench-sources';
function authenticatedInspectionSession(): HizoFSAuthenticatedInspectionSession {
  return {
    inspectContainer: vi.fn(async () => ({}) as never),
    inspectHomeRecord: vi.fn(async () => ({}) as never),
    inspectNamespacePath: vi.fn(async () => ({}) as never),
    inspectRecord: vi.fn(async () => ({}) as never),
    inspectRecordFrame: vi.fn(async () => ({}) as never),
  };
}


function debugAuthority(): HizoFSDebugWorkspaceAuthority {
  return {
    async create() {
      const fileSystemSession: StorageFileSystemSession = {
        root: createInMemoryStorageRoot({ name: 'decrypted-root' }),
        capabilities: {
          atomicMove: 'supported',
          directBlob: 'supported',
          symbolicLink: 'supported',
          wholeFileClone: 'supported',
        },
        async close() {},
        async sync() {},
      };
      return {
        authenticatedInspectionSession: authenticatedInspectionSession(),
        fileSystemId: 'debug-file-system',
        fileSystemSession,
        dispose: async () => await fileSystemSession.close(),
      };
    },
  };
}

describe('HizoFS Workbench source registry', () => {
  it('combines injected active sources with isolated debug workspaces', async () => {
    const nativeOpfsRoot = new MockFileSystemDirectoryHandle({ name: 'opfs-root' });
    const open: ActiveHizoFSWorkbenchSource['physicalInspectionSource']['open'] = vi.fn(async () => {
      throw new Error('not opened by this registry test');
    });
    const active: ActiveHizoFSWorkbenchSource = {
      type: 'active_encrypted_store',
      sourceId: 'active',
      label: 'Active encrypted store',
      access: 'read',
      physicalInspectionSource: { open },
    };
    const registry = createHizoFSWorkbenchSourceRegistry({
      activeSources: async () => [active],
      debugWorkspaceAuthority: debugAuthority(),
      nativeOpfsRoot,
    });

    const workspace = await registry.createWorkspace();
    expect(await registry.listSources()).toEqual(expect.arrayContaining([active, workspace]));
    expect((await registry.openWorkspace({ source: workspace })).decryptedRoot.kind).toBe('directory');

    await registry.destroyWorkspace({ source: workspace });
    expect(await registry.listSources()).toEqual([active]);
  });

  it('does not invent an active product source', async () => {
    const registry = createHizoFSWorkbenchSourceRegistry({
      activeSources: async () => [],
      debugWorkspaceAuthority: debugAuthority(),
      nativeOpfsRoot: new MockFileSystemDirectoryHandle({ name: 'opfs-root' }),
    });
    expect(await registry.listSources()).toEqual([]);
  });
});
