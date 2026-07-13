import { describe, expect, it } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import { NativeOpfsEncryptedOpfsBackingStore } from '@/00-storage/service/encrypted-opfs/backing-store/native-opfs-backing-store';
import { importEncryptedOpfsRootKey } from '@/00-storage/service/encrypted-opfs/crypto/object-crypto';
import { getEncryptedOpfsObjectShard } from './object-id';
import { EncryptedOpfsObjectStore } from './object-store';

async function createStore({
  root,
  rootKeyByte,
  fileSystemId,
}: {
  root: FileSystemDirectoryHandle;
  rootKeyByte: number;
  fileSystemId: string;
}): Promise<{
  readonly backingStore: NativeOpfsEncryptedOpfsBackingStore;
  readonly store: EncryptedOpfsObjectStore;
}> {
  const backingStore = new NativeOpfsEncryptedOpfsBackingStore({ root });
  const rootKey = await importEncryptedOpfsRootKey({
    rawRootKey: new Uint8Array(32).fill(rootKeyByte),
  });
  return {
    backingStore,
    store: new EncryptedOpfsObjectStore({ backingStore, rootKey, fileSystemId }),
  };
}

describe('EncryptedOpfs immutable object store', () => {
  it('round-trips an authenticated record under a random opaque object ID', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const { store } = await createStore({
      root,
      rootKeyByte: 1,
      fileSystemId: 'filesystem-a',
    });

    const objectId = await store.create({
      record: {
        kind: 'file_chunk',
        recordVersion: 1,
        metadata: { nodeId: 'node', chunkIndex: 2 },
        binaryPayload: new Uint8Array([1, 2, 3]),
      },
    });

    expect(objectId).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(await store.read({ objectId })).toEqual({
      kind: 'file_chunk',
      recordVersion: 1,
      metadata: { nodeId: 'node', chunkIndex: 2 },
      binaryPayload: new Uint8Array([1, 2, 3]),
    });
  });

  it('generates independent physical object IDs for identical plaintext', async () => {
    const { store } = await createStore({
      root: new MockFileSystemDirectoryHandle({ name: 'backing' }),
      rootKeyByte: 1,
      fileSystemId: 'filesystem-a',
    });
    const record = {
      kind: 'commit' as const,
      recordVersion: 1,
      metadata: { revision: 1 },
      binaryPayload: new Uint8Array(),
    };
    const first = await store.create({ record });
    const second = await store.create({ record });
    expect(first).not.toBe(second);
  });

  it('fails authentication with a different root key or filesystem ID', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const { store } = await createStore({
      root,
      rootKeyByte: 1,
      fileSystemId: 'filesystem-a',
    });
    const objectId = await store.create({
      record: {
        kind: 'commit',
        recordVersion: 1,
        metadata: { revision: 1 },
        binaryPayload: new Uint8Array(),
      },
    });

    const wrongKey = await createStore({
      root,
      rootKeyByte: 2,
      fileSystemId: 'filesystem-a',
    });
    await expect(wrongKey.store.read({ objectId })).rejects.toThrow();

    const wrongFileSystem = await createStore({
      root,
      rootKeyByte: 1,
      fileSystemId: 'filesystem-b',
    });
    await expect(wrongFileSystem.store.read({ objectId })).rejects.toThrow();
  });

  it('binds ciphertext to its object ID', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const { backingStore, store } = await createStore({
      root,
      rootKeyByte: 1,
      fileSystemId: 'filesystem-a',
    });
    const objectId = await store.create({
      record: {
        kind: 'commit',
        recordVersion: 1,
        metadata: { revision: 1 },
        binaryPayload: new Uint8Array(),
      },
    });
    const physical = await backingStore.read({
      path: ['objects', getEncryptedOpfsObjectShard({ objectId }), `${objectId}.eopfs`],
    });
    expect(physical).toBeDefined();

    const otherObjectId = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    await backingStore.write({
      path: [
        'objects',
        getEncryptedOpfsObjectShard({ objectId: otherObjectId }),
        `${otherObjectId}.eopfs`,
      ],
      bytes: physical ?? new Uint8Array(),
    });
    await expect(store.read({ objectId: otherObjectId })).rejects.toThrow();
  });

  it('stores the two superblock slots outside the immutable object namespace', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const { backingStore, store } = await createStore({
      root,
      rootKeyByte: 1,
      fileSystemId: 'filesystem-a',
    });
    await store.writeSuperblock({
      slot: 1,
      record: {
        kind: 'superblock',
        recordVersion: 1,
        metadata: {
          sequence: 5,
          fileSystemId: 'filesystem-a',
          activeCommitObjectId: 'commit',
        },
        binaryPayload: new Uint8Array(),
      },
    });

    expect(await store.readSuperblock({ slot: 1 })).toMatchObject({
      kind: 'superblock',
      metadata: { sequence: 5 },
    });
    expect(await backingStore.read({ path: ['superblock-1.eopfs'] })).toBeDefined();
  });
});
