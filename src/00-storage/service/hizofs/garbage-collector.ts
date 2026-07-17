import type {
  HizoFSDirectoryInodeDto,
  HizoFSFileInodeDto,
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
import { acquireHizoFSMaintenanceLease } from './file-system/maintenance-lock';
import type { HizoFSRecordKind } from './format/record';
import {
  getHizoFSObjectShard,
  validateHizoFSObjectId,
} from './object-store/object-id';

export type HizoFSGarbageCollectionSweepPolicy = {
  readonly removeConcurrency: number;
  readonly maximumRemovalsPerSlice: number;
  readonly maximumSliceDurationMs: number;
};

export const DEFAULT_HIZOFS_GARBAGE_COLLECTION_SWEEP_POLICY:
  HizoFSGarbageCollectionSweepPolicy = {
    removeConcurrency: 4,
    maximumRemovalsPerSlice: 64,
    maximumSliceDurationMs: 150,
  };

export type HizoFSGarbageCollectionDiagnostics = {
  readonly reachableObjectCount: number;
  readonly candidateObjectCount: number;
  readonly removedObjectCount: number;
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
  readonly visitedDirectoryPageObjectIds: Set<string>;
  readonly visitedExtentPageObjectIds: Set<string>;
  readonly extentRootChunkSizes: Map<string, number>;
  readonly chunkSizeLimits: Map<string, number>;
};

type GarbageCollectionDependencies = {
  readonly now: () => number;
  readonly removeObject: ({ runtime, objectId }: {
    runtime: HizoFSRuntime;
    objectId: string;
  }) => Promise<void>;
  readonly yieldToForeground: () => Promise<void>;
};

type GarbageCollectionPreparation = {
  readonly runtime: HizoFSRuntime;
  readonly reachableObjectCount: number;
  readonly unreachableObjectIds: readonly string[];
  readonly ignoredPhysicalPaths: readonly string[];
  readonly initialFenceWaitDurationMs: number;
  readonly initialFenceHoldDurationMs: number;
  readonly rootSnapshotDurationMs: number;
  readonly markDurationMs: number;
  readonly chunkVerificationDurationMs: number;
  readonly objectListingDurationMs: number;
  readonly candidateBuildDurationMs: number;
};

type GarbageCollectionSweepMetrics = {
  readonly removedObjectCount: number;
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
      removeObject: async ({ runtime, objectId }) => {
        await runtime.objectStore.remove({ objectId });
      },
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
    diagnostics: undefined,
  });
  const rootKey = await importHizoFSRootKey({
    rawRootKey: fileSystemRootKey,
  });
  const fileSystemId = await deriveHizoFSFileSystemId({ rootKey });
  const preparation = await prepareGarbageCollection({
    backingStore,
    rootKey,
    fileSystemId,
    signal,
    now: dependencies.now,
  });

  // Marking authenticates plaintext metadata and file chunks, but sweeping
  // needs only immutable object IDs. Release and zero those cached plaintexts
  // before a potentially long multi-slice sweep.
  preparation.runtime.objectStore.clearPlaintextCaches();

  const sweepMetrics = dryRun
    ? createEmptySweepMetrics()
    : await sweepGarbageCollectionCandidates({
      runtime: preparation.runtime,
      fileSystemId,
      objectIds: preparation.unreachableObjectIds,
      sweepPolicy: resolvedSweepPolicy,
      signal,
      dependencies,
    });

  const maximumPauseDurationMs = Math.max(
    preparation.initialFenceHoldDurationMs,
    sweepMetrics.maximumSweepSliceDurationMs,
  );

  return {
    reachableObjectCount: preparation.reachableObjectCount,
    unreachableObjectIds: preparation.unreachableObjectIds,
    removedObjectCount: sweepMetrics.removedObjectCount,
    ignoredPhysicalPaths: preparation.ignoredPhysicalPaths,
    diagnostics: {
      reachableObjectCount: preparation.reachableObjectCount,
      candidateObjectCount: preparation.unreachableObjectIds.length,
      removedObjectCount: sweepMetrics.removedObjectCount,
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
    },
  };
}

async function prepareGarbageCollection({
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
}): Promise<GarbageCollectionPreparation> {
  const fenceRequestedAt = now();
  const lease = await acquireHizoFSMaintenanceLease({ fileSystemId });
  const initialFenceWaitDurationMs = elapsed({ now, startedAt: fenceRequestedAt });
  const fenceStartedAt = now();
  let rootSnapshotDurationMs = 0;
  let markDurationMs = 0;
  let chunkVerificationDurationMs = 0;
  let objectListingDurationMs = 0;
  let candidateBuildDurationMs = 0;
  let preparation: Omit<GarbageCollectionPreparation, 'initialFenceHoldDurationMs'>
    | undefined;
  try {
    throwIfAborted({ signal });
    const runtime = createHizoFSRuntime({
      backingStore,
      rootKey,
      fileSystemId,
      policy: DEFAULT_HIZOFS_POLICY,
      now: () => Date.now(),
      diagnostics: undefined,
    });

    const rootSnapshotStartedAt = now();
    const activeState = await runtime.core.loadActiveState();
    switch (activeState.mode) {
    case 'current':
      break;
    case 'fallback_read_only':
      throw new HizoFSCorruptionError({
        message: 'HizoFS garbage collection is disabled in read-only recovery mode',
        cause: undefined,
      });
    default: {
      const _ex: never = activeState.mode;
      throw new Error(`Unhandled HizoFS active state mode: ${String(_ex)}`);
    }
    }
    const superblocks = await runtime.core.superblockStore.readCandidates();
    rootSnapshotDurationMs = elapsed({ now, startedAt: rootSnapshotStartedAt });

    const markStartedAt = now();
    const markState: HizoFSMarkState = {
      reachableObjectIds: new Set<string>(),
      expectedKinds: new Map<string, HizoFSRecordKind>(),
      loadedInodes: new Map<string, LoadedReferencedInode>(),
      visitedDirectoryPageObjectIds: new Set<string>(),
      visitedExtentPageObjectIds: new Set<string>(),
      extentRootChunkSizes: new Map<string, number>(),
      chunkSizeLimits: new Map<string, number>(),
    };
    const markedCommitIds = new Set<string>();
    for (const superblock of superblocks) {
      throwIfAborted({ signal });
      if (markedCommitIds.has(superblock.activeCommitObjectId)) continue;
      markedCommitIds.add(superblock.activeCommitObjectId);
      await markCommitGeneration({
        runtime,
        commitObjectId: superblock.activeCommitObjectId,
        markState,
      });
    }
    if (!markedCommitIds.has(activeState.commitObjectId)) {
      throw new HizoFSCorruptionError({
        message: 'HizoFS active commit is absent from the valid superblock candidates',
        cause: undefined,
      });
    }
    markDurationMs = elapsed({ now, startedAt: markStartedAt });

    const chunkVerificationStartedAt = now();
    for (const [objectId, chunkSize] of markState.chunkSizeLimits) {
      throwIfAborted({ signal });
      await runtime.chunkStore.read({ objectId, chunkSize });
    }
    chunkVerificationDurationMs = elapsed({ now, startedAt: chunkVerificationStartedAt });

    const objectListingStartedAt = now();
    const {
      canonicalObjectIds,
      ignoredPhysicalPaths,
    } = await listPhysicalHizoFSObjects({ backingStore });
    objectListingDurationMs = elapsed({ now, startedAt: objectListingStartedAt });

    const candidateBuildStartedAt = now();
    const unreachableObjectIds = [...canonicalObjectIds]
      .filter(objectId => !markState.reachableObjectIds.has(objectId))
      .sort();
    candidateBuildDurationMs = elapsed({ now, startedAt: candidateBuildStartedAt });

    preparation = {
      runtime,
      reachableObjectCount: markState.reachableObjectIds.size,
      unreachableObjectIds,
      ignoredPhysicalPaths,
      initialFenceWaitDurationMs,
      rootSnapshotDurationMs,
      markDurationMs,
      chunkVerificationDurationMs,
      objectListingDurationMs,
      candidateBuildDurationMs,
    };
  } finally {
    await lease.release();
  }
  if (preparation === undefined) {
    throw new Error('HizoFS garbage-collection preparation completed without a result');
  }
  return {
    ...preparation,
    initialFenceHoldDurationMs: elapsed({ now, startedAt: fenceStartedAt }),
  };
}

function createEmptySweepMetrics(): GarbageCollectionSweepMetrics {
  return {
    removedObjectCount: 0,
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
  objectIds,
  sweepPolicy,
  signal,
  dependencies,
}: {
  runtime: HizoFSRuntime;
  fileSystemId: string;
  objectIds: readonly string[];
  sweepPolicy: HizoFSGarbageCollectionSweepPolicy;
  signal: AbortSignal | undefined;
  dependencies: GarbageCollectionDependencies;
}): Promise<GarbageCollectionSweepMetrics> {
  if (objectIds.length === 0) return createEmptySweepMetrics();

  const sweepStartedAt = dependencies.now();
  let nextObjectIndex = 0;
  let removedObjectCount = 0;
  let sweepLockWaitDurationMs = 0;
  let sweepLockHoldDurationMs = 0;
  let yieldDurationMs = 0;
  let sweepSliceCount = 0;
  let maximumSweepSliceDurationMs = 0;
  let maximumRemovesInFlight = 0;
  let maximumRemovalsInSlice = 0;
  let sliceDurationBudgetOverrunCount = 0;

  while (nextObjectIndex < objectIds.length) {
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
      while (
        nextObjectIndex < objectIds.length
        && removalsInSlice < sweepPolicy.maximumRemovalsPerSlice
      ) {
        const remainingInSlice = sweepPolicy.maximumRemovalsPerSlice - removalsInSlice;
        const batchSize = Math.min(
          sweepPolicy.removeConcurrency,
          remainingInSlice,
          objectIds.length - nextObjectIndex,
        );
        const batchObjectIds = objectIds.slice(
          nextObjectIndex,
          nextObjectIndex + batchSize,
        );
        maximumRemovesInFlight = Math.max(maximumRemovesInFlight, batchObjectIds.length);
        const outcomes = await Promise.allSettled(batchObjectIds.map(async objectId => {
          await dependencies.removeObject({ runtime, objectId });
        }));
        const failures: Error[] = [];
        for (let index = 0; index < outcomes.length; index += 1) {
          const outcome = outcomes[index];
          const objectId = batchObjectIds[index];
          if (outcome === undefined || objectId === undefined) {
            throw new Error('HizoFS garbage-collection sweep batch lost positional identity');
          }
          switch (outcome.status) {
          case 'fulfilled':
            removedObjectCount += 1;
            break;
          case 'rejected':
            failures.push(new Error(
              `Failed to remove HizoFS garbage object ${objectId}`,
              { cause: outcome.reason },
            ));
            break;
          default: {
            const _ex: never = outcome;
            throw new Error(`Unhandled HizoFS garbage-collection result: ${String(_ex)}`);
          }
          }
        }
        nextObjectIndex += batchObjectIds.length;
        removalsInSlice += batchObjectIds.length;
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

    if (nextObjectIndex < objectIds.length) {
      const yieldStartedAt = dependencies.now();
      await dependencies.yieldToForeground();
      yieldDurationMs += elapsed({ now: dependencies.now, startedAt: yieldStartedAt });
    }
  }

  return {
    removedObjectCount,
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

async function markCommitGeneration({ runtime, commitObjectId, markState }: {
  runtime: HizoFSRuntime;
  commitObjectId: string;
  markState: HizoFSMarkState;
}): Promise<void> {
  registerObjectReference({
    markState,
    objectId: commitObjectId,
    expectedKind: 'commit',
  });
  const commit = await runtime.commitStore.read({ objectId: commitObjectId });
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
        pending.push({ nodeId: entry.nodeId, expectedKind: entry.kind });
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

  if (namespaceNodeIds.size !== referencedInodes.size) {
    const disconnectedNodeIds = [...referencedInodes.keys()]
      .filter(nodeId => !namespaceNodeIds.has(nodeId))
      .sort();
    throw new HizoFSCorruptionError({
      message: `HizoFS inode index contains namespace-disconnected nodes: ${disconnectedNodeIds.join(', ')}`,
      cause: undefined,
    });
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

async function listPhysicalHizoFSObjects({ backingStore }: {
  backingStore: NativeOpfsHizoFSBackingStore;
}): Promise<{
  readonly canonicalObjectIds: ReadonlySet<string>;
  readonly ignoredPhysicalPaths: readonly string[];
}> {
  const canonicalObjectIds = new Set<string>();
  const ignoredPhysicalPaths: string[] = [];
  for await (const shardEntry of backingStore.list({ path: ['objects'] })) {
    const shardPath = `objects/${shardEntry.name}`;
    if (
      shardEntry.kind !== 'directory'
      || !/^[0-9a-f]{2}$/u.test(shardEntry.name)
    ) {
      ignoredPhysicalPaths.push(shardPath);
      continue;
    }
    for await (const objectEntry of backingStore.list({ path: ['objects', shardEntry.name] })) {
      const objectPath = `${shardPath}/${objectEntry.name}`;
      if (objectEntry.kind !== 'file' || !objectEntry.name.endsWith('.enc')) {
        ignoredPhysicalPaths.push(objectPath);
        continue;
      }
      const objectId = objectEntry.name.slice(0, -'.enc'.length);
      try {
        validateHizoFSObjectId({ objectId });
        if (getHizoFSObjectShard({ objectId }) !== shardEntry.name) {
          ignoredPhysicalPaths.push(objectPath);
          continue;
        }
      } catch {
        ignoredPhysicalPaths.push(objectPath);
        continue;
      }
      canonicalObjectIds.add(objectId);
    }
  }
  return {
    canonicalObjectIds,
    ignoredPhysicalPaths: ignoredPhysicalPaths.sort(),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  collectHizoFSGarbageInternal,
};
