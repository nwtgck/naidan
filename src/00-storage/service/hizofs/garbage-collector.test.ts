import { describe, expect, it, vi } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import { writeStorageFileText, readStorageFileText } from '@/00-storage/service/storage-file-system/io';
import type { StorageFileSystemSession } from '@/00-storage/service/storage-file-system/types';
import {
  collectHizoFSGarbage,
  TEST_ONLY as GARBAGE_COLLECTOR_TEST_ONLY,
} from './garbage-collector';
import { createHizoFS, openHizoFS, inspectHizoFS, TEST_ONLY } from './api';
import type { HizoFSPolicy } from './file-system/policy';
import { getHizoFSObjectShard } from './object-store/object-id';
import {
  decodeHizoFSObjectReference,
  encodeHizoFSSegmentId,
} from './segment-store/object-reference';
import { toExactArrayBuffer } from './bytes';
import { HizoFSSession } from './file-system/session';
import { createHizoFSStableId } from './id';

const ROOT_KEY = new Uint8Array(32).fill(17);
const TINY_POLICY: HizoFSPolicy = {
  inlineFileByteLimit: 8,
  inlineDirectoryEntryLimit: 2,
  fileChunkSize: 4,
  decodedInodeIndexPageCacheEntryLimit: 16,
  inodeIndexPageEntryLimit: 2,
  directoryIndexPageEntryLimit: 2,
  fileExtentIndexPageEntryLimit: 2,
  readerStreamChunkSize: 3,
  fileChunkReadPrefetchConcurrency: 2,
  backingFileHandleCacheEntryLimit: 64,
  backingFileSnapshotCacheEntryLimit: 64,
  maxDirtyFileBytes: 16,
  fileChunkWriteConcurrency: 2,
  metadataObjectCacheByteLimit: 64 * 1024,
  metadataObjectCacheEntryLimit: 1024,
  fileChunkCacheByteLimit: 64,
  fileChunkCacheEntryLimit: 16,
  fileChunkCacheAdmission: 'read',
};

function createTiny({ backing }: {
  backing: FileSystemDirectoryHandle;
}): Promise<StorageFileSystemSession> {
  return TEST_ONLY.createHizoFSInternal({
    backingDirectory: backing,
    fileSystemRootKey: ROOT_KEY,
    policy: TINY_POLICY,
    now: () => 1,
  });
}

function openTiny({ backing }: {
  backing: FileSystemDirectoryHandle;
}): Promise<StorageFileSystemSession> {
  return TEST_ONLY.openHizoFSInternal({
    backingDirectory: backing,
    fileSystemRootKey: ROOT_KEY,
    policy: TINY_POLICY,
    now: () => 2,
  });
}

async function writeLargeValue({ session, value }: {
  session: StorageFileSystemSession;
  value: string;
}): Promise<void> {
  const file = await session.root.getFileHandle({ name: 'value.txt', create: true });
  await writeStorageFileText({ fileHandle: file, value });
}

async function writeLargeValueInFreshSegments({ session, value }: {
  session: StorageFileSystemSession;
  value: string;
}): Promise<void> {
  if (!(session instanceof HizoFSSession)) throw new Error('Expected a HizoFS session');
  await session.runtime.objectStore.releasePhysicalHandles();
  await writeLargeValue({ session, value });
}

async function countPhysicalFiles({ directory }: {
  directory: FileSystemDirectoryHandle;
}): Promise<number> {
  let count = 0;
  for await (const [, handle] of directory.entries()) {
    if (handle.kind === 'file') {
      count += 1;
    } else {
      count += await countPhysicalFiles({ directory: handle });
    }
  }
  return count;
}

function getPhysicalObjectPath({ objectId }: { objectId: string }): readonly string[] {
  const reference = decodeHizoFSObjectReference({ value: objectId });
  return [
    'segments',
    reference.kind === 'file_chunk' ? 'data' : 'metadata',
    getHizoFSObjectShard({ objectId }),
    `${encodeHizoFSSegmentId({ segmentId: reference.homeSegmentId })}.seg`,
  ];
}

async function overwritePhysicalFile({
  backing,
  path,
  bytes,
}: {
  backing: FileSystemDirectoryHandle;
  path: readonly string[];
  bytes: Uint8Array;
}): Promise<void> {
  let directory = backing;
  for (const segment of path.slice(0, -1)) {
    directory = await directory.getDirectoryHandle(segment);
  }
  const name = path.at(-1);
  if (name === undefined) throw new Error('Physical file path must not be empty');
  const file = await directory.getFileHandle(name);
  const writable = await file.createWritable({ keepExistingData: false });
  await writable.write(toExactArrayBuffer({ bytes }));
  await writable.close();
}

describe('HizoFS garbage collection', () => {
  it('fails closed before sweeping when a mounted child subvolume is reachable', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ backing });
    if (!(session instanceof HizoFSSession)) throw new Error('Expected a HizoFS session');
    const state = await session.loadActiveState();
    const childDescriptorObjectId =
      await session.runtime.subvolumeDescriptorStore.write({
        descriptor: {
          subvolumeId: createHizoFSStableId(),
          access: 'read_write',
        },
      });
    const mountRootObjectId = await session.runtime.subvolumeMountIndex.set({
      rootObjectId: state.commit.subvolumeMountIndexRootObjectId,
      mount: {
        mountId: createHizoFSStableId(),
        subvolumeDescriptorObjectId: childDescriptorObjectId,
      },
    });
    const commitObjectId = await session.runtime.commitStore.write({
      commit: {
        ...state.commit,
        revision: state.commit.revision + 1,
        publicationId: createHizoFSStableId(),
        subvolumeMountIndexRootObjectId: mountRootObjectId,
      },
    });
    await session.runtime.objectStore.flushPendingRecords();
    await session.runtime.core.superblockStore.write({
      value: {
        ...state.superblock,
        sequence: state.superblock.sequence + 1,
        activeCommitObjectId: commitObjectId,
      },
    });
    await session.close();

    const before = await countPhysicalFiles({ directory: backing });
    await expect(collectHizoFSGarbage({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      dryRun: false,
      sweepPolicy: undefined,
      signal: undefined,
    })).rejects.toThrow(
      'refuses mounted child subvolumes until child-head traversal is enabled',
    );
    expect(await countPhysicalFiles({ directory: backing })).toBe(before);
  });

  it('removes only unreachable immutable objects and preserves the active filesystem', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ backing });
    await writeLargeValueInFreshSegments({ session, value: 'first-large-value' });
    await writeLargeValueInFreshSegments({ session, value: 'second-large-value' });
    await writeLargeValueInFreshSegments({ session, value: 'third-large-value' });
    await session.close();

    const dryRun = await collectHizoFSGarbage({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      dryRun: true,
      sweepPolicy: undefined,
      signal: undefined,
    });
    expect(dryRun.unreachableObjectIds.length).toBeGreaterThan(0);
    expect(dryRun.removedObjectCount).toBe(0);

    const before = await countPhysicalFiles({ directory: backing });
    const collected = await collectHizoFSGarbage({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      dryRun: false,
      sweepPolicy: undefined,
      signal: undefined,
    });
    expect(collected.unreachableObjectIds).toEqual(dryRun.unreachableObjectIds);
    expect(collected.removedObjectCount).toBeGreaterThan(0);
    expect(collected.removedObjectCount).toBeLessThanOrEqual(dryRun.unreachableObjectIds.length);
    expect(await countPhysicalFiles({ directory: backing })).toBeLessThan(before);

    const reopened = await openTiny({ backing });
    const file = await reopened.root.getFileHandle({ name: 'value.txt', create: false });
    expect(await readStorageFileText({ fileHandle: file })).toBe('third-large-value');
    await reopened.close();
    const remaining = await collectHizoFSGarbage({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      dryRun: true,
      sweepPolicy: undefined,
      signal: undefined,
    });
    expect(remaining.unreachableObjectIds.length).toBeLessThan(
      dryRun.unreachableObjectIds.length,
    );
  });


  it('releases same-realm physical handles while an idle session remains open', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ backing });
    if (!(session instanceof HizoFSSession)) throw new Error('Expected a HizoFS session');
    await writeLargeValueInFreshSegments({ session, value: 'first-large-value' });
    await writeLargeValueInFreshSegments({ session, value: 'second-large-value' });
    await writeLargeValueInFreshSegments({ session, value: 'third-large-value' });
    const releaseSpy = vi.spyOn(session.runtime.objectStore, 'releasePhysicalHandles');

    const result = await collectHizoFSGarbage({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      dryRun: false,
      sweepPolicy: undefined,
      signal: undefined,
    });

    expect(result.removedObjectCount).toBeGreaterThan(0);
    expect(releaseSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    const file = await session.root.getFileHandle({ name: 'value.txt', create: false });
    expect(await readStorageFileText({ fileHandle: file })).toBe('third-large-value');
    await session.close();
  });

  it('releases the maintenance fence before mark and preserves later mutations', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ backing });
    await writeLargeValue({ session, value: 'first-large-value' });
    await writeLargeValue({ session, value: 'second-large-value' });

    const snapshotReleased = Promise.withResolvers<void>();
    const continueMark = Promise.withResolvers<void>();
    const collection = GARBAGE_COLLECTOR_TEST_ONLY.collectHizoFSGarbageInternal({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      dryRun: false,
      sweepPolicy: {
        removeConcurrency: 2,
        maximumRemovalsPerSlice: 3,
        maximumSliceDurationMs: 10,
      },
      signal: undefined,
      dependencies: {
        afterRootSnapshot: async () => {
          snapshotReleased.resolve();
          await continueMark.promise;
        },
        now: () => performance.now(),
        removeCandidate: async ({ runtime, candidate }) => (
          runtime.objectStore.removeWholeSegmentIfUnchanged({ candidate })
        ),
        yieldToForeground: async () => {},
      },
    });

    await snapshotReleased.promise;
    await writeLargeValue({ session, value: 'foreground-after-snapshot' });
    continueMark.resolve();
    await collection;

    const file = await session.root.getFileHandle({ name: 'value.txt', create: false });
    expect(await readStorageFileText({ fileHandle: file })).toBe(
      'foreground-after-snapshot',
    );
    await session.close();
  });

  it('serializes collectors while mark runs outside the maintenance fence', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ backing });
    await writeLargeValue({ session, value: 'first-large-value' });
    await writeLargeValue({ session, value: 'second-large-value' });
    await session.close();

    const firstSnapshotReleased = Promise.withResolvers<void>();
    const continueFirstMark = Promise.withResolvers<void>();
    const firstCollection = GARBAGE_COLLECTOR_TEST_ONLY.collectHizoFSGarbageInternal({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      dryRun: true,
      sweepPolicy: undefined,
      signal: undefined,
      dependencies: {
        afterRootSnapshot: async () => {
          firstSnapshotReleased.resolve();
          await continueFirstMark.promise;
        },
        now: () => performance.now(),
        removeCandidate: async ({ runtime, candidate }) => (
          runtime.objectStore.removeWholeSegmentIfUnchanged({ candidate })
        ),
        yieldToForeground: async () => {},
      },
    });
    await firstSnapshotReleased.promise;

    let secondReachedSnapshot = false;
    const secondCollection = GARBAGE_COLLECTOR_TEST_ONLY.collectHizoFSGarbageInternal({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      dryRun: true,
      sweepPolicy: undefined,
      signal: undefined,
      dependencies: {
        afterRootSnapshot: async () => {
          secondReachedSnapshot = true;
        },
        now: () => performance.now(),
        removeCandidate: async ({ runtime, candidate }) => (
          runtime.objectStore.removeWholeSegmentIfUnchanged({ candidate })
        ),
        yieldToForeground: async () => {},
      },
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(secondReachedSnapshot).toBe(false);

    continueFirstMark.resolve();
    await firstCollection;
    await secondCollection;
    expect(secondReachedSnapshot).toBe(true);
  });

  it('waits for an active directory traversal while allowing idle sessions', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ backing });
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      await writeStorageFileText({
        fileHandle: await session.root.getFileHandle({ name, create: true }),
        value: name,
      });
    }

    const iterator = session.root.entries()[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    let settled = false;
    const collection = collectHizoFSGarbage({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      dryRun: true,
      sweepPolicy: undefined,
      signal: undefined,
    }).finally(() => {
      settled = true;
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    await iterator.return?.();
    await collection;
    expect(settled).toBe(true);
    await session.close();
  });

  it('refuses to sweep when the inode index contains a disconnected node', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ backing });
    if (!(session instanceof HizoFSSession)) {
      throw new Error('Expected a HizoFS session');
    }
    await session.runtime.core.mutate({
      operation: async ({ state }) => {
        const nodeId = createHizoFSStableId();
        const inodeObjectId = await session.runtime.inodeStore.writeFile({
          inode: {
            nodeId,
            revision: 0,
            createdAt: 1,
            modifiedAt: 1,
            size: 0,
            storage: { type: 'inline' },
          },
          binaryPayload: new Uint8Array(),
        });
        return {
          changed: 'yes' as const,
          inodeIndexRootObjectId: await session.runtime.inodeIndex.set({
            rootObjectId: state.commit.inodeIndexRootObjectId,
            entry: { nodeId, inodeObjectId },
          }),
          result: undefined,
        };
      },
    });

    await expect(collectHizoFSGarbage({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      dryRun: false,
      sweepPolicy: undefined,
      signal: undefined,
    })).rejects.toThrow('disconnected');
    await session.close();
  });

  it('preserves the previous valid superblock generation as a physical fallback', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ backing });
    await writeLargeValue({ session, value: 'first-large-value' });
    await writeLargeValue({ session, value: 'second-large-value' });
    await session.close();

    await collectHizoFSGarbage({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      dryRun: false,
      sweepPolicy: undefined,
      signal: undefined,
    });
    const inspection = await inspectHizoFS({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    await overwritePhysicalFile({
      backing,
      path: [`head-${String(inspection.superblock.sequence % 2)}.hfs`],
      bytes: new Uint8Array([1, 2, 3]),
    });

    const reopened = await openTiny({ backing });
    if (!(reopened instanceof HizoFSSession)) {
      throw new Error('Expected a HizoFS session');
    }
    expect((await reopened.loadActiveState()).stateSelection).toBe('fallback');
    const file = await reopened.root.getFileHandle({ name: 'value.txt', create: false });
    expect(await readStorageFileText({ fileHandle: file })).toBe('first-large-value');
    await reopened.close();
    await expect(collectHizoFSGarbage({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      dryRun: true,
      sweepPolicy: undefined,
      signal: undefined,
    })).rejects.toThrow('read-only recovery mode');
  });

  it('waits for active child resources and session close disposes them before collection', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ backing });
    await writeLargeValue({ session, value: 'reader-snapshot-value' });
    const file = await session.root.getFileHandle({ name: 'value.txt', create: false });
    const reader = await file.openReadable({ mimeType: 'text/plain' });
    const writer = await file.createWritable({ keepExistingData: true });
    await writer.write({ position: 0, data: new TextEncoder().encode('not-committed') });

    let settled = false;
    const collection = collectHizoFSGarbage({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      dryRun: true,
      sweepPolicy: undefined,
      signal: undefined,
    }).finally(() => {
      settled = true;
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    await session.close();
    await collection;
    expect(settled).toBe(true);
    await expect(reader.read({
      buffer: new Uint8Array(1),
      offset: 0,
      length: 1,
      position: 0,
      signal: undefined,
    })).rejects.toThrow('reader is closed');
    await expect(writer.close()).rejects.toThrow('writer is already closed or aborted');

    const reopened = await openTiny({ backing });
    const reopenedFile = await reopened.root.getFileHandle({ name: 'value.txt', create: false });
    expect(await readStorageFileText({ fileHandle: reopenedFile })).toBe('reader-snapshot-value');
    await reopened.close();
  });

  it('does not delete anything if reachable state validation fails', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ backing });
    await writeLargeValue({ session, value: 'first-large-value' });
    await writeLargeValue({ session, value: 'second-large-value' });
    await session.close();

    const inspection = await inspectHizoFS({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    const before = await countPhysicalFiles({ directory: backing });
    await overwritePhysicalFile({
      backing,
      path: getPhysicalObjectPath({ objectId: inspection.activeCommitObjectId }),
      bytes: new Uint8Array([1, 2, 3]),
    });

    await expect(collectHizoFSGarbage({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      dryRun: false,
      sweepPolicy: undefined,
      signal: undefined,
    })).rejects.toThrow();
    expect(await countPhysicalFiles({ directory: backing })).toBe(before);
  });

  it('leaves unknown physical entries untouched and reports them', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ backing });
    await session.close();
    const unknownDirectory = await backing
      .getDirectoryHandle('segments')
      .then(directory => directory.getDirectoryHandle('metadata'))
      .then(directory => directory.getDirectoryHandle('not-a-shard', { create: true }));
    await unknownDirectory.getFileHandle('manual-backup', { create: true });

    const result = await collectHizoFSGarbage({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      dryRun: true,
      sweepPolicy: undefined,
      signal: undefined,
    });
    expect(result.ignoredPhysicalPaths).toContain('segments/metadata/not-a-shard');
    await expect(unknownDirectory.getFileHandle('manual-backup')).resolves.toBeDefined();
  });

  it('bounds parallel sweep work and lets foreground mutations run between slices', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ backing });
    await writeLargeValueInFreshSegments({ session, value: 'first-large-value' });
    await writeLargeValueInFreshSegments({ session, value: 'second-large-value' });
    await writeLargeValueInFreshSegments({ session, value: 'third-large-value' });
    await writeLargeValueInFreshSegments({ session, value: 'fourth-large-value' });

    const firstBatchStarted = Promise.withResolvers<void>();
    const releaseFirstBatch = Promise.withResolvers<void>();
    let clock = 0;
    let activeRemovals = 0;
    let maximumActiveRemovals = 0;
    let startedRemovals = 0;
    let yieldCount = 0;
    const collection = GARBAGE_COLLECTOR_TEST_ONLY.collectHizoFSGarbageInternal({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      dryRun: false,
      sweepPolicy: {
        removeConcurrency: 2,
        maximumRemovalsPerSlice: 3,
        maximumSliceDurationMs: 5,
      },
      signal: undefined,
      dependencies: {
        afterRootSnapshot: async () => {},
        now: () => clock,
        removeCandidate: async ({ runtime, candidate }) => {
          activeRemovals += 1;
          startedRemovals += 1;
          maximumActiveRemovals = Math.max(maximumActiveRemovals, activeRemovals);
          if (startedRemovals === 2) firstBatchStarted.resolve();
          try {
            if (startedRemovals <= 2) await releaseFirstBatch.promise;
            const result = await runtime.objectStore.removeWholeSegmentIfUnchanged({ candidate });
            clock += 10;
            return result;
          } finally {
            activeRemovals -= 1;
          }
        },
        yieldToForeground: async () => {
          yieldCount += 1;
          await writeStorageFileText({
            fileHandle: await session.root.getFileHandle({
              name: `foreground-${String(yieldCount)}.txt`,
              create: true,
            }),
            value: 'foreground-progress',
          });
          clock += 1;
        },
      },
    });

    await firstBatchStarted.promise;
    expect(maximumActiveRemovals).toBe(2);
    expect(activeRemovals).toBe(2);
    releaseFirstBatch.resolve();

    const result = await collection;
    expect(result.removedObjectCount).toBeGreaterThan(0);
    expect(result.removedObjectCount).toBeLessThanOrEqual(result.unreachableObjectIds.length);
    expect(result.diagnostics.maximumRemovesInFlight).toBe(2);
    expect(result.diagnostics.maximumRemovalsInSlice).toBeLessThanOrEqual(3);
    expect(result.diagnostics.sweepSliceCount).toBeGreaterThan(1);
    expect(result.diagnostics.sliceDurationBudgetOverrunCount).toBeGreaterThan(0);
    expect(yieldCount).toBe(result.diagnostics.sweepSliceCount - 1);
    expect(activeRemovals).toBe(0);
    expect(await readStorageFileText({
      fileHandle: await session.root.getFileHandle({
        name: 'foreground-1.txt',
        create: false,
      }),
    })).toBe('foreground-progress');
    await session.close();
  });

  it('waits for every removal in a failed batch before releasing the sweep slice', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ backing });
    await writeLargeValueInFreshSegments({ session, value: 'first-large-value' });
    await writeLargeValueInFreshSegments({ session, value: 'second-large-value' });
    await writeLargeValueInFreshSegments({ session, value: 'third-large-value' });
    await writeLargeValueInFreshSegments({ session, value: 'fourth-large-value' });
    await session.close();

    const delayedRemovalStarted = Promise.withResolvers<void>();
    const releaseDelayedRemoval = Promise.withResolvers<void>();
    let startedRemovals = 0;
    let activeRemovals = 0;
    let settled = false;
    const collection = GARBAGE_COLLECTOR_TEST_ONLY.collectHizoFSGarbageInternal({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      dryRun: false,
      sweepPolicy: {
        removeConcurrency: 2,
        maximumRemovalsPerSlice: 64,
        maximumSliceDurationMs: 1_000,
      },
      signal: undefined,
      dependencies: {
        afterRootSnapshot: async () => {},
        now: () => performance.now(),
        removeCandidate: async ({ runtime, candidate }) => {
          startedRemovals += 1;
          activeRemovals += 1;
          try {
            if (startedRemovals === 1) throw new Error('injected remove failure');
            if (startedRemovals === 2) {
              delayedRemovalStarted.resolve();
              await releaseDelayedRemoval.promise;
            }
            return await runtime.objectStore.removeWholeSegmentIfUnchanged({ candidate });
          } finally {
            activeRemovals -= 1;
          }
        },
        yieldToForeground: async () => {},
      },
    }).finally(() => {
      settled = true;
    });

    await delayedRemovalStarted.promise;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(activeRemovals).toBe(1);

    releaseDelayedRemoval.resolve();
    await expect(collection).rejects.toThrow(
      'HizoFS garbage collection could not remove every scheduled object',
    );
    expect(settled).toBe(true);
    expect(activeRemovals).toBe(0);

    const resumed = await collectHizoFSGarbage({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      dryRun: false,
      sweepPolicy: undefined,
      signal: undefined,
    });
    expect(resumed.diagnostics.resumedFromCheckpoint).toBe(true);
    expect(resumed.diagnostics.checkpointSequence).toBeGreaterThan(0);
    expect(resumed.removedObjectCount).toBeGreaterThan(0);

    const afterClear = await collectHizoFSGarbage({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      dryRun: false,
      sweepPolicy: undefined,
      signal: undefined,
    });
    expect(afterClear.diagnostics.resumedFromCheckpoint).toBe(false);
  }, 30_000);

  it('honors cancellation only after every started removal settles', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ backing });
    await writeLargeValueInFreshSegments({ session, value: 'first-large-value' });
    await writeLargeValueInFreshSegments({ session, value: 'second-large-value' });
    await writeLargeValueInFreshSegments({ session, value: 'third-large-value' });
    await writeLargeValueInFreshSegments({ session, value: 'fourth-large-value' });
    await session.close();

    const controller = new AbortController();
    const firstBatchStarted = Promise.withResolvers<void>();
    const releaseFirstBatch = Promise.withResolvers<void>();
    let activeRemovals = 0;
    let startedRemovals = 0;
    let settled = false;
    const collection = GARBAGE_COLLECTOR_TEST_ONLY.collectHizoFSGarbageInternal({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      dryRun: false,
      sweepPolicy: {
        removeConcurrency: 2,
        maximumRemovalsPerSlice: 64,
        maximumSliceDurationMs: 1_000,
      },
      signal: controller.signal,
      dependencies: {
        afterRootSnapshot: async () => {},
        now: () => performance.now(),
        removeCandidate: async ({ runtime, candidate }) => {
          activeRemovals += 1;
          startedRemovals += 1;
          if (startedRemovals === 2) firstBatchStarted.resolve();
          try {
            await releaseFirstBatch.promise;
            return await runtime.objectStore.removeWholeSegmentIfUnchanged({ candidate });
          } finally {
            activeRemovals -= 1;
          }
        },
        yieldToForeground: async () => {},
      },
    }).finally(() => {
      settled = true;
    });

    await firstBatchStarted.promise;
    controller.abort(new DOMException('cancelled by test', 'AbortError'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(activeRemovals).toBe(2);

    releaseFirstBatch.resolve();
    await expect(collection).rejects.toMatchObject({ name: 'AbortError' });
    expect(settled).toBe(true);
    expect(activeRemovals).toBe(0);
    expect(startedRemovals).toBe(2);
  }, 30_000);

  it('compacts a partial-live data segment and preserves file bytes after reopen', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createHizoFS({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    const file = await session.root.getFileHandle({ name: 'large.bin', create: true });
    const chunkSize = 256 * 1024;
    const original = new Uint8Array(8 * chunkSize).fill(1);
    const writer = await file.createWritable({ keepExistingData: false });
    await writer.write({ position: 0, data: original });
    await writer.close();

    const replacement = new Uint8Array(6 * chunkSize).fill(2);
    const replacementWriter = await file.createWritable({ keepExistingData: true });
    await replacementWriter.write({ position: 0, data: replacement });
    await replacementWriter.close();
    await session.root.getFileHandle({ name: 'rotate-a', create: true });
    await session.root.getFileHandle({ name: 'rotate-b', create: true });
    await session.close();

    const result = await GARBAGE_COLLECTOR_TEST_ONLY.collectHizoFSGarbageInternal({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      dryRun: false,
      sweepPolicy: undefined,
      signal: undefined,
      dependencies: {
        now: () => performance.now(),
        afterRootSnapshot: async () => {},
        removeCandidate: async ({ runtime, candidate }) => (
          runtime.objectStore.removeWholeSegmentIfUnchanged({ candidate })
        ),
        yieldToForeground: async () => {},
        compactionPolicy: {
          minimumDeadRecordByteLength: 1,
          maximumLiveRecordByteLength: 1024 * 1024,
          maximumLiveRecordCount: 16,
          maximumCandidateCount: 4,
        },
      },
    });
    expect(result.diagnostics.compactedSegmentCount).toBeGreaterThanOrEqual(1);
    expect(result.diagnostics.relocatedObjectCount).toBeGreaterThanOrEqual(2);
    expect(result.diagnostics.reclaimedCompactionObjectCount).toBeGreaterThanOrEqual(6);

    const reopened = await openHizoFS({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    const reopenedFile = await reopened.root.getFileHandle({ name: 'large.bin', create: false });
    const readable = await reopenedFile.openReadable({ mimeType: 'application/octet-stream' });
    const bytes = new Uint8Array(await new Response(readable.stream({
      start: 0,
      end: undefined,
      signal: undefined,
    })).arrayBuffer());
    await readable.close();
    expect(bytes.byteLength).toBe(8 * chunkSize);
    expect(bytes.subarray(0, 6 * chunkSize)).toEqual(replacement);
    expect(bytes.subarray(6 * chunkSize)).toEqual(original.subarray(6 * chunkSize));
    await reopened.close();
  }, 30_000);

  it('preserves shared reflink objects until both file identities are unreachable', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ backing });
    await writeLargeValue({ session, value: 'shared-reflink-value' });
    await session.root.cloneFile({
      name: 'value.txt',
      destination: session.root,
      newName: 'clone.txt',
      replace: false,
    });
    await session.root.removeEntry({ name: 'value.txt', recursive: false });
    await session.close();

    await collectHizoFSGarbage({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      dryRun: false,
      sweepPolicy: undefined,
      signal: undefined,
    });
    const cloneOnly = await openTiny({ backing });
    expect(await readStorageFileText({
      fileHandle: await cloneOnly.root.getFileHandle({ name: 'clone.txt', create: false }),
    })).toBe('shared-reflink-value');
    await cloneOnly.root.removeEntry({ name: 'clone.txt', recursive: false });
    await cloneOnly.root.getFileHandle({ name: 'rotate-a', create: true });
    await cloneOnly.root.getFileHandle({ name: 'rotate-b', create: true });
    await cloneOnly.close();

    const finalCollection = await collectHizoFSGarbage({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      dryRun: false,
      sweepPolicy: undefined,
      signal: undefined,
    });
    expect(finalCollection.removedObjectCount).toBeGreaterThan(0);
    const reopened = await openTiny({ backing });
    await expect(reopened.root.getFileHandle({
      name: 'clone.txt',
      create: false,
    })).rejects.toMatchObject({ name: 'NotFoundError' });
    await reopened.close();
  }, 30_000);

  it('marks one shared extent graph for one hundred whole-file clones', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ backing });
    await writeLargeValue({ session, value: 'one-hundred-reflink-clones' });
    for (let index = 0; index < 100; index += 1) {
      await session.root.cloneFile({
        name: 'value.txt',
        destination: session.root,
        newName: `clone-${String(index).padStart(3, '0')}`,
        replace: false,
      });
    }
    await session.close();

    const result = await collectHizoFSGarbage({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      dryRun: true,
      sweepPolicy: undefined,
      signal: undefined,
    });
    expect(result.reachableObjectCount).toBeGreaterThan(100);
  }, 30_000);
});
