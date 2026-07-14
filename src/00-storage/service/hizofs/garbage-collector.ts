import type {
  HizoFSDirectoryInodeDto,
  HizoFSFileInodeDto,
  HizoFSSymlinkInodeDto,
} from '@/00-storage/00-dto/hizofs.dto';
import { HizoFSCorruptionError } from './errors';
import { NativeOpfsHizoFSBackingStore } from './backing-store/native-opfs-backing-store';
import { importHizoFSRootKey } from './crypto/object-crypto';
import { createHizoFSRuntime, type HizoFSRuntime } from './file-system/runtime';
import { DEFAULT_HIZOFS_POLICY } from './file-system/policy';
import { runWithHizoFSMaintenanceLock } from './file-system/maintenance-lock';
import { readHizoFSDescriptor } from './format/descriptor-store';
import type { HizoFSRecordKind } from './format/record';
import {
  getHizoFSObjectShard,
  validateHizoFSObjectId,
} from './object-store/object-id';

export type HizoFSGarbageCollectionResult = {
  readonly reachableObjectCount: number;
  readonly unreachableObjectIds: readonly string[];
  readonly removedObjectCount: number;
  readonly ignoredPhysicalPaths: readonly string[];
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

export async function collectHizoFSGarbage({
  backingDirectory,
  fileSystemRootKey,
  dryRun,
}: {
  backingDirectory: FileSystemDirectoryHandle;
  fileSystemRootKey: Uint8Array;
  dryRun: boolean;
}): Promise<HizoFSGarbageCollectionResult> {
  const backingStore = new NativeOpfsHizoFSBackingStore({
    root: backingDirectory,
  });
  const descriptor = await readHizoFSDescriptor({ backingStore });
  if (descriptor === undefined) {
    throw new Error('HizoFS descriptor is missing');
  }

  return runWithHizoFSMaintenanceLock({
    fileSystemId: descriptor.fileSystemId,
    operation: async () => {
      const rootKey = await importHizoFSRootKey({
        rawRootKey: fileSystemRootKey,
      });
      const runtime = createHizoFSRuntime({
        backingStore,
        rootKey,
        fileSystemId: descriptor.fileSystemId,
        policy: DEFAULT_HIZOFS_POLICY,
        now: () => Date.now(),
      });
      const activeState = await runtime.core.loadActiveState();
      const superblocks = await runtime.core.superblockStore.readCandidates();
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
      for (const [objectId, chunkSize] of markState.chunkSizeLimits) {
        await runtime.chunkStore.read({ objectId, chunkSize });
      }

      const {
        canonicalObjectIds,
        ignoredPhysicalPaths,
      } = await listPhysicalHizoFSObjects({ backingStore });
      const unreachableObjectIds = [...canonicalObjectIds]
        .filter(objectId => !markState.reachableObjectIds.has(objectId))
        .sort();

      if (!dryRun) {
        for (const objectId of unreachableObjectIds) {
          await runtime.objectStore.remove({ objectId });
        }
      }

      return {
        reachableObjectCount: markState.reachableObjectIds.size,
        unreachableObjectIds,
        removedObjectCount: dryRun ? 0 : unreachableObjectIds.length,
        ignoredPhysicalPaths,
      };
    },
  });
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
  const referencedInodes: ReferencedInode[] = [];
  await runtime.inodeIndex.visitReferences({
    rootObjectId: commit.inodeIndexRootObjectId,
    visitPageObjectId: ({ objectId }) => registerObjectReference({
      markState,
      objectId,
      expectedKind: 'inode_index_page',
    }),
    visitInodeObjectId: ({ objectId, nodeId }) => {
      markState.reachableObjectIds.add(objectId);
      referencedInodes.push({ objectId, nodeId });
    },
    visitedPageObjectIds: undefined,
  });

  let rootDirectoryFound = false;
  for (const reference of referencedInodes) {
    const loaded = await loadReferencedInode({ runtime, reference, markState });
    switch (loaded.kind) {
    case 'file_inode': {
      if (reference.nodeId === commit.rootDirectoryNodeId) {
        throw new HizoFSCorruptionError({
          message: 'HizoFS commit root points to a file inode',
          cause: undefined,
        });
      }
      const { storage } = loaded.inode;
      switch (storage.type) {
      case 'inline':
        break;
      case 'extents': {
        const previousChunkSize = markState.extentRootChunkSizes.get(
          storage.extentIndexRootObjectId,
        );
        if (previousChunkSize !== undefined && previousChunkSize !== storage.chunkSize) {
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
      if (reference.nodeId === commit.rootDirectoryNodeId) {
        rootDirectoryFound = true;
      }
      const { storage } = loaded.inode;
      switch (storage.type) {
      case 'inline':
        break;
      case 'indexed':
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
      break;
    }
    case 'symlink_inode':
      if (reference.nodeId === commit.rootDirectoryNodeId) {
        throw new HizoFSCorruptionError({
          message: 'HizoFS commit root points to a symlink inode',
          cause: undefined,
        });
      }
      break;
    default: {
      const _ex: never = loaded;
      throw new Error(`Unhandled HizoFS loaded inode: ${String(_ex)}`);
    }
    }
  }

  if (!rootDirectoryFound) {
    throw new HizoFSCorruptionError({
      message: 'HizoFS commit root directory is absent from its inode index',
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
};
