import type { HizoFSBackingStore } from '@/00-storage/service/hizofs/backing-store/backing-store';
import type { HizoFSPolicy } from './policy';
import { HizoFSObjectStore } from '@/00-storage/service/hizofs/object-store/object-store';
import { HizoFSSuperblockStore } from '@/00-storage/service/hizofs/object-store/superblock-store';
import type { HizoFSHeadScope } from '@/00-storage/service/hizofs/segment-store/head-scope';
import { HizoFSRecordStore } from './record-store';
import { HizoFSCommitStore } from './commit-store';
import { HizoFSInodeIndex } from './inode-index';
import { HizoFSDirectoryIndex } from './directory-index';
import { HizoFSExtentIndex } from './extent-index';
import { HizoFSInodeStore } from './inode-store';
import { HizoFSFileChunkStore } from './file-chunk-store';
import { HizoFSNodeService } from './node-service';
import { HizoFSDirectoryStorage } from './directory-storage';
import { HizoFSCore } from './core';
import type { HizoFSRuntimeDiagnostics } from './diagnostics';
import { HizoFSActiveStateCoordinator } from './active-state-coordinator';
import {
  loadHizoFSActiveStateFromStores,
  validateHizoFSCommitRoot,
  type HizoFSValidatedCommitRootCache,
} from './active-state';
import { HizoFSCorruptionError } from '@/00-storage/service/hizofs/errors';
import { HizoFSSubvolumeDescriptorStore } from './subvolume-descriptor-store';
import { HizoFSSubvolumeMountIndex } from './subvolume-mount-index';

type HizoFSPhysicalHandleParticipant = {
  releasePhysicalHandles(): Promise<void>;
};

// Native OPFS SyncAccessHandles can keep an otherwise unreachable segment
// non-removable after its logical operation has settled. The maintenance lease
// drains active resources first; this realm-local registry then closes idle
// segment writers and retained head handles without discarding logical caches.
const localPhysicalHandleParticipants = new WeakMap<
  object,
  Map<string, Set<HizoFSPhysicalHandleParticipant>>
>();

function getLocalPhysicalHandleParticipants({
  localCoordinationIdentity,
  fileSystemId,
}: {
  localCoordinationIdentity: object;
  fileSystemId: string;
}): Set<HizoFSPhysicalHandleParticipant> {
  let byFileSystemId = localPhysicalHandleParticipants.get(localCoordinationIdentity);
  if (byFileSystemId === undefined) {
    byFileSystemId = new Map();
    localPhysicalHandleParticipants.set(localCoordinationIdentity, byFileSystemId);
  }
  let participants = byFileSystemId.get(fileSystemId);
  if (participants === undefined) {
    participants = new Set();
    byFileSystemId.set(fileSystemId, participants);
  }
  return participants;
}

function deleteLocalPhysicalHandleParticipantsIfEmpty({
  localCoordinationIdentity,
  fileSystemId,
  participants,
}: {
  localCoordinationIdentity: object;
  fileSystemId: string;
  participants: Set<HizoFSPhysicalHandleParticipant>;
}): void {
  if (participants.size !== 0) return;
  const byFileSystemId = localPhysicalHandleParticipants.get(localCoordinationIdentity);
  if (byFileSystemId?.get(fileSystemId) !== participants) return;
  byFileSystemId.delete(fileSystemId);
  if (byFileSystemId.size === 0) {
    localPhysicalHandleParticipants.delete(localCoordinationIdentity);
  }
}

async function releaseLocalPhysicalHandlesForMaintenance({
  localCoordinationIdentity,
  fileSystemId,
}: {
  localCoordinationIdentity: object;
  fileSystemId: string;
}): Promise<void> {
  const participants = localPhysicalHandleParticipants
    .get(localCoordinationIdentity)
    ?.get(fileSystemId);
  if (participants === undefined || participants.size === 0) return;

  const outcomes = await Promise.allSettled(
    [...participants].map(async participant => participant.releasePhysicalHandles()),
  );
  const errors: unknown[] = [];
  for (const outcome of outcomes) {
    switch (outcome.status) {
    case 'fulfilled':
      break;
    case 'rejected':
      errors.push(outcome.reason);
      break;
    default: {
      const _ex: never = outcome;
      throw new Error(`Unhandled HizoFS physical-handle release result: ${String(_ex)}`);
    }
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      'Failed to release local HizoFS physical handles for maintenance',
    );
  }
}

export type HizoFSRuntime = {
  readonly core: HizoFSCore;
  readonly objectStore: HizoFSObjectStore;
  readonly recordStore: HizoFSRecordStore;
  readonly commitStore: HizoFSCommitStore;
  readonly subvolumeDescriptorStore: HizoFSSubvolumeDescriptorStore;
  readonly subvolumeMountIndex: HizoFSSubvolumeMountIndex;
  readonly inodeIndex: HizoFSInodeIndex;
  readonly directoryIndex: HizoFSDirectoryIndex;
  readonly extentIndex: HizoFSExtentIndex;
  readonly inodeStore: HizoFSInodeStore;
  readonly chunkStore: HizoFSFileChunkStore;
  readonly nodeService: HizoFSNodeService;
  readonly directoryStorage: HizoFSDirectoryStorage;
  readonly policy: HizoFSPolicy;
  readonly now: () => number;
  readonly diagnostics: HizoFSRuntimeDiagnostics | undefined;
  clearPlaintextCaches(): void;
  getReadWriteSubvolumeCore({ subvolumeId }: {
    subvolumeId: string;
  }): HizoFSCore;
  retainSession(): void;
  releaseSession(): Promise<void>;
  releaseLocalPhysicalHandlesForMaintenance(): Promise<void>;
  close(): Promise<void>;
};

export function createHizoFSRuntime({
  backingStore,
  rootKey,
  fileSystemId,
  policy,
  now,
  diagnostics,
}: {
  backingStore: HizoFSBackingStore;
  rootKey: CryptoKey;
  fileSystemId: string;
  policy: HizoFSPolicy;
  now: () => number;
  diagnostics: HizoFSRuntimeDiagnostics | undefined;
}): HizoFSRuntime {
  const localCoordinationIdentity = backingStore.getCoordinationIdentity();
  const objectStore = new HizoFSObjectStore({
    backingStore,
    rootKey,
    fileSystemId,
    metadataCacheByteLimit: policy.metadataObjectCacheByteLimit,
    metadataCacheEntryLimit: policy.metadataObjectCacheEntryLimit,
    fileChunkCacheByteLimit: policy.fileChunkCacheByteLimit,
    fileChunkCacheEntryLimit: policy.fileChunkCacheEntryLimit,
    fileChunkCacheAdmission: policy.fileChunkCacheAdmission,
    diagnostics,
  });
  const recordStore = new HizoFSRecordStore({ objectStore });
  const commitStore = new HizoFSCommitStore({ recordStore });
  const subvolumeDescriptorStore = new HizoFSSubvolumeDescriptorStore({
    recordStore,
  });
  const subvolumeMountIndex = new HizoFSSubvolumeMountIndex({
    recordStore,
    maxPageEntries: policy.directoryIndexPageEntryLimit,
    diagnostics,
  });
  const inodeIndex = new HizoFSInodeIndex({
    recordStore,
    maxPageEntries: policy.inodeIndexPageEntryLimit,
    decodedPageCacheEntryLimit:
      policy.decodedInodeIndexPageCacheEntryLimit,
    diagnostics,
  });
  const directoryIndex = new HizoFSDirectoryIndex({
    recordStore,
    maxPageEntries: policy.directoryIndexPageEntryLimit,
    diagnostics,
  });
  const extentIndex = new HizoFSExtentIndex({
    recordStore,
    maxPageEntries: policy.fileExtentIndexPageEntryLimit,
    diagnostics,
  });
  const inodeStore = new HizoFSInodeStore({ recordStore });
  const chunkStore = new HizoFSFileChunkStore({ recordStore });
  const nodeService = new HizoFSNodeService({ inodeIndex, inodeStore });
  const directoryStorage = new HizoFSDirectoryStorage({
    inodeStore,
    directoryIndex,
    inlineEntryLimit: policy.inlineDirectoryEntryLimit,
  });
  type WritableCoreBundle = {
    readonly core: HizoFSCore;
    readonly coordinator: HizoFSActiveStateCoordinator;
    readonly validatedRootCache: HizoFSValidatedCommitRootCache;
  };
  const writableCoreBundles = new Map<string, WritableCoreBundle>();

  function createWritableCoreBundle({
    headScope,
    coordinationScope,
    expectedSubvolumeId,
    managePersistentHeadHandles,
  }: {
    headScope: HizoFSHeadScope;
    coordinationScope: string;
    expectedSubvolumeId: string | undefined;
    managePersistentHeadHandles: boolean;
  }): WritableCoreBundle {
    const validatedRootCache: HizoFSValidatedCommitRootCache = {
      value: undefined,
    };
    const superblockStore = new HizoFSSuperblockStore({
      objectStore,
      fileSystemId,
      headScope,
    });
    const coordinator = new HizoFSActiveStateCoordinator({
      fileSystemId,
      coordinationScope,
      localCoordinationIdentity,
      loadFromBacking: async () => await loadHizoFSActiveStateFromStores({
        superblockStore,
        expectedSubvolumeId,
        commitStore,
        subvolumeDescriptorStore,
        inodeIndex,
        inodeStore,
        validatedRootCache,
      }),
      publishFromState: async ({
        currentState,
        publicationId,
        inodeIndexRootObjectId,
        subvolumeMountIndexRootObjectId,
      }) => {
        switch (currentState.stateSelection) {
        case 'current':
          break;
        case 'fallback':
          throw new HizoFSCorruptionError({
            message:
              'HizoFS opened an older complete generation in read-only recovery mode',
            cause: undefined,
          });
        default: {
          const _ex: never = currentState.stateSelection;
          throw new Error(
            `Unhandled HizoFS active state selection: ${String(_ex)}`,
          );
        }
        }
        const commit = {
          revision: currentState.commit.revision + 1,
          publicationId,
          subvolumeId: currentState.commit.subvolumeId,
          rootDirectoryNodeId: currentState.commit.rootDirectoryNodeId,
          inodeIndexRootObjectId,
          subvolumeMountIndexRootObjectId,
        };
        await validateHizoFSCommitRoot({
          commit,
          inodeIndex,
          inodeStore,
          validatedRootCache,
        });
        if (
          subvolumeMountIndexRootObjectId
          !== currentState.commit.subvolumeMountIndexRootObjectId
        ) {
          await subvolumeMountIndex.validateStructure({
            rootObjectId: subvolumeMountIndexRootObjectId,
          });
          const mountedDescriptorObjectIds = new Set<string>();
          await subvolumeMountIndex.visitReferences({
            rootObjectId: subvolumeMountIndexRootObjectId,
            visitPageObjectId: () => {},
            visitDescriptorObjectId: ({ objectId }) => {
              mountedDescriptorObjectIds.add(objectId);
            },
            visitedPageObjectIds: undefined,
          });
          for (const objectId of mountedDescriptorObjectIds) {
            await subvolumeDescriptorStore.read({ objectId });
          }
        }
        const commitObjectId = await commitStore.write({ commit });
        const superblock = {
          sequence: currentState.superblock.sequence + 1,
          fileSystemId,
          subvolumeDescriptorObjectId:
            currentState.superblock.subvolumeDescriptorObjectId,
          activeCommitObjectId: commitObjectId,
        };
        await superblockStore.write({ value: superblock });
        return {
          superblock,
          subvolumeDescriptorObjectId:
            currentState.subvolumeDescriptorObjectId,
          subvolumeDescriptor: currentState.subvolumeDescriptor,
          commitObjectId,
          commit,
          stateSelection: 'current' as const,
        };
      },
      setHeadHandleRetention: async ({ retention }) => {
        if (!managePersistentHeadHandles) return;
        await objectStore.setHeadHandleRetention({ retention });
      },
      diagnostics,
    });
    const core = new HizoFSCore({
      fileSystemId,
      objectStore,
      superblockStore,
      commitStore,
      inodeIndex,
      inodeStore,
      activeStateCoordinator: coordinator,
      diagnostics,
    });
    const bundle = { core, coordinator, validatedRootCache };
    writableCoreBundles.set(coordinationScope, bundle);
    return bundle;
  }

  const rootCoreBundle = createWritableCoreBundle({
    headScope: { type: 'root' },
    coordinationScope: 'root',
    expectedSubvolumeId: undefined,
    managePersistentHeadHandles: true,
  });
  const core = rootCoreBundle.core;

  function getReadWriteSubvolumeCore({ subvolumeId }: {
    subvolumeId: string;
  }): HizoFSCore {
    const coordinationScope = `subvolume/${subvolumeId}`;
    const existing = writableCoreBundles.get(coordinationScope);
    if (existing !== undefined) return existing.core;
    return createWritableCoreBundle({
      headScope: { type: 'subvolume', subvolumeId },
      coordinationScope,
      expectedSubvolumeId: subvolumeId,
      // Persistent head-handle retention is currently store-wide. The root
      // coordinator owns that optimization; child correctness never depends
      // on retaining a physical handle between operations.
      managePersistentHeadHandles: false,
    }).core;
  }

  let sessionCount = 0;
  let closePromise: Promise<void> | undefined;
  const physicalHandleParticipants = getLocalPhysicalHandleParticipants({
    localCoordinationIdentity,
    fileSystemId,
  });
  const physicalHandleParticipant: HizoFSPhysicalHandleParticipant = {
    releasePhysicalHandles: async () => {
      if (closePromise !== undefined) {
        await closePromise;
        return;
      }
      try {
        await objectStore.releasePhysicalHandles();
      } catch (error) {
        if (closePromise === undefined) throw error;
        await closePromise;
      }
    },
  };
  physicalHandleParticipants.add(physicalHandleParticipant);

  function clearPlaintextCaches(): void {
    objectStore.clearPlaintextCaches();
    inodeIndex.clearDecodedPageCache();
    for (const bundle of writableCoreBundles.values()) {
      bundle.validatedRootCache.value = undefined;
    }
  }

  function getRejectedReason({
    result,
  }: {
    result: PromiseSettledResult<void>;
  }): readonly unknown[] {
    switch (result.status) {
    case 'fulfilled':
      return [];
    case 'rejected':
      return [result.reason];
    default: {
      const _ex: never = result;
      throw new Error(`Unhandled settled coordinator result: ${String(_ex)}`);
    }
    }
  }

  function close(): Promise<void> {
    closePromise ??= (async () => {
      clearPlaintextCaches();
      const coordinatorResults = await Promise.allSettled(
        [...writableCoreBundles.values()].map(
          async ({ coordinator }) => await coordinator.close(),
        ),
      );
      const coordinatorErrors = coordinatorResults.flatMap(result =>
        getRejectedReason({ result }),
      );

      let objectStoreError: unknown | undefined;
      try {
        await objectStore.close();
      } catch (error) {
        objectStoreError = error;
      }

      physicalHandleParticipants.delete(physicalHandleParticipant);
      deleteLocalPhysicalHandleParticipantsIfEmpty({
        localCoordinationIdentity,
        fileSystemId,
        participants: physicalHandleParticipants,
      });

      const cleanupErrors = [
        ...coordinatorErrors,
        ...(objectStoreError === undefined ? [] : [objectStoreError]),
      ];
      if (cleanupErrors.length === 1) throw cleanupErrors[0];
      if (cleanupErrors.length > 1) {
        throw new AggregateError(
          cleanupErrors,
          'HizoFS coordinator and object-store cleanup failed',
        );
      }
    })();
    return closePromise;
  }

  function retainSession(): void {
    if (closePromise !== undefined) {
      throw new Error('Cannot retain a closed HizoFS runtime');
    }
    sessionCount += 1;
  }

  async function releaseLocalPhysicalHandlesForMaintenanceFromRuntime(): Promise<void> {
    await releaseLocalPhysicalHandlesForMaintenance({
      localCoordinationIdentity,
      fileSystemId,
    });
  }

  async function releaseSession(): Promise<void> {
    if (sessionCount <= 0) {
      throw new Error('HizoFS runtime session reference count underflow');
    }
    sessionCount -= 1;
    if (sessionCount === 0) await close();
  }

  return {
    core,
    objectStore,
    recordStore,
    commitStore,
    subvolumeDescriptorStore,
    subvolumeMountIndex,
    inodeIndex,
    directoryIndex,
    extentIndex,
    inodeStore,
    chunkStore,
    nodeService,
    directoryStorage,
    policy,
    now,
    diagnostics,
    clearPlaintextCaches,
    getReadWriteSubvolumeCore,
    retainSession,
    releaseSession,
    releaseLocalPhysicalHandlesForMaintenance:
      releaseLocalPhysicalHandlesForMaintenanceFromRuntime,
    close,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
