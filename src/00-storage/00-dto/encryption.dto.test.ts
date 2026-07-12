import { describe, expect, it } from 'vitest';
import {
  EncryptedDirectoryManifestSchemaDto,
  EncryptedFileManifestSchemaDto,
  EncryptedFileSystemDescriptorSchemaDto,
  EncryptedObjectTransactionSchemaDto,
  EncryptionOperationSchemaDto,
  EncryptionStateSchemaDto,
  NaidanEncryptedStoreManifestSchemaDto,
} from './encryption.dto';

describe('encryption DTO schemas', () => {
  it('represents an encrypted state using JSON-only generic key slots', () => {
    const value = {
      formatVersion: 1,
      sequence: 4,
      state: 'encrypted',
      keySlots: [{
        id: 'slot-id',
        keyDerivation: {
          type: 'pbkdf2_sha256',
          salt: 'salt',
          iterations: 600_000,
        },
        wrappedStorageUnlockKey: {
          nonce: 'nonce',
          ciphertext: 'ciphertext',
        },
      }],
      activeEncryptedStoreId: 'store-id',
    } as const;

    const parsed = EncryptionStateSchemaDto.parse(
      JSON.parse(JSON.stringify(value)),
    );

    expect(parsed).toEqual(value);
  });

  it('represents each transition operation explicitly', () => {
    const value = {
      type: 'reencrypting',
      phase: 'building_target',
      sourceEncryptedStoreId: 'source-store',
      targetEncryptedStoreId: 'target-store',
    } as const;

    expect(EncryptionOperationSchemaDto.parse(value)).toEqual(value);
  });

  it('stores immutable directory shard generations by reference', () => {
    const value = {
      directoryId: 'directory-id',
      revision: 3,
      createdAt: 1,
      modifiedAt: 2,
      shards: [{ shardId: '7f', objectId: 'object-id' }],
    } as const;

    expect(EncryptedDirectoryManifestSchemaDto.parse(value)).toEqual(value);
  });

  it('keeps generic encrypted filesystems independent from Naidan purposes', () => {
    const value = {
      id: 'system/chat-wesh',
      rootDirectoryId: 'root-directory-id',
      createdAt: 1,
    } as const;

    expect(EncryptedFileSystemDescriptorSchemaDto.parse(value)).toEqual(value);
  });

  it('represents an unknown imported creation time explicitly', () => {
    expect(EncryptedFileManifestSchemaDto.parse({
      fileId: 'file-id',
      revision: 0,
      size: 0,
      chunkSize: 1024,
      chunkMapPageSize: 1024,
      chunkMapPageIds: [],
      createdAt: null,
      modifiedAt: 1,
    }).createdAt).toBeNull();
  });

  it('catalogs Naidan collections without embedding every entity ID', () => {
    const value = {
      collections: [
        { type: 'chat_meta', shardIds: ['01'] },
        { type: 'binary_object', shardIds: ['7f', 'ff'] },
      ],
    } as const;

    expect(NaidanEncryptedStoreManifestSchemaDto.parse(value)).toEqual(value);
  });

  it('represents an encrypted write-ahead log using JSON-only operations', () => {
    const value = {
      id: 'transaction-id',
      scopeId: 'file-system/root-id',
      operations: [
        {
          type: 'write',
          namespace: 'directory_manifest',
          key: 'directory-id',
          plaintextBase64Url: 'encoded-json',
        },
        {
          type: 'delete',
          namespace: 'directory_shard',
          key: 'old-object-id',
        },
      ],
    } as const;

    expect(EncryptedObjectTransactionSchemaDto.parse(value)).toEqual(value);
  });
});
