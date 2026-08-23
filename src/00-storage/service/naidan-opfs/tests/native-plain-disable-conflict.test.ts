import { describe, expect, it, vi } from 'vitest';
import { fileSystemIdToNaidanContainerToken, NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS } from '@/00-storage/service/naidan-persistence-control/00-format';
import { NativePlainDisableConflictCoordinator, TEST_ONLY } from '@/00-storage/service/naidan-opfs/native-plain-disable-conflict';
import { NAIDAN_OPFS_STORAGE_DIRECTORY_NAME } from '@/00-storage/service/opfs/naidan-opfs-root-directory-registry';
import { TEST_ONLY as RUNTIME_TEST_ONLY } from '@/00-storage/service/naidan-opfs/persistence-runtime-contract';
import { InMemoryOpfsDirectoryHandle } from '@/00-storage/service/test-support/in-memory-opfs';

const FILE_SYSTEM_ID = RUNTIME_TEST_ONLY.createEncryptedInspection({
  fileSystemId: '0123456789_ABCDEFGHIJ',
}).mode.activeFileSystemId;

async function createRoot(): Promise<{
  nativeRoot: FileSystemDirectoryHandle;
  root: InMemoryOpfsDirectoryHandle;
  storage: FileSystemDirectoryHandle;
}> {
  const root = new InMemoryOpfsDirectoryHandle({ capabilityProfile: 'window', name: 'opfs-root' });
  const nativeRoot = root as unknown as FileSystemDirectoryHandle;
  const storage = await nativeRoot.getDirectoryHandle(NAIDAN_OPFS_STORAGE_DIRECTORY_NAME, { create: true });
  await storage.getDirectoryHandle(
    NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS.storage.collectionDirectoryName,
    { create: true },
  );
  await storage.getDirectoryHandle(fileSystemIdToNaidanContainerToken({ id: FILE_SYSTEM_ID }), { create: true });
  await nativeRoot.getDirectoryHandle('models', { create: true });
  await nativeRoot.getDirectoryHandle('naidan-debug-hizofs', { create: true });
  return { nativeRoot, root, storage };
}

describe('native plain disable conflict coordinator', () => {
  it('excludes physical authority, containers, models, and Temporary HizoFS roots', async () => {
    const { nativeRoot } = await createRoot();
    const coordinator = new NativePlainDisableConflictCoordinator();

    await expect(coordinator.inspect({ nativeNamespaceRoot: nativeRoot })).resolves.toEqual({ type: 'clear' });
  });

  it('projects a bounded sanitized conflict and removes only the unchanged exact set', async () => {
    const { nativeRoot, storage } = await createRoot();
    await storage.getFileHandle('settings.json', { create: true });
    await nativeRoot.getDirectoryHandle('naidan-chat-wesh', { create: true });
    const coordinator = new NativePlainDisableConflictCoordinator();

    const conflict = await coordinator.inspect({ nativeNamespaceRoot: nativeRoot });
    expect(conflict).toMatchObject({
      entries: [
        { entryKind: 'directory', relativePath: 'naidan-chat-wesh' },
        { entryKind: 'file', relativePath: 'naidan-storage/settings.json' },
      ],
      totalEntryCount: 2,
      truncated: false,
      type: 'conflict',
    });
    if (conflict.type !== 'conflict') throw new TypeError('expected a native plain conflict');

    await expect(coordinator.cleanupIfUnchanged({
      inspectionId: conflict.inspectionId,
      nativeNamespaceRoot: nativeRoot,
    })).resolves.toEqual({ type: 'clear' });
    await expect(storage.getFileHandle('settings.json', { create: false }))
      .rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(nativeRoot.getDirectoryHandle('naidan-chat-wesh', { create: false }))
      .rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(nativeRoot.getDirectoryHandle('models', { create: false })).resolves.toBeDefined();
    await expect(nativeRoot.getDirectoryHandle('naidan-debug-hizofs', { create: false })).resolves.toBeDefined();
    await expect(storage.getDirectoryHandle(
      NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS.storage.collectionDirectoryName,
      { create: false },
    )).resolves.toBeDefined();
    await expect(storage.getDirectoryHandle(
      fileSystemIdToNaidanContainerToken({ id: FILE_SYSTEM_ID }),
      { create: false },
    )).resolves.toBeDefined();
  });

  it('aborts cleanup and returns a fresh snapshot when the conflict set changes', async () => {
    const { nativeRoot, storage } = await createRoot();
    const conflictDirectory = await storage.getDirectoryHandle('conflict', { create: true });
    await conflictDirectory.getFileHandle('old.bin', { create: true });
    const coordinator = new NativePlainDisableConflictCoordinator();
    const first = await coordinator.inspect({ nativeNamespaceRoot: nativeRoot });
    if (first.type !== 'conflict') throw new TypeError('expected a native plain conflict');
    await conflictDirectory.getFileHandle('new.bin', { create: true });

    const changed = await coordinator.cleanupIfUnchanged({
      inspectionId: first.inspectionId,
      nativeNamespaceRoot: nativeRoot,
    });
    expect(changed).toMatchObject({
      entries: [
        { relativePath: 'naidan-storage/conflict' },
        { relativePath: 'naidan-storage/conflict/new.bin' },
        { relativePath: 'naidan-storage/conflict/old.bin' },
      ],
      totalEntryCount: 3,
      type: 'conflict',
    });
    await expect(conflictDirectory.getFileHandle('old.bin', { create: false })).resolves.toBeDefined();
    await expect(conflictDirectory.getFileHandle('new.bin', { create: false })).resolves.toBeDefined();
  });

  it('reports partial deletion failure and leaves the encrypted-authority artifacts untouched', async () => {
    const { nativeRoot, root, storage } = await createRoot();
    await nativeRoot.getDirectoryHandle('naidan-chat-wesh', { create: true });
    await nativeRoot.getDirectoryHandle('naidan-debug-wesh', { create: true });
    const coordinator = new NativePlainDisableConflictCoordinator();
    const conflict = await coordinator.inspect({ nativeNamespaceRoot: nativeRoot });
    if (conflict.type !== 'conflict') throw new TypeError('expected a native plain conflict');

    const originalRemoveEntry = root.removeEntry.bind(root);
    const removeEntry = vi.spyOn(root, 'removeEntry');
    removeEntry.mockImplementation(async (name, options) => {
      if (name === 'naidan-debug-wesh') throw new DOMException('injected delete failure', 'UnknownError');
      await originalRemoveEntry(name, options);
    });

    await expect(coordinator.cleanupIfUnchanged({
      inspectionId: conflict.inspectionId,
      nativeNamespaceRoot: nativeRoot,
    })).rejects.toThrow('injected delete failure');
    await expect(nativeRoot.getDirectoryHandle('naidan-debug-wesh', { create: false })).resolves.toBeDefined();
    await expect(storage.getDirectoryHandle(
      fileSystemIdToNaidanContainerToken({ id: FILE_SYSTEM_ID }),
      { create: false },
    )).resolves.toBeDefined();
  });

  it('bounds the UI projection without dropping the exact cleanup snapshot', async () => {
    const { nativeRoot, storage } = await createRoot();
    for (let index = 0; index <= TEST_ONLY.MAXIMUM_EXPOSED_CONFLICT_ENTRIES; index += 1) {
      await storage.getFileHandle(`entry-${index.toString().padStart(3, '0')}.bin`, { create: true });
    }
    const coordinator = new NativePlainDisableConflictCoordinator();
    const conflict = await coordinator.inspect({ nativeNamespaceRoot: nativeRoot });
    expect(conflict).toMatchObject({
      totalEntryCount: TEST_ONLY.MAXIMUM_EXPOSED_CONFLICT_ENTRIES + 1,
      truncated: true,
      type: 'conflict',
    });
    if (conflict.type !== 'conflict') throw new TypeError('expected a native plain conflict');
    expect(conflict.entries).toHaveLength(TEST_ONLY.MAXIMUM_EXPOSED_CONFLICT_ENTRIES);
    await expect(coordinator.cleanupIfUnchanged({
      inspectionId: conflict.inspectionId,
      nativeNamespaceRoot: nativeRoot,
    })).resolves.toEqual({ type: 'clear' });
  });
});
