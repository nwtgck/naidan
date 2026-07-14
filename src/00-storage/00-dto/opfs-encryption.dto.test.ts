import { describe, expect, it } from 'vitest';
import {
  OpfsEncryptedStoreHeaderSchemaDto,
  OpfsEncryptionStateSchemaDto,
} from './opfs-encryption.dto';

describe('OPFS encryption integration DTO schemas', () => {
  it('parses encrypted state with generic key slots', () => {
    expect(OpfsEncryptionStateSchemaDto.parse({
      formatVersion: 1,
      sequence: 1,
      state: 'encrypted',
      keySlots: [{
        id: 'slot-id',
        keyDerivation: {
          type: 'pbkdf2_hmac_sha256',
          salt: 'salt',
          iterations: 600000,
        },
        wrappedStorageUnlockKey: {
          nonce: 'nonce',
          ciphertext: 'ciphertext',
        },
      }],
      activeEncryptedStoreId: 'store-id',
    }).state).toBe('encrypted');
  });

  it('parses transition state without duplicated authority', () => {
    const state = OpfsEncryptionStateSchemaDto.parse({
      formatVersion: 1,
      sequence: 2,
      state: 'transitioning',
      keySlots: [],
      operation: {
        type: 'reencrypting',
        phase: 'cleaning_up_source',
        sourceEncryptedStoreId: 'source',
        targetEncryptedStoreId: 'target',
      },
    });
    expect(state).not.toHaveProperty('authority');
  });

  it('keeps key management outside the HizoFS descriptor', () => {
    expect(OpfsEncryptedStoreHeaderSchemaDto.parse({
      formatVersion: 1,
      encryptedStoreId: 'store-id',
      fileSystemId: 'filesystem-id',
      wrappedFileSystemRootKey: {
        nonce: 'nonce',
        ciphertext: 'ciphertext',
      },
    })).toEqual({
      formatVersion: 1,
      encryptedStoreId: 'store-id',
      fileSystemId: 'filesystem-id',
      wrappedFileSystemRootKey: {
        nonce: 'nonce',
        ciphertext: 'ciphertext',
      },
    });
  });
});
