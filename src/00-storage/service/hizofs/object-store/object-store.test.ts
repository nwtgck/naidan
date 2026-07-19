import { describe, expect, it, vi } from 'vitest';
import { decodeBase64Url, encodeBase64Url } from '@/00-storage/service/hizofs/base64-url';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import { NativeOpfsHizoFSBackingStore } from '@/00-storage/service/hizofs/backing-store/native-opfs-backing-store';
import { importHizoFSRootKey } from '@/00-storage/service/hizofs/crypto/object-crypto';
import {
  createHizoFSRuntimeDiagnostics,
  type HizoFSRuntimeDiagnostics,
} from '@/00-storage/service/hizofs/file-system/diagnostics';
import {
  getHizoFSObjectShard,
  validateHizoFSObjectId,
} from './object-id';
import { HizoFSObjectStore } from './object-store';
import {
  decodeHizoFSObjectReference,
  encodeHizoFSSegmentId,
  getHizoFSSegmentShard,
} from '@/00-storage/service/hizofs/segment-store/object-reference';

const FILE_SYSTEM_ID_A = encodeBase64Url({ bytes: new Uint8Array(16).fill(0xa1) });
const FILE_SYSTEM_ID_B = encodeBase64Url({ bytes: new Uint8Array(16).fill(0xb2) });

async function createStore({
  root,
  rootKeyByte,
  fileSystemId,
  fileChunkCacheAdmission = 'read_only',
  diagnostics,
}: {
  root: FileSystemDirectoryHandle;
  rootKeyByte: number;
  fileSystemId: string;
  fileChunkCacheAdmission?: 'read_only' | 'read_write';
  diagnostics?: HizoFSRuntimeDiagnostics;
}): Promise<{
  readonly backingStore: NativeOpfsHizoFSBackingStore;
  readonly store: HizoFSObjectStore;
}> {
  const backingStore = new NativeOpfsHizoFSBackingStore({
    root,
    fileHandleCacheEntryLimit: 64,
    fileSnapshotCacheEntryLimit: 64,
    diagnostics,
  });
  const rootKey = await importHizoFSRootKey({
    rawRootKey: new Uint8Array(32).fill(rootKeyByte),
  });
  return {
    backingStore,
    store: new HizoFSObjectStore({
      backingStore,
      rootKey,
      fileSystemId,
      metadataCacheByteLimit: 1024,
      metadataCacheEntryLimit: 64,
      fileChunkCacheByteLimit: 1024,
      fileChunkCacheEntryLimit: 64,
      fileChunkCacheAdmission,
      diagnostics,
    }),
  };
}

async function publishStore({
  store,
  fileSystemId,
  activeCommitObjectId,
  sequence = 0,
}: {
  store: HizoFSObjectStore;
  fileSystemId: string;
  activeCommitObjectId: string;
  sequence?: number;
}): Promise<void> {
  await store.writeSuperblock({
    slot: (sequence % 2) as 0 | 1,
    record: {
      kind: 'superblock',
      recordVersion: 1,
      metadata: { sequence, fileSystemId, activeCommitObjectId },
      binaryPayload: new Uint8Array(),
    },
  });
}

describe('HizoFS immutable object store', () => {
  it('persists authenticated indexes for sealed segments and falls back after index corruption', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const diagnostics = createHizoFSRuntimeDiagnostics();
    const { backingStore, store } = await createStore({
      root,
      rootKeyByte: 1,
      fileSystemId: FILE_SYSTEM_ID_A,
      diagnostics,
    });
    const objectIds = await store.createMany({
      records: [1, 2].map(value => ({
        kind: 'file_chunk' as const,
        recordVersion: 1,
        metadata: {},
        binaryPayload: new Uint8Array([value]),
      })),
    });
    await publishStore({
      store,
      fileSystemId: FILE_SYSTEM_ID_A,
      activeCommitObjectId: objectIds[0] ?? '',
    });
    await store.releasePhysicalHandles();

    const candidates = await store.selectWholeSegmentReclaimCandidates({
      unreachableObjectIds: objectIds,
    });
    expect(candidates).toHaveLength(1);

    const reference = decodeHizoFSObjectReference({ value: objectIds[0] ?? '' });
    const encodedSegmentId = encodeHizoFSSegmentId({ segmentId: reference.homeSegmentId });
    const indexPath = [
      'segment-indexes',
      'data',
      getHizoFSSegmentShard({ segmentId: reference.homeSegmentId }),
      `${encodedSegmentId}.idx`,
    ] as const;
    const indexBytes = await backingStore.read({ path: indexPath });
    expect(indexBytes).toBeDefined();

    const dataSegmentPath = [
      'segments',
      'data',
      getHizoFSSegmentShard({ segmentId: reference.homeSegmentId }),
      `${encodedSegmentId}.seg`,
    ] as const;
    const readRange = vi.spyOn(backingStore, 'readRange');
    await store.selectWholeSegmentReclaimCandidates({ unreachableObjectIds: objectIds });
    const indexedDataReads = readRange.mock.calls.filter(([arguments_]) =>
      arguments_.path.join('/') === dataSegmentPath.join('/')
    );
    expect(indexedDataReads).toHaveLength(1);
    readRange.mockClear();

    if (indexBytes === undefined) throw new Error('Expected a sealed-segment index');
    const corrupted = indexBytes.slice();
    const corruptedLastByte = corrupted.at(-1);
    if (corruptedLastByte === undefined) throw new Error('Expected non-empty authenticated bytes');
    corrupted[corrupted.byteLength - 1] = corruptedLastByte ^ 1;
    await backingStore.write({ path: indexPath, bytes: corrupted });
    const listing = await store.listPhysicalObjects();
    expect(listing.entries.map(entry => entry.objectId)).toEqual(
      expect.arrayContaining([...objectIds]),
    );
    expect(listing.ignoredPhysicalPaths).toContain(indexPath.join('/'));
    const rebuiltDataReads = readRange.mock.calls.filter(([arguments_]) =>
      arguments_.path.join('/') === dataSegmentPath.join('/')
    );
    expect(rebuiltDataReads).toHaveLength(3);
    await store.close();
  });
  it('plans and completes partial-live compaction without breaking logical object IDs', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const { store } = await createStore({
      root,
      rootKeyByte: 1,
      fileSystemId: FILE_SYSTEM_ID_A,
    });
    const objectIds: string[] = [];
    for (let batchStart = 0; batchStart < 8; batchStart += 2) {
      objectIds.push(...await store.createMany({
        records: [batchStart, batchStart + 1].map(index => ({
          kind: 'file_chunk' as const,
          recordVersion: 1,
          metadata: { chunkSize: 262144 },
          binaryPayload: new Uint8Array(262144).fill(index + 1),
        })),
      }));
    }
    await publishStore({
      store,
      fileSystemId: FILE_SYSTEM_ID_A,
      activeCommitObjectId: objectIds[0] ?? '',
    });
    await store.releasePhysicalHandles();
    const liveObjectIds = objectIds.slice(0, 2);
    const deadObjectIds = objectIds.slice(2);
    await expect(store.selectPartialSegmentCompactionCandidates({
      reachableObjectIds: liveObjectIds,
      minimumDeadRecordByteLength: 1024 * 1024,
      maximumLiveRecordByteLength: 1024 * 1024,
      maximumLiveRecordCount: 1,
      maximumCandidateCount: 1,
    })).resolves.toEqual([]);
    const [candidate] = await store.selectPartialSegmentCompactionCandidates({
      reachableObjectIds: liveObjectIds,
      minimumDeadRecordByteLength: 1024 * 1024,
      maximumLiveRecordByteLength: 1024 * 1024,
      maximumLiveRecordCount: 16,
      maximumCandidateCount: 1,
    });
    if (candidate === undefined) throw new Error('Expected one partial-live compaction candidate');
    expect(candidate.liveObjectIds).toEqual(liveObjectIds);
    expect(candidate.deadObjectIds).toEqual(deadObjectIds);

    const mappings = await store.copyObjectsForRelocation({ objectIds: candidate.liveObjectIds });
    await store.publishRelocations({ mappings });
    await expect(store.removeWholeSegmentIfUnchanged({
      candidate: {
        representativeObjectId: candidate.representativeObjectId,
        objectIds,
        physicalPath: candidate.physicalPath,
        expectedPhysicalByteLength: candidate.expectedPhysicalByteLength,
      },
    })).resolves.toBe('removed');
    await expect(store.read({ objectId: liveObjectIds[0] ?? '' })).resolves.toMatchObject({
      kind: 'file_chunk',
      binaryPayload: new Uint8Array(262144).fill(1),
    });
    await expect(store.read({ objectId: deadObjectIds[0] ?? '' })).resolves.toBeUndefined();
    const relocationTargets = await Promise.all(liveObjectIds.map(async objectId => (
      store.resolveObjectId({ objectId })
    )));
    expect(relocationTargets.every((target, index) => target !== liveObjectIds[index])).toBe(true);
    await store.close();
  });

  it('resolves relocated objects after the source segment is removed and after reopening', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const first = await createStore({
      root,
      rootKeyByte: 1,
      fileSystemId: FILE_SYSTEM_ID_A,
    });
    const [sourceObjectId] = await first.store.createMany({
      records: [{
        kind: 'file_chunk',
        recordVersion: 1,
        metadata: { chunkSize: 3 },
        binaryPayload: new Uint8Array([1, 2, 3]),
      }],
    });
    if (sourceObjectId === undefined) throw new Error('Expected one source object');
    await publishStore({
      store: first.store,
      fileSystemId: FILE_SYSTEM_ID_A,
      activeCommitObjectId: sourceObjectId,
    });
    await first.store.releasePhysicalHandles();
    const [candidate] = await first.store.selectWholeSegmentReclaimCandidates({
      unreachableObjectIds: [sourceObjectId],
    });
    if (candidate === undefined) throw new Error('Expected one source segment candidate');

    const mappings = await first.store.copyObjectsForRelocation({ objectIds: [sourceObjectId] });
    const relocatedObjectId = mappings.get(sourceObjectId);
    if (relocatedObjectId === undefined) throw new Error('Expected one relocation mapping');
    await first.store.publishRelocations({ mappings });
    await expect(first.store.removeWholeSegmentIfUnchanged({ candidate })).resolves.toBe('removed');
    await expect(first.store.read({ objectId: sourceObjectId })).resolves.toMatchObject({
      kind: 'file_chunk',
      binaryPayload: new Uint8Array([1, 2, 3]),
    });
    expect(await first.store.resolveObjectId({ objectId: sourceObjectId })).toBe(relocatedObjectId);
    await first.store.close();

    const reopened = await createStore({
      root,
      rootKeyByte: 1,
      fileSystemId: FILE_SYSTEM_ID_A,
    });
    await expect(reopened.store.read({ objectId: sourceObjectId })).resolves.toMatchObject({
      kind: 'file_chunk',
      binaryPayload: new Uint8Array([1, 2, 3]),
    });
    expect(await reopened.store.resolveObjectId({ objectId: sourceObjectId })).toBe(relocatedObjectId);
    await reopened.store.close();
  });

  it('writes adjacent encrypted records with one bounded segment write', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const diagnostics = createHizoFSRuntimeDiagnostics();
    const { store } = await createStore({
      root,
      rootKeyByte: 1,
      fileSystemId: FILE_SYSTEM_ID_A,
      fileChunkCacheAdmission: 'read_write',
      diagnostics,
    });

    const objectIds = await store.createMany({
      records: [1, 2].map(value => ({
        kind: 'file_chunk' as const,
        recordVersion: 1,
        metadata: {},
        binaryPayload: new Uint8Array([value]),
      })),
    });
    const snapshot = diagnostics.snapshot();

    expect(objectIds).toHaveLength(2);
    expect(snapshot.phases.object_encrypt.operationCount).toBe(2);
    expect(snapshot.phases.backing_write_at.operationCount).toBe(2);
    await expect(Promise.all(objectIds.map(objectId => store.read({ objectId }))))
      .resolves.toEqual([
        expect.objectContaining({ binaryPayload: new Uint8Array([1]) }),
        expect.objectContaining({ binaryPayload: new Uint8Array([2]) }),
      ]);
  });

  it('starts the next chunk when one encryption slot becomes free', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const diagnostics = createHizoFSRuntimeDiagnostics();
    const { store } = await createStore({
      root,
      rootKeyByte: 1,
      fileSystemId: FILE_SYSTEM_ID_A,
      fileChunkCacheAdmission: 'read_only',
      diagnostics,
    });
    const releaseFirst = Promise.withResolvers<void>();
    const releaseSecond = Promise.withResolvers<void>();
    const firstTwoStarted = Promise.withResolvers<void>();
    const thirdStarted = Promise.withResolvers<void>();
    const started: number[] = [];
    const discarded = [0, 0, 0, 0];

    const write = store.createFileChunksPipelined({
      records: [0, 1, 2, 3].map(index => ({
        binaryPayloadByteLength: 1,
        createBinaryPayload: async (): Promise<Uint8Array> => {
          started.push(index);
          if (started.length === 2) firstTwoStarted.resolve();
          if (index === 2) thirdStarted.resolve();
          if (index === 0) await releaseFirst.promise;
          if (index === 1) await releaseSecond.promise;
          return new Uint8Array([index + 1]);
        },
        discardBinaryPayload: (): void => {
          discarded[index] = (discarded[index] ?? 0) + 1;
        },
      })),
      maximumPlaintextRecordsInFlight: 2,
    });

    await firstTwoStarted.promise;
    expect(started).toEqual([0, 1]);
    releaseFirst.resolve();
    await thirdStarted.promise;
    expect(started.slice(0, 3)).toEqual([0, 1, 2]);
    releaseSecond.resolve();

    await expect(write).resolves.toHaveLength(4);
    expect(started).toEqual([0, 1, 2, 3]);
    expect(discarded).toEqual([1, 1, 1, 1]);
    const snapshot = diagnostics.snapshot();
    expect(snapshot.phases.object_encrypt.operationCount).toBe(4);
    expect(snapshot.phases.backing_write_at.operationCount).toBe(3);
    await store.close();
  });

  it('discards queued chunk payloads after a pipeline factory fails', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const { store } = await createStore({
      root,
      rootKeyByte: 1,
      fileSystemId: FILE_SYSTEM_ID_A,
      fileChunkCacheAdmission: 'read_only',
    });
    const discarded = [0, 0, 0, 0];

    await expect(store.createFileChunksPipelined({
      records: [0, 1, 2, 3].map(index => ({
        binaryPayloadByteLength: 1,
        createBinaryPayload: async (): Promise<Uint8Array> => {
          if (index === 0) throw new Error('injected payload factory failure');
          return new Uint8Array([index + 1]);
        },
        discardBinaryPayload: (): void => {
          discarded[index] = (discarded[index] ?? 0) + 1;
        },
      })),
      maximumPlaintextRecordsInFlight: 2,
    })).rejects.toThrow('injected payload factory failure');

    expect(discarded).toEqual([1, 1, 1, 1]);
    await expect(store.create({
      record: {
        kind: 'commit',
        recordVersion: 1,
        metadata: { revision: 1 },
        binaryPayload: new Uint8Array(),
      },
    })).resolves.toEqual(expect.any(String));
    await expect(store.close()).rejects.toThrow(
      'Failed to close HizoFS segment writers',
    );
  });

  it('rejects object batches wider than the bounded physical write', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const { store } = await createStore({
      root,
      rootKeyByte: 1,
      fileSystemId: FILE_SYSTEM_ID_A,
    });

    await expect(store.createMany({
      records: [1, 2, 3].map(value => ({
        kind: 'file_chunk' as const,
        recordVersion: 1,
        metadata: {},
        binaryPayload: new Uint8Array([value]),
      })),
    })).rejects.toThrow('at most 2 records');
  });

  it('round-trips an authenticated record under a random opaque object ID', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const { store } = await createStore({
      root,
      rootKeyByte: 1,
      fileSystemId: FILE_SYSTEM_ID_A,
    });

    const objectId = await store.create({
      record: {
        kind: 'file_chunk',
        recordVersion: 1,
        metadata: {},
        binaryPayload: new Uint8Array([1, 2, 3]),
      },
    });

    expect(objectId).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(await store.read({ objectId })).toEqual({
      kind: 'file_chunk',
      recordVersion: 1,
      metadata: {},
      binaryPayload: new Uint8Array([1, 2, 3]),
    });
  });

  it('reuses runtime-owned metadata and data segments across durable publications', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const { store } = await createStore({
      root,
      rootKeyByte: 1,
      fileSystemId: FILE_SYSTEM_ID_A,
    });

    const firstMetadataObjectId = await store.create({
      record: {
        kind: 'commit',
        recordVersion: 1,
        metadata: { revision: 1 },
        binaryPayload: new Uint8Array(),
      },
    });
    await publishStore({
      store,
      fileSystemId: FILE_SYSTEM_ID_A,
      activeCommitObjectId: firstMetadataObjectId,
      sequence: 0,
    });
    const secondMetadataObjectId = await store.create({
      record: {
        kind: 'commit',
        recordVersion: 1,
        metadata: { revision: 2 },
        binaryPayload: new Uint8Array(),
      },
    });
    await publishStore({
      store,
      fileSystemId: FILE_SYSTEM_ID_A,
      activeCommitObjectId: secondMetadataObjectId,
      sequence: 1,
    });

    const firstDataObjectId = await store.create({
      record: {
        kind: 'file_chunk',
        recordVersion: 1,
        metadata: {},
        binaryPayload: new Uint8Array([1]),
      },
    });
    await publishStore({
      store,
      fileSystemId: FILE_SYSTEM_ID_A,
      activeCommitObjectId: secondMetadataObjectId,
      sequence: 2,
    });
    const secondDataObjectId = await store.create({
      record: {
        kind: 'file_chunk',
        recordVersion: 1,
        metadata: {},
        binaryPayload: new Uint8Array([2]),
      },
    });
    await publishStore({
      store,
      fileSystemId: FILE_SYSTEM_ID_A,
      activeCommitObjectId: secondMetadataObjectId,
      sequence: 3,
    });

    expect(store.getObjectPhysicalPath({ objectId: firstMetadataObjectId })).toEqual(
      store.getObjectPhysicalPath({ objectId: secondMetadataObjectId }),
    );
    expect(store.getObjectPhysicalPath({ objectId: firstDataObjectId })).toEqual(
      store.getObjectPhysicalPath({ objectId: secondDataObjectId }),
    );
    await store.close();
  });

  it('blocks new segment reservations until a publication flush boundary completes', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const backingStore = new NativeOpfsHizoFSBackingStore({
      root,
      fileHandleCacheEntryLimit: 64,
      fileSnapshotCacheEntryLimit: 64,
      diagnostics: undefined,
    });
    const openRandomAccessFile = backingStore.openRandomAccessFile.bind(backingStore);
    const secondMetadataFlushStarted = Promise.withResolvers<void>();
    const releaseSecondMetadataFlush = Promise.withResolvers<void>();
    let metadataFlushCount = 0;
    vi.spyOn(backingStore, 'openRandomAccessFile').mockImplementation(async options => {
      const file = await openRandomAccessFile(options);
      if (options.path.includes('metadata')) {
        const flush = file.flush.bind(file);
        vi.spyOn(file, 'flush').mockImplementation(async () => {
          metadataFlushCount += 1;
          if (metadataFlushCount === 2) {
            secondMetadataFlushStarted.resolve();
            await releaseSecondMetadataFlush.promise;
          }
          await flush();
        });
      }
      return file;
    });
    const store = new HizoFSObjectStore({
      backingStore,
      rootKey: await importHizoFSRootKey({
        rawRootKey: new Uint8Array(32).fill(1),
      }),
      fileSystemId: FILE_SYSTEM_ID_A,
      metadataCacheByteLimit: 1024,
      metadataCacheEntryLimit: 64,
      fileChunkCacheByteLimit: 1024,
      fileChunkCacheEntryLimit: 64,
      fileChunkCacheAdmission: 'read_only',
    });
    const firstObjectId = await store.create({
      record: {
        kind: 'commit',
        recordVersion: 1,
        metadata: { revision: 1 },
        binaryPayload: new Uint8Array(),
      },
    });
    await publishStore({
      store,
      fileSystemId: FILE_SYSTEM_ID_A,
      activeCommitObjectId: firstObjectId,
      sequence: 0,
    });
    const secondObjectId = await store.create({
      record: {
        kind: 'commit',
        recordVersion: 1,
        metadata: { revision: 2 },
        binaryPayload: new Uint8Array(),
      },
    });
    const publication = publishStore({
      store,
      fileSystemId: FILE_SYSTEM_ID_A,
      activeCommitObjectId: secondObjectId,
      sequence: 1,
    });
    await secondMetadataFlushStarted.promise;

    let laterCreateSettled = false;
    const laterCreate = store.create({
      record: {
        kind: 'commit',
        recordVersion: 1,
        metadata: { revision: 3 },
        binaryPayload: new Uint8Array(),
      },
    }).finally(() => {
      laterCreateSettled = true;
    });
    await Promise.resolve();
    expect(laterCreateSettled).toBe(false);

    releaseSecondMetadataFlush.resolve();
    await publication;
    await laterCreate;
    await store.close();
  });

  it('serves immutable objects from bounded plaintext caches without sharing mutable payloads', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const { backingStore, store } = await createStore({
      root,
      rootKeyByte: 1,
      fileSystemId: FILE_SYSTEM_ID_A,
      fileChunkCacheAdmission: 'read_write',
    });
    const objectId = await store.create({
      record: {
        kind: 'file_chunk',
        recordVersion: 1,
        metadata: {},
        binaryPayload: new Uint8Array([1, 2, 3]),
      },
    });
    const readSpy = vi.spyOn(backingStore, 'readRange');

    const first = await store.read({ objectId });
    if (first === undefined) throw new Error('Expected cached HizoFS object');
    first.binaryPayload[0] = 99;
    const second = await store.read({ objectId });

    expect(readSpy).not.toHaveBeenCalled();
    expect(second?.binaryPayload).toEqual(new Uint8Array([1, 2, 3]));
  });


  it('copies only requested bytes from cached file chunks', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const { backingStore, store } = await createStore({
      root,
      rootKeyByte: 1,
      fileSystemId: FILE_SYSTEM_ID_A,
      fileChunkCacheAdmission: 'read_write',
    });
    const objectId = await store.create({
      record: {
        kind: 'file_chunk',
        recordVersion: 1,
        metadata: {},
        binaryPayload: new Uint8Array([1, 2, 3, 4, 5]),
      },
    });
    const backingReadSpy = vi.spyOn(backingStore, 'readRange');

    const first = await store.readBinaryPayloadRange({
      objectId,
      offset: 1,
      length: 2,
    });
    if (first === undefined) throw new Error('Expected cached HizoFS object range');
    first.binaryPayload[0] = 99;
    const second = await store.readBinaryPayloadRange({
      objectId,
      offset: 1,
      length: 2,
    });

    expect(backingReadSpy).not.toHaveBeenCalled();
    expect(first.binaryPayloadByteLength).toBe(5);
    expect(second?.binaryPayload).toEqual(new Uint8Array([2, 3]));
  });

  it('admits file chunks on the first range read without caching the write', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const { backingStore, store } = await createStore({
      root,
      rootKeyByte: 1,
      fileSystemId: FILE_SYSTEM_ID_A,
      fileChunkCacheAdmission: 'read_only',
    });
    const objectId = await store.create({
      record: {
        kind: 'file_chunk',
        recordVersion: 1,
        metadata: {},
        binaryPayload: new Uint8Array([1, 2, 3]),
      },
    });
    await publishStore({ store, fileSystemId: FILE_SYSTEM_ID_A, activeCommitObjectId: objectId });
    await store.releasePhysicalHandles();
    const readSpy = vi.spyOn(backingStore, 'readRange');

    const first = await store.readBinaryPayloadRange({
      objectId,
      offset: 0,
      length: 1,
    });
    const second = await store.readBinaryPayloadRange({
      objectId,
      offset: 1,
      length: 2,
    });

    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(first?.binaryPayload).toEqual(new Uint8Array([1]));
    expect(second?.binaryPayload).toEqual(new Uint8Array([2, 3]));
  });

  it('can retain newly written file chunks for controlled benchmark comparison', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const { backingStore, store } = await createStore({
      root,
      rootKeyByte: 1,
      fileSystemId: FILE_SYSTEM_ID_A,
      fileChunkCacheAdmission: 'read_write',
    });
    const objectId = await store.create({
      record: {
        kind: 'file_chunk',
        recordVersion: 1,
        metadata: {},
        binaryPayload: new Uint8Array([1, 2, 3]),
      },
    });
    const readSpy = vi.spyOn(backingStore, 'readRange');

    await store.read({ objectId });

    expect(readSpy).not.toHaveBeenCalled();
  });

  it('honors a zero-byte cache budget without retaining immutable plaintext', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const backingStore = new NativeOpfsHizoFSBackingStore({
      root,
      fileHandleCacheEntryLimit: 64,
      fileSnapshotCacheEntryLimit: 64,
      diagnostics: undefined,
    });
    const store = new HizoFSObjectStore({
      backingStore,
      rootKey: await importHizoFSRootKey({
        rawRootKey: new Uint8Array(32).fill(1),
      }),
      fileSystemId: FILE_SYSTEM_ID_A,
      metadataCacheByteLimit: 0,
      metadataCacheEntryLimit: 0,
      fileChunkCacheByteLimit: 0,
      fileChunkCacheEntryLimit: 0,
      fileChunkCacheAdmission: 'read_only',
    });
    const objectId = await store.create({
      record: {
        kind: 'commit',
        recordVersion: 1,
        metadata: { revision: 1 },
        binaryPayload: new Uint8Array(),
      },
    });
    await publishStore({ store, fileSystemId: FILE_SYSTEM_ID_A, activeCommitObjectId: objectId });
    await store.releasePhysicalHandles();
    const readSpy = vi.spyOn(backingStore, 'readRange');

    await store.read({ objectId });
    await store.read({ objectId });

    expect(readSpy).toHaveBeenCalledTimes(2);
  });

  it('evicts immutable plaintext by byte budget instead of growing without bound', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const backingStore = new NativeOpfsHizoFSBackingStore({
      root,
      fileHandleCacheEntryLimit: 64,
      fileSnapshotCacheEntryLimit: 64,
      diagnostics: undefined,
    });
    const store = new HizoFSObjectStore({
      backingStore,
      rootKey: await importHizoFSRootKey({
        rawRootKey: new Uint8Array(32).fill(1),
      }),
      fileSystemId: FILE_SYSTEM_ID_A,
      metadataCacheByteLimit: 0,
      metadataCacheEntryLimit: 0,
      fileChunkCacheByteLimit: 64,
      fileChunkCacheEntryLimit: 64,
      fileChunkCacheAdmission: 'read_only',
    });
    const firstObjectId = await store.create({
      record: {
        kind: 'file_chunk',
        recordVersion: 1,
        metadata: {},
        binaryPayload: new Uint8Array(32).fill(1),
      },
    });
    const secondObjectId = await store.create({
      record: {
        kind: 'file_chunk',
        recordVersion: 1,
        metadata: {},
        binaryPayload: new Uint8Array(32).fill(2),
      },
    });
    await publishStore({
      store,
      fileSystemId: FILE_SYSTEM_ID_A,
      activeCommitObjectId: secondObjectId,
    });
    await store.releasePhysicalHandles();
    const readSpy = vi.spyOn(backingStore, 'readRange');

    await store.read({ objectId: firstObjectId });
    await store.read({ objectId: secondObjectId });

    expect(readSpy).toHaveBeenCalledTimes(2);
  });

  it('also bounds cache entry overhead when immutable records are small', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const backingStore = new NativeOpfsHizoFSBackingStore({
      root,
      fileHandleCacheEntryLimit: 64,
      fileSnapshotCacheEntryLimit: 64,
      diagnostics: undefined,
    });
    const store = new HizoFSObjectStore({
      backingStore,
      rootKey: await importHizoFSRootKey({
        rawRootKey: new Uint8Array(32).fill(1),
      }),
      fileSystemId: FILE_SYSTEM_ID_A,
      metadataCacheByteLimit: 0,
      metadataCacheEntryLimit: 0,
      fileChunkCacheByteLimit: 1024,
      fileChunkCacheEntryLimit: 1,
      fileChunkCacheAdmission: 'read_only',
    });
    const firstObjectId = await store.create({
      record: {
        kind: 'file_chunk',
        recordVersion: 1,
        metadata: {},
        binaryPayload: new Uint8Array([1]),
      },
    });
    const secondObjectId = await store.create({
      record: {
        kind: 'file_chunk',
        recordVersion: 1,
        metadata: {},
        binaryPayload: new Uint8Array([2]),
      },
    });
    await publishStore({
      store,
      fileSystemId: FILE_SYSTEM_ID_A,
      activeCommitObjectId: secondObjectId,
    });
    await store.releasePhysicalHandles();
    const readSpy = vi.spyOn(backingStore, 'readRange');

    await store.read({ objectId: firstObjectId });
    await store.read({ objectId: secondObjectId });

    expect(readSpy).toHaveBeenCalledTimes(2);
  });

  it('clears cached plaintext explicitly so later reads reauthenticate physical objects', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const { backingStore, store } = await createStore({
      root,
      rootKeyByte: 1,
      fileSystemId: FILE_SYSTEM_ID_A,
      fileChunkCacheAdmission: 'read_write',
    });
    const objectId = await store.create({
      record: {
        kind: 'file_chunk',
        recordVersion: 1,
        metadata: {},
        binaryPayload: new Uint8Array([1, 2, 3]),
      },
    });
    await publishStore({ store, fileSystemId: FILE_SYSTEM_ID_A, activeCommitObjectId: objectId });
    store.clearPlaintextCaches();
    await store.releasePhysicalHandles();
    const readSpy = vi.spyOn(backingStore, 'readRange');

    await store.read({ objectId });

    expect(readSpy).toHaveBeenCalledTimes(1);
  });

  it('truncates a persistent head only when the replacement is shorter', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const { backingStore, store } = await createStore({
      root,
      rootKeyByte: 1,
      fileSystemId: FILE_SYSTEM_ID_A,
    });
    const openRandomAccessFile = backingStore.openRandomAccessFile.bind(backingStore);
    let headTruncates = 0;
    vi.spyOn(backingStore, 'openRandomAccessFile').mockImplementation(async options => {
      const file = await openRandomAccessFile(options);
      if (options.path[0] === 'head-0.hfs') {
        const truncate = file.truncate.bind(file);
        vi.spyOn(file, 'truncate').mockImplementation(async arguments_ => {
          headTruncates += 1;
          await truncate(arguments_);
        });
      }
      return file;
    });
    await store.setHeadHandleRetention({ retention: 'persistent' });
    const write = async ({ activeCommitObjectId, sequence }: {
      activeCommitObjectId: string;
      sequence: number;
    }): Promise<void> => {
      await store.writeSuperblock({
        slot: 0,
        record: {
          kind: 'superblock',
          recordVersion: 1,
          metadata: {
            sequence,
            fileSystemId: FILE_SYSTEM_ID_A,
            activeCommitObjectId,
          },
          binaryPayload: new Uint8Array(),
        },
      });
    };

    await write({ activeCommitObjectId: 'a', sequence: 0 });
    await write({ activeCommitObjectId: 'b', sequence: 1 });
    await write({ activeCommitObjectId: 'a-much-longer-commit-id', sequence: 2 });
    await write({ activeCommitObjectId: 'c', sequence: 3 });

    expect(headTruncates).toBe(1);
    await expect(store.readSuperblock({ slot: 0 })).resolves.toMatchObject({
      metadata: { sequence: 3, activeCommitObjectId: 'c' },
    });
    await store.close();
  });

  it('does not cache mutable superblock slots', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const { backingStore, store } = await createStore({
      root,
      rootKeyByte: 1,
      fileSystemId: FILE_SYSTEM_ID_A,
    });
    await store.writeSuperblock({
      slot: 0,
      record: {
        kind: 'superblock',
        recordVersion: 1,
        metadata: {
          sequence: 0,
          fileSystemId: FILE_SYSTEM_ID_A,
          activeCommitObjectId: 'commit',
        },
        binaryPayload: new Uint8Array(),
      },
    });
    const readSpy = vi.spyOn(backingStore, 'read');

    await store.readSuperblock({ slot: 0 });
    await store.readSuperblock({ slot: 0 });

    expect(readSpy).toHaveBeenCalledTimes(2);
  });

  it('generates independent physical object IDs for identical plaintext', async () => {
    const { store } = await createStore({
      root: new MockFileSystemDirectoryHandle({ name: 'backing' }),
      rootKeyByte: 1,
      fileSystemId: FILE_SYSTEM_ID_A,
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

  it('uses the first eight home-segment bits for canonical object sharding', () => {
    const objectIdForFirstByte = (firstByte: number) => {
      const bytes = new Uint8Array(32);
      bytes[0] = firstByte;
      new DataView(bytes.buffer).setUint32(24, 1, false);
      bytes[28] = 1;
      return encodeBase64Url({ bytes });
    };
    expect(getHizoFSObjectShard({ objectId: objectIdForFirstByte(0x00) })).toBe('00');
    expect(getHizoFSObjectShard({ objectId: objectIdForFirstByte(0x01) })).toBe('01');
    expect(getHizoFSObjectShard({ objectId: objectIdForFirstByte(0xf8) })).toBe('f8');
    expect(getHizoFSObjectShard({ objectId: objectIdForFirstByte(0xff) })).toBe('ff');
  });

  it('rejects invalid direct object references', () => {
    expect(() => validateHizoFSObjectId({
      objectId: 'A'.repeat(42),
    })).toThrow('exactly 43 Base64URL characters');
    expect(() => validateHizoFSObjectId({
      objectId: `${'A'.repeat(42)}!`,
    })).toThrow('Invalid Base64URL value');
  });

  it('fails authentication with a different root key or filesystem ID', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const { store } = await createStore({
      root,
      rootKeyByte: 1,
      fileSystemId: FILE_SYSTEM_ID_A,
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
      fileSystemId: FILE_SYSTEM_ID_A,
    });
    await expect(wrongKey.store.read({ objectId })).rejects.toThrow();

    const wrongFileSystem = await createStore({
      root,
      rootKeyByte: 1,
      fileSystemId: FILE_SYSTEM_ID_B,
    });
    await expect(wrongFileSystem.store.read({ objectId })).rejects.toThrow();
  });

  it('binds ciphertext to its object ID', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const { backingStore, store } = await createStore({
      root,
      rootKeyByte: 1,
      fileSystemId: FILE_SYSTEM_ID_A,
    });
    const objectId = await store.create({
      record: {
        kind: 'commit',
        recordVersion: 1,
        metadata: { revision: 1 },
        binaryPayload: new Uint8Array(),
      },
    });
    const physicalPath = store.getObjectPhysicalPath({ objectId });
    const physical = await backingStore.read({ path: physicalPath });
    expect(physical).toBeDefined();

    const referenceBytes = decodeBase64Url({ value: objectId });
    referenceBytes[0] = (referenceBytes[0] ?? 0) ^ 0x01;
    const otherObjectId = encodeBase64Url({ bytes: referenceBytes });
    await backingStore.write({
      path: store.getObjectPhysicalPath({ objectId: otherObjectId }),
      bytes: physical ?? new Uint8Array(),
    });
    await expect(store.read({ objectId: otherObjectId })).rejects.toThrow();
  });

  it('stores the two superblock slots outside the immutable object namespace', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const { backingStore, store } = await createStore({
      root,
      rootKeyByte: 1,
      fileSystemId: FILE_SYSTEM_ID_A,
    });
    await store.writeSuperblock({
      slot: 1,
      record: {
        kind: 'superblock',
        recordVersion: 1,
        metadata: {
          sequence: 5,
          fileSystemId: FILE_SYSTEM_ID_A,
          activeCommitObjectId: 'commit',
        },
        binaryPayload: new Uint8Array(),
      },
    });

    expect(await store.readSuperblock({ slot: 1 })).toMatchObject({
      kind: 'superblock',
      metadata: { sequence: 5 },
    });
    expect(await backingStore.read({ path: ['head-1.hfs'] })).toBeDefined();
  });

  it('packs exactly sixty-four 256 KiB records into one 16 MiB data payload segment', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const { store } = await createStore({
      root,
      rootKeyByte: 1,
      fileSystemId: FILE_SYSTEM_ID_A,
    });
    const payload = new Uint8Array(256 * 1024);
    const objectIds: string[] = [];
    for (let index = 0; index < 65; index += 1) {
      objectIds.push(await store.create({
        record: {
          kind: 'file_chunk',
          recordVersion: 1,
          metadata: {},
          binaryPayload: payload,
        },
      }));
    }

    const firstPath = store.getObjectPhysicalPath({ objectId: objectIds[0] ?? '' });
    for (const objectId of objectIds.slice(0, 64)) {
      expect(store.getObjectPhysicalPath({ objectId })).toEqual(firstPath);
    }
    expect(store.getObjectPhysicalPath({ objectId: objectIds[64] ?? '' }))
      .not.toEqual(firstPath);
  });

  it('packs immutable metadata records into one authenticated segment before publication', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const { store } = await createStore({
      root,
      rootKeyByte: 1,
      fileSystemId: FILE_SYSTEM_ID_A,
    });
    const firstObjectId = await store.create({
      record: {
        kind: 'commit',
        recordVersion: 1,
        metadata: { revision: 1 },
        binaryPayload: new Uint8Array(),
      },
    });
    const secondObjectId = await store.create({
      record: {
        kind: 'file_inode',
        recordVersion: 1,
        metadata: { nodeId: 'test' },
        binaryPayload: new Uint8Array(),
      },
    });

    expect(store.getObjectPhysicalPath({ objectId: firstObjectId })).toEqual(
      store.getObjectPhysicalPath({ objectId: secondObjectId }),
    );
    await publishStore({
      store,
      fileSystemId: FILE_SYSTEM_ID_A,
      activeCommitObjectId: firstObjectId,
    });
    const listing = await store.listPhysicalObjects();
    expect(listing.ignoredPhysicalPaths).toEqual([]);
    expect(listing.entries.map(entry => entry.objectId)).toEqual(
      expect.arrayContaining([firstObjectId, secondObjectId]),
    );
  });

  it('reclaims a packed segment only when every contained record is unreachable', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const { store } = await createStore({
      root,
      rootKeyByte: 1,
      fileSystemId: FILE_SYSTEM_ID_A,
    });
    const firstObjectId = await store.create({
      record: {
        kind: 'commit',
        recordVersion: 1,
        metadata: { revision: 1 },
        binaryPayload: new Uint8Array(),
      },
    });
    const secondObjectId = await store.create({
      record: {
        kind: 'commit',
        recordVersion: 1,
        metadata: { revision: 2 },
        binaryPayload: new Uint8Array(),
      },
    });
    await publishStore({
      store,
      fileSystemId: FILE_SYSTEM_ID_A,
      activeCommitObjectId: secondObjectId,
    });

    await expect(store.selectWholeSegmentReclaimCandidates({
      unreachableObjectIds: [firstObjectId],
    })).resolves.toEqual([]);
    const candidates = await store.selectWholeSegmentReclaimCandidates({
      unreachableObjectIds: [firstObjectId, secondObjectId],
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.objectIds).toEqual(
      expect.arrayContaining([firstObjectId, secondObjectId]),
    );
  });

  it('does not reclaim a segment that grew after the whole-segment candidate was built', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const { store } = await createStore({
      root,
      rootKeyByte: 1,
      fileSystemId: FILE_SYSTEM_ID_A,
    });
    const firstObjectId = await store.create({
      record: {
        kind: 'commit',
        recordVersion: 1,
        metadata: { revision: 1 },
        binaryPayload: new Uint8Array(),
      },
    });
    const secondObjectId = await store.create({
      record: {
        kind: 'commit',
        recordVersion: 1,
        metadata: { revision: 2 },
        binaryPayload: new Uint8Array(),
      },
    });
    await publishStore({
      store,
      fileSystemId: FILE_SYSTEM_ID_A,
      activeCommitObjectId: secondObjectId,
    });
    const [candidate] = await store.selectWholeSegmentReclaimCandidates({
      unreachableObjectIds: [firstObjectId, secondObjectId],
    });
    if (candidate === undefined) throw new Error('Expected one whole-segment candidate');

    const foregroundObjectId = await store.create({
      record: {
        kind: 'commit',
        recordVersion: 1,
        metadata: { revision: 3 },
        binaryPayload: new Uint8Array(),
      },
    });
    await publishStore({
      store,
      fileSystemId: FILE_SYSTEM_ID_A,
      activeCommitObjectId: foregroundObjectId,
      sequence: 1,
    });

    await expect(store.removeWholeSegmentIfUnchanged({ candidate })).resolves.toBe('changed');
    await expect(store.read({ objectId: foregroundObjectId })).resolves.toMatchObject({
      kind: 'commit',
      metadata: { revision: 3 },
    });
    await store.close();
  });


});
