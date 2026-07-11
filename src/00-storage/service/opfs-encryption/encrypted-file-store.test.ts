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
  it('reads only the requested logical range across chunk boundaries', async () => {
    const store = await createFileStore();
    const size = TEST_ONLY.DEFAULT_LOGICAL_CHUNK_SIZE + 19;
    const bytes = new Uint8Array(size);
    for (let index = 0; index < bytes.length; index++) {
      bytes[index] = index % 251;
    }

    await store.write({
      fileId: 'file-id',
      source: streamBytes({ bytes }),
      logicalSize: bytes.byteLength,
      modifiedAt: 1,
      signal: undefined,
    });
    const handle = await store.open({
      fileId: 'file-id',
      mimeType: 'application/octet-stream',
    });
    expect(handle?.backing).toEqual({ type: 'reader_only' });

    const target = new Uint8Array(32);
    const position = TEST_ONLY.DEFAULT_LOGICAL_CHUNK_SIZE - 9;
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
      logicalSize: 100,
      modifiedAt: 1,
      signal: undefined,
    })).rejects.toThrow('size mismatch');
    await expect(store.open({
      fileId: 'file-id',
      mimeType: 'text/plain',
    })).resolves.toBeNull();
  });

  it('rejects a persisted manifest whose file ID does not match its address', async () => {
    const { store, objectStore } = await createFileStoreContext();
    await objectStore.write({
      locator: { namespace: 'file_manifest', key: 'expected-file-id' },
      plaintext: new TextEncoder().encode(JSON.stringify({
        fileId: 'different-file-id',
        logicalSize: 0,
        logicalChunkSize: TEST_ONLY.DEFAULT_LOGICAL_CHUNK_SIZE,
        modifiedAt: 1,
        chunkIds: [],
      })),
    });

    await expect(store.readManifest({
      fileId: 'expected-file-id',
    })).rejects.toThrow('manifest ID mismatch');
  });

  it('rejects a persisted manifest that aliases one chunk from multiple positions', async () => {
    const { store, objectStore } = await createFileStoreContext();
    await objectStore.write({
      locator: { namespace: 'file_manifest', key: 'file-id' },
      plaintext: new TextEncoder().encode(JSON.stringify({
        fileId: 'file-id',
        logicalSize: TEST_ONLY.DEFAULT_LOGICAL_CHUNK_SIZE + 1,
        logicalChunkSize: TEST_ONLY.DEFAULT_LOGICAL_CHUNK_SIZE,
        modifiedAt: 1,
        chunkIds: ['shared-chunk-id', 'shared-chunk-id'],
      })),
    });

    await expect(store.readManifest({
      fileId: 'file-id',
    })).rejects.toThrow('duplicate chunk ID');
  });

  it('rejects authenticated chunks whose size disagrees with the manifest', async () => {
    const { store, objectStore } = await createFileStoreContext();
    const bytes = new TextEncoder().encode('expected payload');
    await store.write({
      fileId: 'file-id',
      source: streamBytes({ bytes }),
      logicalSize: bytes.byteLength,
      modifiedAt: 1,
      signal: undefined,
    });
    const manifest = await store.readManifest({ fileId: 'file-id' });
    const chunkId = manifest?.chunkIds[0];
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
});
