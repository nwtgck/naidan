import { describe, expect, it } from 'vitest';
import {
  fileSystemIdToNaidanContainerToken,
  NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS,
} from '@/00-storage/service/naidan-persistence-control/00-format';
import {
  cleanupNativePlainApplicationNamespace,
  createNativePlainApplicationNamespaceSession,
  listNativePlainApplicationNamespaceEntryNames,
} from '@/00-storage/service/naidan-opfs/native-plain-application-namespace';
import {
  NAIDAN_OPFS_CONTAINER_ROOT_DIRECTORY_NAMES,
  NAIDAN_OPFS_SPECIAL_FILE_SYSTEM_DIRECTORY_NAMES,
} from '@/00-storage/service/opfs/naidan-opfs-root-directory-registry';
import { NAIDAN_OPFS_STORAGE_DIRECTORY_NAME } from '@/00-storage/service/naidan-opfs/opfs-storage-location';
import { TEST_ONLY as PERSISTENCE_RUNTIME_TEST_ONLY } from '@/00-storage/service/naidan-opfs/persistence-runtime-contract';
import type { StorageDirectoryHandle } from '@/00-storage/service/storage-file-system/types';
import { InMemoryOpfsDirectoryHandle } from '@/00-storage/service/test-support/in-memory-opfs';

const FILE_SYSTEM_ID = PERSISTENCE_RUNTIME_TEST_ONLY.createEncryptedInspection({
  fileSystemId: '0123456789_ABCDEFGHIJ',
}).mode.activeFileSystemId;

async function writeNativeFile({ bytes, directory, name }: {
  bytes: Uint8Array<ArrayBuffer>;
  directory: FileSystemDirectoryHandle;
  name: string;
}): Promise<void> {
  const writable = await (await directory.getFileHandle(name, { create: true })).createWritable();
  await writable.write(bytes);
  await writable.close();
}

async function listStorageEntryNames({ directory }: {
  directory: StorageDirectoryHandle;
}): Promise<readonly string[]> {
  const names: string[] = [];
  for await (const [name] of directory.entries()) names.push(name);
  return names.toSorted();
}

describe('native plain application namespace', () => {
  it('projects a stable empty managed-root shape without creating raw directories', async () => {
    const root = new InMemoryOpfsDirectoryHandle({
      capabilityProfile: 'window',
      name: 'opfs-root',
    });
    const nativeRoot = root as unknown as FileSystemDirectoryHandle;
    const session = createNativePlainApplicationNamespaceSession({ nativeNamespaceRoot: nativeRoot });
    const rootNames: string[] = [];
    for await (const [name] of session.root.entries()) rootNames.push(name);
    expect(rootNames).toEqual(NAIDAN_OPFS_CONTAINER_ROOT_DIRECTORY_NAMES);
    await session.close();

    for (const name of NAIDAN_OPFS_CONTAINER_ROOT_DIRECTORY_NAMES) {
      await expect(nativeRoot.getDirectoryHandle(name, { create: false }))
        .rejects.toMatchObject({ name: 'NotFoundError' });
    }
  });

  it('projects and cleans all managed roots while retaining physical and unrelated entries', async () => {
    const root = new InMemoryOpfsDirectoryHandle({
      capabilityProfile: 'window',
      name: 'opfs-root',
    });
    const nativeRoot = root as unknown as FileSystemDirectoryHandle;
    const storage = await nativeRoot.getDirectoryHandle(NAIDAN_OPFS_STORAGE_DIRECTORY_NAME, { create: true });
    const containerName = fileSystemIdToNaidanContainerToken({ id: FILE_SYSTEM_ID });
    await writeNativeFile({ bytes: Uint8Array.of(1, 2, 3), directory: storage, name: 'settings.json' });
    await storage.getDirectoryHandle(
      NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS.storage.collectionDirectoryName,
      { create: true },
    );
    await storage.getDirectoryHandle(containerName, { create: true });

    for (const [index, name] of NAIDAN_OPFS_SPECIAL_FILE_SYSTEM_DIRECTORY_NAMES.entries()) {
      const directory = await nativeRoot.getDirectoryHandle(name, { create: true });
      await writeNativeFile({ bytes: Uint8Array.of(index + 10), directory, name: 'value.bin' });
    }
    const models = await nativeRoot.getDirectoryHandle('models', { create: true });
    await writeNativeFile({ bytes: Uint8Array.of(99), directory: models, name: 'cache.bin' });

    const session = createNativePlainApplicationNamespaceSession({ nativeNamespaceRoot: nativeRoot });
    const rootNames: string[] = [];
    for await (const [name] of session.root.entries()) rootNames.push(name);
    expect(rootNames).toEqual(NAIDAN_OPFS_CONTAINER_ROOT_DIRECTORY_NAMES);

    const projectedStorage = await session.root.getDirectoryHandle({
      create: false,
      name: NAIDAN_OPFS_STORAGE_DIRECTORY_NAME,
    });
    await expect(listStorageEntryNames({ directory: projectedStorage })).resolves.toEqual(['settings.json']);
    await expect(session.root.getDirectoryHandle({ create: false, name: 'models' }))
      .rejects.toMatchObject({ name: 'NotFoundError' });
    await session.close();

    await expect(listNativePlainApplicationNamespaceEntryNames({ nativeNamespaceRoot: nativeRoot }))
      .resolves.toEqual([
        'naidan-chat-wesh',
        'naidan-debug-wesh',
        'naidan-tmp',
        'settings.json',
      ]);

    await cleanupNativePlainApplicationNamespace({ nativeNamespaceRoot: nativeRoot });

    await expect(listNativePlainApplicationNamespaceEntryNames({ nativeNamespaceRoot: nativeRoot }))
      .resolves.toEqual([]);
    for (const name of NAIDAN_OPFS_SPECIAL_FILE_SYSTEM_DIRECTORY_NAMES) {
      await expect(nativeRoot.getDirectoryHandle(name, { create: false }))
        .rejects.toMatchObject({ name: 'NotFoundError' });
    }
    await expect(storage.getDirectoryHandle(
      NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS.storage.collectionDirectoryName,
      { create: false },
    )).resolves.toBeDefined();
    await expect(storage.getDirectoryHandle(containerName, { create: false })).resolves.toBeDefined();
    await expect(nativeRoot.getDirectoryHandle('models', { create: false })).resolves.toBeDefined();
  });
});
