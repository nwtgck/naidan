import { describe, expect, it } from 'vitest';
import type { EncryptionStateDto } from '@/00-storage/00-dto/encryption.dto';
import {
  MockFileSystemDirectoryHandle,
} from '@/utils/in-memory-file-system';
import { EncryptionStateStore } from './encryption-state-store';

function createState({
  sequence,
  encryptedStoreId,
}: {
  sequence: number,
  encryptedStoreId: string,
}): EncryptionStateDto {
  return {
    formatVersion: 1,
    sequence,
    state: 'encrypted',
    keySlots: [{
      id: 'passphrase-slot',
      type: 'passphrase',
      kdf: {
        type: 'pbkdf2_sha256',
        salt: 'salt',
        iterations: 10,
      },
      wrappedStorageUnlockKey: {
        nonce: 'nonce',
        ciphertext: 'ciphertext',
      },
    }],
    activeEncryptedStoreId: encryptedStoreId,
  };
}

describe('EncryptionStateStore', () => {
  it('treats a missing encryption-state directory as plain storage', async () => {
    const storageRoot = new MockFileSystemDirectoryHandle({ name: 'naidan-storage' });
    const store = new EncryptionStateStore({ storageRoot });

    await expect(store.inspect()).resolves.toEqual({ type: 'plain' });
  });

  it('selects the newest valid slot and falls back from a corrupt latest slot', async () => {
    const storageRoot = new MockFileSystemDirectoryHandle({ name: 'naidan-storage' });
    const store = new EncryptionStateStore({ storageRoot });
    const first = createState({ sequence: 0, encryptedStoreId: 'store-0' });
    const second = createState({ sequence: 1, encryptedStoreId: 'store-1' });

    await store.writeState({ state: first });
    await store.writeState({ state: second });
    await expect(store.inspect()).resolves.toEqual({
      type: 'encrypted',
      state: second,
    });

    const stateDirectory = await storageRoot.getDirectoryHandle('encryption-state');
    const latestSlot = await stateDirectory.getFileHandle('state-1.json');
    const writable = await latestSlot.createWritable();
    await writable.write('{invalid json');
    await writable.close();

    await expect(store.inspect()).resolves.toEqual({
      type: 'encrypted',
      state: first,
    });
  });

  it('returns to the legacy plain representation by removing all state', async () => {
    const storageRoot = new MockFileSystemDirectoryHandle({ name: 'naidan-storage' });
    const store = new EncryptionStateStore({ storageRoot });

    await store.writeState({
      state: createState({ sequence: 0, encryptedStoreId: 'store-0' }),
    });
    await store.removeAll();

    await expect(store.inspect()).resolves.toEqual({ type: 'plain' });
  });
});
