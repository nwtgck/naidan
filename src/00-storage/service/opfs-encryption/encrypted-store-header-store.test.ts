import { describe, expect, it, vi } from 'vitest';
import type { OpfsEncryptedStoreHeaderDto } from '@/00-storage/00-dto/opfs-encryption.dto';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import { encodeBase64Url } from './base64-url';
import { EncryptedStoreHeaderStore, TEST_ONLY } from './encrypted-store-header-store';

function createHeader({
  encryptedStoreId,
  fileSystemId = encodeBase64Url({ bytes: new Uint8Array(16).fill(7) }),
}: {
  encryptedStoreId: string;
  fileSystemId?: string;
}): OpfsEncryptedStoreHeaderDto {
  return {
    formatVersion: 1,
    encryptedStoreId,
    fileSystemId,
    wrappedFileSystemRootKey: {
      nonce: encodeBase64Url({ bytes: new Uint8Array(12).fill(1) }),
      ciphertext: encodeBase64Url({ bytes: new Uint8Array(48).fill(2) }),
    },
  };
}

describe('EncryptedStoreHeaderStore', () => {
  it('writes one immutable header beside a separate HizoFS data directory', async () => {
    const storageRoot = new MockFileSystemDirectoryHandle({ name: 'naidan-storage' });
    const store = new EncryptedStoreHeaderStore({ storageRoot });
    const header = createHeader({ encryptedStoreId: 'store-id' });

    await store.write({ header });
    await store.write({ header });

    await expect(store.read({ encryptedStoreId: 'store-id' })).resolves.toEqual(header);
    const storeDirectory = await store.getStoreDirectory({
      encryptedStoreId: 'store-id',
      create: false,
    });
    await expect(storeDirectory.getFileHandle(TEST_ONLY.HEADER_FILE_NAME)).resolves.toBeDefined();
    await expect(store.getHizoFSBackingDirectory({
      encryptedStoreId: 'store-id',
      create: true,
    })).resolves.toMatchObject({ name: TEST_ONLY.HIZOFS_BACKING_DIRECTORY_NAME });
  });

  it('treats property order as irrelevant when writing the same immutable header', async () => {
    const storageRoot = new MockFileSystemDirectoryHandle({ name: 'naidan-storage' });
    const store = new EncryptedStoreHeaderStore({ storageRoot });
    const header = createHeader({ encryptedStoreId: 'store-id' });
    await store.write({ header });

    const reorderedHeader: OpfsEncryptedStoreHeaderDto = {
      wrappedFileSystemRootKey: {
        ciphertext: header.wrappedFileSystemRootKey.ciphertext,
        nonce: header.wrappedFileSystemRootKey.nonce,
      },
      fileSystemId: header.fileSystemId,
      encryptedStoreId: header.encryptedStoreId,
      formatVersion: header.formatVersion,
    };

    await expect(store.write({ header: reorderedHeader })).resolves.toBeUndefined();
  });

  it('rejects replacing an existing header with different contents', async () => {
    const storageRoot = new MockFileSystemDirectoryHandle({ name: 'naidan-storage' });
    const store = new EncryptedStoreHeaderStore({ storageRoot });
    await store.write({ header: createHeader({ encryptedStoreId: 'store-id' }) });

    await expect(store.write({
      header: createHeader({
        encryptedStoreId: 'store-id',
        fileSystemId: encodeBase64Url({ bytes: new Uint8Array(16).fill(8) }),
      }),
    })).rejects.toThrow('immutable');
  });

  it('accepts a durable encrypted-store removal when removeEntry reports an error', async () => {
    const storageRoot = new MockFileSystemDirectoryHandle({ name: 'naidan-storage' });
    const store = new EncryptedStoreHeaderStore({ storageRoot });
    await store.write({ header: createHeader({ encryptedStoreId: 'store-id' }) });
    const storesDirectory = await storageRoot.getDirectoryHandle('encrypted-stores');
    const removeEntry = storesDirectory.removeEntry.bind(storesDirectory);
    vi.spyOn(storesDirectory, 'removeEntry').mockImplementation(async (name, options) => {
      await removeEntry(name, options);
      throw new Error('simulated remove error after durable deletion');
    });

    await expect(store.removeStore({ encryptedStoreId: 'store-id' })).resolves.toBeUndefined();
    await expect(store.read({ encryptedStoreId: 'store-id' })).resolves.toBeUndefined();
  });

  it('removes only the requested encrypted store', async () => {
    const storageRoot = new MockFileSystemDirectoryHandle({ name: 'naidan-storage' });
    const store = new EncryptedStoreHeaderStore({ storageRoot });
    await store.write({ header: createHeader({ encryptedStoreId: 'store-a' }) });
    await store.write({ header: createHeader({ encryptedStoreId: 'store-b' }) });

    await store.removeStore({ encryptedStoreId: 'store-a' });

    await expect(store.read({ encryptedStoreId: 'store-b' })).resolves.toMatchObject({
      encryptedStoreId: 'store-b',
    });
    await expect(store.read({ encryptedStoreId: 'store-a' })).resolves.toBeUndefined();
  });
});
