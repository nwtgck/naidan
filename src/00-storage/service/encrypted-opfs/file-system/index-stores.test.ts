import { describe, expect, it } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import { NativeOpfsEncryptedOpfsBackingStore } from '@/00-storage/service/encrypted-opfs/backing-store/native-opfs-backing-store';
import { importEncryptedOpfsRootKey } from '@/00-storage/service/encrypted-opfs/crypto/object-crypto';
import { createEncryptedOpfsStableId } from '@/00-storage/service/encrypted-opfs/id';
import { EncryptedOpfsObjectStore } from '@/00-storage/service/encrypted-opfs/object-store/object-store';
import { EncryptedOpfsDirectoryIndex } from './directory-index';
import { EncryptedOpfsExtentIndex } from './extent-index';
import { EncryptedOpfsInodeIndex } from './inode-index';
import { EncryptedOpfsRecordStore } from './record-store';

async function setup() {
  const objectStore = new EncryptedOpfsObjectStore({
    backingStore: new NativeOpfsEncryptedOpfsBackingStore({
      root: new MockFileSystemDirectoryHandle({ name: 'backing' }),
    }),
    rootKey: await importEncryptedOpfsRootKey({
      rawRootKey: new Uint8Array(32).fill(8),
    }),
    fileSystemId: createEncryptedOpfsStableId(),
  });
  const recordStore = new EncryptedOpfsRecordStore({ objectStore });
  return { objectStore, recordStore };
}

async function createDummyObject({ objectStore, value }: {
  objectStore: EncryptedOpfsObjectStore;
  value: number;
}): Promise<string> {
  return objectStore.create({
    record: {
      kind: 'file_chunk',
      recordVersion: 1,
      metadata: { value },
      binaryPayload: new Uint8Array([value]),
    },
  });
}

describe('EncryptedOpfs typed persistent indexes', () => {
  it('persists an inode index without exposing node IDs as physical paths', async () => {
    const { objectStore, recordStore } = await setup();
    const index = new EncryptedOpfsInodeIndex({ recordStore, maxPageEntries: 3 });
    const emptyRoot = await index.createEmpty();
    let root = emptyRoot;
    const expected = new Map<string, string>();

    for (let number = 0; number < 12; number += 1) {
      const nodeId = createEncryptedOpfsStableId();
      const inodeObjectId = await createDummyObject({ objectStore, value: number });
      expected.set(nodeId, inodeObjectId);
      root = await index.set({
        rootObjectId: root,
        entry: { nodeId, inodeObjectId },
      });
    }

    expect([...expected]).not.toEqual([]);
    for (const [nodeId, inodeObjectId] of expected) {
      await expect(index.get({ rootObjectId: root, nodeId })).resolves.toEqual({
        nodeId,
        inodeObjectId,
      });
    }
    expect([...await collectInodeEntries({ index, rootObjectId: emptyRoot })]).toEqual([]);
  });

  it('keeps directory names sorted by canonical UTF-8 bytes across split pages', async () => {
    const { recordStore } = await setup();
    const index = new EncryptedOpfsDirectoryIndex({ recordStore, maxPageEntries: 2 });
    let root = await index.createEmpty();
    for (const name of ['z', 'あ', 'a', 'ä', 'A']) {
      root = await index.set({
        rootObjectId: root,
        entry: {
          name,
          kind: 'file',
          nodeId: createEncryptedOpfsStableId(),
        },
      });
    }

    const names: string[] = [];
    for await (const entry of index.entries({ rootObjectId: root })) {
      names.push(entry.name);
    }
    const encoded = new TextEncoder();
    const expected = [...names].sort((left, right) => {
      const leftBytes = encoded.encode(left);
      const rightBytes = encoded.encode(right);
      for (let index = 0; index < Math.min(leftBytes.length, rightBytes.length); index += 1) {
        const difference = leftBytes[index]! - rightBytes[index]!;
        if (difference !== 0) return difference;
      }
      return leftBytes.length - rightBytes.length;
    });
    expect(names).toEqual(expected);
  });

  it('stores sparse extents without entries for holes', async () => {
    const { objectStore, recordStore } = await setup();
    const index = new EncryptedOpfsExtentIndex({ recordStore, maxPageEntries: 2 });
    let root = await index.createEmpty();
    const chunk0 = await createDummyObject({ objectStore, value: 1 });
    const chunk9 = await createDummyObject({ objectStore, value: 9 });
    root = await index.set({
      rootObjectId: root,
      extent: { chunkIndex: 0, chunkObjectId: chunk0 },
    });
    root = await index.set({
      rootObjectId: root,
      extent: { chunkIndex: 9, chunkObjectId: chunk9 },
    });

    expect(await index.get({ rootObjectId: root, chunkIndex: 4 })).toBeUndefined();
    expect(await index.get({ rootObjectId: root, chunkIndex: 9 })).toEqual({
      chunkIndex: 9,
      chunkObjectId: chunk9,
    });
  });
});

async function collectInodeEntries({ index, rootObjectId }: {
  index: EncryptedOpfsInodeIndex;
  rootObjectId: string;
}) {
  const entries = [];
  for await (const entry of index.entries({ rootObjectId })) {
    entries.push(entry);
  }
  return entries;
}
