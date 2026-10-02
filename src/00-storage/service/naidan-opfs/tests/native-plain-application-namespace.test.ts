import { describe, expect, it, vi } from 'vitest';
import {
  fileSystemIdToNaidanContainerToken,
  NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS,
} from '@/00-storage/service/naidan-persistence-control/00-format';
import {
  cleanupNativePlainApplicationNamespace,
  createNativePlainApplicationNamespaceSession,
  listNativePlainApplicationNamespaceEntryNames,
  projectCanonicalNaidanApplicationNamespaceSession,
  TEST_ONLY,
} from '@/00-storage/service/naidan-opfs/native-plain-application-namespace';
import {
  NAIDAN_OPFS_CONTAINER_ROOT_DIRECTORY_NAMES,
  NAIDAN_OPFS_SPECIAL_FILE_SYSTEM_DIRECTORY_NAMES,
} from '@/00-storage/service/opfs/naidan-opfs-root-directory-registry';
import { NAIDAN_OPFS_STORAGE_DIRECTORY_NAME } from '@/00-storage/service/naidan-opfs/opfs-storage-location';
import { TEST_ONLY as PERSISTENCE_RUNTIME_TEST_ONLY } from '@/00-storage/service/naidan-opfs/persistence-runtime-contract';
import type { StorageDirectoryHandle, StorageEntryHandle, StorageFileSystemSession } from '@/00-storage/service/storage-file-system/types';
import { createInMemoryStorageRoot } from '@/00-storage/service/storage-file-system/test-support/in-memory-storage-file-system';
import { compareTransitionNamespaceEntryNameBytes } from '@/00-storage/service/naidan-persistence-control/transition/namespace-contracts';
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
  it('merges bounded raw pages with only missing managed roots and preserves real entry kinds', async () => {
    const root = createInMemoryStorageRoot({ name: 'root' });
    await root.getFileHandle({ create: true, name: 'naidan-storage' });
    await root.createSymlink({ name: 'naidan-tmp', target: 'somewhere' });
    await root.getDirectoryHandle({ create: true, name: 'extra-directory' });
    for (const name of ['a', '\uFF21', '\u{10400}']) await root.getFileHandle({ create: true, name });
    const raw: Array<readonly [string, StorageEntryHandle]> = [];
    for await (const entry of root.entries()) raw.push(entry);
    const bytes = (name: string) => new TextEncoder().encode(name);
    const compare = (left: string, right: string) => compareTransitionNamespaceEntryNameBytes({ left: bytes(left), right: bytes(right) });
    raw.sort(([left], [right]) => compare(left, right));
    const rawPage = vi.fn<NonNullable<StorageDirectoryHandle['listEntriesPage']>>(async ({ afterName, maximumEntries }) => {
      const remaining = raw.filter(([name]) => afterName === undefined || compare(name, afterName) > 0);
      return { entries: remaining.slice(0, maximumEntries), truncated: remaining.length > maximumEntries };
    });
    root.listEntriesPage = rawPage;
    const enumerate = vi.spyOn(root, 'entries');
    const lookup = vi.spyOn(root, 'getEntryHandle');
    const stat = vi.spyOn(root, 'stat');
    const close = vi.fn(async () => undefined);
    const session: StorageFileSystemSession = {
      capabilities: { atomicMove: 'supported', directBlob: 'unsupported', symbolicLink: 'supported', wholeFileClone: 'supported' },
      root, close, sync: async () => undefined,
    };
    const projected = projectCanonicalNaidanApplicationNamespaceSession({ session });
    expect(rawPage).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    const expected = [...new Set([...raw.map(([name]) => name), ...NAIDAN_OPFS_CONTAINER_ROOT_DIRECTORY_NAMES])].sort(compare);
    const received: string[] = [];
    let afterName: string | undefined;
    for (;;) {
      const callsBefore = lookup.mock.calls.length;
      const page = await projected.root.listEntriesPage!({ afterName, maximumEntries: 2 });
      expect(page.entries.length).toBeLessThanOrEqual(2);
      expect(lookup.mock.calls.length - callsBefore).toBeLessThanOrEqual(NAIDAN_OPFS_CONTAINER_ROOT_DIRECTORY_NAMES.length);
      received.push(...page.entries.map(([name]) => name));
      if (!page.truncated) break;
      afterName = page.entries.at(-1)![0];
    }
    expect(received).toEqual(expected);
    const arbitrary = await projected.root.listEntriesPage!({ afterName: 'naidan-chat', maximumEntries: 3 });
    expect(arbitrary.entries.map(([name]) => name)).toEqual(expected.filter(name => compare(name, 'naidan-chat') > 0).slice(0, 3));
    await expect(projected.root.getEntryHandle({ name: 'naidan-storage' })).resolves.toMatchObject({ kind: 'file' });
    await expect(projected.root.getEntryHandle({ name: 'naidan-tmp' })).resolves.toMatchObject({ kind: 'symlink' });
    const virtual = await projected.root.getDirectoryHandle({ create: false, name: 'naidan-chat-wesh' });
    await expect(virtual.listEntriesPage!({ afterName: undefined, maximumEntries: 1 })).resolves.toEqual({ entries: [], truncated: false });
    await expect(virtual.stat()).resolves.toMatchObject({ size: 0 });
    expect(stat).not.toHaveBeenCalled();
    expect(enumerate).not.toHaveBeenCalled();
    const filtered = TEST_ONLY.projectDirectory({ assertOpen: undefined, directory: root, filterDirectChild: ({ name }) => name !== 'a' });
    expect(filtered.listEntriesPage).toBeUndefined();
    await projected.close();
    expect(close).toHaveBeenCalledOnce();
    await expect(virtual.stat()).rejects.toThrow('closed');
    await expect(listStorageEntryNames({ directory: virtual })).rejects.toThrow('closed');
    await expect(virtual.listEntriesPage!({ afterName: undefined, maximumEntries: 1 })).rejects.toThrow('closed');
    await expect(virtual.getEntryHandle({ name: 'missing' })).rejects.toThrow('closed');
    await expect(projected.root.listEntriesPage!({ afterName: undefined, maximumEntries: 1 })).rejects.toThrow('closed');
  });

  it.each([new Error('root lookup failed'), undefined])('does not turn a failed managed-root lookup into a virtual entry: %s', async cause => {
    const root = createInMemoryStorageRoot({ name: 'root' });
    root.listEntriesPage = async () => ({ entries: [], truncated: false });
    vi.spyOn(root, 'getEntryHandle').mockRejectedValue(cause);
    const projected = projectCanonicalNaidanApplicationNamespaceSession({ session: {
      capabilities: { atomicMove: 'supported', directBlob: 'unsupported', symbolicLink: 'supported', wholeFileClone: 'supported' },
      close: async () => undefined, root, sync: async () => undefined,
    } });
    await expect(projected.root.listEntriesPage!({ afterName: undefined, maximumEntries: 2 })).rejects.toBe(cause);
    await projected.close();
  });

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

  it('forwards filesystem sync to the unqualified native OPFS boundary', async () => {
    const root = new InMemoryOpfsDirectoryHandle({ capabilityProfile: 'worker', name: 'root' });
    const session = createNativePlainApplicationNamespaceSession({
      nativeNamespaceRoot: root as unknown as FileSystemDirectoryHandle,
    });

    await expect(session.sync()).rejects.toMatchObject({
      code: 'durability_not_demonstrated',
      implementation: 'native_opfs',
      retryable: false,
    });
    await session.close();
  });
});
