import { describe, expect, it } from 'vitest';
import type {
  OpfsEncryptedStoreHeaderDto,
  OpfsEncryptionKeySlotDto,
  OpfsEncryptionStateDto,
} from '@/00-storage/00-dto/opfs-encryption.dto';
import { encodeBase64Url } from './base64-url';
import {
  assertEncryptedStoreHeaderCanBeUsed,
  assertEncryptionStateCanBeUsed,
} from './encryption-semantic-validation';

function encodeBytes({ byteLength, value }: { byteLength: number; value: number }): string {
  return encodeBase64Url({ bytes: new Uint8Array(byteLength).fill(value) });
}

function createKeySlot(): OpfsEncryptionKeySlotDto {
  return {
    id: 'slot-id',
    keyDerivation: {
      type: 'pbkdf2_hmac_sha256',
      salt: encodeBytes({ byteLength: 32, value: 1 }),
      iterations: 100_000,
    },
    wrappedStorageUnlockKey: {
      nonce: encodeBytes({ byteLength: 12, value: 2 }),
      ciphertext: encodeBytes({ byteLength: 48, value: 3 }),
    },
  };
}

function createState({ keySlots = [createKeySlot()] }: {
  keySlots?: readonly OpfsEncryptionKeySlotDto[];
} = {}): OpfsEncryptionStateDto {
  return {
    formatVersion: 1,
    sequence: 0,
    state: 'encrypted',
    keySlots,
    activeEncryptedStoreId: 'store-id',
  };
}

function createHeader({ ciphertext = encodeBytes({ byteLength: 48, value: 5 }) }: {
  ciphertext?: string;
} = {}): OpfsEncryptedStoreHeaderDto {
  return {
    formatVersion: 1,
    encryptedStoreId: 'store-id',
    fileSystemId: encodeBytes({ byteLength: 16, value: 6 }),
    wrappedFileSystemRootKey: {
      nonce: encodeBytes({ byteLength: 12, value: 4 }),
      ciphertext,
    },
  };
}

describe('encryption semantic validation', () => {
  it('accepts key material with the exact protocol byte lengths', () => {
    expect(() => assertEncryptionStateCanBeUsed({ state: createState() })).not.toThrow();
    expect(() => assertEncryptedStoreHeaderCanBeUsed({ header: createHeader() })).not.toThrow();
  });

  it('rejects an invalid PBKDF2 salt length', () => {
    const slot = createKeySlot();
    const state = createState({
      keySlots: [{
        ...slot,
        keyDerivation: {
          ...slot.keyDerivation,
          salt: encodeBytes({ byteLength: 31, value: 1 }),
        },
      }],
    });
    expect(() => assertEncryptionStateCanBeUsed({ state })).toThrow(
      'PBKDF2 salt must contain exactly 32 bytes',
    );
  });

  it('rejects an invalid wrapped storage unlock key nonce length', () => {
    const slot = createKeySlot();
    const state = createState({
      keySlots: [{
        ...slot,
        wrappedStorageUnlockKey: {
          ...slot.wrappedStorageUnlockKey,
          nonce: encodeBytes({ byteLength: 11, value: 2 }),
        },
      }],
    });
    expect(() => assertEncryptionStateCanBeUsed({ state })).toThrow(
      'Wrapped storage unlock key nonce must contain exactly 12 bytes',
    );
  });

  it('rejects an invalid wrapped storage unlock key ciphertext length', () => {
    const slot = createKeySlot();
    const state = createState({
      keySlots: [{
        ...slot,
        wrappedStorageUnlockKey: {
          ...slot.wrappedStorageUnlockKey,
          ciphertext: encodeBytes({ byteLength: 47, value: 3 }),
        },
      }],
    });
    expect(() => assertEncryptionStateCanBeUsed({ state })).toThrow(
      'Wrapped storage unlock key ciphertext must contain exactly 48 bytes',
    );
  });

  it('rejects invalid wrapped file-system root key lengths', () => {
    const header = createHeader({
      ciphertext: encodeBytes({ byteLength: 49, value: 5 }),
    });
    expect(() => assertEncryptedStoreHeaderCanBeUsed({ header })).toThrow(
      'Wrapped file system root key ciphertext must contain exactly 48 bytes',
    );
  });

  it('bounds the number of persisted key slots', () => {
    const template = createKeySlot();
    const state = createState({
      keySlots: Array.from({ length: 33 }, (_, index) => ({
        ...template,
        id: `slot-${String(index)}`,
      })),
    });

    expect(() => assertEncryptionStateCanBeUsed({ state })).toThrow(
      'between 1 and 32 key slots',
    );
  });
});
