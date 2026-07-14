import { HizoFSCorruptionError } from './errors';
import { NativeOpfsHizoFSBackingStore } from './backing-store/native-opfs-backing-store';
import { importHizoFSRootKey } from './crypto/object-crypto';
import { createHizoFSRuntime, type HizoFSRuntime } from './file-system/runtime';
import { DEFAULT_HIZOFS_POLICY } from './file-system/policy';
import { runWithHizoFSMaintenanceLock } from './file-system/maintenance-lock';
import { readHizoFSDescriptor } from './format/descriptor-store';
import {
  decodeHizoFSObjectId,
  getHizoFSObjectShard,
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

type ReferencedChunk = {
  readonly nodeId: string;
  readonly objectId: string;
  readonly chunkIndex: number;
  readonly chunkSize: number;
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
      const reachableObjectIds = new Set<string>();
      const markedCommitIds = new Set<string>();
      for (const superblock of superblocks) {
        if (markedCommitIds.has(superblock.activeCommitObjectId)) continue;
        markedCommitIds.add(superblock.activeCommitObjectId);
        await markCommitGeneration({
          runtime,
          commitObjectId: superblock.activeCommitObjectId,
          reachableObjectIds,
        });
      }
      if (!markedCommitIds.has(activeState.commitObjectId)) {
        throw new HizoFSCorruptionError({
          message: 'HizoFS active commit is absent from the valid superblock candidates',
          cause: undefined,
        });
      }

      const {
        canonicalObjectIds,
        ignoredPhysicalPaths,
      } = await listPhysicalHizoFSObjects({ backingStore });
      const unreachableObjectIds = [...canonicalObjectIds]
        .filter(objectId => !reachableObjectIds.has(objectId))
        .sort();

      if (!dryRun) {
        for (const objectId of unreachableObjectIds) {
          await runtime.objectStore.remove({ objectId });
        }
      }

      return {
        reachableObjectCount: reachableObjectIds.size,
        unreachableObjectIds,
        removedObjectCount: dryRun ? 0 : unreachableObjectIds.length,
        ignoredPhysicalPaths,
      };
    },
  });
}

async function markCommitGeneration({ runtime, commitObjectId, reachableObjectIds }: {
  runtime: HizoFSRuntime;
  commitObjectId: string;
  reachableObjectIds: Set<string>;
}): Promise<void> {
  reachableObjectIds.add(commitObjectId);
  const commit = await runtime.commitStore.read({ objectId: commitObjectId });
  const referencedInodes: ReferencedInode[] = [];
  await runtime.inodeIndex.visitReferences({
    rootObjectId: commit.inodeIndexRootObjectId,
    visitPageObjectId: ({ objectId }) => reachableObjectIds.add(objectId),
    visitInodeObjectId: ({ objectId, nodeId }) => {
      reachableObjectIds.add(objectId);
      referencedInodes.push({ objectId, nodeId });
    },
  });

  const referencedChunks: ReferencedChunk[] = [];
  let rootDirectoryFound = false;
  for (const reference of referencedInodes) {
    const rawRecord = await runtime.objectStore.read({ objectId: reference.objectId });
    if (rawRecord === undefined) {
      throw new HizoFSCorruptionError({
        message: `HizoFS inode object is missing: ${reference.objectId}`,
        cause: undefined,
      });
    }
    switch (rawRecord.kind) {
    case 'file_inode': {
      const { inode } = await runtime.inodeStore.readFile({ objectId: reference.objectId });
      assertNodeIdentity({ expectedNodeId: reference.nodeId, actualNodeId: inode.nodeId });
      if (reference.nodeId === commit.rootDirectoryNodeId) {
        throw new HizoFSCorruptionError({
          message: 'HizoFS commit root points to a file inode',
          cause: undefined,
        });
      }
      switch (inode.storage.type) {
      case 'inline':
        break;
      case 'extents': {
        const { chunkSize, extentIndexRootObjectId } = inode.storage;
        await runtime.extentIndex.visitReferences({
          rootObjectId: extentIndexRootObjectId,
          visitPageObjectId: ({ objectId }) => reachableObjectIds.add(objectId),
          visitChunkObjectId: ({ objectId, chunkIndex }) => {
            reachableObjectIds.add(objectId);
            referencedChunks.push({
              nodeId: inode.nodeId,
              objectId,
              chunkIndex,
              chunkSize,
            });
          },
        });
        break;
      }
      default: {
        const _ex: never = inode.storage;
        throw new Error(`Unhandled HizoFS file storage: ${String(_ex)}`);
      }
      }
      break;
    }
    case 'directory_inode': {
      const inode = await runtime.inodeStore.readDirectory({ objectId: reference.objectId });
      assertNodeIdentity({ expectedNodeId: reference.nodeId, actualNodeId: inode.nodeId });
      if (reference.nodeId === commit.rootDirectoryNodeId) {
        rootDirectoryFound = true;
      }
      switch (inode.storage.type) {
      case 'inline':
        break;
      case 'indexed':
        await runtime.directoryIndex.visitReferences({
          rootObjectId: inode.storage.directoryIndexRootObjectId,
          visitPageObjectId: ({ objectId }) => reachableObjectIds.add(objectId),
        });
        break;
      default: {
        const _ex: never = inode.storage;
        throw new Error(`Unhandled HizoFS directory storage: ${String(_ex)}`);
      }
      }
      break;
    }
    case 'symlink_inode': {
      const inode = await runtime.inodeStore.readSymlink({ objectId: reference.objectId });
      assertNodeIdentity({ expectedNodeId: reference.nodeId, actualNodeId: inode.nodeId });
      if (reference.nodeId === commit.rootDirectoryNodeId) {
        throw new HizoFSCorruptionError({
          message: 'HizoFS commit root points to a symlink inode',
          cause: undefined,
        });
      }
      break;
    }
    default:
      throw new HizoFSCorruptionError({
        message: `HizoFS inode index references a non-inode object: ${rawRecord.kind}`,
        cause: undefined,
      });
    }
  }

  if (!rootDirectoryFound) {
    throw new HizoFSCorruptionError({
      message: 'HizoFS commit root directory is absent from its inode index',
      cause: undefined,
    });
  }
  for (const chunk of referencedChunks) {
    await runtime.chunkStore.read({
      objectId: chunk.objectId,
      expectedNodeId: chunk.nodeId,
      expectedChunkIndex: chunk.chunkIndex,
      chunkSize: chunk.chunkSize,
    });
  }
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
        decodeHizoFSObjectId({ objectId });
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
