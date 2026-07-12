import { describe, expect, it } from 'vitest';
import {
  createEncryptionMaterial,
  deriveEncryptedStoreRuntimeKeys,
} from '@/00-storage/service/opfs-encryption/encryption-key-manager';
import { EncryptedFileStore } from '@/00-storage/service/opfs-encryption/encrypted-file-store';
import { EncryptedFileSystemStore } from '@/00-storage/service/opfs-encryption/encrypted-file-system-store';
import { EncryptedObjectStore } from '@/00-storage/service/opfs-encryption/encrypted-object-store';
import type { StorageVolumeAccess } from '@/00-storage/service/volume-access';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import { EncryptedDirectoryWeshProvider } from './encrypted-directory-provider';

async function createContext(): Promise<{
  provider: EncryptedDirectoryWeshProvider,
  store: EncryptedFileSystemStore,
  rootDirectoryId: string,
}> {
  const material = await createEncryptionMaterial({
    passphrase: 'test passphrase',
    pbkdf2Iterations: 10,
  });
  const encryptedStoreId = 'test-store';
  const keys = await deriveEncryptedStoreRuntimeKeys({
    storeRootKey: material.storeRootKey,
    encryptedStoreId,
  });
  const storeDirectory = new MockFileSystemDirectoryHandle({ name: encryptedStoreId });
  const objectStore = new EncryptedObjectStore({
    storeDirectory,
    keys,
    area: 'durable',
  });
  const fileStore = new EncryptedFileStore({ objectStore });
  const store = new EncryptedFileSystemStore({ objectStore, fileStore });
  const fileSystemId = 'system/test-wesh';
  const descriptor = await store.createFileSystem({
    fileSystemId,
    createdAt: 101,
  });
  const access: Extract<StorageVolumeAccess, { type: 'encrypted_directory' }> = {
    type: 'encrypted_directory',
    storeDirectory,
    encryptedStoreId,
    fileSystemId,
    physicalArea: 'durable',
    rootDirectoryId: descriptor.rootDirectoryId,
    objectEncryptionKey: keys.objectEncryptionKey,
    objectAddressKey: keys.objectAddressKey,
  };
  return {
    provider: new EncryptedDirectoryWeshProvider({
      access,
      mountPath: '/encrypted',
    }),
    store,
    rootDirectoryId: descriptor.rootDirectoryId,
  };
}

describe('EncryptedDirectoryWeshProvider', () => {
  it('returns persisted directory modification times from stat', async () => {
    const { provider, store, rootDirectoryId } = await createContext();
    const childDirectoryId = await store.createDirectory({
      rootDirectoryId,
      path: '/docs',
      recursive: false,
      createdAt: 202,
    });
    const rootManifest = await store.getDirectoryManifest({
      rootDirectoryId,
      directoryId: rootDirectoryId,
    });
    const childManifest = await store.getDirectoryManifest({
      rootDirectoryId,
      directoryId: childDirectoryId,
    });

    await expect(provider.stat({ path: '/encrypted' })).resolves.toMatchObject({
      type: 'directory',
      mtime: rootManifest.modifiedAt,
    });
    await expect(provider.stat({ path: '/encrypted/docs' })).resolves.toMatchObject({
      type: 'directory',
      mtime: childManifest.modifiedAt,
    });
  });

  it('lists child directories through the root filesystem transaction scope', async () => {
    const { provider, store, rootDirectoryId } = await createContext();
    await store.createDirectory({
      rootDirectoryId,
      path: '/docs/nested',
      recursive: true,
    });

    const names: string[] = [];
    for await (const entry of provider.readDir({ path: '/encrypted/docs' })) {
      names.push(entry.name);
    }

    expect(names).toEqual(['nested']);
  });

  it('opens files through final symlinks and rejects symlink loops', async () => {
    const { provider, store, rootDirectoryId } = await createContext();
    const bytes = new TextEncoder().encode('symlinked file contents');
    await store.writeFile({
      rootDirectoryId,
      path: '/target.txt',
      source: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      size: bytes.byteLength,
      modifiedAt: 1,
      signal: undefined,
    });
    await store.createSymlink({
      rootDirectoryId,
      path: '/link.txt',
      targetPath: 'target.txt',
      modifiedAt: 2,
    });

    const handle = await provider.open({
      path: '/encrypted/link.txt',
      flags: {
        access: 'read',
        creation: 'never',
        truncate: 'preserve',
        append: 'preserve',
      },
    });
    const output = new Uint8Array(bytes.byteLength);
    await expect(handle.read({ buffer: output })).resolves.toMatchObject({
      bytesRead: bytes.byteLength,
    });
    expect(Array.from(output)).toEqual(Array.from(bytes));
    await handle.close();

    await store.createSymlink({
      rootDirectoryId,
      path: '/loop-a',
      targetPath: '/loop-b',
      modifiedAt: 3,
    });
    await store.createSymlink({
      rootDirectoryId,
      path: '/loop-b',
      targetPath: '/loop-a',
      modifiedAt: 4,
    });

    await expect(provider.stat({ path: '/encrypted/loop-a' })).rejects.toThrow(
      'Too many symbolic links',
    );
  });

  it('keeps an open file handle bound to its file identity across rename', async () => {
    const { provider, store, rootDirectoryId } = await createContext();
    const initial = new TextEncoder().encode('stable file identity');
    await store.writeFile({
      rootDirectoryId,
      path: '/before.txt',
      source: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(initial);
          controller.close();
        },
      }),
      size: initial.byteLength,
      modifiedAt: 1,
      signal: undefined,
    });
    const handle = await provider.open({
      path: '/encrypted/before.txt',
      flags: {
        access: 'read-write',
        creation: 'never',
        truncate: 'preserve',
        append: 'preserve',
      },
    });

    await provider.rename({
      oldPath: '/encrypted/before.txt',
      newPath: '/encrypted/after.txt',
    });

    const output = new Uint8Array(initial.byteLength);
    await expect(handle.read({ buffer: output, position: 0 })).resolves.toMatchObject({
      bytesRead: initial.byteLength,
    });
    expect(Array.from(output)).toEqual(Array.from(initial));
    await expect(handle.write({
      buffer: new TextEncoder().encode('!'),
      position: initial.byteLength,
    })).resolves.toMatchObject({ bytesWritten: 1 });
    await expect(handle.stat()).resolves.toMatchObject({ size: initial.byteLength + 1 });
    await handle.close();

    await expect(provider.stat({ path: '/encrypted/before.txt' })).rejects.toThrow('path not found');
    await expect(provider.stat({ path: '/encrypted/after.txt' })).resolves.toMatchObject({
      type: 'file',
      size: initial.byteLength + 1,
    });
  });
});
