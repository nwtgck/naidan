import { describe, expect, it } from 'vitest';
import type {
  EncryptedStoreHeaderDto,
  EncryptionStateDto,
} from '@/00-storage/00-dto/encryption.dto';
import { encodeBase64Url } from './base64-url';
import {
  assertEncryptedStoreHeaderCanBeUsed,
  assertEncryptionStateCanBeUsed,
} from './encryption-semantic-validation';

function encodeBytes({ byteLength, value }: { byteLength: number, value: number }): string {
  return encodeBase64Url({ bytes: new Uint8Array(byteLength).fill(value) });
}

function createState(): EncryptionStateDto {
  return {
    formatVersion: 1,
    sequence: 0,
    state: 'encrypted',
    keySlots: [{
      id: 'slot-id',
      keyDerivation: {
        type: 'pbkdf2_sha256',
        salt: encodeBytes({ byteLength: 32, value: 1 }),
        iterations: 100_000,
      },
      wrappedStorageUnlockKey: {
        nonce: encodeBytes({ byteLength: 12, value: 2 }),
        ciphertext: encodeBytes({ byteLength: 48, value: 3 }),
      },
    }],
    activeEncryptedStoreId: 'store-id',
  };
}

function createHeader(): EncryptedStoreHeaderDto {
  return {
    formatVersion: 1,
    sequence: 0,
    encryptedStoreId: 'store-id',
    wrappedStoreRootKey: {
      nonce: encodeBytes({ byteLength: 12, value: 4 }),
      ciphertext: encodeBytes({ byteLength: 48, value: 5 }),
    },
  };
}

describe('encryption semantic validation', () => {
  it('accepts key material with the exact protocol byte lengths', () => {
    expect(() => assertEncryptionStateCanBeUsed({ state: createState() })).not.toThrow();
    expect(() => assertEncryptedStoreHeaderCanBeUsed({ header: createHeader() })).not.toThrow();
  });

  it.each([
    {
      name: 'PBKDF2 salt',
      mutate: (state: EncryptionStateDto) => {
        state.keySlots[0]!.keyDerivation.salt = encodeBytes({ byteLength: 31, value: 1 });
      },
      message: 'PBKDF2 salt must contain exactly 32 bytes',
    },
    {
      name: 'wrapped storage unlock key nonce',
      mutate: (state: EncryptionStateDto) => {
        state.keySlots[0]!.wrappedStorageUnlockKey.nonce = encodeBytes({ byteLength: 11, value: 2 });
      },
      message: 'Wrapped storage unlock key nonce must contain exactly 12 bytes',
    },
    {
      name: 'wrapped storage unlock key ciphertext',
      mutate: (state: EncryptionStateDto) => {
        state.keySlots[0]!.wrappedStorageUnlockKey.ciphertext = encodeBytes({ byteLength: 47, value: 3 });
      },
      message: 'Wrapped storage unlock key ciphertext must contain exactly 48 bytes',
    },
  ])('rejects an invalid $name length', ({ mutate, message }) => {
    const state = createState();
    mutate(state);
    expect(() => assertEncryptionStateCanBeUsed({ state })).toThrow(message);
  });

  it('rejects invalid wrapped store root key lengths', () => {
    const header = createHeader();
    header.wrappedStoreRootKey.ciphertext = encodeBytes({ byteLength: 49, value: 5 });
    expect(() => assertEncryptedStoreHeaderCanBeUsed({ header })).toThrow(
      'Wrapped store root key ciphertext must contain exactly 48 bytes',
    );
  });

  it('bounds the number of persisted key slots', () => {
    const state = createState();
    const template = state.keySlots[0]!;
    state.keySlots = Array.from({ length: 33 }, (_, index) => ({
      ...template,
      id: `slot-${index}`,
    }));

    expect(() => assertEncryptionStateCanBeUsed({ state })).toThrow(
      'between 1 and 32 key slots',
    );
  });
});
