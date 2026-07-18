import type { HizoFSBackingStore } from '@/00-storage/service/hizofs/backing-store/backing-store';
import type { HizoFSPolicy } from './policy';
import { HizoFSObjectStore } from '@/00-storage/service/hizofs/object-store/object-store';
import { HizoFSSuperblockStore } from '@/00-storage/service/hizofs/object-store/superblock-store';
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
} from './active-state';
import { HizoFSCorruptionError } from '@/00-storage/service/hizofs/errors';

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
  const inodeIndex = new HizoFSInodeIndex({
    recordStore,
    maxPageEntries: policy.indexPageEntryLimit,
    diagnostics,
  });
  const directoryIndex = new HizoFSDirectoryIndex({
    recordStore,
    maxPageEntries: policy.indexPageEntryLimit,
    diagnostics,
  });
  const extentIndex = new HizoFSExtentIndex({
    recordStore,
    maxPageEntries: policy.indexPageEntryLimit,
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
  const superblockStore = new HizoFSSuperblockStore({
    objectStore,
    fileSystemId,
  });
  const activeStateCoordinator = new HizoFSActiveStateCoordinator({
    fileSystemId,
    localCoordinationIdentity,
    loadFromBacking: async () => await loadHizoFSActiveStateFromStores({
      superblockStore,
      commitStore,
      inodeIndex,
      inodeStore,
    }),
    publishFromState: async ({
      currentState,
      publicationId,
      inodeIndexRootObjectId,
    }) => {
      switch (currentState.mode) {
      case 'current':
        break;
      case 'fallback_read_only':
        throw new HizoFSCorruptionError({
          message:
            'HizoFS opened an older complete generation in read-only recovery mode',
          cause: undefined,
        });
      default: {
        const _ex: never = currentState.mode;
        throw new Error(`Unhandled HizoFS active state mode: ${String(_ex)}`);
      }
      }
      const commit = {
        revision: currentState.commit.revision + 1,
        publicationId,
        rootDirectoryNodeId: currentState.commit.rootDirectoryNodeId,
        inodeIndexRootObjectId,
      };
      // A follower can prepare immutable records in another realm and ask the
      // leader to publish only their root reference. Authenticate that root
      // through this leader's object store before making it durable, so a
      // malformed or stale coordinator message cannot publish an incomplete
      // filesystem generation.
      await validateHizoFSCommitRoot({
        commit,
        inodeIndex,
        inodeStore,
      });
      const commitObjectId = await commitStore.write({ commit });
      const superblock = {
        sequence: currentState.superblock.sequence + 1,
        fileSystemId,
        activeCommitObjectId: commitObjectId,
      };
      await superblockStore.write({ value: superblock });
      return {
        superblock,
        commitObjectId,
        commit,
        mode: 'current',
      };
    },
    setHeadHandleRetention: async ({ retention }) => {
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
    activeStateCoordinator,
    diagnostics,
  });
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

  function close(): Promise<void> {
    closePromise ??= (async () => {
      let coordinatorError: unknown | undefined;
      try {
        await activeStateCoordinator.close();
      } catch (error) {
        coordinatorError = error;
      }

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

      if (coordinatorError !== undefined && objectStoreError !== undefined) {
        throw new AggregateError(
          [coordinatorError, objectStoreError],
          'HizoFS coordinator and object-store cleanup both failed',
        );
      }
      if (coordinatorError !== undefined) throw coordinatorError;
      if (objectStoreError !== undefined) throw objectStoreError;
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
