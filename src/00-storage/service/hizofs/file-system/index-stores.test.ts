import { describe, expect, it, vi } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import { NativeOpfsHizoFSBackingStore } from '@/00-storage/service/hizofs/backing-store/native-opfs-backing-store';
import { importHizoFSRootKey } from '@/00-storage/service/hizofs/crypto/object-crypto';
import { createHizoFSStableId } from '@/00-storage/service/hizofs/id';
import { HizoFSObjectStore } from '@/00-storage/service/hizofs/object-store/object-store';
import { HizoFSDirectoryIndex } from './directory-index';
import { createHizoFSRuntimeDiagnostics } from './diagnostics';
import { HizoFSExtentIndex } from './extent-index';
import { HizoFSInodeIndex } from './inode-index';
import { HizoFSRecordStore } from './record-store';

async function setup() {
  const objectStore = new HizoFSObjectStore({
    backingStore: new NativeOpfsHizoFSBackingStore({
      root: new MockFileSystemDirectoryHandle({ name: 'backing' }),
      fileHandleCacheEntryLimit: 64,
      fileSnapshotCacheEntryLimit: 64,
      diagnostics: undefined,
    }),
    rootKey: await importHizoFSRootKey({
      rawRootKey: new Uint8Array(32).fill(8),
    }),
    fileSystemId: createHizoFSStableId(),
    metadataCacheByteLimit: 1024,
    metadataCacheEntryLimit: 64,
    fileChunkCacheByteLimit: 1024,
    fileChunkCacheEntryLimit: 64,
    fileChunkCacheAdmission: 'read_only',
  });
  const recordStore = new HizoFSRecordStore({ objectStore });
  return { objectStore, recordStore };
}

async function createDummyObject({ objectStore, value }: {
  objectStore: HizoFSObjectStore;
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

describe('HizoFS typed persistent indexes', () => {
  it('persists an inode index without exposing node IDs as physical paths', async () => {
    const { objectStore, recordStore } = await setup();
    const index = new HizoFSInodeIndex({
      recordStore,
      maxPageEntries: 3,
      decodedPageCacheEntryLimit: 16,
    });
    const emptyRoot = await index.createEmpty();
    let root = emptyRoot;
    const expected = new Map<string, string>();

    for (let number = 0; number < 12; number += 1) {
      const nodeId = createHizoFSStableId();
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

  it('reuses decoded inode-index pages written by the same runtime', async () => {
    const { objectStore, recordStore } = await setup();
    const readRecord = vi.spyOn(recordStore, 'read');
    const diagnostics = createHizoFSRuntimeDiagnostics();
    const cached = new HizoFSInodeIndex({
      recordStore,
      maxPageEntries: 3,
      decodedPageCacheEntryLimit: 16,
      diagnostics,
    });
    let cachedRoot = await cached.createEmpty();
    let lastNodeId = '';
    for (let number = 0; number < 6; number += 1) {
      lastNodeId = createHizoFSStableId();
      cachedRoot = await cached.set({
        rootObjectId: cachedRoot,
        entry: {
          nodeId: lastNodeId,
          inodeObjectId: await createDummyObject({
            objectStore,
            value: number,
          }),
        },
      });
    }
    expect(readRecord).not.toHaveBeenCalled();
    expect(diagnostics.snapshot().caches.decodedInodeIndexPage).toMatchObject({
      hits: expect.any(Number),
      misses: 0,
      currentEntries: expect.any(Number),
    });
    expect(
      diagnostics.snapshot().caches.decodedInodeIndexPage.hits,
    ).toBeGreaterThan(0);
    expect(
      diagnostics.snapshot().caches.decodedInodeIndexPage.currentEntries,
    ).toBeLessThanOrEqual(16);

    cached.clearDecodedPageCache();
    expect(
      diagnostics.snapshot().caches.decodedInodeIndexPage.currentEntries,
    ).toBe(0);
    await expect(cached.get({
      rootObjectId: cachedRoot,
      nodeId: lastNodeId,
    })).resolves.toMatchObject({ nodeId: lastNodeId });
    expect(readRecord).toHaveBeenCalled();
    readRecord.mockClear();

    const uncached = new HizoFSInodeIndex({
      recordStore,
      maxPageEntries: 3,
      decodedPageCacheEntryLimit: 0,
      diagnostics,
    });
    let uncachedRoot = await uncached.createEmpty();
    uncachedRoot = await uncached.set({
      rootObjectId: uncachedRoot,
      entry: {
        nodeId: createHizoFSStableId(),
        inodeObjectId: await createDummyObject({ objectStore, value: 7 }),
      },
    });
    expect(uncachedRoot).not.toBe('');
    expect(readRecord).toHaveBeenCalledTimes(1);
  });

  it('keeps directory names sorted by canonical UTF-8 bytes across split pages', async () => {
    const { recordStore } = await setup();
    const index = new HizoFSDirectoryIndex({ recordStore, maxPageEntries: 2 });
    let root = await index.createEmpty();
    for (const name of ['z', 'あ', 'a', 'ä', 'A']) {
      root = await index.set({
        rootObjectId: root,
        entry: {
          name,
          kind: 'file',
          nodeId: createHizoFSStableId(),
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
    const index = new HizoFSExtentIndex({ recordStore, maxPageEntries: 2 });
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

  it('reads each shared extent page once across many reflink traversals', async () => {
    const { objectStore, recordStore } = await setup();
    const index = new HizoFSExtentIndex({ recordStore, maxPageEntries: 2 });
    let root = await index.createEmpty();
    for (let chunkIndex = 0; chunkIndex < 12; chunkIndex += 1) {
      root = await index.set({
        rootObjectId: root,
        extent: {
          chunkIndex,
          chunkObjectId: await createDummyObject({
            objectStore,
            value: chunkIndex + 1,
          }),
        },
      });
    }

    const readSpy = vi.spyOn(recordStore, 'read');
    const visitedPageObjectIds = new Set<string>();
    const visitedChunkObjectIds = new Set<string>();
    for (let cloneIndex = 0; cloneIndex < 100; cloneIndex += 1) {
      await index.visitReferences({
        rootObjectId: root,
        visitPageObjectId: () => {},
        visitChunkObjectId: ({ objectId }) => visitedChunkObjectIds.add(objectId),
        visitedPageObjectIds,
      });
    }

    const extentPageReads = readSpy.mock.calls.filter(([request]) => (
      request.expectedKind === 'file_extent_page'
    ));
    expect(extentPageReads).toHaveLength(visitedPageObjectIds.size);
    expect(visitedChunkObjectIds.size).toBe(12);
  });
});

async function collectInodeEntries({ index, rootObjectId }: {
  index: HizoFSInodeIndex;
  rootObjectId: string;
}) {
  const entries = [];
  for await (const entry of index.entries({ rootObjectId })) {
    entries.push(entry);
  }
  return entries;
}
