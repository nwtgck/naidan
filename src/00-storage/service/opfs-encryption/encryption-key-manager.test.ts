import { describe, expect, it } from 'vitest';
import {
  createEncryptionMaterial,
  deriveEncryptedStoreRuntimeKeys,
  replacePassphraseEncryptionKeySlots,
  unlockStorageUnlockKeyWithPassphrase,
  unlockStorageUnlockKeyWithRecoveryKey,
  unwrapStoreRootKey,
  wrapStoreRootKey,
} from './encryption-key-manager';

describe('encryption key manager', () => {
  it('unlocks the same storage key using passphrase and recovery slots', async () => {
    const material = await createEncryptionMaterial({
      passphrase: 'correct horse battery staple',
      pbkdf2Iterations: 10,
    });

    const fromPassphrase = await unlockStorageUnlockKeyWithPassphrase({
      keySlots: material.keySlots,
      passphrase: 'correct horse battery staple',
    });
    const fromRecovery = await unlockStorageUnlockKeyWithRecoveryKey({
      keySlots: material.keySlots,
      recoveryKey: material.recoveryKey,
    });

    expect(fromPassphrase).toEqual(material.storageUnlockKey);
    expect(fromRecovery).toEqual(material.storageUnlockKey);
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

  it('replaces passphrase slots without changing the storage unlock key or recovery slot', async () => {
    const material = await createEncryptionMaterial({
      passphrase: 'old passphrase',
      pbkdf2Iterations: 10,
    });
    const keySlots = await replacePassphraseEncryptionKeySlots({
      keySlots: material.keySlots,
      storageUnlockKey: material.storageUnlockKey,
      passphrase: 'new passphrase',
      pbkdf2Iterations: 10,
    });

    await expect(unlockStorageUnlockKeyWithPassphrase({
      keySlots,
      passphrase: 'new passphrase',
    })).resolves.toEqual(material.storageUnlockKey);
    await expect(unlockStorageUnlockKeyWithPassphrase({
      keySlots,
      passphrase: 'old passphrase',
    })).rejects.toThrow('did not unlock');
    await expect(unlockStorageUnlockKeyWithRecoveryKey({
      keySlots,
      recoveryKey: material.recoveryKey,
    })).resolves.toEqual(material.storageUnlockKey);
  });

  it('does not unlock with a different passphrase', async () => {
    const material = await createEncryptionMaterial({
      passphrase: 'correct horse battery staple',
      pbkdf2Iterations: 10,
    });

    await expect(unlockStorageUnlockKeyWithPassphrase({
      keySlots: material.keySlots,
      passphrase: 'incorrect passphrase',
    })).rejects.toThrow('did not unlock');
  });
});
