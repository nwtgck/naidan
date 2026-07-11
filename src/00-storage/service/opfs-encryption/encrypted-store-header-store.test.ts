import { describe, expect, it } from 'vitest';
import type { EncryptedStoreHeaderDto } from '@/00-storage/00-dto/encryption.dto';
import {
  MockFileSystemDirectoryHandle,
} from '@/utils/in-memory-file-system';
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
    encryptionSuite: 'aes_256_gcm_chunked_v1',
    wrappedStoreRootKey: {
      nonce: `nonce-${sequence}`,
      ciphertext: `ciphertext-${sequence}`,
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
