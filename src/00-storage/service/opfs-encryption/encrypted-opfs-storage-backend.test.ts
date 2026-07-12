import { describe, expect, it, vi } from 'vitest';
import type { NaidanEncryptedStoreManifestDto } from '@/00-storage/00-dto/encryption.dto';
import { toBinaryObjectId } from '@/01-models/ids';
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

const EMPTY_COLLECTIONS: NaidanEncryptedStoreManifestDto['collections'] = [
  { type: 'chat_meta', shardIds: [] },
  { type: 'chat_group', shardIds: [] },
  { type: 'binary_object', shardIds: [] },
  { type: 'volume', shardIds: [] },
];

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
    backend: new EncryptedOPFSStorageBackend({
      encryptedStoreId: 'test-store',
      storeDirectory,
      keys,
    }),
    objectStore: new EncryptedObjectStore({ storeDirectory, keys, area: 'durable' }),
  };
}

describe('EncryptedOPFSStorageBackend semantic validation', () => {
  it('rejects a persisted store manifest with duplicate shard identifiers', async () => {
    const { backend, objectStore } = await createContext();
    await objectStore.write({
      locator: { namespace: 'singleton', key: 'store_manifest' },
      plaintext: new TextEncoder().encode(JSON.stringify({
        collections: EMPTY_COLLECTIONS.map(collection =>
          collection.type === 'chat_meta'
            ? { ...collection, shardIds: ['ab', 'ab'] }
            : collection,
        ),
      })),
    });

    await expect(backend.init()).rejects.toThrow('duplicate shard ID');
  });

  it('does not reinterpret a missing active store manifest as an empty store', async () => {
    const { backend, objectStore } = await createContext();
    await backend.initializeNewStore();
    await backend.init();
    await objectStore.delete({
      locator: { namespace: 'singleton', key: 'store_manifest' },
    });

    await expect(backend.listChatMetasRaw()).rejects.toThrow(
      'Encrypted store manifest is missing',
    );
  });

  it('does not reinterpret registered missing collection indexes as empty shards', async () => {
    const cases: Array<{
      type: NaidanEncryptedStoreManifestDto['collections'][number]['type'],
      read: (backend: EncryptedOPFSStorageBackend) => Promise<void>,
      expectedMessage: string,
    }> = [
      {
        type: 'chat_meta',
        read: async backend => {
          await backend.listChatMetasRaw();
        },
        expectedMessage: 'Registered encrypted chat metadata shard index is missing',
      },
      {
        type: 'chat_group',
        read: async backend => {
          await backend.listChatGroupsRaw();
        },
        expectedMessage: 'Registered encrypted chat group shard index is missing',
      },
      {
        type: 'binary_object',
        read: async backend => {
          for await (const _object of backend.listBinaryObjects()) {
            // The missing registered index must fail before yielding entries.
          }
        },
        expectedMessage: 'Registered encrypted binary shard index is missing',
      },
      {
        type: 'volume',
        read: async backend => {
          for await (const _volume of backend.listVolumes()) {
            // The missing registered index must fail before yielding entries.
          }
        },
        expectedMessage: 'Registered encrypted volume shard index is missing',
      },
    ];

    for (const testCase of cases) {
      const { backend, objectStore } = await createContext();
      await backend.initializeNewStore();
      await objectStore.write({
        locator: { namespace: 'singleton', key: 'store_manifest' },
        plaintext: new TextEncoder().encode(JSON.stringify({
          collections: EMPTY_COLLECTIONS.map(collection =>
            collection.type === testCase.type
              ? { ...collection, shardIds: ['ab'] }
              : collection,
          ),
        })),
      });

      await expect(testCase.read(backend)).rejects.toThrow(testCase.expectedMessage);
    }
  });

  it('rejects duplicate and missing collection declarations', () => {
    expect(() => TEST_ONLY.assertEncryptedStoreManifest({
      manifest: {
        collections: [
          ...EMPTY_COLLECTIONS,
          { type: 'chat_meta', shardIds: [] },
        ],
      },
    })).toThrow('duplicate collection');

    expect(() => TEST_ONLY.assertEncryptedStoreManifest({
      manifest: {
        collections: EMPTY_COLLECTIONS.filter(collection => collection.type !== 'volume'),
      },
    })).toThrow('missing collection: volume');
  });

  it('rejects malformed collection shard identifiers', () => {
    expect(() => TEST_ONLY.assertEncryptedStoreManifest({
      manifest: {
        collections: EMPTY_COLLECTIONS.map(collection =>
          collection.type === 'chat_group'
            ? { ...collection, shardIds: ['not-a-shard'] }
            : collection,
        ),
      },
    })).toThrow('invalid shard ID');
  });

  it('rejects binary and volume records whose map key differs from their DTO ID', () => {
    expect(() => TEST_ONLY.assertBinaryShardIndex({
      index: {
        objects: {
          'object-id': {
            metadata: {
              id: 'different-id',
              mimeType: 'application/octet-stream',
              size: 1,
              createdAt: 1,
              name: undefined,
            },
            fileId: 'file-id',
          },
        },
      },
    })).toThrow('does not match its DTO ID');

    expect(() => TEST_ONLY.assertVolumeShardIndex({
      index: {
        volumes: {
          'volume-id': {
            id: 'different-id',
            type: 'opfs',
            name: 'Volume',
            createdAt: 1,
          },
        },
      },
    })).toThrow('does not match its DTO ID');
  });

  it('rejects an empty binary file identity', () => {
    expect(() => TEST_ONLY.assertBinaryShardIndex({
      index: {
        objects: {
          'object-id': {
            metadata: {
              id: 'object-id',
              mimeType: 'application/octet-stream',
              size: 1,
              createdAt: 1,
              name: undefined,
            },
            fileId: '',
          },
        },
      },
    })).toThrow('empty file ID');
  });

  it('acknowledges a durable binary index transaction and completes it during recovery', async () => {
    const { backend } = await createContext();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await backend.initializeNewStore();
    const binaryObjectId = toBinaryObjectId({ raw: 'debug-binary-object' });
    const originalWrite = EncryptedObjectStore.prototype.write;
    let journalPersisted = false;
    let injectedFailure = false;
    const writeSpy = vi.spyOn(EncryptedObjectStore.prototype, 'write').mockImplementation(async function(this: EncryptedObjectStore, args) {
      if (
        journalPersisted
        && !injectedFailure
        && args.locator.namespace === 'singleton'
        && args.locator.key === 'store_manifest'
      ) {
        injectedFailure = true;
        throw new Error('injected store manifest interruption');
      }
      await originalWrite.call(this, args);
      if (
        args.locator.namespace === 'object_transaction_journal'
        && args.locator.key === 'naidan-store'
      ) {
        journalPersisted = true;
      }
    });

    await expect(backend.writeBinaryObject({
      source: { type: 'direct_blob', blob: new Blob(['recoverable payload']) },
      binaryObjectId,
      name: 'payload.txt',
      mimeType: 'text/plain',
      size: 19,
      createdAt: 1,
      signal: undefined,
    })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      'Encrypted object mutation is committed and pending recovery',
      expect.objectContaining({ message: 'injected store manifest interruption' }),
    );
    writeSpy.mockRestore();

    await backend.init();
    const handle = await backend.openBinaryObject({ binaryObjectId });
    expect(handle).not.toBeNull();
    const target = new Uint8Array(19);
    const result = await handle!.read({
      buffer: target,
      offset: 0,
      length: target.byteLength,
      position: 0,
      signal: undefined,
    });
    await handle!.close();

    expect(result.bytesRead).toBe(19);
    expect(new TextDecoder().decode(target)).toBe('recoverable payload');
    await expect(backend.getBinaryObject({ binaryObjectId })).resolves.toMatchObject({
      name: 'payload.txt',
      mimeType: 'text/plain',
      size: 19,
    });
    warn.mockRestore();
  });

});
