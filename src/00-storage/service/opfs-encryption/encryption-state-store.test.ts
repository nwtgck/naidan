import { describe, expect, it, vi } from 'vitest';
import type { OpfsEncryptionStateDto } from '@/00-storage/00-dto/opfs-encryption.dto';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import { encodeBase64Url } from './base64-url';
import { EncryptionStateStore } from './encryption-state-store';

function createState({
  sequence,
  encryptedStoreId,
}: {
  sequence: number;
  encryptedStoreId: string;
}): OpfsEncryptionStateDto {
  return {
    formatVersion: 1,
    sequence,
    state: 'encrypted',
    keySlots: [{
      id: 'slot-id',
      keyDerivation: {
        type: 'pbkdf2_hmac_sha256',
        salt: encodeBase64Url({ bytes: new Uint8Array(32).fill(1) }),
        iterations: 10,
      },
      wrappedStorageUnlockKey: {
        nonce: encodeBase64Url({ bytes: new Uint8Array(12).fill(2) }),
        ciphertext: encodeBase64Url({ bytes: new Uint8Array(48).fill(3) }),
      },
    }],
    activeEncryptedStoreId: encryptedStoreId,
  };
}

describe('EncryptionStateStore', () => {
  it('treats a missing encryption-state directory as plain storage', async () => {
    const storageRoot = new MockFileSystemDirectoryHandle({ name: 'naidan-storage' });
    await expect(new EncryptionStateStore({ storageRoot }).inspect()).resolves.toEqual({
      type: 'plain',
    });
  });

  it('selects the newest valid slot and falls back from a corrupt latest slot', async () => {
    const storageRoot = new MockFileSystemDirectoryHandle({ name: 'naidan-storage' });
    const store = new EncryptionStateStore({ storageRoot });
    const first = createState({ sequence: 0, encryptedStoreId: 'store-0' });
    const second = createState({ sequence: 1, encryptedStoreId: 'store-1' });

    await store.writeState({ state: first });
    await store.writeState({ state: second });
    await expect(store.inspect()).resolves.toEqual({ type: 'encrypted', state: second });

    const stateDirectory = await storageRoot.getDirectoryHandle('encryption-state');
    const latestSlot = await stateDirectory.getFileHandle('state-1.json');
    const writable = await latestSlot.createWritable();
    await writable.write('{invalid json');
    await writable.close();

    await expect(store.inspect()).resolves.toEqual({ type: 'encrypted', state: first });
  });

  it('accepts a durable state-directory removal when removeEntry reports an error', async () => {
    const storageRoot = new MockFileSystemDirectoryHandle({ name: 'naidan-storage' });
    const store = new EncryptionStateStore({ storageRoot });
    await store.writeState({ state: createState({ sequence: 0, encryptedStoreId: 'store-0' }) });
    const removeEntry = storageRoot.removeEntry.bind(storageRoot);
    vi.spyOn(storageRoot, 'removeEntry').mockImplementation(async (name, options) => {
      await removeEntry(name, options);
      throw new Error('simulated remove error after durable deletion');
    });

    await expect(store.removeAll()).resolves.toBeUndefined();
    await expect(store.inspect()).resolves.toEqual({ type: 'plain' });
  });
});
