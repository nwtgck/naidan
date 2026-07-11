import { describe, expect, it } from 'vitest';
import {
  EncryptedDirectoryManifestSchemaDto,
  EncryptedStoreManifestSchemaDto,
  EncryptionOperationSchemaDto,
  EncryptionStateSchemaDto,
} from './encryption.dto';

describe('encryption DTO schemas', () => {
  it('represents an encrypted state using JSON-only values', () => {
    const value = {
      formatVersion: 1,
      sequence: 4,
      state: 'encrypted',
      passphraseKeySlot: {
        pbkdf2: {
          salt: 'salt',
          iterations: 600_000,
        },
        wrappedStorageUnlockKey: {
          nonce: 'nonce',
          ciphertext: 'ciphertext',
        },
      },
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

  it('uses positive shard naming without embedding non-empty semantics', () => {
    expect(EncryptedDirectoryManifestSchemaDto.parse({
      directoryId: 'directory-id',
      modifiedAt: 1,
      shardIds: [],
    })).toEqual({
      directoryId: 'directory-id',
      modifiedAt: 1,
      shardIds: [],
    });
  });

  it('requires source IDs only for OPFS volume filesystems', () => {
    expect(EncryptedStoreManifestSchemaDto.parse({
      chatMetaShardIds: [],
      chatGroupShardIds: [],
      binaryObjectShardIds: [],
      volumeShardIds: [],
      fileSystems: [
        {
          id: 'volume-filesystem',
          type: 'opfs_volume',
          sourceId: 'volume-id',
          rootDirectoryId: 'volume-root',
        },
        {
          id: 'chat-filesystem',
          type: 'chat_wesh',
          rootDirectoryId: 'chat-root',
        },
      ],
    }).fileSystems).toHaveLength(2);
  });
});
