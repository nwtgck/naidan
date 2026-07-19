import type {
  HizoFSDirectoryInodeDto,
  HizoFSFileInodeDto,
  HizoFSSubvolumeDescriptorDto,
  HizoFSSymlinkInodeDto,
} from '@/00-storage/00-dto/hizofs.dto';
import { HizoFSCorruptionError } from './errors';
import { NativeOpfsHizoFSBackingStore } from './backing-store/native-opfs-backing-store';
import {
  deriveHizoFSFileSystemId,
  importHizoFSRootKey,
} from './crypto/object-crypto';
import { createHizoFSRuntime, type HizoFSRuntime } from './file-system/runtime';
import { DEFAULT_HIZOFS_POLICY } from './file-system/policy';
import {
  acquireHizoFSGarbageCollectionLease,
  acquireHizoFSMaintenanceLease,
} from './file-system/maintenance-lock';
import type { HizoFSRecordKind } from './format/record';
import { promiseAllKeyed } from '@/utils/promise';
import {
  HizoFSGarbageCollectionCheckpointStore,
  type HizoFSGarbageCollectionCheckpoint,
} from './garbage-collection-checkpoint';
import type {
  HizoFSWholeSegmentReclaimCandidate,
  HizoFSWholeSegmentRemovalResult,
  HizoFSPartialSegmentCompactionCandidate,
} from './segment-store/segmented-store';

export type HizoFSGarbageCollectionSweepPolicy = {
  readonly removeConcurrency: number;
  readonly maximumRemovalsPerSlice: number;
  readonly maximumSliceDurationMs: number;
};

export const DEFAULT_HIZOFS_GARBAGE_COLLECTION_SWEEP_POLICY:
  HizoFSGarbageCollectionSweepPolicy = {
    removeConcurrency: 4,
    maximumRemovalsPerSlice: 16,
    maximumSliceDurationMs: 150,
  };

type HizoFSGarbageCollectionCompactionPolicy = {
  readonly minimumDeadRecordByteLength: number;
  readonly maximumLiveRecordByteLength: number;
  readonly maximumLiveRecordCount: number;
  readonly maximumCandidateCount: number;
};

const DEFAULT_HIZOFS_GARBAGE_COLLECTION_COMPACTION_POLICY:
  HizoFSGarbageCollectionCompactionPolicy = {
    minimumDeadRecordByteLength: 1024 * 1024,
    maximumLiveRecordByteLength: 4 * 1024 * 1024,
    maximumLiveRecordCount: 256,
    maximumCandidateCount: 4,
  };

export type HizoFSGarbageCollectionDiagnostics = {
  readonly reachableObjectCount: number;
  readonly candidateObjectCount: number;
  readonly removedObjectCount: number;
  readonly changedSegmentCount: number;
  readonly compactedSegmentCount: number;
  readonly relocatedObjectCount: number;
  readonly reclaimedCompactionObjectCount: number;
  readonly ignoredPhysicalPathCount: number;
  readonly configuredRemoveConcurrency: number;
  readonly configuredMaximumRemovalsPerSlice: number;
  readonly configuredMaximumSliceDurationMs: number;
  readonly initialFenceWaitDurationMs: number;
  readonly initialFenceHoldDurationMs: number;
  readonly rootSnapshotDurationMs: number;
  readonly markDurationMs: number;
  readonly chunkVerificationDurationMs: number;
  readonly objectListingDurationMs: number;
  readonly candidateBuildDurationMs: number;
  readonly compactionWallDurationMs: number;
  readonly compactionLockWaitDurationMs: number;
  readonly compactionLockHoldDurationMs: number;
  readonly compactionYieldDurationMs: number;
  readonly compactionSliceCount: number;
  readonly maximumCompactionSliceDurationMs: number;
  readonly sweepWallDurationMs: number;
  readonly sweepLockWaitDurationMs: number;
  readonly sweepLockHoldDurationMs: number;
  readonly yieldDurationMs: number;
  readonly totalDurationMs: number;
  readonly sweepSliceCount: number;
  readonly maximumPauseDurationMs: number;
  readonly maximumSweepSliceDurationMs: number;
  readonly maximumRemovesInFlight: number;
  readonly maximumRemovalsInSlice: number;
  readonly sliceDurationBudgetOverrunCount: number;
  readonly resumedFromCheckpoint: boolean;
  readonly checkpointSequence: number;
};

export type HizoFSGarbageCollectionResult = {
  readonly reachableObjectCount: number;
  readonly unreachableObjectIds: readonly string[];
  readonly removedObjectCount: number;
  readonly ignoredPhysicalPaths: readonly string[];
  readonly diagnostics: HizoFSGarbageCollectionDiagnostics;
};

type ReferencedInode = {
  readonly nodeId: string;
  readonly objectId: string;
};

type LoadedReferencedInode =
  | {
      readonly kind: 'file_inode';
      readonly inode: HizoFSFileInodeDto;
    }
  | {
      readonly kind: 'directory_inode';
      readonly inode: HizoFSDirectoryInodeDto;
    }
  | {
      readonly kind: 'symlink_inode';
      readonly inode: HizoFSSymlinkInodeDto;
    };

type HizoFSMarkState = {
  readonly reachableObjectIds: Set<string>;
  readonly expectedKinds: Map<string, HizoFSRecordKind>;
  readonly loadedInodes: Map<string, LoadedReferencedInode>;
  readonly loadedSubvolumeDescriptors: Map<string, HizoFSSubvolumeDescriptorDto>;
  readonly visitedCommitObjectIds: Set<string>;
  readonly visitingCommitObjectIds: Set<string>;
  readonly visitedDirectoryPageObjectIds: Set<string>;
  readonly visitedSubvolumeMountPageObjectIds: Set<string>;
  readonly visitedExtentPageObjectIds: Set<string>;
  readonly extentRootChunkSizes: Map<string, number>;
  readonly chunkSizeLimits: Map<string, number>;
};

type GarbageCollectionDependencies = {
  readonly now: () => number;
  readonly compactionPolicy?: HizoFSGarbageCollectionCompactionPolicy;
  readonly afterRootSnapshot: () => Promise<void>;
  readonly removeCandidate: ({ runtime, candidate }: {
    runtime: HizoFSRuntime;
    candidate: HizoFSWholeSegmentReclaimCandidate;
  }) => Promise<HizoFSWholeSegmentRemovalResult>;
  readonly yieldToForeground: () => Promise<void>;
};

type GarbageCollectionRootSnapshot = {
  readonly runtime: HizoFSRuntime;
  readonly activeCommitObjectId: string;
  readonly commitObjectIds: readonly string[];
  readonly subvolumeDescriptorObjectIds: readonly string[];
  readonly canonicalObjectIds: ReadonlySet<string>;
  readonly ignoredPhysicalPaths: readonly string[];
  readonly initialFenceWaitDurationMs: number;
  readonly initialFenceHoldDurationMs: number;
  readonly rootSnapshotDurationMs: number;
  readonly objectListingDurationMs: number;
};

type GarbageCollectionPreparation = GarbageCollectionRootSnapshot & {
  readonly reachableObjectCount: number;
  readonly unreachableObjectIds: readonly string[];
  readonly sweepCandidates: readonly HizoFSWholeSegmentReclaimCandidate[];
  readonly compactionCandidates: readonly HizoFSPartialSegmentCompactionCandidate[];
  readonly markDurationMs: number;
  readonly chunkVerificationDurationMs: number;
  readonly candidateBuildDurationMs: number;
};

type GarbageCollectionCompactionMetrics = {
  readonly compactedSegmentCount: number;
  readonly relocatedObjectCount: number;
  readonly reclaimedObjectCount: number;
  readonly changedSegmentCount: number;
  readonly wallDurationMs: number;
  readonly lockWaitDurationMs: number;
  readonly lockHoldDurationMs: number;
  readonly yieldDurationMs: number;
  readonly sliceCount: number;
  readonly maximumSliceDurationMs: number;
};

type GarbageCollectionSweepMetrics = {
  readonly removedObjectCount: number;
  readonly changedSegmentCount: number;
  readonly sweepWallDurationMs: number;
  readonly sweepLockWaitDurationMs: number;
  readonly sweepLockHoldDurationMs: number;
  readonly yieldDurationMs: number;
  readonly sweepSliceCount: number;
  readonly maximumSweepSliceDurationMs: number;
  readonly maximumRemovesInFlight: number;
  readonly maximumRemovalsInSlice: number;
  readonly sliceDurationBudgetOverrunCount: number;
};

function monotonicNow(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

async function yieldToForeground(): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 0));
}

function elapsed({ now, startedAt }: {
  now: () => number;
  startedAt: number;
}): number {
  return Math.max(now() - startedAt, 0);
}

function resolveSweepPolicy({
  sweepPolicy,
}: {
  sweepPolicy: HizoFSGarbageCollectionSweepPolicy | undefined;
}): HizoFSGarbageCollectionSweepPolicy {
  const resolved = sweepPolicy ?? DEFAULT_HIZOFS_GARBAGE_COLLECTION_SWEEP_POLICY;
  if (!Number.isSafeInteger(resolved.removeConcurrency) || resolved.removeConcurrency <= 0) {
    throw new Error('HizoFS garbage-collection remove concurrency must be a positive safe integer');
  }
  if (
    !Number.isSafeInteger(resolved.maximumRemovalsPerSlice)
    || resolved.maximumRemovalsPerSlice <= 0
  ) {
    throw new Error(
      'HizoFS garbage-collection maximum removals per slice must be a positive safe integer',
    );
  }
  if (
    !Number.isFinite(resolved.maximumSliceDurationMs)
    || resolved.maximumSliceDurationMs <= 0
  ) {
    throw new Error('HizoFS garbage-collection slice duration must be a positive finite number');
  }
  return {
    removeConcurrency: resolved.removeConcurrency,
    maximumRemovalsPerSlice: resolved.maximumRemovalsPerSlice,
    maximumSliceDurationMs: resolved.maximumSliceDurationMs,
  };
}

function throwIfAborted({ signal }: {
  signal: AbortSignal | undefined;
}): void {
  if (signal?.aborted !== true) return;
  if (signal.reason !== undefined) throw signal.reason;
  throw new DOMException('HizoFS garbage collection was aborted', 'AbortError');
}

export async function collectHizoFSGarbage({
  backingDirectory,
  fileSystemRootKey,
  dryRun,
  sweepPolicy,
  signal,
}: {
  backingDirectory: FileSystemDirectoryHandle;
  fileSystemRootKey: Uint8Array;
  dryRun: boolean;
  sweepPolicy: HizoFSGarbageCollectionSweepPolicy | undefined;
  signal: AbortSignal | undefined;
}): Promise<HizoFSGarbageCollectionResult> {
  return collectHizoFSGarbageInternal({
    backingDirectory,
    fileSystemRootKey,
    dryRun,
    sweepPolicy,
    signal,
    dependencies: {
      now: monotonicNow,
      afterRootSnapshot: async () => {},
      removeCandidate: async ({ runtime, candidate }) => (
        runtime.objectStore.removeWholeSegmentIfUnchanged({ candidate })
      ),
      yieldToForeground,
    },
  });
}

async function collectHizoFSGarbageInternal({
  backingDirectory,
  fileSystemRootKey,
  dryRun,
  sweepPolicy,
  signal,
  dependencies,
}: {
  backingDirectory: FileSystemDirectoryHandle;
  fileSystemRootKey: Uint8Array;
  dryRun: boolean;
  sweepPolicy: HizoFSGarbageCollectionSweepPolicy | undefined;
  signal: AbortSignal | undefined;
  dependencies: GarbageCollectionDependencies;
}): Promise<HizoFSGarbageCollectionResult> {
  const totalStartedAt = dependencies.now();
  const resolvedSweepPolicy = resolveSweepPolicy({ sweepPolicy });
  throwIfAborted({ signal });

  const backingStore = new NativeOpfsHizoFSBackingStore({
    root: backingDirectory,
    // GC walks most immutable objects only once, so retaining a large runtime
    // handle cache would trade memory for little reuse. Keep only a small
    // working set for superblocks and nearby metadata.
    fileHandleCacheEntryLimit: 64,
    fileSnapshotCacheEntryLimit: 64,
    diagnostics: undefined,
  });
  const rootKey = await importHizoFSRootKey({
    rawRootKey: fileSystemRootKey,
  });
  const fileSystemId = await deriveHizoFSFileSystemId({ rootKey });
  const checkpointStore = new HizoFSGarbageCollectionCheckpointStore({
    backingStore,
    rootKey,
    fileSystemId,
  });
  const garbageCollectionLease = await acquireHizoFSGarbageCollectionLease({
    fileSystemId,
  });
  let preparation: GarbageCollectionPreparation | undefined;
  let compactionMetrics: GarbageCollectionCompactionMetrics | undefined;
  let sweepMetrics: GarbageCollectionSweepMetrics | undefined;
  let operationError: unknown;
  let checkpoint: HizoFSGarbageCollectionCheckpoint | undefined;
  let resumedFromCheckpoint = false;
  let resumedCounters = { relocated: 0, reclaimedCompaction: 0, removedSweep: 0 };
  try {
    preparation = await prepareGarbageCollection({
      backingStore,
      rootKey,
      fileSystemId,
      signal,
      now: dependencies.now,
      afterRootSnapshot: dependencies.afterRootSnapshot,
      compactionPolicy: dependencies.compactionPolicy
        ?? DEFAULT_HIZOFS_GARBAGE_COLLECTION_COMPACTION_POLICY,
    });

    // Marking authenticates plaintext metadata and file chunks, but sweeping
    // needs only immutable object IDs. Release and zero those cached plaintexts
    // before a potentially long multi-slice sweep.
    preparation.runtime.objectStore.clearPlaintextCaches();

    if (!dryRun) {
      const persisted = await checkpointStore.read();
      resumedFromCheckpoint = persisted?.activeCommitObjectId === preparation.activeCommitObjectId;
      if (resumedFromCheckpoint && persisted !== undefined) {
        resumedCounters = {
          relocated: persisted.relocatedObjectCount,
          reclaimedCompaction: persisted.reclaimedCompactionObjectCount,
          removedSweep: persisted.removedSweepObjectCount,
        };
      }
      const base = resumedFromCheckpoint && persisted !== undefined
        ? persisted
        : {
          sequence: persisted?.sequence ?? 0,
          activeCommitObjectId: preparation.activeCommitObjectId,
          phase: 'compaction' as const,
          completedCompactionCandidateCount: 0,
          completedSweepCandidateCount: 0,
          relocatedObjectCount: 0,
          reclaimedCompactionObjectCount: 0,
          removedSweepObjectCount: 0,
          lastCompletedCandidateObjectId: null,
        };
      checkpoint = {
        ...base,
        sequence: base.sequence + 1,
        activeCommitObjectId: preparation.activeCommitObjectId,
        phase: 'compaction',
      };
      await checkpointStore.write({ checkpoint });
    }

    compactionMetrics = dryRun
      ? createEmptyCompactionMetrics()
      : await compactGarbageCollectionCandidates({
        runtime: preparation.runtime,
        fileSystemId,
        candidates: preparation.compactionCandidates,
        signal,
        dependencies,
        onProgress: async ({ candidate, metrics }) => {
          if (checkpoint === undefined) return;
          checkpoint = {
            ...checkpoint,
            sequence: checkpoint.sequence + 1,
            phase: 'compaction',
            completedCompactionCandidateCount:
              checkpoint.completedCompactionCandidateCount + 1,
            relocatedObjectCount: checkpoint.relocatedObjectCount
              + metrics.lastRelocatedObjectCount,
            reclaimedCompactionObjectCount:
              checkpoint.reclaimedCompactionObjectCount
              + metrics.lastReclaimedObjectCount,
            lastCompletedCandidateObjectId: candidate.representativeObjectId,
          };
          await checkpointStore.write({ checkpoint });
        },
      });

    if (!dryRun && checkpoint !== undefined) {
      checkpoint = {
        ...checkpoint,
        sequence: checkpoint.sequence + 1,
        phase: 'sweep',
        lastCompletedCandidateObjectId: null,
      };
      await checkpointStore.write({ checkpoint });
    }

    sweepMetrics = dryRun
      ? createEmptySweepMetrics()
      : await sweepGarbageCollectionCandidates({
        runtime: preparation.runtime,
        fileSystemId,
        candidates: preparation.sweepCandidates,
        sweepPolicy: resolvedSweepPolicy,
        signal,
        dependencies,
        onProgress: async ({ candidate, removedObjectCount }) => {
          if (checkpoint === undefined) return;
          checkpoint = {
            ...checkpoint,
            sequence: checkpoint.sequence + 1,
            phase: 'sweep',
            completedSweepCandidateCount: checkpoint.completedSweepCandidateCount + 1,
            removedSweepObjectCount: checkpoint.removedSweepObjectCount + removedObjectCount,
            lastCompletedCandidateObjectId: candidate.representativeObjectId,
          };
          await checkpointStore.write({ checkpoint });
        },
      });
    if (!dryRun) await checkpointStore.clear();
  } catch (error) {
    operationError = error;
  }

  const cleanupErrors: unknown[] = [];
  if (preparation !== undefined) {
    try {
      await preparation.runtime.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    await garbageCollectionLease.release();
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (operationError !== undefined) throw operationError;
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'Failed to release HizoFS garbage-collection resources');
  }

  if (preparation === undefined || compactionMetrics === undefined || sweepMetrics === undefined) {
    throw new Error('HizoFS garbage collection completed without metrics');
  }

  const resumedRelocatedObjectCount = resumedCounters.relocated;
  const resumedReclaimedCompactionObjectCount = resumedCounters.reclaimedCompaction;
  const resumedRemovedSweepObjectCount = resumedCounters.removedSweep;

  const maximumPauseDurationMs = Math.max(
    preparation.initialFenceHoldDurationMs,
    compactionMetrics.maximumSliceDurationMs,
    sweepMetrics.maximumSweepSliceDurationMs,
  );

  return {
    reachableObjectCount: preparation.reachableObjectCount,
    unreachableObjectIds: preparation.unreachableObjectIds,
    removedObjectCount: resumedRemovedSweepObjectCount + resumedReclaimedCompactionObjectCount
      + sweepMetrics.removedObjectCount + compactionMetrics.reclaimedObjectCount,
    ignoredPhysicalPaths: preparation.ignoredPhysicalPaths,
    diagnostics: {
      reachableObjectCount: preparation.reachableObjectCount,
      candidateObjectCount: preparation.unreachableObjectIds.length,
      removedObjectCount: resumedRemovedSweepObjectCount + resumedReclaimedCompactionObjectCount
      + sweepMetrics.removedObjectCount + compactionMetrics.reclaimedObjectCount,
      changedSegmentCount: sweepMetrics.changedSegmentCount + compactionMetrics.changedSegmentCount,
      compactedSegmentCount: compactionMetrics.compactedSegmentCount,
      relocatedObjectCount: resumedRelocatedObjectCount + compactionMetrics.relocatedObjectCount,
      reclaimedCompactionObjectCount: resumedReclaimedCompactionObjectCount
        + compactionMetrics.reclaimedObjectCount,
      ignoredPhysicalPathCount: preparation.ignoredPhysicalPaths.length,
      configuredRemoveConcurrency: resolvedSweepPolicy.removeConcurrency,
      configuredMaximumRemovalsPerSlice: resolvedSweepPolicy.maximumRemovalsPerSlice,
      configuredMaximumSliceDurationMs: resolvedSweepPolicy.maximumSliceDurationMs,
      initialFenceWaitDurationMs: preparation.initialFenceWaitDurationMs,
      initialFenceHoldDurationMs: preparation.initialFenceHoldDurationMs,
      rootSnapshotDurationMs: preparation.rootSnapshotDurationMs,
      markDurationMs: preparation.markDurationMs,
      chunkVerificationDurationMs: preparation.chunkVerificationDurationMs,
      objectListingDurationMs: preparation.objectListingDurationMs,
      candidateBuildDurationMs: preparation.candidateBuildDurationMs,
      compactionWallDurationMs: compactionMetrics.wallDurationMs,
      compactionLockWaitDurationMs: compactionMetrics.lockWaitDurationMs,
      compactionLockHoldDurationMs: compactionMetrics.lockHoldDurationMs,
      compactionYieldDurationMs: compactionMetrics.yieldDurationMs,
      compactionSliceCount: compactionMetrics.sliceCount,
      maximumCompactionSliceDurationMs: compactionMetrics.maximumSliceDurationMs,
      sweepWallDurationMs: sweepMetrics.sweepWallDurationMs,
      sweepLockWaitDurationMs: sweepMetrics.sweepLockWaitDurationMs,
      sweepLockHoldDurationMs: sweepMetrics.sweepLockHoldDurationMs,
      yieldDurationMs: sweepMetrics.yieldDurationMs,
      totalDurationMs: elapsed({ now: dependencies.now, startedAt: totalStartedAt }),
      sweepSliceCount: sweepMetrics.sweepSliceCount,
      maximumPauseDurationMs,
      maximumSweepSliceDurationMs: sweepMetrics.maximumSweepSliceDurationMs,
      maximumRemovesInFlight: sweepMetrics.maximumRemovesInFlight,
      maximumRemovalsInSlice: sweepMetrics.maximumRemovalsInSlice,
      sliceDurationBudgetOverrunCount: sweepMetrics.sliceDurationBudgetOverrunCount,
      resumedFromCheckpoint,
      checkpointSequence: checkpoint?.sequence ?? 0,
    },
  };
}

async function prepareGarbageCollection({
  backingStore,
  rootKey,
  fileSystemId,
  signal,
  now,
  afterRootSnapshot,
  compactionPolicy,
}: {
  backingStore: NativeOpfsHizoFSBackingStore;
  rootKey: CryptoKey;
  fileSystemId: string;
  signal: AbortSignal | undefined;
  now: () => number;
  afterRootSnapshot: () => Promise<void>;
  compactionPolicy: HizoFSGarbageCollectionCompactionPolicy;
}): Promise<GarbageCollectionPreparation> {
  const snapshot = await snapshotGarbageCollectionRoots({
    backingStore,
    rootKey,
    fileSystemId,
    signal,
    now,
  });
  await afterRootSnapshot();
  throwIfAborted({ signal });

  // The maintenance fence drained every pre-existing reader, writer, bulk
  // builder, and mutation before this snapshot was taken. Object IDs are never
  // reused, and later mutations can reference only objects reachable from the
  // snapped active generation plus objects created after the physical listing.
  // Therefore marking the immutable snapped roots is safe without holding the
  // foreground-blocking maintenance lease.
  const markStartedAt = now();
  const markState: HizoFSMarkState = {
    reachableObjectIds: new Set<string>(),
    expectedKinds: new Map<string, HizoFSRecordKind>(),
    loadedInodes: new Map<string, LoadedReferencedInode>(),
    loadedSubvolumeDescriptors: new Map<string, HizoFSSubvolumeDescriptorDto>(),
    visitedCommitObjectIds: new Set<string>(),
    visitingCommitObjectIds: new Set<string>(),
    visitedDirectoryPageObjectIds: new Set<string>(),
    visitedSubvolumeMountPageObjectIds: new Set<string>(),
    visitedExtentPageObjectIds: new Set<string>(),
    extentRootChunkSizes: new Map<string, number>(),
    chunkSizeLimits: new Map<string, number>(),
  };
  let rootSubvolumeId: string | undefined;
  for (const descriptorObjectId of snapshot.subvolumeDescriptorObjectIds) {
    registerObjectReference({
      markState,
      objectId: descriptorObjectId,
      expectedKind: 'subvolume_descriptor',
    });
    const descriptor = await snapshot.runtime.subvolumeDescriptorStore.read({
      objectId: descriptorObjectId,
    });
    markState.loadedSubvolumeDescriptors.set(descriptorObjectId, descriptor);
    switch (descriptor.access) {
    case 'read':
      throw new HizoFSCorruptionError({
        message: 'HizoFS root descriptor must be read_write during garbage collection',
        cause: undefined,
      });
    case 'read_write':
      rootSubvolumeId = descriptor.subvolumeId;
      break;
    default: {
      const _ex: never = descriptor;
      throw new Error(
        `Unhandled HizoFS root descriptor access: ${
          ((_ex satisfies never) as { readonly access: string }).access
        }`,
      );
    }
    }
  }
  if (rootSubvolumeId === undefined) {
    throw new HizoFSCorruptionError({
      message: 'HizoFS garbage collection found no root subvolume identity',
      cause: undefined,
    });
  }
  for (const commitObjectId of snapshot.commitObjectIds) {
    throwIfAborted({ signal });
    await markCommitGeneration({
      runtime: snapshot.runtime,
      commitObjectId,
      expectedSubvolumeId: rootSubvolumeId,
      markState,
    });
  }
  if (!snapshot.commitObjectIds.includes(snapshot.activeCommitObjectId)) {
    throw new HizoFSCorruptionError({
      message: 'HizoFS active commit is absent from the valid superblock candidates',
      cause: undefined,
    });
  }
  const markDurationMs = elapsed({ now, startedAt: markStartedAt });

  const chunkVerificationStartedAt = now();
  for (const [objectId, chunkSize] of markState.chunkSizeLimits) {
    throwIfAborted({ signal });
    await snapshot.runtime.chunkStore.read({ objectId, chunkSize });
  }
  const chunkVerificationDurationMs = elapsed({
    now,
    startedAt: chunkVerificationStartedAt,
  });

  const candidateBuildStartedAt = now();
  const canonicalReachableObjectIds = new Set<string>();
  for (const objectId of markState.reachableObjectIds) {
    canonicalReachableObjectIds.add(await snapshot.runtime.objectStore.resolveObjectId({ objectId }));
  }
  const unreachableObjectIds = [...snapshot.canonicalObjectIds]
    .filter(objectId => !canonicalReachableObjectIds.has(objectId))
    .sort();
  const { sweepCandidates, compactionCandidates } = await promiseAllKeyed({
    sweepCandidates: snapshot.runtime.objectStore
      .selectWholeSegmentReclaimCandidates({ unreachableObjectIds }),
    compactionCandidates: snapshot.runtime.objectStore.selectPartialSegmentCompactionCandidates({
      reachableObjectIds: [...canonicalReachableObjectIds],
      minimumDeadRecordByteLength: compactionPolicy.minimumDeadRecordByteLength,
      maximumLiveRecordByteLength: compactionPolicy.maximumLiveRecordByteLength,
      maximumLiveRecordCount: compactionPolicy.maximumLiveRecordCount,
      maximumCandidateCount: compactionPolicy.maximumCandidateCount,
    }),
  });
  const candidateBuildDurationMs = elapsed({
    now,
    startedAt: candidateBuildStartedAt,
  });

  return {
    ...snapshot,
    reachableObjectCount: markState.reachableObjectIds.size,
    unreachableObjectIds,
    sweepCandidates,
    compactionCandidates,
    markDurationMs,
    chunkVerificationDurationMs,
    candidateBuildDurationMs,
  };
}

async function snapshotGarbageCollectionRoots({
  backingStore,
  rootKey,
  fileSystemId,
  signal,
  now,
}: {
  backingStore: NativeOpfsHizoFSBackingStore;
  rootKey: CryptoKey;
  fileSystemId: string;
  signal: AbortSignal | undefined;
  now: () => number;
}): Promise<GarbageCollectionRootSnapshot> {
  const runtime = createHizoFSRuntime({
    backingStore,
    rootKey,
    fileSystemId,
    policy: DEFAULT_HIZOFS_POLICY,
    now: () => Date.now(),
    diagnostics: undefined,
  });
  const fenceRequestedAt = now();
  const lease = await acquireHizoFSMaintenanceLease({ fileSystemId });
  const initialFenceWaitDurationMs = elapsed({ now, startedAt: fenceRequestedAt });
  const fenceStartedAt = now();
  let rootSnapshotDurationMs = 0;
  let objectListingDurationMs = 0;
  let snapshot: Omit<GarbageCollectionRootSnapshot, 'initialFenceHoldDurationMs'>
    | undefined;
  try {
    throwIfAborted({ signal });
    await runtime.releaseLocalPhysicalHandlesForMaintenance();

    const rootSnapshotStartedAt = now();
    const activeState = await runtime.core.loadActiveState();
    switch (activeState.stateSelection) {
    case 'current':
      break;
    case 'fallback':
      throw new HizoFSCorruptionError({
        message: 'HizoFS garbage collection is disabled in read-only recovery mode',
        cause: undefined,
      });
    default: {
      const _ex: never = activeState.stateSelection;
      throw new Error(`Unhandled HizoFS active state mode: ${String(_ex)}`);
    }
    }
    const superblocks = await runtime.core.superblockStore.readCandidates();
    const commitObjectIds = [...new Set(
      superblocks.map(superblock => superblock.activeCommitObjectId),
    )];
    const subvolumeDescriptorObjectIds = [...new Set(
      superblocks.map(superblock => superblock.subvolumeDescriptorObjectId),
    )];
    if (subvolumeDescriptorObjectIds.length !== 1) {
      throw new HizoFSCorruptionError({
        message: 'HizoFS root superblock generations disagree on the subvolume descriptor',
        cause: undefined,
      });
    }
    if (!commitObjectIds.includes(activeState.commitObjectId)) {
      throw new HizoFSCorruptionError({
        message: 'HizoFS active commit is absent from the valid superblock candidates',
        cause: undefined,
      });
    }
    rootSnapshotDurationMs = elapsed({ now, startedAt: rootSnapshotStartedAt });

    const objectListingStartedAt = now();
    const listing = await runtime.objectStore.listPhysicalObjects();
    const canonicalObjectIds = new Set(listing.entries.map(entry => entry.objectId));
    const { ignoredPhysicalPaths } = listing;
    objectListingDurationMs = elapsed({ now, startedAt: objectListingStartedAt });

    snapshot = {
      runtime,
      activeCommitObjectId: activeState.commitObjectId,
      commitObjectIds,
      subvolumeDescriptorObjectIds,
      canonicalObjectIds,
      ignoredPhysicalPaths,
      initialFenceWaitDurationMs,
      rootSnapshotDurationMs,
      objectListingDurationMs,
    };
  } finally {
    await lease.release();
  }
  if (snapshot === undefined) {
    await runtime.close();
    throw new Error('HizoFS garbage-collection root snapshot completed without a result');
  }
  return {
    ...snapshot,
    initialFenceHoldDurationMs: elapsed({ now, startedAt: fenceStartedAt }),
  };
}

function createEmptyCompactionMetrics(): GarbageCollectionCompactionMetrics {
  return {
    compactedSegmentCount: 0,
    relocatedObjectCount: 0,
    reclaimedObjectCount: 0,
    changedSegmentCount: 0,
    wallDurationMs: 0,
    lockWaitDurationMs: 0,
    lockHoldDurationMs: 0,
    yieldDurationMs: 0,
    sliceCount: 0,
    maximumSliceDurationMs: 0,
  };
}

async function compactGarbageCollectionCandidates({
  runtime,
  fileSystemId,
  candidates,
  signal,
  dependencies,
  onProgress,
}: {
  runtime: HizoFSRuntime;
  fileSystemId: string;
  candidates: readonly HizoFSPartialSegmentCompactionCandidate[];
  signal: AbortSignal | undefined;
  dependencies: GarbageCollectionDependencies;
  onProgress: (({ candidate, metrics }: {
    candidate: HizoFSPartialSegmentCompactionCandidate;
    metrics: { lastRelocatedObjectCount: number; lastReclaimedObjectCount: number };
  }) => Promise<void>) | undefined;
}): Promise<GarbageCollectionCompactionMetrics> {
  if (candidates.length === 0) return createEmptyCompactionMetrics();
  const startedAt = dependencies.now();
  let compactedSegmentCount = 0;
  let relocatedObjectCount = 0;
  let reclaimedObjectCount = 0;
  let changedSegmentCount = 0;
  let lockWaitDurationMs = 0;
  let lockHoldDurationMs = 0;
  let yieldDurationMs = 0;
  let sliceCount = 0;
  let maximumSliceDurationMs = 0;

  for (let index = 0; index < candidates.length; index += 1) {
    throwIfAborted({ signal });
    const candidate = candidates[index];
    if (candidate === undefined) continue;
    const requestedAt = dependencies.now();
    const lease = await acquireHizoFSMaintenanceLease({ fileSystemId });
    lockWaitDurationMs += elapsed({ now: dependencies.now, startedAt: requestedAt });
    const sliceStartedAt = dependencies.now();
    try {
      await runtime.releaseLocalPhysicalHandlesForMaintenance();
      const mappings = await runtime.objectStore.copyObjectsForRelocation({
        objectIds: candidate.liveObjectIds,
      });
      await runtime.objectStore.publishRelocations({ mappings });
      const result = await runtime.objectStore.removeWholeSegmentIfUnchanged({
        candidate: {
          representativeObjectId: candidate.representativeObjectId,
          objectIds: [...candidate.liveObjectIds, ...candidate.deadObjectIds],
          physicalPath: candidate.physicalPath,
          expectedPhysicalByteLength: candidate.expectedPhysicalByteLength,
        },
      });
      relocatedObjectCount += mappings.size;
      switch (result) {
      case 'removed':
      case 'missing':
        compactedSegmentCount += 1;
        reclaimedObjectCount += candidate.deadObjectIds.length;
        break;
      case 'changed':
        changedSegmentCount += 1;
        break;
      default: {
        const _ex: never = result;
        throw new Error(`Unhandled HizoFS compaction removal result: ${String(_ex)}`);
      }
      }
      await onProgress?.({
        candidate,
        metrics: {
          lastRelocatedObjectCount: mappings.size,
          lastReclaimedObjectCount:
            result === 'removed' || result === 'missing' ? candidate.deadObjectIds.length : 0,
        },
      });
    } finally {
      await lease.release();
    }
    const sliceDurationMs = elapsed({ now: dependencies.now, startedAt: sliceStartedAt });
    sliceCount += 1;
    lockHoldDurationMs += sliceDurationMs;
    maximumSliceDurationMs = Math.max(maximumSliceDurationMs, sliceDurationMs);
    if (index + 1 < candidates.length) {
      const yieldStartedAt = dependencies.now();
      await dependencies.yieldToForeground();
      yieldDurationMs += elapsed({ now: dependencies.now, startedAt: yieldStartedAt });
    }
  }
  return {
    compactedSegmentCount,
    relocatedObjectCount,
    reclaimedObjectCount,
    changedSegmentCount,
    wallDurationMs: elapsed({ now: dependencies.now, startedAt }),
    lockWaitDurationMs,
    lockHoldDurationMs,
    yieldDurationMs,
    sliceCount,
    maximumSliceDurationMs,
  };
}

function createEmptySweepMetrics(): GarbageCollectionSweepMetrics {
  return {
    removedObjectCount: 0,
    changedSegmentCount: 0,
    sweepWallDurationMs: 0,
    sweepLockWaitDurationMs: 0,
    sweepLockHoldDurationMs: 0,
    yieldDurationMs: 0,
    sweepSliceCount: 0,
    maximumSweepSliceDurationMs: 0,
    maximumRemovesInFlight: 0,
    maximumRemovalsInSlice: 0,
    sliceDurationBudgetOverrunCount: 0,
  };
}

async function sweepGarbageCollectionCandidates({
  runtime,
  fileSystemId,
  candidates,
  sweepPolicy,
  signal,
  dependencies,
  onProgress,
}: {
  runtime: HizoFSRuntime;
  fileSystemId: string;
  candidates: readonly HizoFSWholeSegmentReclaimCandidate[];
  sweepPolicy: HizoFSGarbageCollectionSweepPolicy;
  signal: AbortSignal | undefined;
  dependencies: GarbageCollectionDependencies;
  onProgress: (({ candidate, removedObjectCount }: {
    candidate: HizoFSWholeSegmentReclaimCandidate;
    removedObjectCount: number;
  }) => Promise<void>) | undefined;
}): Promise<GarbageCollectionSweepMetrics> {
  // Every resumed invocation performs a fresh authenticated mark. The durable
  // checkpoint records cumulative progress and the last completed candidate,
  // but never substitutes stale reachability data for the fresh candidate set.
  // Started removals always settle before the maintenance lease is released.
  if (candidates.length === 0) return createEmptySweepMetrics();

  const sweepStartedAt = dependencies.now();
  let nextObjectIndex = 0;
  let removedObjectCount = 0;
  let changedSegmentCount = 0;
  let sweepLockWaitDurationMs = 0;
  let sweepLockHoldDurationMs = 0;
  let yieldDurationMs = 0;
  let sweepSliceCount = 0;
  let maximumSweepSliceDurationMs = 0;
  let maximumRemovesInFlight = 0;
  let maximumRemovalsInSlice = 0;
  let sliceDurationBudgetOverrunCount = 0;

  while (nextObjectIndex < candidates.length) {
    throwIfAborted({ signal });
    const leaseRequestedAt = dependencies.now();
    const lease = await acquireHizoFSMaintenanceLease({ fileSystemId });
    sweepLockWaitDurationMs += elapsed({ now: dependencies.now, startedAt: leaseRequestedAt });
    const sliceStartedAt = dependencies.now();
    let removalsInSlice = 0;
    let sliceFailure: unknown;
    let abortAfterSlice = false;
    try {
      throwIfAborted({ signal });
      await runtime.releaseLocalPhysicalHandlesForMaintenance();
      while (
        nextObjectIndex < candidates.length
        && removalsInSlice < sweepPolicy.maximumRemovalsPerSlice
      ) {
        const remainingInSlice = sweepPolicy.maximumRemovalsPerSlice - removalsInSlice;
        const batchSize = Math.min(
          sweepPolicy.removeConcurrency,
          remainingInSlice,
          candidates.length - nextObjectIndex,
        );
        const batchCandidates = candidates.slice(
          nextObjectIndex,
          nextObjectIndex + batchSize,
        );
        maximumRemovesInFlight = Math.max(maximumRemovesInFlight, batchCandidates.length);
        const outcomes = await Promise.allSettled(batchCandidates.map(async candidate => (
          dependencies.removeCandidate({ runtime, candidate })
        )));
        const failures: Error[] = [];
        for (let index = 0; index < outcomes.length; index += 1) {
          const outcome = outcomes[index];
          const candidate = batchCandidates[index];
          if (outcome === undefined || candidate === undefined) {
            throw new Error('HizoFS garbage-collection sweep batch lost positional identity');
          }
          switch (outcome.status) {
          case 'fulfilled':
            switch (outcome.value) {
            case 'removed':
            case 'missing':
              removedObjectCount += candidate.objectIds.length;
              await onProgress?.({ candidate, removedObjectCount: candidate.objectIds.length });
              break;
            case 'changed':
              changedSegmentCount += 1;
              await onProgress?.({ candidate, removedObjectCount: 0 });
              break;
            default: {
              const _ex: never = outcome.value;
              throw new Error(`Unhandled HizoFS segment-removal result: ${String(_ex)}`);
            }
            }
            break;
          case 'rejected':
            failures.push(new Error(
              `Failed to remove HizoFS garbage segment ${candidate.physicalPath.join('/')}`,
              { cause: outcome.reason },
            ));
            break;
          default: {
            const _ex: never = outcome;
            throw new Error(`Unhandled HizoFS garbage-collection result: ${String(_ex)}`);
          }
          }
        }
        nextObjectIndex += batchCandidates.length;
        removalsInSlice += batchCandidates.length;
        if (failures.length > 0) {
          sliceFailure = new AggregateError(
            failures,
            'HizoFS garbage collection could not remove every scheduled object',
          );
          break;
        }
        if (signal?.aborted === true) {
          abortAfterSlice = true;
          break;
        }
        if (
          elapsed({ now: dependencies.now, startedAt: sliceStartedAt })
          >= sweepPolicy.maximumSliceDurationMs
        ) {
          break;
        }
      }
    } finally {
      await lease.release();
    }

    const sliceDurationMs = elapsed({ now: dependencies.now, startedAt: sliceStartedAt });
    sweepSliceCount += 1;
    sweepLockHoldDurationMs += sliceDurationMs;
    maximumSweepSliceDurationMs = Math.max(maximumSweepSliceDurationMs, sliceDurationMs);
    maximumRemovalsInSlice = Math.max(maximumRemovalsInSlice, removalsInSlice);
    if (sliceDurationMs > sweepPolicy.maximumSliceDurationMs) {
      sliceDurationBudgetOverrunCount += 1;
    }
    if (sliceFailure !== undefined) throw sliceFailure;
    if (abortAfterSlice) throwIfAborted({ signal });

    if (nextObjectIndex < candidates.length) {
      const yieldStartedAt = dependencies.now();
      await dependencies.yieldToForeground();
      yieldDurationMs += elapsed({ now: dependencies.now, startedAt: yieldStartedAt });
    }
  }

  return {
    removedObjectCount,
    changedSegmentCount,
    sweepWallDurationMs: elapsed({ now: dependencies.now, startedAt: sweepStartedAt }),
    sweepLockWaitDurationMs,
    sweepLockHoldDurationMs,
    yieldDurationMs,
    sweepSliceCount,
    maximumSweepSliceDurationMs,
    maximumRemovesInFlight,
    maximumRemovalsInSlice,
    sliceDurationBudgetOverrunCount,
  };
}

async function markCommitGeneration({
  runtime,
  commitObjectId,
  expectedSubvolumeId,
  markState,
}: {
  runtime: HizoFSRuntime;
  commitObjectId: string;
  expectedSubvolumeId: string;
  markState: HizoFSMarkState;
}): Promise<void> {
  registerObjectReference({
    markState,
    objectId: commitObjectId,
    expectedKind: 'commit',
  });
  const commit = await runtime.commitStore.read({ objectId: commitObjectId });
  if (commit.subvolumeId !== expectedSubvolumeId) {
    throw new HizoFSCorruptionError({
      message: 'HizoFS subvolume descriptor and commit identities do not match',
      cause: undefined,
    });
  }
  if (markState.visitedCommitObjectIds.has(commitObjectId)) return;
  if (markState.visitingCommitObjectIds.has(commitObjectId)) {
    throw new HizoFSCorruptionError({
      message: `HizoFS subvolume graph contains a commit cycle: ${commitObjectId}`,
      cause: undefined,
    });
  }
  markState.visitingCommitObjectIds.add(commitObjectId);
  try {
    await runtime.subvolumeMountIndex.visitReferences({
      rootObjectId: commit.subvolumeMountIndexRootObjectId,
      visitPageObjectId: ({ objectId }) => registerObjectReference({
        markState,
        objectId,
        expectedKind: 'subvolume_mount_index_page',
      }),
      visitDescriptorObjectId: ({ objectId }) => registerObjectReference({
        markState,
        objectId,
        expectedKind: 'subvolume_descriptor',
      }),
      visitedPageObjectIds: markState.visitedSubvolumeMountPageObjectIds,
    });
    const mountsById = new Map<string, string>();
    for await (const mount of runtime.subvolumeMountIndex.entries({
      rootObjectId: commit.subvolumeMountIndexRootObjectId,
    })) {
      if (mountsById.has(mount.mountId)) {
        throw new HizoFSCorruptionError({
          message: `HizoFS subvolume mount index contains a duplicate mount ID: ${mount.mountId}`,
          cause: undefined,
        });
      }
      mountsById.set(mount.mountId, mount.subvolumeDescriptorObjectId);
      let descriptor = markState.loadedSubvolumeDescriptors.get(
        mount.subvolumeDescriptorObjectId,
      );
      if (descriptor === undefined) {
        descriptor = await runtime.subvolumeDescriptorStore.read({
          objectId: mount.subvolumeDescriptorObjectId,
        });
        markState.loadedSubvolumeDescriptors.set(
          mount.subvolumeDescriptorObjectId,
          descriptor,
        );
      }
      switch (descriptor.access) {
      case 'read':
        await markCommitGeneration({
          runtime,
          commitObjectId: descriptor.fixedCommitObjectId,
          expectedSubvolumeId: descriptor.subvolumeId,
          markState,
        });
        break;
      case 'read_write':
        throw new HizoFSCorruptionError({
          message:
            'HizoFS garbage collection refuses read_write child subvolumes until child-head traversal is enabled',
          cause: undefined,
        });
      default: {
        const _ex: never = descriptor;
        throw new Error(`Unhandled HizoFS subvolume descriptor: ${String(_ex)}`);
      }
      }
    }
    const namespaceMountIds = new Set<string>();
    await runtime.inodeIndex.validateStructure({
      rootObjectId: commit.inodeIndexRootObjectId,
    });

    const referencedInodes = new Map<string, ReferencedInode>();
    await runtime.inodeIndex.visitReferences({
      rootObjectId: commit.inodeIndexRootObjectId,
      visitPageObjectId: ({ objectId }) => registerObjectReference({
        markState,
        objectId,
        expectedKind: 'inode_index_page',
      }),
      visitInodeObjectId: ({ objectId, nodeId }) => {
        if (referencedInodes.has(nodeId)) {
          throw new HizoFSCorruptionError({
            message: `HizoFS inode index contains a duplicate node ID: ${nodeId}`,
            cause: undefined,
          });
        }
        referencedInodes.set(nodeId, { objectId, nodeId });
      },
      visitedPageObjectIds: undefined,
    });

    type PendingNode = {
      readonly nodeId: string;
      readonly expectedKind: 'file' | 'directory' | 'symlink';
    };
    const pending: PendingNode[] = [{
      nodeId: commit.rootDirectoryNodeId,
      expectedKind: 'directory',
    }];
    const namespaceNodeIds = new Set<string>();

    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) break;
      if (namespaceNodeIds.has(current.nodeId)) {
        throw new HizoFSCorruptionError({
          message: `HizoFS namespace contains a cycle or duplicate inode reference: ${current.nodeId}`,
          cause: undefined,
        });
      }
      namespaceNodeIds.add(current.nodeId);

      const reference = referencedInodes.get(current.nodeId);
      if (reference === undefined) {
        throw new HizoFSCorruptionError({
          message: `HizoFS directory entry references an inode absent from the index: ${current.nodeId}`,
          cause: undefined,
        });
      }
      const loaded = await loadReferencedInode({ runtime, reference, markState });
      switch (loaded.kind) {
      case 'file_inode': {
        switch (current.expectedKind) {
        case 'file':
          break;
        case 'directory':
        case 'symlink':
          throw new HizoFSCorruptionError({
            message: `HizoFS directory entry kind does not match file inode: ${current.nodeId}`,
            cause: undefined,
          });
        default: {
          const _ex: never = current.expectedKind;
          throw new Error(`Unhandled HizoFS directory entry kind: ${String(_ex)}`);
        }
        }
        const { storage } = loaded.inode;
        switch (storage.type) {
        case 'inline':
          break;
        case 'extents': {
          await runtime.extentIndex.validateStructure({
            rootObjectId: storage.extentIndexRootObjectId,
          });
          const previousChunkSize = markState.extentRootChunkSizes.get(
            storage.extentIndexRootObjectId,
          );
          if (
            previousChunkSize !== undefined
            && previousChunkSize !== storage.chunkSize
          ) {
            throw new HizoFSCorruptionError({
              message: 'A shared HizoFS extent root is referenced with inconsistent chunk sizes',
              cause: undefined,
            });
          }
          markState.extentRootChunkSizes.set(
            storage.extentIndexRootObjectId,
            storage.chunkSize,
          );
          await runtime.extentIndex.visitReferences({
            rootObjectId: storage.extentIndexRootObjectId,
            visitPageObjectId: ({ objectId }) => registerObjectReference({
              markState,
              objectId,
              expectedKind: 'file_extent_page',
            }),
            visitChunkObjectId: ({ objectId }) => {
              registerObjectReference({
                markState,
                objectId,
                expectedKind: 'file_chunk',
              });
              const previousLimit = markState.chunkSizeLimits.get(objectId);
              markState.chunkSizeLimits.set(
                objectId,
                previousLimit === undefined
                  ? storage.chunkSize
                  : Math.min(previousLimit, storage.chunkSize),
              );
            },
            visitedPageObjectIds: markState.visitedExtentPageObjectIds,
          });
          break;
        }
        default: {
          const _ex: never = storage;
          throw new Error(`Unhandled HizoFS file storage: ${String(_ex)}`);
        }
        }
        break;
      }
      case 'directory_inode': {
        switch (current.expectedKind) {
        case 'directory':
          break;
        case 'file':
        case 'symlink':
          throw new HizoFSCorruptionError({
            message: `HizoFS directory entry kind does not match directory inode: ${current.nodeId}`,
            cause: undefined,
          });
        default: {
          const _ex: never = current.expectedKind;
          throw new Error(`Unhandled HizoFS directory entry kind: ${String(_ex)}`);
        }
        }
        const { storage } = loaded.inode;
        switch (storage.type) {
        case 'inline':
          break;
        case 'indexed':
          await runtime.directoryIndex.validateStructure({
            rootObjectId: storage.directoryIndexRootObjectId,
          });
          await runtime.directoryIndex.visitReferences({
            rootObjectId: storage.directoryIndexRootObjectId,
            visitPageObjectId: ({ objectId }) => registerObjectReference({
              markState,
              objectId,
              expectedKind: 'directory_index_page',
            }),
            visitedPageObjectIds: markState.visitedDirectoryPageObjectIds,
          });
          break;
        default: {
          const _ex: never = storage;
          throw new Error(`Unhandled HizoFS directory storage: ${String(_ex)}`);
        }
        }
        for await (const entry of runtime.directoryStorage.entries({
          inode: loaded.inode,
        })) {
          switch (entry.kind) {
          case 'file':
          case 'directory':
          case 'symlink':
            pending.push({ nodeId: entry.nodeId, expectedKind: entry.kind });
            break;
          case 'subvolume': {
            const descriptorObjectId = mountsById.get(entry.mountId);
            if (descriptorObjectId === undefined) {
              throw new HizoFSCorruptionError({
                message: `HizoFS namespace references a missing subvolume mount: ${entry.mountId}`,
                cause: undefined,
              });
            }
            if (namespaceMountIds.has(entry.mountId)) {
              throw new HizoFSCorruptionError({
                message: `HizoFS namespace references one subvolume mount more than once: ${entry.mountId}`,
                cause: undefined,
              });
            }
            namespaceMountIds.add(entry.mountId);
            break;
          }
          default: {
            const _ex: never = entry;
            throw new Error(`Unhandled HizoFS directory entry: ${String(_ex)}`);
          }
          }
        }
        break;
      }
      case 'symlink_inode': {
        switch (current.expectedKind) {
        case 'symlink':
          break;
        case 'file':
        case 'directory':
          throw new HizoFSCorruptionError({
            message: `HizoFS directory entry kind does not match symlink inode: ${current.nodeId}`,
            cause: undefined,
          });
        default: {
          const _ex: never = current.expectedKind;
          throw new Error(`Unhandled HizoFS directory entry kind: ${String(_ex)}`);
        }
        }
        break;
      }
      default: {
        const _ex: never = loaded;
        throw new Error(`Unhandled HizoFS loaded inode: ${String(_ex)}`);
      }
      }
    }

    if (namespaceMountIds.size !== mountsById.size) {
      const disconnectedMountIds = [...mountsById.keys()]
        .filter(mountId => !namespaceMountIds.has(mountId))
        .sort();
      throw new HizoFSCorruptionError({
        message: `HizoFS mount index contains namespace-disconnected mounts: ${disconnectedMountIds.join(', ')}`,
        cause: undefined,
      });
    }

    if (namespaceNodeIds.size !== referencedInodes.size) {
      const disconnectedNodeIds = [...referencedInodes.keys()]
        .filter(nodeId => !namespaceNodeIds.has(nodeId))
        .sort();
      throw new HizoFSCorruptionError({
        message: `HizoFS inode index contains namespace-disconnected nodes: ${disconnectedNodeIds.join(', ')}`,
        cause: undefined,
      });
    }
    markState.visitedCommitObjectIds.add(commitObjectId);
  } finally {
    markState.visitingCommitObjectIds.delete(commitObjectId);
  }
}

async function loadReferencedInode({ runtime, reference, markState }: {
  runtime: HizoFSRuntime;
  reference: ReferencedInode;
  markState: HizoFSMarkState;
}): Promise<LoadedReferencedInode> {
  const cached = markState.loadedInodes.get(reference.objectId);
  if (cached !== undefined) {
    assertNodeIdentity({
      expectedNodeId: reference.nodeId,
      actualNodeId: cached.inode.nodeId,
    });
    return cached;
  }

  const rawRecord = await runtime.objectStore.read({ objectId: reference.objectId });
  if (rawRecord === undefined) {
    throw new HizoFSCorruptionError({
      message: `HizoFS inode object is missing: ${reference.objectId}`,
      cause: undefined,
    });
  }

  let loaded: LoadedReferencedInode;
  switch (rawRecord.kind) {
  case 'file_inode': {
    registerObjectReference({
      markState,
      objectId: reference.objectId,
      expectedKind: rawRecord.kind,
    });
    const { inode } = await runtime.inodeStore.readFile({ objectId: reference.objectId });
    loaded = { kind: rawRecord.kind, inode };
    break;
  }
  case 'directory_inode': {
    registerObjectReference({
      markState,
      objectId: reference.objectId,
      expectedKind: rawRecord.kind,
    });
    const inode = await runtime.inodeStore.readDirectory({ objectId: reference.objectId });
    loaded = { kind: rawRecord.kind, inode };
    break;
  }
  case 'symlink_inode': {
    registerObjectReference({
      markState,
      objectId: reference.objectId,
      expectedKind: rawRecord.kind,
    });
    const inode = await runtime.inodeStore.readSymlink({ objectId: reference.objectId });
    loaded = { kind: rawRecord.kind, inode };
    break;
  }
  default:
    throw new HizoFSCorruptionError({
      message: `HizoFS inode index references a non-inode object: ${rawRecord.kind}`,
      cause: undefined,
    });
  }

  assertNodeIdentity({
    expectedNodeId: reference.nodeId,
    actualNodeId: loaded.inode.nodeId,
  });
  markState.loadedInodes.set(reference.objectId, loaded);
  return loaded;
}

function registerObjectReference({ markState, objectId, expectedKind }: {
  markState: HizoFSMarkState;
  objectId: string;
  expectedKind: HizoFSRecordKind;
}): void {
  const previousKind = markState.expectedKinds.get(objectId);
  if (previousKind !== undefined && previousKind !== expectedKind) {
    throw new HizoFSCorruptionError({
      message: `HizoFS object is referenced as both ${previousKind} and ${expectedKind}: ${objectId}`,
      cause: undefined,
    });
  }
  markState.expectedKinds.set(objectId, expectedKind);
  markState.reachableObjectIds.add(objectId);
}

function assertNodeIdentity({ expectedNodeId, actualNodeId }: {
  expectedNodeId: string;
  actualNodeId: string;
}): void {
  if (expectedNodeId !== actualNodeId) {
    throw new HizoFSCorruptionError({
      message: 'HizoFS inode identity does not match the inode index',
      cause: undefined,
    });
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  collectHizoFSGarbageInternal,
};
