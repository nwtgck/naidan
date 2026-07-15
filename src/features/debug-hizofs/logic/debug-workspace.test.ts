import { afterEach, describe, expect, it } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import { writeStorageFileText } from '@/00-storage/service/storage-file-system/io';
import { createHizoFS } from '@/00-storage/service/hizofs';
import {
  createHizoFSDebugWorkspace,
  destroyHizoFSDebugWorkspace,
  listHizoFSDebugWorkspaces,
  openHizoFSDebugWorkspace,
  TEST_ONLY,
} from './debug-workspace';

const roots: MockFileSystemDirectoryHandle[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    const workspaces = await listHizoFSDebugWorkspaces({
      nativeOpfsRoot: root,
    });
    for (const workspace of workspaces) {
      await destroyHizoFSDebugWorkspace({
        workspaceId: workspace.workspaceId,
        nativeOpfsRoot: root,
      });
    }
  }
});

describe('HizoFS debug workspaces', () => {
  it('creates a read-write HizoFS with a runtime-only key independently of Naidan encryption', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'opfs-root' });
    roots.push(root);

    const summary = await createHizoFSDebugWorkspace({ nativeOpfsRoot: root });
    expect(summary).toMatchObject({
      status: 'live',
      fileSystemId: expect.any(String),
      physicalPath: [TEST_ONLY.DEBUG_WORKSPACE_DIRECTORY_NAME, TEST_ONLY.getPhysicalDirectoryName({ workspaceId: summary.workspaceId })],
    });

    const session = await openHizoFSDebugWorkspace({
      workspaceId: summary.workspaceId,
    });
    await writeStorageFileText({
      fileHandle: await session.decryptedRoot.getFileHandle({ name: 'probe.txt', create: true }),
      value: 'HizoFS probe',
    });
    const overview = await session.hizoFSReader.readOverview();
    expect(overview.fileSystemId).toBe(summary.fileSystemId);
    expect(overview.activeCommit.revision).toBeGreaterThan(0);
    await session.dispose();

    expect(await listHizoFSDebugWorkspaces({ nativeOpfsRoot: root })).toContainEqual(summary);
    await destroyHizoFSDebugWorkspace({
      workspaceId: summary.workspaceId,
      nativeOpfsRoot: root,
    });
    await expect(openHizoFSDebugWorkspace({ workspaceId: summary.workspaceId }))
      .rejects.toThrow('is not live');
  });

  it('retains a keyless backing directory as a stale source for raw physical inspection', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'opfs-root' });
    roots.push(root);
    const parent = await root.getDirectoryHandle(TEST_ONLY.DEBUG_WORKSPACE_DIRECTORY_NAME, { create: true });
    const workspaceId = 'stale-test-workspace';
    const backing = await parent.getDirectoryHandle(TEST_ONLY.getPhysicalDirectoryName({ workspaceId }), { create: true });
    const session = await createHizoFS({
      backingDirectory: backing,
      fileSystemRootKey: new Uint8Array(32).fill(91),
    });
    await session.close();

    const workspaces = await listHizoFSDebugWorkspaces({ nativeOpfsRoot: root });
    expect(workspaces).toContainEqual(expect.objectContaining({
      status: 'stale',
      workspaceId,
      fileSystemId: undefined,
      physicalPath: [TEST_ONLY.DEBUG_WORKSPACE_DIRECTORY_NAME, TEST_ONLY.getPhysicalDirectoryName({ workspaceId })],
    }));
  });

  it('discovers and removes stale workspaces after their canonical suffix changes', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'opfs-root' });
    roots.push(root);
    const parent = await root.getDirectoryHandle(
      TEST_ONLY.DEBUG_WORKSPACE_DIRECTORY_NAME,
      { create: true },
    );
    const cases = [
      {
        workspaceId: 'stale-without-suffix',
        physicalDirectoryName: 'runtime-stale-without-suffix',
      },
      {
        workspaceId: 'stale-other-suffix',
        physicalDirectoryName: 'runtime-stale-other-suffix.anything',
      },
    ] as const;

    for (const [index, testCase] of cases.entries()) {
      const backing = await parent.getDirectoryHandle(testCase.physicalDirectoryName, {
        create: true,
      });
      const session = await createHizoFS({
        backingDirectory: backing,
        fileSystemRootKey: new Uint8Array(32).fill(100 + index),
      });
      await session.close();
    }

    const workspaces = await listHizoFSDebugWorkspaces({ nativeOpfsRoot: root });
    for (const testCase of cases) {
      expect(workspaces).toContainEqual(expect.objectContaining({
        status: 'stale',
        workspaceId: testCase.workspaceId,
        fileSystemId: undefined,
        physicalPath: [
          TEST_ONLY.DEBUG_WORKSPACE_DIRECTORY_NAME,
          testCase.physicalDirectoryName,
        ],
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
