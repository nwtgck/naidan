import { describe, expect, it } from 'vitest';
import {
  createEncryptionMaterial,
  deriveEncryptedStoreRuntimeKeys,
  replacePassphraseEncryptionKeySlot,
  unlockStorageUnlockKeyWithPassphrase,
  unwrapStoreRootKey,
  wrapStoreRootKey,
} from './encryption-key-manager';

describe('encryption key manager', () => {
  it('unlocks the storage key using its passphrase slot', async () => {
    const material = await createEncryptionMaterial({
      passphrase: 'correct horse battery staple',
      pbkdf2Iterations: 10,
    });

    const fromPassphrase = await unlockStorageUnlockKeyWithPassphrase({
      passphraseKeySlot: material.passphraseKeySlot,
      passphrase: 'correct horse battery staple',
    });
    expect(fromPassphrase).toEqual(material.storageUnlockKey);
    expect(material.passphraseKeySlot.pbkdf2.iterations).toBe(10);
  });

  it('keeps the store root key separately wrapped by the storage unlock key', async () => {
    const material = await createEncryptionMaterial({
      passphrase: 'correct horse battery staple',
      pbkdf2Iterations: 10,
    });
    const wrappedStoreRootKey = await wrapStoreRootKey({
      storageUnlockKey: material.storageUnlockKey,
      storeRootKey: material.storeRootKey,
    });
    const header = {
      formatVersion: 1,
      sequence: 0,
      encryptedStoreId: 'store-id',
      encryptionSuite: 'aes_256_gcm_chunked_v1',
      wrappedStoreRootKey,
    } as const;

    expect(await unwrapStoreRootKey({
      storageUnlockKey: material.storageUnlockKey,
      header,
    })).toEqual(material.storeRootKey);
    await expect(deriveEncryptedStoreRuntimeKeys({
      storeRootKey: material.storeRootKey,
      encryptedStoreId: header.encryptedStoreId,
    })).resolves.toMatchObject({
      objectEncryptionKey: expect.any(Object),
      objectAddressKey: expect.any(Object),
    });
  });

  it('replaces the passphrase slot without changing the storage unlock key', async () => {
    const material = await createEncryptionMaterial({
      passphrase: 'old passphrase',
      pbkdf2Iterations: 10,
    });
    const passphraseKeySlot = await replacePassphraseEncryptionKeySlot({
      storageUnlockKey: material.storageUnlockKey,
      passphrase: 'new passphrase',
      pbkdf2Iterations: 10,
    });

    await expect(unlockStorageUnlockKeyWithPassphrase({
      passphraseKeySlot,
      passphrase: 'new passphrase',
    })).resolves.toEqual(material.storageUnlockKey);
    await expect(unlockStorageUnlockKeyWithPassphrase({
      passphraseKeySlot,
      passphrase: 'old passphrase',
    })).rejects.toThrow('did not unlock');
    expect(passphraseKeySlot.pbkdf2.iterations).toBe(10);
  });

  it('does not unlock with a different passphrase', async () => {
    const material = await createEncryptionMaterial({
      passphrase: 'correct horse battery staple',
      pbkdf2Iterations: 10,
    });

    await expect(unlockStorageUnlockKeyWithPassphrase({
      passphraseKeySlot: material.passphraseKeySlot,
      passphrase: 'incorrect passphrase',
    })).rejects.toThrow('did not unlock');
  });
});
