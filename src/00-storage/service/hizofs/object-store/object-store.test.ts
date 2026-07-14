import { describe, expect, it } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import { NativeOpfsHizoFSBackingStore } from '@/00-storage/service/hizofs/backing-store/native-opfs-backing-store';
import { importHizoFSRootKey } from '@/00-storage/service/hizofs/crypto/object-crypto';
import {
  getHizoFSObjectShard,
  validateHizoFSObjectId,
} from './object-id';
import { HizoFSObjectStore } from './object-store';

async function createStore({
  root,
  rootKeyByte,
  fileSystemId,
}: {
  root: FileSystemDirectoryHandle;
  rootKeyByte: number;
  fileSystemId: string;
}): Promise<{
  readonly backingStore: NativeOpfsHizoFSBackingStore;
  readonly store: HizoFSObjectStore;
}> {
  const backingStore = new NativeOpfsHizoFSBackingStore({ root });
  const rootKey = await importHizoFSRootKey({
    rawRootKey: new Uint8Array(32).fill(rootKeyByte),
  });
  return {
    backingStore,
    store: new HizoFSObjectStore({ backingStore, rootKey, fileSystemId }),
  };
}

describe('HizoFS immutable object store', () => {
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
        metadata: {},
        binaryPayload: new Uint8Array([1, 2, 3]),
      },
    });

    expect(objectId).toMatch(/^[A-Za-z0-9_-]{21}$/u);
    expect(await store.read({ objectId })).toEqual({
      kind: 'file_chunk',
      recordVersion: 1,
      metadata: {},
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

  it('uses the first eight Nano ID bits for canonical object sharding', () => {
    expect(getHizoFSObjectShard({ objectId: 'AAAAAAAAAAAAAAAAAAAAA' })).toBe('00');
    expect(getHizoFSObjectShard({ objectId: 'AQAAAAAAAAAAAAAAAAAAA' })).toBe('01');
    expect(getHizoFSObjectShard({ objectId: '_AAAAAAAAAAAAAAAAAAAA' })).toBe('f8');
    expect(getHizoFSObjectShard({ objectId: '---------------------' })).toBe('ff');
  });

  it('rejects non-canonical Nano ID lengths and characters', () => {
    expect(() => validateHizoFSObjectId({
      objectId: 'AAAAAAAAAAAAAAAAAAAA',
    })).toThrow('exactly 21 characters');
    expect(() => validateHizoFSObjectId({
      objectId: 'AAAAAAAAAAAAAAAAAAAA!',
    })).toThrow('canonical alphabet');
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
      path: ['objects', getHizoFSObjectShard({ objectId }), `${objectId}.enc`],
    });
    expect(physical).toBeDefined();

    const otherObjectId = 'AAAAAAAAAAAAAAAAAAAAA';
    await backingStore.write({
      path: [
        'objects',
        getHizoFSObjectShard({ objectId: otherObjectId }),
        `${otherObjectId}.enc`,
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
    expect(await backingStore.read({ path: ['superblock-1.enc'] })).toBeDefined();
  });
});
