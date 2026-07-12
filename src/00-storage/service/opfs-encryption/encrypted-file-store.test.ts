import { describe, expect, it } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import {
  createEncryptionMaterial,
  deriveEncryptedStoreRuntimeKeys,
} from './encryption-key-manager';
import { EncryptedObjectStore } from './encrypted-object-store';
import { EncryptedFileStore, TEST_ONLY } from './encrypted-file-store';

function streamBytes({ bytes }: { bytes: Uint8Array }): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function createFileStoreContext(): Promise<{
  store: EncryptedFileStore,
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
  const objectStore = new EncryptedObjectStore({
    storeDirectory: new MockFileSystemDirectoryHandle({ name: 'test-store' }),
    keys,
    area: 'durable',
  });
  return {
    objectStore,
    store: new EncryptedFileStore({ objectStore }),
  };
}

async function createFileStore(): Promise<EncryptedFileStore> {
  return (await createFileStoreContext()).store;
}

describe('EncryptedFileStore', () => {
  it('reads only the requested file range across chunk boundaries', async () => {
    const store = await createFileStore();
    const size = TEST_ONLY.DEFAULT_CHUNK_SIZE + 19;
    const bytes = new Uint8Array(size);
    for (let index = 0; index < bytes.length; index++) {
      bytes[index] = index % 251;
    }

    await store.write({
      fileId: 'file-id',
      source: streamBytes({ bytes }),
      size: bytes.byteLength,
      modifiedAt: 1,
      signal: undefined,
    });
    const handle = await store.open({
      fileId: 'file-id',
      mimeType: 'application/octet-stream',
    });
    expect(handle?.backing).toEqual({ type: 'reader_only' });

    const target = new Uint8Array(32);
    const position = TEST_ONLY.DEFAULT_CHUNK_SIZE - 9;
    const result = await handle!.read({
      buffer: target,
      offset: 0,
      length: target.byteLength,
      position,
      signal: undefined,
    });

    expect(result.bytesRead).toBe(28);
    expect(target.subarray(0, result.bytesRead)).toEqual(
      bytes.subarray(position, position + result.bytesRead),
    );
  });

  it('rejects sources whose actual size differs from metadata', async () => {
    const store = await createFileStore();
    await expect(store.write({
      fileId: 'file-id',
      source: streamBytes({ bytes: new TextEncoder().encode('short') }),
      size: 100,
      modifiedAt: 1,
      signal: undefined,
    })).rejects.toThrow('size mismatch');
    await expect(store.open({
      fileId: 'file-id',
      mimeType: 'text/plain',
    })).resolves.toBeNull();
  });

  it('keeps a stable creation time and increments the manifest revision', async () => {
    const store = await createFileStore();
    const first = new TextEncoder().encode('first');
    const second = new TextEncoder().encode('second');
    await store.write({
      fileId: 'file-id',
      source: streamBytes({ bytes: first }),
      size: first.byteLength,
      modifiedAt: 10,
      signal: undefined,
    });
    await store.write({
      fileId: 'file-id',
      source: streamBytes({ bytes: second }),
      size: second.byteLength,
      modifiedAt: 20,
      signal: undefined,
    });

    await expect(store.readManifest({ fileId: 'file-id' })).resolves.toMatchObject({
      revision: 1,
      size: second.byteLength,
      chunkSize: TEST_ONLY.DEFAULT_CHUNK_SIZE,
      chunkMapPageSize: TEST_ONLY.DEFAULT_CHUNK_MAP_PAGE_SIZE,
      createdAt: 10,
      modifiedAt: 20,
    });
  });

  it('rejects a persisted manifest whose file ID does not match its address', async () => {
    const { store, objectStore } = await createFileStoreContext();
    await objectStore.write({
      locator: { namespace: 'file_manifest', key: 'expected-file-id' },
      plaintext: new TextEncoder().encode(JSON.stringify({
        fileId: 'different-file-id',
        revision: 0,
        size: 0,
        chunkSize: TEST_ONLY.DEFAULT_CHUNK_SIZE,
        chunkMapPageSize: TEST_ONLY.DEFAULT_CHUNK_MAP_PAGE_SIZE,
        chunkMapPageIds: [],
        createdAt: 1,
        modifiedAt: 1,
      })),
    });

    await expect(store.readManifest({
      fileId: 'expected-file-id',
    })).rejects.toThrow('manifest ID mismatch');
  });

  it('rejects a chunk-map page that aliases one chunk from multiple positions', async () => {
    const { store, objectStore } = await createFileStoreContext();
    await objectStore.write({
      locator: { namespace: 'file_manifest', key: 'file-id' },
      plaintext: new TextEncoder().encode(JSON.stringify({
        fileId: 'file-id',
        revision: 0,
        size: TEST_ONLY.DEFAULT_CHUNK_SIZE + 1,
        chunkSize: TEST_ONLY.DEFAULT_CHUNK_SIZE,
        chunkMapPageSize: TEST_ONLY.DEFAULT_CHUNK_MAP_PAGE_SIZE,
        chunkMapPageIds: ['page-id'],
        createdAt: 1,
        modifiedAt: 1,
      })),
    });
    await objectStore.write({
      locator: { namespace: 'file_chunk_map_page', key: 'page-id' },
      plaintext: new TextEncoder().encode(JSON.stringify({
        pageId: 'page-id',
        fileId: 'file-id',
        pageIndex: 0,
        chunkIds: ['shared-chunk-id', 'shared-chunk-id'],
      })),
    });

    await expect(store.truncate({
      fileId: 'file-id',
      size: 0,
      modifiedAt: 2,
    })).rejects.toThrow('invalid chunk ID');
  });

  it('rejects authenticated chunks whose size disagrees with the manifest', async () => {
    const { store, objectStore } = await createFileStoreContext();
    const bytes = new TextEncoder().encode('expected payload');
    await store.write({
      fileId: 'file-id',
      source: streamBytes({ bytes }),
      size: bytes.byteLength,
      modifiedAt: 1,
      signal: undefined,
    });
    const manifest = await store.readManifest({ fileId: 'file-id' });
    const pageId = manifest?.chunkMapPageIds[0];
    if (pageId === undefined) {
      throw new Error('Expected a persisted encrypted chunk-map page');
    }
    const pageBytes = await objectStore.read({
      locator: { namespace: 'file_chunk_map_page', key: pageId },
    });
    if (pageBytes === undefined) {
      throw new Error('Expected a persisted encrypted chunk-map page');
    }
    const page = JSON.parse(new TextDecoder().decode(pageBytes)) as {
      chunkIds: Array<string | null>,
    };
    const chunkId = page.chunkIds[0];
    if (chunkId === undefined || chunkId === null) {
      throw new Error('Expected a persisted encrypted chunk');
    }
    await objectStore.write({
      locator: { namespace: 'file_chunk', key: chunkId },
      plaintext: new TextEncoder().encode('short'),
    });

    const handle = await store.open({
      fileId: 'file-id',
      mimeType: 'application/octet-stream',
    });
    const target = new Uint8Array(bytes.byteLength);
    await expect(handle!.read({
      buffer: target,
      offset: 0,
      length: target.byteLength,
      position: 0,
      signal: undefined,
    })).rejects.toThrow('chunk size mismatch');
  });

  it('keeps an open revision readable while a replacement commits and cleans it after close', async () => {
    const store = await createFileStore();
    const first = new TextEncoder().encode('first generation');
    const second = new TextEncoder().encode('second generation');
    await store.write({
      fileId: 'file-id',
      source: streamBytes({ bytes: first }),
      size: first.byteLength,
      modifiedAt: 1,
      signal: undefined,
    });
    const firstHandle = await store.open({
      fileId: 'file-id',
      mimeType: 'text/plain',
    });
    if (firstHandle === null) {
      throw new Error('Expected the first encrypted file handle');
    }

    await store.write({
      fileId: 'file-id',
      source: streamBytes({ bytes: second }),
      size: second.byteLength,
      modifiedAt: 2,
      signal: undefined,
    });

    const firstTarget = new Uint8Array(first.byteLength);
    await expect(firstHandle.read({
      buffer: firstTarget,
      offset: 0,
      length: firstTarget.byteLength,
      position: 0,
      signal: undefined,
    })).resolves.toEqual({ bytesRead: first.byteLength });
    expect([...firstTarget]).toEqual([...first]);

    const secondHandle = await store.open({
      fileId: 'file-id',
      mimeType: 'text/plain',
    });
    if (secondHandle === null) {
      throw new Error('Expected the replacement encrypted file handle');
    }
    const secondTarget = new Uint8Array(second.byteLength);
    await secondHandle.read({
      buffer: secondTarget,
      offset: 0,
      length: secondTarget.byteLength,
      position: 0,
      signal: undefined,
    });
    expect([...secondTarget]).toEqual([...second]);

    await firstHandle.close();
    await secondHandle.close();
    await expect(firstHandle.read({
      buffer: new Uint8Array(1),
      offset: 0,
      length: 1,
      position: 0,
      signal: undefined,
    })).rejects.toThrow('handle is closed');
  });

  it('preserves chunks shared by multiple revisions until every old handle closes', async () => {
    const store = await createFileStore();
    const original = new Uint8Array(TEST_ONLY.DEFAULT_CHUNK_SIZE + 16);
    original.fill(4);
    original[TEST_ONLY.DEFAULT_CHUNK_SIZE + 5] = 7;
    await store.write({
      fileId: 'file-id',
      source: streamBytes({ bytes: original }),
      size: original.byteLength,
      modifiedAt: 1,
      signal: undefined,
    });
    const originalHandle = await store.open({
      fileId: 'file-id',
      mimeType: 'application/octet-stream',
    });
    if (originalHandle === null) {
      throw new Error('Expected the original encrypted file handle');
    }

    await store.writeRange({
      fileId: 'file-id',
      bytes: new Uint8Array([9]),
      position: 0,
      modifiedAt: 2,
      signal: undefined,
    });
    await store.writeRange({
      fileId: 'file-id',
      bytes: new Uint8Array([8]),
      position: TEST_ONLY.DEFAULT_CHUNK_SIZE + 5,
      modifiedAt: 3,
      signal: undefined,
    });

    const oldFirstByte = new Uint8Array(1);
    const oldSecondChunkByte = new Uint8Array(1);
    await originalHandle.read({
      buffer: oldFirstByte,
      offset: 0,
      length: 1,
      position: 0,
      signal: undefined,
    });
    await originalHandle.read({
      buffer: oldSecondChunkByte,
      offset: 0,
      length: 1,
      position: TEST_ONLY.DEFAULT_CHUNK_SIZE + 5,
      signal: undefined,
    });
    expect([...oldFirstByte]).toEqual([4]);
    expect([...oldSecondChunkByte]).toEqual([7]);

    const currentHandle = await store.open({
      fileId: 'file-id',
      mimeType: 'application/octet-stream',
    });
    if (currentHandle === null) {
      throw new Error('Expected the current encrypted file handle');
    }
    const currentFirstByte = new Uint8Array(1);
    const currentSecondChunkByte = new Uint8Array(1);
    await currentHandle.read({
      buffer: currentFirstByte,
      offset: 0,
      length: 1,
      position: 0,
      signal: undefined,
    });
    await currentHandle.read({
      buffer: currentSecondChunkByte,
      offset: 0,
      length: 1,
      position: TEST_ONLY.DEFAULT_CHUNK_SIZE + 5,
      signal: undefined,
    });
    expect([...currentFirstByte]).toEqual([9]);
    expect([...currentSecondChunkByte]).toEqual([8]);

    await originalHandle.close();
    await currentHandle.close();
  });

  it('serializes concurrent replacements of the same file', async () => {
    const store = await createFileStore();
    const first = new TextEncoder().encode('first');
    const second = new TextEncoder().encode('second');

    await Promise.all([
      store.write({
        fileId: 'file-id',
        source: streamBytes({ bytes: first }),
        size: first.byteLength,
        modifiedAt: 1,
        signal: undefined,
      }),
      store.write({
        fileId: 'file-id',
        source: streamBytes({ bytes: second }),
        size: second.byteLength,
        modifiedAt: 2,
        signal: undefined,
      }),
    ]);

    await expect(store.readManifest({ fileId: 'file-id' })).resolves.toMatchObject({
      revision: 1,
      modifiedAt: 2,
      size: second.byteLength,
    });
    const handle = await store.open({ fileId: 'file-id', mimeType: 'text/plain' });
    if (handle === null) {
      throw new Error('Expected the final encrypted file handle');
    }
    const target = new Uint8Array(second.byteLength);
    await handle.read({
      buffer: target,
      offset: 0,
      length: target.byteLength,
      position: 0,
      signal: undefined,
    });
    expect([...target]).toEqual([...second]);
    await handle.close();
  });

});
