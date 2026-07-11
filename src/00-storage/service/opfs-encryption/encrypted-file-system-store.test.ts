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
  it('stores file and directory names only through encrypted filesystem objects', async () => {
    const store = await createFileSystemStore();
    const rootDirectoryId = await store.createFileSystem();
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
      logicalSize: bytes.byteLength,
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

  it('renames entries without rewriting their file payload identity', async () => {
    const store = await createFileSystemStore();
    const rootDirectoryId = await store.createFileSystem();
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

  it('completes an interrupted rename when the destination already points to the same entry', async () => {
    const store = await createFileSystemStore();
    const rootDirectoryId = await store.createFileSystem();
    const fileId = await store.createFile({
      rootDirectoryId,
      path: '/before.bin',
      overwrite: false,
      modifiedAt: 1,
    });
    await (
      store as unknown as {
        setEntry({
          directoryId,
          entry,
        }: {
          directoryId: string,
          entry: {
            type: 'file',
            name: string,
            fileId: string,
          },
        }): Promise<void>,
      }
    ).setEntry({
      directoryId: rootDirectoryId,
      entry: { type: 'file', name: 'after.bin', fileId },
    });

    await store.rename({
      rootDirectoryId,
      oldPath: '/before.bin',
      newPath: '/after.bin',
    });

    await expect(store.tryResolve({
      rootDirectoryId,
      path: '/before.bin',
    })).resolves.toBeUndefined();
    await expect(store.resolve({
      rootDirectoryId,
      path: '/after.bin',
    })).resolves.toMatchObject({
      entry: { type: 'file', fileId },
    });
  });

  it('refuses to move a directory into one of its descendants', async () => {
    const store = await createFileSystemStore();
    const rootDirectoryId = await store.createFileSystem();
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
  });

  it('rejects a directory manifest whose logical ID does not match its address', async () => {
    const { store, objectStore } = await createFileSystemStoreContext();
    const rootDirectoryId = await store.createFileSystem();
    await writeJsonObject({
      objectStore,
      locator: { namespace: 'directory_manifest', key: rootDirectoryId },
      value: {
        directoryId: 'different-directory-id',
        modifiedAt: 1,
        shardIds: [],
      },
    });

    await expect(async () => {
      for await (const _entry of store.readDirectory({
        directoryId: rootDirectoryId,
      })) {
        // The manifest must be rejected before entries can be yielded.
      }
    }).rejects.toThrow('manifest ID mismatch');
  });

  it('rejects a directory manifest that references a missing shard', async () => {
    const { store, objectStore } = await createFileSystemStoreContext();
    const rootDirectoryId = await store.createFileSystem();
    await writeJsonObject({
      objectStore,
      locator: { namespace: 'directory_manifest', key: rootDirectoryId },
      value: {
        directoryId: rootDirectoryId,
        modifiedAt: 1,
        shardIds: ['aa'],
      },
    });

    await expect(async () => {
      for await (const _entry of store.readDirectory({
        directoryId: rootDirectoryId,
      })) {
        // A listed shard is part of the authenticated logical directory.
      }
    }).rejects.toThrow('directory shard is missing');
  });

  it('rejects a directory entry stored under the wrong HMAC-derived address', async () => {
    const { store, objectStore } = await createFileSystemStoreContext();
    const rootDirectoryId = await store.createFileSystem();
    const fileId = await store.createFile({
      rootDirectoryId,
      path: '/payload.bin',
      overwrite: false,
      modifiedAt: 1,
    });
    const expectedOpaqueId = await objectStore.getObjectId({
      locator: {
        namespace: 'directory_entry',
        key: `${rootDirectoryId}\0payload.bin`,
      },
    });
    const shardId = expectedOpaqueId.slice(0, 2);
    const wrongOpaqueId = `${shardId}${'x'.repeat(expectedOpaqueId.length - 2)}`;
    await writeJsonObject({
      objectStore,
      locator: { namespace: 'directory_shard', key: `${rootDirectoryId}/${shardId}` },
      value: {
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
        directoryId: rootDirectoryId,
      })) {
        // Entry addresses must be reproducible from the encrypted name.
      }
    }).rejects.toThrow('entry address mismatch');
  });

  it('removes the reachable entry before file payload cleanup', async () => {
    const { store, fileStore } = await createFileSystemStoreContext();
    const rootDirectoryId = await store.createFileSystem();
    await store.writeFile({
      rootDirectoryId,
      path: '/payload.bin',
      source: streamBytes({ bytes: new TextEncoder().encode('payload') }),
      logicalSize: 7,
      modifiedAt: 1,
      signal: undefined,
    });
    const cleanupError = new Error('cleanup failed');
    vi.spyOn(fileStore, 'delete').mockRejectedValueOnce(cleanupError);

    await expect(store.remove({
      rootDirectoryId,
      path: '/payload.bin',
      recursive: false,
    })).rejects.toBe(cleanupError);

    await expect(store.resolve({
      rootDirectoryId,
      path: '/payload.bin',
    })).rejects.toThrow('Encrypted filesystem path not found');
  });

  it('refuses to remove a non-empty directory unless recursive removal is requested', async () => {
    const store = await createFileSystemStore();
    const rootDirectoryId = await store.createFileSystem();
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
