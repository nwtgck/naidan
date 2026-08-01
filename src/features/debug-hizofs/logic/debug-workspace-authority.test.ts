import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import { writeStorageFileText } from '@/00-storage/service/storage-file-system/io';
import type { StorageFileSystemSession } from '@/00-storage/service/storage-file-system/types';
import {
  createHizoFSDebugWorkspace,
  destroyHizoFSDebugWorkspace,
  listHizoFSDebugWorkspaces,
  openHizoFSDebugWorkspace,
  TEST_ONLY,
  type HizoFSDebugWorkspaceAuthority,
} from './debug-workspace';
import { createInMemoryStorageRoot } from '@/00-storage/service/storage-file-system/test-support/in-memory-storage-file-system';

const roots: MockFileSystemDirectoryHandle[] = [];

function authority(): {
  readonly authority: HizoFSDebugWorkspaceAuthority;
  readonly close: ReturnType<typeof vi.fn>;
  } {
  const close = vi.fn(async () => undefined);
  return {
    close,
    authority: {
      async create() {
        const fileSystemSession: StorageFileSystemSession = {
          root: createInMemoryStorageRoot({ name: 'decrypted-root' }),
          capabilities: {
            atomicMove: 'supported',
            directBlob: 'supported',
            symbolicLink: 'supported',
            wholeFileClone: 'supported',
          },
          close,
        };
        return { fileSystemId: 'debug-file-system', fileSystemSession };
      },
    },
  };
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    const workspaces = await listHizoFSDebugWorkspaces({ nativeOpfsRoot: root });
    for (const workspace of workspaces) {
      await destroyHizoFSDebugWorkspace({
        workspaceId: workspace.workspaceId,
        nativeOpfsRoot: root,
      });
    }
  }
});

describe('HizoFS debug workspaces', () => {
  it('uses an injected creation authority and keeps the root key inside the lifecycle adapter', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'opfs-root' });
    roots.push(root);
    const configured = authority();

    const summary = await createHizoFSDebugWorkspace({
      authority: configured.authority,
      nativeOpfsRoot: root,
    });
    expect(summary).toMatchObject({
      status: 'live',
      fileSystemId: 'debug-file-system',
      physicalPath: [
        TEST_ONLY.DEBUG_WORKSPACE_DIRECTORY_NAME,
        TEST_ONLY.getPhysicalDirectoryName({ workspaceId: summary.workspaceId }),
      ],
    });

    const session = await openHizoFSDebugWorkspace({ workspaceId: summary.workspaceId });
    await writeStorageFileText({
      fileHandle: await session.decryptedRoot.getFileHandle({ name: 'probe.txt', create: true }),
      value: 'HizoFS probe',
    });
    await session.dispose();

    expect(await listHizoFSDebugWorkspaces({ nativeOpfsRoot: root })).toContainEqual(summary);
    await destroyHizoFSDebugWorkspace({ workspaceId: summary.workspaceId, nativeOpfsRoot: root });
    expect(configured.close).toHaveBeenCalledOnce();
    await expect(openHizoFSDebugWorkspace({ workspaceId: summary.workspaceId }))
      .rejects.toThrow('is not live');
  });

  it('removes a failed creation directory and does not publish a live workspace', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'opfs-root' });
    roots.push(root);
    const failing: HizoFSDebugWorkspaceAuthority = {
      async create() {
        throw new Error('creation failed');
      },
    };

    await expect(createHizoFSDebugWorkspace({ authority: failing, nativeOpfsRoot: root }))
      .rejects.toThrow('creation failed');
    expect(await listHizoFSDebugWorkspaces({ nativeOpfsRoot: root })).toEqual([]);
  });

  it('discovers and removes keyless physical directories as stale workspaces', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'opfs-root' });
    roots.push(root);
    const parent = await root.getDirectoryHandle(
      TEST_ONLY.DEBUG_WORKSPACE_DIRECTORY_NAME,
      { create: true },
    );
    const cases = [
      { workspaceId: 'stale-without-suffix', physicalDirectoryName: 'runtime-stale-without-suffix' },
      { workspaceId: 'stale-other-suffix', physicalDirectoryName: 'runtime-stale-other-suffix.anything' },
    ] as const;
    for (const testCase of cases) {
      await parent.getDirectoryHandle(testCase.physicalDirectoryName, { create: true });
    }

    const workspaces = await listHizoFSDebugWorkspaces({ nativeOpfsRoot: root });
    for (const testCase of cases) {
      expect(workspaces).toContainEqual(expect.objectContaining({
        status: 'stale',
        workspaceId: testCase.workspaceId,
        fileSystemId: undefined,
      }));
      await destroyHizoFSDebugWorkspace({
        workspaceId: testCase.workspaceId,
        nativeOpfsRoot: root,
      });
      await expect(parent.getDirectoryHandle(testCase.physicalDirectoryName))
        .rejects.toMatchObject({ name: 'NotFoundError' });
    }
  });
});
