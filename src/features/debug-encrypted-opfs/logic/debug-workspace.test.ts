import { afterEach, describe, expect, it } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import { writeStorageFileText } from '@/00-storage/service/storage-file-system/io';
import { createEncryptedOpfs } from '@/00-storage/service/encrypted-opfs';
import {
  createEncryptedOpfsDebugWorkspace,
  destroyEncryptedOpfsDebugWorkspace,
  listEncryptedOpfsDebugWorkspaces,
  openEncryptedOpfsDebugWorkspace,
  TEST_ONLY,
} from './debug-workspace';

const roots: MockFileSystemDirectoryHandle[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    const workspaces = await listEncryptedOpfsDebugWorkspaces({
      nativeOpfsRoot: root,
    });
    for (const workspace of workspaces) {
      await destroyEncryptedOpfsDebugWorkspace({
        workspaceId: workspace.workspaceId,
        nativeOpfsRoot: root,
      });
    }
  }
});

describe('EncryptedOpfs debug workspaces', () => {
  it('creates a read-write EncryptedOpfs with a runtime-only key independently of Naidan encryption', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'opfs-root' });
    roots.push(root);

    const summary = await createEncryptedOpfsDebugWorkspace({ nativeOpfsRoot: root });
    expect(summary).toMatchObject({
      status: 'live',
      fileSystemId: expect.any(String),
      physicalPath: [TEST_ONLY.DEBUG_WORKSPACE_DIRECTORY_NAME, `runtime-${summary.workspaceId}`],
    });

    const session = await openEncryptedOpfsDebugWorkspace({
      workspaceId: summary.workspaceId,
    });
    await writeStorageFileText({
      fileHandle: await session.decryptedRoot.getFileHandle({ name: 'probe.txt', create: true }),
      value: 'EncryptedOpfs probe',
    });
    const overview = await session.encryptedOpfsReader.readOverview();
    expect(overview.descriptor.fileSystemId).toBe(summary.fileSystemId);
    expect(overview.activeCommit.revision).toBeGreaterThan(0);
    await session.dispose();

    expect(await listEncryptedOpfsDebugWorkspaces({ nativeOpfsRoot: root })).toContainEqual(summary);
    await destroyEncryptedOpfsDebugWorkspace({
      workspaceId: summary.workspaceId,
      nativeOpfsRoot: root,
    });
    await expect(openEncryptedOpfsDebugWorkspace({ workspaceId: summary.workspaceId }))
      .rejects.toThrow('is not live');
  });

  it('retains a keyless backing directory as a stale source for raw physical inspection', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'opfs-root' });
    roots.push(root);
    const parent = await root.getDirectoryHandle(TEST_ONLY.DEBUG_WORKSPACE_DIRECTORY_NAME, { create: true });
    const workspaceId = 'stale-test-workspace';
    const backing = await parent.getDirectoryHandle(`runtime-${workspaceId}`, { create: true });
    const session = await createEncryptedOpfs({
      backingDirectory: backing,
      fileSystemRootKey: new Uint8Array(32).fill(91),
    });
    await session.close();

    const workspaces = await listEncryptedOpfsDebugWorkspaces({ nativeOpfsRoot: root });
    expect(workspaces).toContainEqual(expect.objectContaining({
      status: 'stale',
      workspaceId,
      fileSystemId: expect.any(String),
      physicalPath: [TEST_ONLY.DEBUG_WORKSPACE_DIRECTORY_NAME, `runtime-${workspaceId}`],
    }));
  });
});
