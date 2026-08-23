import { describe, expect, it, vi } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import type { StorageFileSystemSession } from '@/00-storage/service/storage-file-system/types';
import { createInMemoryStorageRoot } from '@/00-storage/service/storage-file-system/test-support/in-memory-storage-file-system';
import type { HizoFSAuthenticatedInspectionSession } from '@/00-storage/service/hizofs/inspection';
import { TEST_ONLY, type HizoFSDebugWorkspaceAuthority } from './debug-workspace';
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
        generateComprehensiveFixture: vi.fn(async () => ({
          coverage: [],
          manifestPath: '/__hizofs_fixture__/manifest.json',
          rootPath: '/__hizofs_fixture__',
        })),
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

  it('deletes an unavailable workspace as stale raw OPFS residue', async () => {
    const nativeOpfsRoot = new MockFileSystemDirectoryHandle({ name: 'opfs-root' });
    const parent = await nativeOpfsRoot.getDirectoryHandle(
      TEST_ONLY.DEBUG_WORKSPACE_DIRECTORY_NAME,
      { create: true },
    );
    const workspaceId = 'stale-workspace';
    const physicalDirectoryName = TEST_ONLY.getPhysicalDirectoryName({ workspaceId });
    await parent.getDirectoryHandle(physicalDirectoryName, { create: true });
    const registry = createHizoFSWorkbenchSourceRegistry({
      activeSources: async () => [],
      debugWorkspaceAuthority: debugAuthority(),
      nativeOpfsRoot,
    });
    const source = (await registry.listSources()).find(candidate => candidate.type === 'stale_debug_workspace');
    if (source?.type !== 'stale_debug_workspace') throw new Error('stale source was not listed');

    await registry.destroyWorkspace({ source });

    await expect(parent.getDirectoryHandle(physicalDirectoryName))
      .rejects.toMatchObject({ name: 'NotFoundError' });
  });
});
