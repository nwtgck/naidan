import { describe, expect, it, vi } from 'vitest';
import type { EncryptedStoreHeaderDto } from '@/00-storage/00-dto/encryption.dto';
import {
  MockFileSystemDirectoryHandle,
} from '@/utils/in-memory-file-system';
import { encodeBase64Url } from './base64-url';
import { EncryptedStoreHeaderStore } from './encrypted-store-header-store';

function createHeader({
  sequence,
  encryptedStoreId,
}: {
  sequence: number,
  encryptedStoreId: string,
}): EncryptedStoreHeaderDto {
  return {
    formatVersion: 1,
    sequence,
    encryptedStoreId,
    wrappedStoreRootKey: {
      nonce: encodeBase64Url({ bytes: new Uint8Array(12).fill(sequence + 1) }),
      ciphertext: encodeBase64Url({ bytes: new Uint8Array(48).fill(sequence + 2) }),
    },
  };
}

describe('EncryptedStoreHeaderStore', () => {
  it('selects the newest valid header slot', async () => {
    const storageRoot = new MockFileSystemDirectoryHandle({ name: 'naidan-storage' });
    const store = new EncryptedStoreHeaderStore({ storageRoot });
    const first = createHeader({ sequence: 0, encryptedStoreId: 'store-id' });
    const second = createHeader({ sequence: 1, encryptedStoreId: 'store-id' });

    await store.write({ header: first });
    await store.write({ header: second });

    await expect(store.read({ encryptedStoreId: 'store-id' })).resolves.toEqual(second);
  });

  it('accepts a durable encrypted-store removal when removeEntry reports an error', async () => {
    const storageRoot = new MockFileSystemDirectoryHandle({ name: 'naidan-storage' });
    const store = new EncryptedStoreHeaderStore({ storageRoot });
    await store.write({
      header: createHeader({ sequence: 0, encryptedStoreId: 'store-id' }),
    });
    const storesDirectory = await storageRoot.getDirectoryHandle('encrypted-stores');
    const removeEntry = storesDirectory.removeEntry.bind(storesDirectory);
    vi.spyOn(storesDirectory, 'removeEntry').mockImplementation(async (name, options) => {
      await removeEntry(name, options);
      throw new Error('simulated remove error after durable deletion');
    });

    await expect(store.removeStore({ encryptedStoreId: 'store-id' })).resolves.toBeUndefined();
    await expect(store.read({ encryptedStoreId: 'store-id' })).rejects.toMatchObject({
      name: 'NotFoundError',
    });
  });

  it('removes only the requested encrypted store', async () => {
    const storageRoot = new MockFileSystemDirectoryHandle({ name: 'naidan-storage' });
    const store = new EncryptedStoreHeaderStore({ storageRoot });

    await store.write({
      header: createHeader({ sequence: 0, encryptedStoreId: 'store-a' }),
    });
    await store.write({
      header: createHeader({ sequence: 0, encryptedStoreId: 'store-b' }),
    });
    await store.removeStore({ encryptedStoreId: 'store-a' });

    await expect(store.read({ encryptedStoreId: 'store-b' })).resolves.toMatchObject({
      encryptedStoreId: 'store-b',
    });
    await expect(store.read({ encryptedStoreId: 'store-a' })).rejects.toMatchObject({
      name: 'NotFoundError',
    });
  });
});
