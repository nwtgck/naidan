import {
  HIZOFS_SUPERBLOCK_FILES,
  parseSegmentId,
  segmentIdToRelativePath,
  type SegmentId,
} from "@/00-storage/service/hizofs/00-format";
import { AUTHENTICATED_PHYSICAL_ACCESS_REASONS } from "@/00-storage/service/hizofs/diagnostics/authenticated-store-diagnostics";
import { IMMUTABLE_BTREE_DIAGNOSTIC_OPERATIONS } from "@/00-storage/service/hizofs/diagnostics/immutable-btree-diagnostics";
import type {
  StorageDirectoryHandle,
  StorageFileHandle,
  StorageFileSystemSession,
  StorageWritableFile,
} from "@/00-storage/service/storage-file-system/types";
import { createInMemoryStorageRoot } from "@/00-storage/service/storage-file-system/test-support/in-memory-storage-file-system";
import {
  HIZOFS_BENCHMARK_RUNTIME_PHASES,
  HIZOFS_BENCHMARK_PERSISTED_RECORD_KINDS,
  type HizoFSBenchmarkGarbageCollectionDiagnostics,
  type HizoFSBenchmarkMeasuredRuntimeDiagnosticsSnapshot,
  type HizoFSBenchmarkRuntime,
  type HizoFSBenchmarkRuntimeDiagnostics,
  type HizoFSBenchmarkRuntimePort,
} from "@/features/debug-hizofs/benchmark/runtime-port";

export type InMemoryBenchmarkRuntimeObservations = {
  createRuntimeCalls: number;
  reopenCalls: number;
  bulkCommitCalls: number;
  garbageCollectionCalls: number;
  closeCalls: number;
};

type InMemoryBenchmarkRuntimePortFixture = {
  readonly port: HizoFSBenchmarkRuntimePort;
  readonly observations: InMemoryBenchmarkRuntimeObservations;
};

export function createInMemoryBenchmarkRuntimePort(): InMemoryBenchmarkRuntimePortFixture {
  const observations: InMemoryBenchmarkRuntimeObservations = {
    createRuntimeCalls: 0,
    reopenCalls: 0,
    bulkCommitCalls: 0,
    garbageCollectionCalls: 0,
    closeCalls: 0,
  };

  return {
    observations,
    port: {
      async createRuntime({ backingDirectory }) {
        observations.createRuntimeCalls += 1;
        const uncountedRoot = createInMemoryStorageRoot({ name: "benchmark-root" });
        const diagnostics = createMutableRuntimeDiagnostics();
        let bulkTargetSequence = 0;
        let publicationSequence = 0;
        const recordMutation = async (): Promise<void> => {
          publicationSequence += 1;
          diagnostics.recordMutation({ count: 1 });
          await writePhysicalPublication({
            backingDirectory,
            publicationSequence,
          });
        };
        const root = createMutationPublishingDirectory({
          directory: uncountedRoot,
          recordMutation,
        });
        let session = createSession({ root });
        let closed = false;
        await writePhysicalPublication({
          backingDirectory,
          publicationSequence: 0,
        });

        const runtime: HizoFSBenchmarkRuntime = {
          get session() {
            return session;
          },
          diagnostics,
          async reopen() {
            observations.reopenCalls += 1;
            const marker = await backingDirectory.getFileHandle(HIZOFS_SUPERBLOCK_FILES[0]);
            await (await marker.getFile()).arrayBuffer();
            session = createSession({ root });
            diagnostics.incrementCoordinator({ event: "durableReloads" });
            return session;
          },
          async createBulkBuilder() {
            const targetDirectory = await root.getDirectoryHandle({
              create: true,
              name: `bulk-target-${bulkTargetSequence}`,
            });
            bulkTargetSequence += 1;
            const names: string[] = [];
            return {
              targetDirectory,
              async createEmptyFile({ name }) {
                names.push(name);
              },
              async commit() {
                const target = underlyingDirectoryByWrapper.get(targetDirectory);
                if (target === undefined) {
                  throw new TypeError("benchmark bulk target is not owned by the in-memory runtime");
                }
                for (const name of names) {
                  await target.getFileHandle({ name, create: true });
                }
                observations.bulkCommitCalls += 1;
                await recordMutation();
              },
              async abort() {
                names.length = 0;
              },
            };
          },
          async collectGarbage({ dryRun, sweepPolicy }) {
            observations.garbageCollectionCalls += 1;
            return {
              reachableObjectCount: 1,
              unreachableObjectCount: 1,
              removedObjectCount: dryRun ? 0 : 1,
              diagnostics: createGarbageCollectionDiagnostics({
                sweepPolicy,
                removedObjectCount: dryRun ? 0 : 1,
              }),
            };
          },
          async close() {
            if (closed) return;
            closed = true;
            observations.closeCalls += 1;
            await session.close();
          },
        };
        return runtime;
      },
    },
  };
}

function createSession({ root }: {
  readonly root: ReturnType<typeof createInMemoryStorageRoot>;
}): StorageFileSystemSession {
  return {
    root,
    capabilities: {
      directBlob: "unsupported",
      symbolicLink: "supported",
      atomicMove: "supported",
      wholeFileClone: "supported",
    },
    async close() {},
    async sync() {},
  };
}

const underlyingDirectoryByWrapper = new WeakMap<
  StorageDirectoryHandle,
  StorageDirectoryHandle
>();

function createMutationPublishingDirectory({ directory, recordMutation }: {
  readonly directory: StorageDirectoryHandle;
  readonly recordMutation: () => Promise<void>;
}): StorageDirectoryHandle {
  const wrapper: StorageDirectoryHandle = {
    kind: "directory",
    name: directory.name,
    stat: () => directory.stat(),
    async getFileHandle({ name, create }) {
      const file = await directory.getFileHandle({ name, create });
      if (create) await recordMutation();
      return createMutationPublishingFile({ file, recordMutation });
    },
    async getDirectoryHandle({ name, create }) {
      const child = await directory.getDirectoryHandle({ name, create });
      if (create) await recordMutation();
      return createMutationPublishingDirectory({ directory: child, recordMutation });
    },
    async getEntryHandle({ name }) {
      const entry = await directory.getEntryHandle({ name });
      switch (entry.kind) {
      case "file":
        return createMutationPublishingFile({ file: entry, recordMutation });
      case "directory":
        return createMutationPublishingDirectory({ directory: entry, recordMutation });
      case "symlink":
        return entry;
      default: {
        const _ex: never = entry;
        throw new Error(`Unhandled benchmark test entry: ${String(_ex)}`);
      }
      }
    },
    async *entries() {
      for await (const [name, entry] of directory.entries()) {
        switch (entry.kind) {
        case "file":
          yield [name, createMutationPublishingFile({ file: entry, recordMutation })] as const;
          break;
        case "directory":
          yield [name, createMutationPublishingDirectory({ directory: entry, recordMutation })] as const;
          break;
        case "symlink":
          yield [name, entry] as const;
          break;
        default: {
          const _ex: never = entry;
          throw new Error(`Unhandled benchmark test entry: ${String(_ex)}`);
        }
        }
      }
    },
    async removeEntry({ name, recursive }) {
      await directory.removeEntry({ name, recursive });
      await recordMutation();
    },
    async createSymlink({ name, target }) {
      const result = await directory.createSymlink({ name, target });
      await recordMutation();
      return result;
    },
    async moveEntry({ name, destination, newName, replace }) {
      await directory.moveEntry({
        name,
        destination: unwrapMutationPublishingDirectory({ directory: destination }),
        newName,
        replace,
      });
      await recordMutation();
    },
    async cloneFile({ name, destination, newName, replace }) {
      const result = await directory.cloneFile({
        name,
        destination: unwrapMutationPublishingDirectory({ directory: destination }),
        newName,
        replace,
      });
      await recordMutation();
      return createMutationPublishingFile({ file: result, recordMutation });
    },
  };
  underlyingDirectoryByWrapper.set(wrapper, directory);
  return wrapper;
}

function unwrapMutationPublishingDirectory({ directory }: {
  readonly directory: StorageDirectoryHandle;
}): StorageDirectoryHandle {
  return underlyingDirectoryByWrapper.get(directory) ?? directory;
}

function createMutationPublishingFile({ file, recordMutation }: {
  readonly file: StorageFileHandle;
  readonly recordMutation: () => Promise<void>;
}): StorageFileHandle {
  return {
    kind: "file",
    name: file.name,
    stat: () => file.stat(),
    openReadable: ({ mimeType }) => file.openReadable({ mimeType }),
    async createWritable({ keepExistingData }) {
      return createMutationPublishingWritable({
        writable: await file.createWritable({ keepExistingData }),
        recordMutation,
      });
    },
  };
}

function createMutationPublishingWritable({ writable, recordMutation }: {
  readonly writable: StorageWritableFile;
  readonly recordMutation: () => Promise<void>;
}): StorageWritableFile {
  let completed = false;
  return {
    write: ({ position, data }) => writable.write({ position, data }),
    truncate: ({ size }) => writable.truncate({ size }),
    async close() {
      await writable.close();
      if (!completed) {
        completed = true;
        await recordMutation();
      }
    },
    async abort({ reason }) {
      completed = true;
      await writable.abort({ reason });
    },
  };
}

function deterministicBenchmarkSegmentId({ publicationSequence }: {
  readonly publicationSequence: number;
}): SegmentId {
  if (!Number.isSafeInteger(publicationSequence) || publicationSequence < 0 || publicationSequence >= 0xffff_ffff) {
    throw new RangeError("benchmark publication sequence is outside the deterministic Segment ID range");
  }
  const value = publicationSequence + 1;
  const bytes = new Uint8Array(16);
  bytes[12] = (value >>> 24) & 0xff;
  bytes[13] = (value >>> 16) & 0xff;
  bytes[14] = (value >>> 8) & 0xff;
  bytes[15] = value & 0xff;
  return parseSegmentId({ bytes });
}

async function writePhysicalPublication({ backingDirectory, publicationSequence }: {
  readonly backingDirectory: FileSystemDirectoryHandle;
  readonly publicationSequence: number;
}): Promise<void> {
  const relativePath = segmentIdToRelativePath({
    id: deterministicBenchmarkSegmentId({ publicationSequence }),
    segmentClass: "metadata",
  });
  const [segmentRootName, segmentClassDirectory, shardDirectory, segmentFilename, ...unexpected] = relativePath.split("/");
  if (
    unexpected.length !== 0
    || segmentRootName === undefined
    || segmentClassDirectory === undefined
    || shardDirectory === undefined
    || segmentFilename === undefined
  ) {
    throw new Error("canonical benchmark Segment path shape invariant failed");
  }
  const segments = await backingDirectory.getDirectoryHandle(segmentRootName, { create: true });
  const metadata = await segments.getDirectoryHandle(segmentClassDirectory, { create: true });
  const shard = await metadata.getDirectoryHandle(shardDirectory, { create: true });
  const segment = await shard.getFileHandle(segmentFilename, { create: true });
  const segmentWritable = await segment.createWritable({ keepExistingData: false });
  await segmentWritable.write(new Uint8Array([publicationSequence & 0xff]));
  await segmentWritable.close();

  const head = await backingDirectory.getFileHandle(HIZOFS_SUPERBLOCK_FILES[0], { create: true });
  const headWritable = await head.createWritable({ keepExistingData: false });
  await headWritable.write(new Uint8Array([publicationSequence & 0xff]));
  await headWritable.close();
}

type MutableRuntimeDiagnostics = HizoFSBenchmarkRuntimeDiagnostics & {
  incrementCoordinator({ event }: {
    readonly event: keyof HizoFSBenchmarkMeasuredRuntimeDiagnosticsSnapshot["coordinator"];
  }): void;
  recordMutation({ count }: { readonly count: number }): void;
};

function createMutableRuntimeDiagnostics(): MutableRuntimeDiagnostics {
  const snapshot = createEmptyRuntimeDiagnosticsSnapshot();
  return {
    snapshot: () => structuredClone(snapshot),
    resetResourceHighWaterMarks() {
      for (const resource of Object.values(snapshot.resources)) {
        resource.maximumBytes = resource.currentBytes;
        resource.maximumOperations = resource.currentOperations;
      }
      snapshot.mutation.getFileSize.maximumOperationsPerScope = 0;
      snapshot.mutation.readExact.maximumOperationsPerScope = 0;
      for (const reason of AUTHENTICATED_PHYSICAL_ACCESS_REASONS) {
        snapshot.mutation.physicalAccessReasons[reason].getFileSize.maximumOperationsPerScope = 0;
        snapshot.mutation.physicalAccessReasons[reason].readExact.maximumOperationsPerScope = 0;
      }
      snapshot.publication.getFileSize.maximumOperationsPerScope = 0;
      snapshot.publication.readExact.maximumOperationsPerScope = 0;
      snapshot.indexes.build.maximumPageLevel = 0;
      snapshot.indexes.update.maximumPageLevel = 0;
    },
    incrementCoordinator({ event }) {
      snapshot.coordinator[event] += 1;
    },
    recordMutation({ count }) {
      snapshot.records.inode_table_page.writeOperations += count;
      snapshot.records.directory_page.writeOperations += count;
      snapshot.records.file_system_commit.writeOperations += count;
      snapshot.phases.commit_publication.operationCount += count;
      snapshot.mutation.completed += count;
      snapshot.publication.completed += count;
      snapshot.coordinator.activeStateCacheHits += count;
      snapshot.coordinator.localRequests += count;
      snapshot.indexes.update.inputMutations += count;
      snapshot.indexes.update.maximumPageLevel = Math.max(
        snapshot.indexes.update.maximumPageLevel,
        count > 0 ? 1 : 0,
      );
      snapshot.indexes.update.operations += count;
      snapshot.indexes.update.pageReads += count;
      snapshot.indexes.update.pageWrites += count;
    },
  };
}

function createEmptyRuntimeDiagnosticsSnapshot(): MutableRuntimeDiagnosticsSnapshot {
  return {
    schemaVersion: 9,
    type: "measured",
    phases: Object.fromEntries(HIZOFS_BENCHMARK_RUNTIME_PHASES.map(key => [
      key,
      { operationCount: 0, totalDurationMs: 0 },
    ])) as MutableRuntimeDiagnosticsSnapshot["phases"],
    records: Object.fromEntries(HIZOFS_BENCHMARK_PERSISTED_RECORD_KINDS.map(key => [
      key,
      {
        readOperations: 0,
        writeOperations: 0,
        cacheHits: 0,
        cacheMisses: 0,
        plaintextBytesRead: 0,
        plaintextBytesWritten: 0,
        physicalBytesRead: 0,
        physicalBytesWritten: 0,
      },
    ])) as MutableRuntimeDiagnosticsSnapshot["records"],
    caches: {
      metadata: createEmptyCacheDiagnostics(),
      mutationMetadata: createEmptyCacheDiagnostics(),
      fileChunk: createEmptyCacheDiagnostics(),
      backingFileHandle: createEmptyCacheDiagnostics(),
      backingFileSnapshot: createEmptyCacheDiagnostics(),
      decodedInodeIndexPage: createEmptyCacheDiagnostics(),
    },
    resources: {
      writerDirtyChunks: createEmptyResourceDiagnostics(),
      writerPendingChunkWrites: createEmptyResourceDiagnostics(),
      readerPrefetch: createEmptyResourceDiagnostics(),
    },
    coordinator: {
      activeStateCacheHits: 0,
      durableReloads: 0,
      leadershipAcquisitions: 0,
      failovers: 0,
      localRequests: 0,
      remoteRequests: 0,
    },
    indexes: Object.fromEntries(IMMUTABLE_BTREE_DIAGNOSTIC_OPERATIONS.map(operation => [
      operation,
      createEmptyIndexDiagnostics(),
    ])) as MutableRuntimeDiagnosticsSnapshot["indexes"],
    inodeLeafLookup: {
      branchPageDecodes: 0,
      branchPageBytesDecoded: 0,
      decodedEntryBytes: 0,
      indexBuilds: 0,
      indexBytesCreated: 0,
      indexedEntries: 0,
      indexedPageBytes: 0,
      selectiveEntryHits: 0,
      selectiveEntryMisses: 0,
      skippedPageBytes: 0,
    },
    mutation: {
      abandoned: 0,
      completed: 0,
      failed: 0,
      overlapping: 0,
      getFileSize: createEmptyScopedAccessDiagnostics(),
      physicalAccessReasons: Object.fromEntries(AUTHENTICATED_PHYSICAL_ACCESS_REASONS.map(reason => [reason, {
        getFileSize: createEmptyScopedAccessDiagnostics(),
        readExact: createEmptyScopedAccessDiagnostics(),
      }])) as MutableRuntimeDiagnosticsSnapshot["mutation"]["physicalAccessReasons"],
      readExact: createEmptyScopedAccessDiagnostics(),
    },
    publication: {
      completed: 0,
      overlapping: 0,
      getFileSize: createEmptyScopedAccessDiagnostics(),
      readExact: createEmptyScopedAccessDiagnostics(),
    },
    segmentWriters: {
      data: createEmptySegmentWriterDiagnostics(),
      metadata: createEmptySegmentWriterDiagnostics(),
      relocation: createEmptySegmentWriterDiagnostics(),
    },
  };
}

function createEmptyIndexDiagnostics(): MutableRuntimeDiagnosticsSnapshot["indexes"]["update"] {
  return {
    inputMutations: 0,
    maximumPageLevel: 0,
    operations: 0,
    pageReads: 0,
    pageWrites: 0,
    rootCollapses: 0,
    splitOperations: 0,
    splitOutputPages: 0,
    unchangedPageReuses: 0,
  };
}

function createEmptyScopedAccessDiagnostics(): MutableRuntimeDiagnosticsSnapshot["publication"]["getFileSize"] {
  return {
    duplicateOperations: 0,
    maximumOperationsPerScope: 0,
    operations: 0,
    observedUniqueTargets: 0,
    truncatedScopes: 0,
    unclassifiedOperations: 0,
  };
}

function createEmptySegmentWriterDiagnostics(): MutableRuntimeDiagnosticsSnapshot["segmentWriters"]["metadata"] {
  return {
    appendOperations: 0,
    appendReadBackVerifications: 0,
    created: 0,
    descriptorValidations: 0,
    rollovers: 0,
    trustedTailMatches: 0,
    trustedTailMismatches: 0,
  };
}

type MutableRuntimeDiagnosticsSnapshot = {
  -readonly [K in keyof HizoFSBenchmarkMeasuredRuntimeDiagnosticsSnapshot]:
    MutableDeep<HizoFSBenchmarkMeasuredRuntimeDiagnosticsSnapshot[K]>;
};

type MutableDeep<T> = T extends object
  ? { -readonly [K in keyof T]: MutableDeep<T[K]> }
  : T;

function createEmptyCacheDiagnostics(): MutableRuntimeDiagnosticsSnapshot["caches"]["metadata"] {
  return {
    hits: 0,
    misses: 0,
    evictions: 0,
    currentBytes: 0,
    maximumBytes: 0,
    currentEntries: 0,
    maximumEntries: 0,
  };
}

function createEmptyResourceDiagnostics(): MutableRuntimeDiagnosticsSnapshot["resources"]["writerDirtyChunks"] {
  return {
    currentBytes: 0,
    maximumBytes: 0,
    currentOperations: 0,
    maximumOperations: 0,
  };
}

function createGarbageCollectionDiagnostics({ sweepPolicy, removedObjectCount }: {
  readonly sweepPolicy: {
    readonly removeConcurrency: number;
    readonly maximumRemovalsPerSlice: number;
    readonly maximumSliceDurationMs: number;
  };
  readonly removedObjectCount: number;
}): HizoFSBenchmarkGarbageCollectionDiagnostics {
  return {
    reachableObjectCount: 1,
    candidateObjectCount: 1,
    removedObjectCount,
    changedSegmentCount: 0,
    compactedSegmentCount: 0,
    relocatedObjectCount: 0,
    reclaimedCompactionObjectCount: 0,
    ignoredPhysicalPathCount: 0,
    configuredRemoveConcurrency: sweepPolicy.removeConcurrency,
    configuredMaximumRemovalsPerSlice: sweepPolicy.maximumRemovalsPerSlice,
    configuredMaximumSliceDurationMs: sweepPolicy.maximumSliceDurationMs,
    initialFenceWaitDurationMs: 0,
    initialFenceHoldDurationMs: 0,
    rootSnapshotDurationMs: 0,
    markDurationMs: 0,
    chunkVerificationDurationMs: 0,
    objectListingDurationMs: 0,
    candidateBuildDurationMs: 0,
    compactionWallDurationMs: 0,
    compactionLockWaitDurationMs: 0,
    compactionLockHoldDurationMs: 0,
    compactionYieldDurationMs: 0,
    compactionSliceCount: 0,
    maximumCompactionSliceDurationMs: 0,
    sweepWallDurationMs: 0,
    sweepLockWaitDurationMs: 0,
    sweepLockHoldDurationMs: 0,
    yieldDurationMs: 0,
    totalDurationMs: 0,
    sweepSliceCount: removedObjectCount === 0 ? 0 : 1,
    maximumPauseDurationMs: 0,
    maximumSweepSliceDurationMs: 0,
    maximumRemovesInFlight: Math.min(removedObjectCount, sweepPolicy.removeConcurrency),
    maximumRemovalsInSlice: removedObjectCount,
    sliceDurationBudgetOverrunCount: 0,
    resumedFromCheckpoint: false,
    checkpointSequence: 0,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
