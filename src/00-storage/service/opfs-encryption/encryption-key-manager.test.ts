import { describe, expect, it } from 'vitest';
import { encodeBase64Url } from './base64-url';
import {
  createEncryptionKeySlotFromSecret,
  createEncryptionMaterial,
  replacePassphraseEncryptionKeySlot,
  unlockStorageUnlockKeyWithPassphrase,
  unwrapFileSystemRootKey,
  wrapFileSystemRootKey,
} from './encryption-key-manager';

describe('encryption key manager', () => {
  it.each(['q', '1'])(
    'accepts and unlocks a single-character passphrase %j',
    async (passphrase) => {
      const material = await createEncryptionMaterial({
        passphrase,
        pbkdf2Iterations: 10,
      });

      const unlocked = await unlockStorageUnlockKeyWithPassphrase({
        keySlots: material.keySlots,
        passphrase,
      });
      expect(unlocked.storageUnlockKey).toEqual(material.storageUnlockKey);
      expect(unlocked.keySlotId).toBe(material.keySlots[0]?.id);
      material.storageUnlockKey.fill(0);
      material.fileSystemRootKey.fill(0);
      unlocked.storageUnlockKey.fill(0);
    },
  );

  it('unlocks the storage key using one of multiple generic key slots', async () => {
    const material = await createEncryptionMaterial({
      passphrase: 'correct horse battery staple',
      pbkdf2Iterations: 10,
    });
    const additionalSlot = await createEncryptionKeySlotFromSecret({
      storageUnlockKey: material.storageUnlockKey,
      secret: new TextEncoder().encode('key-file-bytes'),
      keySlotId: 'key-file-slot',
      pbkdf2Iterations: 10,
    });

    const unlocked = await unlockStorageUnlockKeyWithPassphrase({
      keySlots: [additionalSlot, ...material.keySlots],
      passphrase: 'correct horse battery staple',
    });

    expect(unlocked.storageUnlockKey).toEqual(material.storageUnlockKey);
    expect(unlocked.keySlotId).toBe(material.keySlots[0]?.id);
    expect(material.keySlots[0]?.keyDerivation).toMatchObject({
      type: 'pbkdf2_hmac_sha256',
      iterations: 10,
    });
    material.storageUnlockKey.fill(0);
    material.fileSystemRootKey.fill(0);
    unlocked.storageUnlockKey.fill(0);
  });

  it('binds a wrapped storage unlock key to its stable slot ID', async () => {
    const material = await createEncryptionMaterial({
      passphrase: 'correct horse battery staple',
      pbkdf2Iterations: 10,
    });
    const slot = material.keySlots[0];
    if (slot === undefined) {
      throw new Error('Expected an encryption key slot');
    }

    await expect(unlockStorageUnlockKeyWithPassphrase({
      keySlots: [{ ...slot, id: 'different-slot-id' }],
      passphrase: 'correct horse battery staple',
    })).rejects.toThrow('did not unlock');
    material.storageUnlockKey.fill(0);
    material.fileSystemRootKey.fill(0);
  });

  it('wraps the file-system root key separately and binds it to the store ID', async () => {
    const material = await createEncryptionMaterial({
      passphrase: 'correct horse battery staple',
      pbkdf2Iterations: 10,
    });
    const wrappedFileSystemRootKey = await wrapFileSystemRootKey({
      storageUnlockKey: material.storageUnlockKey,
      fileSystemRootKey: material.fileSystemRootKey,
      encryptedStoreId: 'store-id',
    });
    const header = {
      formatVersion: 1 as const,
      encryptedStoreId: 'store-id',
      fileSystemId: encodeBase64Url({ bytes: new Uint8Array(16).fill(7) }),
      wrappedFileSystemRootKey,
    };

    const unwrapped = await unwrapFileSystemRootKey({
      storageUnlockKey: material.storageUnlockKey,
      header,
    });
    expect(unwrapped).toEqual(material.fileSystemRootKey);
    await expect(unwrapFileSystemRootKey({
      storageUnlockKey: material.storageUnlockKey,
      header: { ...header, encryptedStoreId: 'other-store-id' },
    })).rejects.toThrow();
    material.storageUnlockKey.fill(0);
    material.fileSystemRootKey.fill(0);
    unwrapped.fill(0);
  });

  it('replaces one passphrase slot without changing other slots or the storage unlock key', async () => {
    const material = await createEncryptionMaterial({
      passphrase: 'old passphrase',
      pbkdf2Iterations: 10,
    });
    const originalSlot = material.keySlots[0];
    if (originalSlot === undefined) {
      throw new Error('Expected an encryption key slot');
    }
    const otherSlot = await createEncryptionKeySlotFromSecret({
      storageUnlockKey: material.storageUnlockKey,
      secret: new TextEncoder().encode('other secret'),
      keySlotId: 'other-slot',
      pbkdf2Iterations: 10,
    });
    const keySlots = await replacePassphraseEncryptionKeySlot({
      storageUnlockKey: material.storageUnlockKey,
      keySlots: [originalSlot, otherSlot],
      keySlotId: originalSlot.id,
      passphrase: 'new passphrase',
      pbkdf2Iterations: 10,
    });

    expect(keySlots[1]).toEqual(otherSlot);
    const unlocked = await unlockStorageUnlockKeyWithPassphrase({
      keySlots,
      passphrase: 'new passphrase',
    });
    expect(unlocked).toMatchObject({
      storageUnlockKey: material.storageUnlockKey,
      keySlotId: originalSlot.id,
    });
    await expect(unlockStorageUnlockKeyWithPassphrase({
      keySlots,
      passphrase: 'old passphrase',
    })).rejects.toThrow('did not unlock');
    material.storageUnlockKey.fill(0);
    material.fileSystemRootKey.fill(0);
    unlocked.storageUnlockKey.fill(0);
  });

  it('rejects an unbounded key-slot search before running any KDF', async () => {
    const material = await createEncryptionMaterial({
      passphrase: 'correct horse battery staple',
      pbkdf2Iterations: 10,
    });
    const template = material.keySlots[0]!;
    const keySlots = Array.from({ length: 33 }, (_, index) => ({
      ...template,
      id: `slot-${index}`,
    }));

    await expect(unlockStorageUnlockKeyWithPassphrase({
      keySlots,
      passphrase: 'correct horse battery staple',
    })).rejects.toThrow('between 1 and 32 key slots');
    material.storageUnlockKey.fill(0);
    material.fileSystemRootKey.fill(0);
  });
});
