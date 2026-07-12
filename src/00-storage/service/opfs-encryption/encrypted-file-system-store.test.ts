import { describe, expect, it, vi } from 'vitest';
import {
  MockFileSystemDirectoryHandle,
} from '@/utils/in-memory-file-system';
import {
  createEncryptionMaterial,
  deriveEncryptedStoreRuntimeKeys,
} from './encryption-key-manager';
import { EncryptedFileStore } from './encrypted-file-store';
import { EncryptedFileSystemStore } from './encrypted-file-system-store';
import { EncryptedObjectStore } from './encrypted-object-store';
import { acquireEncryptedStorageLock } from './encrypted-storage-lock';

function streamBytes({ bytes }: { bytes: Uint8Array }): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function createFileSystemStoreContext(): Promise<{
  store: EncryptedFileSystemStore,
  fileStore: EncryptedFileStore,
  objectStore: EncryptedObjectStore,
}> {
  const material = await createEncryptionMaterial({
    passphrase: 'test passphrase',
    pbkdf2Iterations: 10,
  });
  const keys = await deriveEncryptedStoreRuntimeKeys({
    storeRootKey: material.storeRootKey,
    encryptedStoreId: 'test-store',
  });
  const objectStore = new EncryptedObjectStore({
    storeDirectory: new MockFileSystemDirectoryHandle({ name: 'test-store' }),
    keys,
    area: 'durable',
  });
  const fileStore = new EncryptedFileStore({ objectStore });
  return {
    fileStore,
    objectStore,
    store: new EncryptedFileSystemStore({
      objectStore,
      fileStore,
    }),
  };
}

async function createFileSystemStore(): Promise<EncryptedFileSystemStore> {
  return (await createFileSystemStoreContext()).store;
}

async function writeJsonObject({
  objectStore,
  locator,
  value,
}: {
  objectStore: EncryptedObjectStore,
  locator: { readonly namespace: string, readonly key: string },
  value: unknown,
}): Promise<void> {
  await objectStore.write({
    locator,
    plaintext: new TextEncoder().encode(JSON.stringify(value)),
  });
}

describe('EncryptedFileSystemStore', () => {
  it('serializes concurrent get-or-create calls for the same filesystem ID', async () => {
    const { store, objectStore, fileStore } = await createFileSystemStoreContext();
    const secondStore = new EncryptedFileSystemStore({ objectStore, fileStore });
    const fileSystemId = `concurrent-file-system-${crypto.randomUUID()}`;

    const [first, second] = await Promise.all([
      store.getOrCreateFileSystem({ fileSystemId, createdAt: 1 }),
      secondStore.getOrCreateFileSystem({ fileSystemId, createdAt: 2 }),
    ]);

    expect(first.rootDirectoryId).toBe(second.rootDirectoryId);
    await expect(store.openFileSystem({ fileSystemId })).resolves.toEqual(first);
  });

  it('waits for active filesystem readers before cleaning up a deleted filesystem', async () => {
    const { store } = await createFileSystemStoreContext();
    const fileSystemId = `delete-file-system-${crypto.randomUUID()}`;
    const { rootDirectoryId } = await store.createFileSystem({
      fileSystemId,
      createdAt: 1,
    });
    await store.createDirectory({
      rootDirectoryId,
      path: '/active',
      recursive: false,
    });
    const readerLease = await acquireEncryptedStorageLock({
      lockName: `naidan/opfs-encryption/file-system/${rootDirectoryId}`,
      mode: 'shared',
    });
    let deletionSettled = false;
    const deletion = store.deleteFileSystem({ fileSystemId }).finally(() => {
      deletionSettled = true;
    });

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(deletionSettled).toBe(false);

    readerLease.release();
    await readerLease.completion;
    await deletion;

    await expect(store.openFileSystem({ fileSystemId })).resolves.toBeUndefined();
    await expect(store.getDirectoryManifest({
      rootDirectoryId,
      directoryId: rootDirectoryId,
    })).rejects.toThrow('Encrypted directory manifest is missing');
  });

  it('stores file and directory names only through encrypted filesystem objects', async () => {
    const store = await createFileSystemStore();
    const { rootDirectoryId } = await store.createFileSystem({
      fileSystemId: `test-file-system-${crypto.randomUUID()}`,
      createdAt: 1,
    });
    const bytes = new TextEncoder().encode('hello encrypted filesystem');

    await store.createDirectory({
      rootDirectoryId,
      path: '/docs/nested',
      recursive: true,
    });
    await store.writeFile({
      rootDirectoryId,
      path: '/docs/nested/readme.txt',
      source: streamBytes({ bytes }),
      size: bytes.byteLength,
      modifiedAt: 123,
      signal: undefined,
    });
    await store.createSymlink({
      rootDirectoryId,
      path: '/docs/readme-link',
      targetPath: 'nested/readme.txt',
      modifiedAt: 456,
    });

    const entries = [];
    const docs = await store.resolve({ rootDirectoryId, path: '/docs' });
    for await (const entry of store.readDirectory({
      rootDirectoryId,
      directoryId: docs.directoryId,
    })) {
      entries.push(entry);
    }
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'directory', name: 'nested' }),
      {
        type: 'symlink',
        name: 'readme-link',
        targetPath: 'nested/readme.txt',
        createdAt: 456,
        modifiedAt: 456,
      },
    ]));

    const handle = await store.openFile({
      rootDirectoryId,
      path: '/docs/nested/readme.txt',
      mimeType: 'text/plain',
    });
    expect(handle).not.toBeNull();
    const target = new Uint8Array(bytes.byteLength);
    const result = await handle!.read({
      buffer: target,
      offset: 0,
      length: target.byteLength,
      position: 0,
      signal: undefined,
    });
    await handle!.close();

    expect(result.bytesRead).toBe(bytes.byteLength);
    expect(new TextDecoder().decode(target)).toBe('hello encrypted filesystem');
  });

  it('follows intermediate directory symlinks and rejects symlink loops', async () => {
    const store = await createFileSystemStore();
    const { rootDirectoryId } = await store.createFileSystem({
      fileSystemId: `test-file-system-${crypto.randomUUID()}`,
      createdAt: 1,
    });
    await store.createDirectory({
      rootDirectoryId,
      path: '/real/nested',
      recursive: true,
    });
    await store.createSymlink({
      rootDirectoryId,
      path: '/alias',
      targetPath: '/real',
      modifiedAt: 2,
    });
    const bytes = new TextEncoder().encode('through a directory symlink');

    const fileId = await store.writeFile({
      rootDirectoryId,
      path: '/alias/nested/data.txt',
      source: streamBytes({ bytes }),
      size: bytes.byteLength,
      modifiedAt: 3,
      signal: undefined,
    });

    await expect(store.resolve({
      rootDirectoryId,
      path: '/real/nested/data.txt',
    })).resolves.toMatchObject({
      entry: { type: 'file', fileId },
    });
    await expect(store.resolve({
      rootDirectoryId,
      path: '/alias/nested/data.txt',
    })).resolves.toMatchObject({
      entry: { type: 'file', fileId },
    });

    await store.createSymlink({
      rootDirectoryId,
      path: '/loop-a',
      targetPath: '/loop-b',
      modifiedAt: 4,
    });
    await store.createSymlink({
      rootDirectoryId,
      path: '/loop-b',
      targetPath: '/loop-a',
      modifiedAt: 5,
    });

    await expect(store.createFile({
      rootDirectoryId,
      path: '/loop-a/unreachable.txt',
      overwrite: false,
      modifiedAt: 6,
    })).rejects.toThrow('Too many symbolic links');
  });

  it('renames entries without rewriting their file payload identity', async () => {
    const store = await createFileSystemStore();
    const { rootDirectoryId } = await store.createFileSystem({
      fileSystemId: `test-file-system-${crypto.randomUUID()}`,
      createdAt: 1,
    });
    await store.createDirectory({
      rootDirectoryId,
      path: '/from',
      recursive: false,
    });
    await store.createDirectory({
      rootDirectoryId,
      path: '/to',
      recursive: false,
    });
    const originalFileId = await store.createFile({
      rootDirectoryId,
      path: '/from/data.bin',
      overwrite: false,
      modifiedAt: 1,
    });

    await store.rename({
      rootDirectoryId,
      oldPath: '/from/data.bin',
      newPath: '/to/renamed.bin',
    });

    await expect(store.tryResolve({
      rootDirectoryId,
      path: '/from/data.bin',
    })).resolves.toBeUndefined();
    await expect(store.resolve({
      rootDirectoryId,
      path: '/to/renamed.bin',
    })).resolves.toMatchObject({
      entry: {
        type: 'file',
        name: 'renamed.bin',
        fileId: originalFileId,
      },
    });
  });

  it('recovers an interrupted cross-directory rename before exposing the filesystem', async () => {
    const { store, objectStore } = await createFileSystemStoreContext();
    const { rootDirectoryId } = await store.createFileSystem({
      fileSystemId: `test-file-system-${crypto.randomUUID()}`,
      createdAt: 1,
    });
    await store.createDirectory({
      rootDirectoryId,
      path: '/from',
      recursive: false,
    });
    await store.createDirectory({
      rootDirectoryId,
      path: '/to',
      recursive: false,
    });
    const fileId = await store.createFile({
      rootDirectoryId,
      path: '/from/before.bin',
      overwrite: false,
      modifiedAt: 1,
    });

    const originalWrite = objectStore.write.bind(objectStore);
    let journalPersisted = false;
    let committedDirectoryWrites = 0;
    const writeSpy = vi.spyOn(objectStore, 'write').mockImplementation(async (args) => {
      if (args.locator.namespace === 'object_transaction_journal') {
        journalPersisted = true;
      } else if (journalPersisted && args.locator.namespace === 'directory_manifest') {
        committedDirectoryWrites += 1;
        if (committedDirectoryWrites === 2) {
          throw new Error('injected rename interruption');
        }
      }
      await originalWrite(args);
    });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(store.rename({
      rootDirectoryId,
      oldPath: '/from/before.bin',
      newPath: '/to/after.bin',
    })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      'Encrypted object mutation is committed and pending recovery',
      expect.objectContaining({ message: 'injected rename interruption' }),
    );
    writeSpy.mockRestore();

    await expect(store.tryResolve({
      rootDirectoryId,
      path: '/from/before.bin',
    })).resolves.toBeUndefined();
    await expect(store.resolve({
      rootDirectoryId,
      path: '/to/after.bin',
    })).resolves.toMatchObject({
      entry: { type: 'file', fileId },
    });
    await expect(objectStore.read({
      locator: {
        namespace: 'object_transaction_journal',
        key: `file-system/${rootDirectoryId}`,
      },
    })).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it('refuses to move a directory into one of its descendants', async () => {
    const store = await createFileSystemStore();
    const { rootDirectoryId } = await store.createFileSystem({
      fileSystemId: `test-file-system-${crypto.randomUUID()}`,
      createdAt: 1,
    });
    await store.createDirectory({
      rootDirectoryId,
      path: '/parent/child',
      recursive: true,
    });

    await expect(store.rename({
      rootDirectoryId,
      oldPath: '/parent',
      newPath: '/parent/child/moved',
    })).rejects.toThrow('cannot be moved into itself');

    await store.createSymlink({
      rootDirectoryId,
      path: '/child-alias',
      targetPath: '/parent/child',
      modifiedAt: 2,
    });
    await expect(store.rename({
      rootDirectoryId,
      oldPath: '/parent',
      newPath: '/child-alias/moved',
    })).rejects.toThrow('cannot be moved into itself');
  });

  it('rejects a filesystem descriptor with an invalid root identity', async () => {
    const { store, objectStore } = await createFileSystemStoreContext();
    const fileSystemId = `invalid-descriptor-${crypto.randomUUID()}`;
    await writeJsonObject({
      objectStore,
      locator: { namespace: 'file_system_descriptor', key: fileSystemId },
      value: {
        id: fileSystemId,
        rootDirectoryId: '',
        createdAt: 1,
      },
    });

    await expect(store.openFileSystem({ fileSystemId })).rejects.toThrow(
      'descriptor contains an empty identity',
    );
  });

  it('rejects a directory manifest whose logical ID does not match its address', async () => {
    const { store, objectStore } = await createFileSystemStoreContext();
    const { rootDirectoryId } = await store.createFileSystem({
      fileSystemId: `test-file-system-${crypto.randomUUID()}`,
      createdAt: 1,
    });
    await writeJsonObject({
      objectStore,
      locator: { namespace: 'directory_manifest', key: rootDirectoryId },
      value: {
        directoryId: 'different-directory-id',
        revision: 0,
        createdAt: 1,
        modifiedAt: 1,
        shards: [],
      },
    });

    await expect(async () => {
      for await (const _entry of store.readDirectory({
        rootDirectoryId,
        directoryId: rootDirectoryId,
      })) {
        // The manifest must be rejected before entries can be yielded.
      }
    }).rejects.toThrow('manifest ID mismatch');
  });

  it('rejects a directory manifest that references a missing shard', async () => {
    const { store, objectStore } = await createFileSystemStoreContext();
    const { rootDirectoryId } = await store.createFileSystem({
      fileSystemId: `test-file-system-${crypto.randomUUID()}`,
      createdAt: 1,
    });
    await writeJsonObject({
      objectStore,
      locator: { namespace: 'directory_manifest', key: rootDirectoryId },
      value: {
        directoryId: rootDirectoryId,
        revision: 1,
        createdAt: 1,
        modifiedAt: 1,
        shards: [{ shardId: 'aa', objectId: 'missing-shard-object' }],
      },
    });

    await expect(async () => {
      for await (const _entry of store.readDirectory({
        rootDirectoryId,
        directoryId: rootDirectoryId,
      })) {
        // A listed shard is part of the authenticated logical directory.
      }
    }).rejects.toThrow('directory shard is missing');
  });

  it('rejects a directory entry stored under the wrong HMAC-derived address', async () => {
    const { store, objectStore } = await createFileSystemStoreContext();
    const { rootDirectoryId } = await store.createFileSystem({
      fileSystemId: `test-file-system-${crypto.randomUUID()}`,
      createdAt: 1,
    });
    const fileId = await store.createFile({
      rootDirectoryId,
      path: '/payload.bin',
      overwrite: false,
      modifiedAt: 1,
    });
    const expectedAddress = await objectStore.getObjectAddress({
      locator: {
        namespace: 'directory_entry',
        key: `${rootDirectoryId}\0payload.bin`,
      },
    });
    const manifest = await store.getDirectoryManifest({
      rootDirectoryId,
      directoryId: rootDirectoryId,
    });
    const shard = manifest.shards.find(candidate => candidate.shardId === expectedAddress.shardId);
    if (shard === undefined) {
      throw new Error('Expected directory shard');
    }
    const wrongOpaqueId = `${expectedAddress.objectId.slice(0, -1)}x`;
    await writeJsonObject({
      objectStore,
      locator: { namespace: 'directory_shard', key: shard.objectId },
      value: {
        objectId: shard.objectId,
        directoryId: rootDirectoryId,
        shardId: shard.shardId,
        entries: {
          [wrongOpaqueId]: {
            type: 'file',
            name: 'payload.bin',
            fileId,
          },
        },
      },
    });

    await expect(async () => {
      for await (const _entry of store.readDirectory({
        rootDirectoryId,
        directoryId: rootDirectoryId,
      })) {
        // Entry addresses must be reproducible from the encrypted name.
      }
    }).rejects.toThrow('entry address mismatch');
  });

  it('removes the reachable entry before file payload cleanup', async () => {
    const { store, fileStore } = await createFileSystemStoreContext();
    const { rootDirectoryId } = await store.createFileSystem({
      fileSystemId: `test-file-system-${crypto.randomUUID()}`,
      createdAt: 1,
    });
    await store.writeFile({
      rootDirectoryId,
      path: '/payload.bin',
      source: streamBytes({ bytes: new TextEncoder().encode('payload') }),
      size: 7,
      modifiedAt: 1,
      signal: undefined,
    });
    const cleanupError = new Error('cleanup failed');
    vi.spyOn(fileStore, 'delete').mockRejectedValueOnce(cleanupError);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(store.remove({
      rootDirectoryId,
      path: '/payload.bin',
      recursive: false,
    })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      'Encrypted object mutation cleanup failed',
      cleanupError,
    );
    warn.mockRestore();

    await expect(store.resolve({
      rootDirectoryId,
      path: '/payload.bin',
    })).rejects.toThrow('Encrypted filesystem path not found');
  });

  it('refuses to remove a non-empty directory unless recursive removal is requested', async () => {
    const store = await createFileSystemStore();
    const { rootDirectoryId } = await store.createFileSystem({
      fileSystemId: `test-file-system-${crypto.randomUUID()}`,
      createdAt: 1,
    });
    await store.createDirectory({
      rootDirectoryId,
      path: '/parent',
      recursive: false,
    });
    await store.createFile({
      rootDirectoryId,
      path: '/parent/child',
      overwrite: false,
      modifiedAt: 1,
    });

    await expect(store.remove({
      rootDirectoryId,
      path: '/parent',
      recursive: false,
    })).rejects.toThrow('directory is not empty');

    await store.remove({
      rootDirectoryId,
      path: '/parent',
      recursive: true,
    });
    await expect(store.tryResolve({
      rootDirectoryId,
      path: '/parent',
    })).resolves.toBeUndefined();
  });
});
