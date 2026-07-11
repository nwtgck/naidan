import { describe, expect, it } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import {
  createEncryptionMaterial,
  deriveEncryptedStoreRuntimeKeys,
} from './encryption-key-manager';
import {
  EncryptedOPFSStorageBackend,
  TEST_ONLY,
} from './encrypted-opfs-storage-backend';
import { EncryptedObjectStore } from './encrypted-object-store';

async function createContext(): Promise<{
  backend: EncryptedOPFSStorageBackend,
  objectStore: EncryptedObjectStore,
}> {
  const material = await createEncryptionMaterial({
    passphrase: 'test passphrase',
    pbkdf2Iterations: 10,
  });
  const keys = await deriveEncryptedStoreRuntimeKeys({
    storeRootKey: material.storeRootKey,
    encryptedStoreId: 'test-store',
  });
  const storeDirectory = new MockFileSystemDirectoryHandle({ name: 'test-store' });
  return {
    backend: new EncryptedOPFSStorageBackend({ storeDirectory, keys }),
    objectStore: new EncryptedObjectStore({ storeDirectory, keys }),
  };
}

describe('EncryptedOPFSStorageBackend semantic validation', () => {
  it('rejects a persisted store manifest with duplicate shard identifiers', async () => {
    const { backend, objectStore } = await createContext();
    await objectStore.write({
      locator: { namespace: 'singleton', key: 'store_manifest' },
      plaintext: new TextEncoder().encode(JSON.stringify({
        chatMetaShardIds: ['ab', 'ab'],
        chatGroupShardIds: [],
        binaryObjectShardIds: [],
        volumeShardIds: [],
        fileSystems: [],
      })),
    });

    await expect(backend.init()).rejects.toThrow('duplicate shard ID');
  });

  it('rejects duplicate special filesystems and shared root directory identities', () => {
    expect(() => TEST_ONLY.assertEncryptedStoreManifest({
      manifest: {
        chatMetaShardIds: [],
        chatGroupShardIds: [],
        binaryObjectShardIds: [],
        volumeShardIds: [],
        fileSystems: [
          {
            id: 'chat-wesh-a',
            type: 'chat_wesh',
            rootDirectoryId: 'shared-root',
          },
          {
            id: 'chat-wesh-b',
            type: 'chat_wesh',
            rootDirectoryId: 'different-root',
          },
        ],
      },
    })).toThrow('duplicate special filesystem');

    expect(() => TEST_ONLY.assertEncryptedStoreManifest({
      manifest: {
        chatMetaShardIds: [],
        chatGroupShardIds: [],
        binaryObjectShardIds: [],
        volumeShardIds: [],
        fileSystems: [
          {
            id: 'chat-wesh',
            type: 'chat_wesh',
            rootDirectoryId: 'shared-root',
          },
          {
            id: 'debug-wesh',
            type: 'debug_wesh',
            rootDirectoryId: 'shared-root',
          },
        ],
      },
    })).toThrow('duplicate root directory ID');
  });

  it('rejects logical IDs outside their declared shard and duplicate IDs', () => {
    expect(() => TEST_ONLY.assertLogicalIdsForShard({
      ids: ['chat-ab', 'chat-cd'],
      shard: 'ab',
      fieldName: 'Chat metadata shard index',
    })).toThrow('outside shard');

    expect(() => TEST_ONLY.assertLogicalIdsForShard({
      ids: ['chat-ab', 'chat-ab'],
      shard: 'ab',
      fieldName: 'Chat metadata shard index',
    })).toThrow('duplicate ID');
  });

  it('rejects binary and volume records whose map key differs from their DTO ID', () => {
    expect(() => TEST_ONLY.assertBinaryShardIndex({
      shard: 'ab',
      index: {
        objects: {
          'object-ab': {
            id: 'different-ab',
            mimeType: 'application/octet-stream',
            size: 1,
            createdAt: 1,
            name: undefined,
          },
        },
      },
    })).toThrow('does not belong to shard');

    expect(() => TEST_ONLY.assertVolumeShardIndex({
      shard: 'ab',
      index: {
        volumes: {
          'volume-ab': {
            id: 'different-ab',
            type: 'opfs',
            name: 'Volume',
            createdAt: 1,
          },
        },
      },
    })).toThrow('does not belong to shard');
  });
});
