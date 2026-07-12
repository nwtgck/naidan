import { describe, expect, it, vi } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import { encodeBase64Url } from '@/00-storage/service/opfs-encryption/base64-url';
import { EncryptedFileStore } from '@/00-storage/service/opfs-encryption/encrypted-file-store';
import { EncryptedFileSystemStore } from '@/00-storage/service/opfs-encryption/encrypted-file-system-store';
import {
  createEncryptionMaterial,
  deriveEncryptedStoreRuntimeKeys,
} from '@/00-storage/service/opfs-encryption/encryption-key-manager';
import { EncryptedObjectStore } from '@/00-storage/service/opfs-encryption/encrypted-object-store';
import { EncryptedStorageDebugReader } from './reader';

function streamBytes({ bytes }: { bytes: Uint8Array }): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function createContext(): Promise<{
  reader: EncryptedStorageDebugReader,
  objectStore: EncryptedObjectStore,
}> {
  const opfsRoot = new MockFileSystemDirectoryHandle({ name: 'opfs' });
  const storageRoot = await opfsRoot.getDirectoryHandle('naidan-storage', { create: true });
  const stores = await storageRoot.getDirectoryHandle('encrypted-stores', { create: true });
  const storeDirectory = await stores.getDirectoryHandle('debug-store', { create: true });
  const material = await createEncryptionMaterial({
    passphrase: 'debug inspector',
    pbkdf2Iterations: 10,
  });
  const keys = await deriveEncryptedStoreRuntimeKeys({
    storeRootKey: material.storeRootKey,
    encryptedStoreId: 'debug-store',
  });
  const objectStore = new EncryptedObjectStore({
    storeDirectory,
    keys,
    area: 'durable',
  });
  await objectStore.write({
    locator: { namespace: 'singleton', key: 'store_manifest' },
    plaintext: new TextEncoder().encode(JSON.stringify({
      collections: [
        { type: 'chat_meta', shardIds: [] },
        { type: 'chat_group', shardIds: [] },
        { type: 'binary_object', shardIds: [] },
        { type: 'volume', shardIds: [] },
      ],
    })),
  });

  const fileStore = new EncryptedFileStore({ objectStore });
  const fileSystemStore = new EncryptedFileSystemStore({ objectStore, fileStore });
  const descriptor = await fileSystemStore.createFileSystem({
    fileSystemId: 'system/chat-wesh',
    createdAt: 1,
  });
  await fileSystemStore.createDirectory({
    rootDirectoryId: descriptor.rootDirectoryId,
    path: '/workspace',
    recursive: false,
  });
  const bytes = new TextEncoder().encode('debug reader payload');
  await fileSystemStore.writeFile({
    rootDirectoryId: descriptor.rootDirectoryId,
    path: '/workspace/readme.txt',
    source: streamBytes({ bytes }),
    size: bytes.byteLength,
    modifiedAt: 2,
    signal: undefined,
  });

  return {
    objectStore,
    reader: new EncryptedStorageDebugReader({
      capability: {
        storageRoot,
        storeDirectory,
        encryptedStoreId: 'debug-store',
        objectEncryptionKey: keys.objectEncryptionKey,
        objectAddressKey: keys.objectAddressKey,
      },
    }),
  };
}

describe('EncryptedStorageDebugReader', () => {
  it('navigates from a Naidan filesystem to encrypted manifests and chunks', async () => {
    const { reader } = await createContext();

    const root = await reader.loadNode({ ref: { type: 'root' } });
    expect(root.references).toContainEqual({
      label: 'Filesystem: system/chat-wesh',
      ref: {
        type: 'file_system',
        area: 'durable',
        fileSystemId: 'system/chat-wesh',
      },
    });

    const searchResults = await reader.search({ query: 'readme.txt' });
    expect(searchResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: expect.stringContaining('readme.txt'),
        ref: expect.objectContaining({
          type: 'logical_object',
          namespace: 'file_manifest',
        }),
      }),
    ]));

    const report = await reader.scanIntegrity();
    expect(report.scannedPhysicalObjects).toBeGreaterThan(5);
    expect(report.findings).toEqual([]);
  });

  it('does not decrypt file content chunks while searching the logical graph', async () => {
    const { reader } = await createContext();
    const readSpy = vi.spyOn(EncryptedObjectStore.prototype, 'read');

    try {
      await reader.search({ query: 'readme.txt' });

      expect(readSpy.mock.calls.some(([arguments_]) => (
        arguments_.locator.namespace === 'file_chunk'
      ))).toBe(false);
    } finally {
      readSpy.mockRestore();
    }
  });

  it('returns a bounded Worker preview for a large decoded object', async () => {
    const { reader, objectStore } = await createContext();
    const value = {
      largeText: 'x'.repeat(20_000),
    };
    await objectStore.write({
      locator: { namespace: 'debug_large_json', key: 'large' },
      plaintext: new TextEncoder().encode(JSON.stringify(value)),
    });

    const node = await reader.loadNode({
      ref: {
        type: 'logical_object',
        area: 'durable',
        namespace: 'debug_large_json',
        key: 'large',
      },
    });

    expect(node.warnings).toContainEqual(expect.stringContaining('preview was truncated'));
    expect(node.value).toEqual({
      largeText: expect.stringContaining('characters omitted'),
    });
    expect(JSON.stringify(node.value).length).toBeLessThan(JSON.stringify(value).length);

    const stored = await reader.loadPersistedJson({
      ref: {
        type: 'logical_object',
        area: 'durable',
        namespace: 'debug_large_json',
        key: 'large',
      },
    });
    expect(stored).toEqual({
      json: JSON.stringify(value),
      parseStatus: 'valid',
      source: 'decrypted_persisted_bytes',
    });
    expect(stored?.json).not.toContain('$debugInspectorTruncated');
  });


  it('does not present binary file chunks as persisted JSON DTOs', async () => {
    const { reader, objectStore } = await createContext();
    await objectStore.write({
      locator: { namespace: 'file_chunk', key: 'binary-chunk' },
      plaintext: new Uint8Array([0, 1, 2, 255]),
    });

    await expect(reader.loadPersistedJson({
      ref: {
        type: 'logical_object',
        area: 'durable',
        namespace: 'file_chunk',
        key: 'binary-chunk',
      },
    })).resolves.toBeUndefined();
  });

  it('supports explicit temporary locators and reverse navigation from physical objects', async () => {
    const { reader, objectStore } = await createContext();

    const temporaryResults = await reader.search({
      query: 'temporary/file_system_descriptor:system/tmp',
    });
    expect(temporaryResults[0]).toEqual({
      label: 'temporary/file_system_descriptor:system/tmp',
      detail: 'Direct temporary logical object locator',
      ref: {
        type: 'logical_object',
        area: 'temporary',
        namespace: 'file_system_descriptor',
        key: 'system/tmp',
      },
    });

    const locator = { namespace: 'singleton', key: 'store_manifest' };
    const address = await objectStore.getObjectAddress({ locator });
    const physicalNode = await reader.loadNode({
      ref: {
        type: 'physical_object',
        area: 'durable',
        objectId: address.objectId,
        shardId: address.shardId,
      },
    });

    expect(physicalNode.references).toContainEqual({
      label: 'Logical locator: singleton:store_manifest',
      ref: {
        type: 'logical_object',
        area: 'durable',
        namespace: 'singleton',
        key: 'store_manifest',
      },
    });
  });

  it('reports and opens a physical object outside the known Naidan graph', async () => {
    const { reader, objectStore } = await createContext();
    const locator = { namespace: 'debug_orphan', key: 'orphan' };
    await objectStore.write({
      locator,
      plaintext: new TextEncoder().encode('orphan payload'),
    });
    const address = await objectStore.getObjectAddress({ locator });

    const report = await reader.scanIntegrity();
    expect(report.findings).toContainEqual(expect.objectContaining({
      severity: 'warning',
      message: expect.stringContaining(address.path),
      ref: {
        type: 'physical_object',
        area: 'durable',
        objectId: address.objectId,
        shardId: address.shardId,
      },
    }));

    const node = await reader.loadNode({
      ref: {
        type: 'physical_object',
        area: 'durable',
        objectId: address.objectId,
        shardId: address.shardId,
      },
    });
    expect(node.kind).toBe('physical_encrypted_object');
    expect(node.physicalPath).toBe(address.path);
    expect(node.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Authentication', value: 'valid' }),
    ]));
  });

  it('treats immutable objects referenced by a pending WAL payload as prepared rather than orphaned', async () => {
    const { reader, objectStore } = await createContext();
    const fileId = 'prepared-file';
    const pageId = 'prepared-page';
    const chunkId = 'prepared-chunk';
    const chunk = new TextEncoder().encode('prepared payload');
    await objectStore.write({
      locator: { namespace: 'file_chunk', key: chunkId },
      plaintext: chunk,
    });
    await objectStore.write({
      locator: { namespace: 'file_chunk_map_page', key: pageId },
      plaintext: new TextEncoder().encode(JSON.stringify({
        pageId,
        fileId,
        pageIndex: 0,
        chunkIds: [chunkId],
      })),
    });
    const manifest = new TextEncoder().encode(JSON.stringify({
      fileId,
      revision: 0,
      size: chunk.byteLength,
      chunkSize: 1024 * 1024,
      chunkMapPageSize: 1024,
      chunkMapPageIds: [pageId],
      createdAt: 3,
      modifiedAt: 3,
    }));
    await objectStore.write({
      locator: { namespace: 'object_transaction_journal', key: 'naidan-store' },
      plaintext: new TextEncoder().encode(JSON.stringify({
        id: 'prepared-transaction',
        scopeId: 'naidan-store',
        operations: [{
          type: 'write',
          namespace: 'file_manifest',
          key: fileId,
          plaintextBase64Url: encodeBase64Url({ bytes: manifest }),
        }],
      })),
    });

    const report = await reader.scanIntegrity();

    expect(report.findings).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: 'warning',
        message: expect.stringContaining('not reachable'),
      }),
    ]));
    expect(report.findings).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining('file_manifest:prepared-file'),
      }),
    ]));
  });

});
