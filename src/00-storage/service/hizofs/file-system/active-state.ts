import {
  HizoFSCommitSchemaDto,
  HizoFSSubvolumeDescriptorSchemaDto,
  HizoFSSuperblockSchemaDto,
  type HizoFSCommitDto,
  type HizoFSSubvolumeDescriptorDto,
  type HizoFSSuperblockDto,
} from '@/00-storage/00-dto/hizofs.dto';
import {
  HizoFSCorruptionError,
  HizoFSUnsupportedFormatError,
} from '@/00-storage/service/hizofs/errors';
import type { HizoFSSuperblockStore } from '@/00-storage/service/hizofs/object-store/superblock-store';
import { z } from 'zod';
import type { HizoFSCommitStore } from './commit-store';
import type { HizoFSInodeIndex } from './inode-index';
import type { HizoFSInodeStore } from './inode-store';
import type { HizoFSSubvolumeDescriptorStore } from './subvolume-descriptor-store';

export type HizoFSFilesystemState = {
  readonly subvolumeDescriptorObjectId: string;
  readonly subvolumeDescriptor: HizoFSSubvolumeDescriptorDto;
  readonly commitObjectId: string;
  readonly commit: HizoFSCommitDto;
  readonly stateSelection: 'current' | 'fallback';
};

export type HizoFSActiveState = HizoFSFilesystemState & {
  readonly superblock: HizoFSSuperblockDto;
};

export const HizoFSActiveStateSchema: z.ZodType<HizoFSActiveState> = z.object({
  superblock: HizoFSSuperblockSchemaDto,
  subvolumeDescriptorObjectId: z.string(),
  subvolumeDescriptor: HizoFSSubvolumeDescriptorSchemaDto,
  commitObjectId: z.string(),
  commit: HizoFSCommitSchemaDto,
  stateSelection: z.enum(['current', 'fallback']),
}).strict();


export function freezeHizoFSActiveState({ state }: {
  state: HizoFSActiveState;
}): HizoFSActiveState {
  if (
    Object.isFrozen(state)
    && Object.isFrozen(state.superblock)
    && Object.isFrozen(state.commit)
  ) {
    return state;
  }

  const {
    superblock,
    subvolumeDescriptorObjectId,
    subvolumeDescriptor,
    commitObjectId,
    commit,
    stateSelection,
    ...unhandledState
  } = state;
  unhandledState satisfies Record<PropertyKey, never>;
  const {
    sequence,
    fileSystemId,
    subvolumeDescriptorObjectId: superblockDescriptorObjectId,
    activeCommitObjectId,
    ...unhandledSuperblock
  } = superblock;
  unhandledSuperblock satisfies Record<PropertyKey, never>;
  const {
    revision,
    publicationId,
    subvolumeId,
    rootDirectoryNodeId,
    inodeIndexRootObjectId,
    subvolumeMountIndexRootObjectId,
    ...unhandledCommit
  } = commit;
  unhandledCommit satisfies Record<PropertyKey, never>;

  return Object.freeze({
    superblock: Object.freeze({
      sequence,
      fileSystemId,
      subvolumeDescriptorObjectId: superblockDescriptorObjectId,
      activeCommitObjectId,
    }),
    subvolumeDescriptorObjectId,
    subvolumeDescriptor: Object.freeze(subvolumeDescriptor),
    commitObjectId,
    commit: Object.freeze({
      revision,
      publicationId,
      subvolumeId,
      rootDirectoryNodeId,
      inodeIndexRootObjectId,
      subvolumeMountIndexRootObjectId,
    }),
    stateSelection,
  });
}

export function freezeHizoFSFilesystemState({ state }: {
  state: HizoFSFilesystemState;
}): HizoFSFilesystemState {
  const {
    subvolumeDescriptorObjectId,
    subvolumeDescriptor,
    commitObjectId,
    commit,
    stateSelection,
    ...unhandledState
  } = state;
  unhandledState satisfies Record<PropertyKey, never>;
  const {
    revision,
    publicationId,
    subvolumeId,
    rootDirectoryNodeId,
    inodeIndexRootObjectId,
    subvolumeMountIndexRootObjectId,
    ...unhandledCommit
  } = commit;
  unhandledCommit satisfies Record<PropertyKey, never>;
  return Object.freeze({
    subvolumeDescriptorObjectId,
    subvolumeDescriptor: Object.freeze(subvolumeDescriptor),
    commitObjectId,
    commit: Object.freeze({
      revision,
      publicationId,
      subvolumeId,
      rootDirectoryNodeId,
      inodeIndexRootObjectId,
      subvolumeMountIndexRootObjectId,
    }),
    stateSelection,
  });
}

export type HizoFSValidatedCommitRootCache = {
  value: {
    readonly rootDirectoryNodeId: string;
    readonly rootDirectoryInodeObjectId: string;
  } | undefined;
};

export async function validateHizoFSCommitRoot({
  commit,
  inodeIndex,
  inodeStore,
  validatedRootCache,
}: {
  commit: HizoFSCommitDto;
  inodeIndex: HizoFSInodeIndex;
  inodeStore: HizoFSInodeStore;
  validatedRootCache: HizoFSValidatedCommitRootCache | undefined;
}): Promise<void> {
  const rootIndexEntry = await inodeIndex.get({
    rootObjectId: commit.inodeIndexRootObjectId,
    nodeId: commit.rootDirectoryNodeId,
  });
  if (rootIndexEntry === undefined) {
    throw new HizoFSCorruptionError({
      message: 'HizoFS root directory is absent from the inode index',
      cause: undefined,
    });
  }
  const cached = validatedRootCache?.value;
  // The new inode-index root is still traversed and authenticated above. The
  // directory inode is an immutable authenticated object, so an identical
  // ObjectRef does not need to be decoded again for every unrelated commit.
  if (
    cached?.rootDirectoryNodeId === commit.rootDirectoryNodeId
    && cached.rootDirectoryInodeObjectId === rootIndexEntry.inodeObjectId
  ) {
    return;
  }
  const rootDirectory = await inodeStore.readDirectory({
    objectId: rootIndexEntry.inodeObjectId,
  });
  if (rootDirectory.nodeId !== commit.rootDirectoryNodeId) {
    throw new HizoFSCorruptionError({
      message: 'HizoFS root directory inode identity is inconsistent',
      cause: undefined,
    });
  }
  if (validatedRootCache !== undefined) {
    validatedRootCache.value = {
      rootDirectoryNodeId: commit.rootDirectoryNodeId,
      rootDirectoryInodeObjectId: rootIndexEntry.inodeObjectId,
    };
  }
}

export async function loadHizoFSActiveStateFromStores({
  superblockStore,
  expectedSubvolumeId,
  commitStore,
  subvolumeDescriptorStore,
  inodeIndex,
  inodeStore,
  validatedRootCache,
}: {
  superblockStore: HizoFSSuperblockStore;
  expectedSubvolumeId: string | undefined;
  commitStore: HizoFSCommitStore;
  subvolumeDescriptorStore: HizoFSSubvolumeDescriptorStore;
  inodeIndex: HizoFSInodeIndex;
  inodeStore: HizoFSInodeStore;
  validatedRootCache: HizoFSValidatedCommitRootCache | undefined;
}): Promise<HizoFSActiveState> {
  const candidateSet = await superblockStore.readCandidateSet();
  const { candidates } = candidateSet;
  if (candidates.length === 0) {
    throw new HizoFSCorruptionError({
      message: 'HizoFS superblock is missing',
      cause: undefined,
    });
  }

  const rejected: unknown[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const superblock = candidates[index];
    if (superblock === undefined) continue;
    try {
      const subvolumeDescriptor = await subvolumeDescriptorStore.read({
        objectId: superblock.subvolumeDescriptorObjectId,
      });
      switch (subvolumeDescriptor.access) {
      case 'read':
        throw new HizoFSCorruptionError({
          message: 'HizoFS mutable subvolume descriptor must permit writes',
          cause: undefined,
        });
      case 'read_write':
        break;
      default: {
        const _ex: never = subvolumeDescriptor;
        throw new Error(
          `Unhandled HizoFS root subvolume access: ${
            ((_ex satisfies never) as { readonly access: string }).access
          }`,
        );
      }
        if (
          expectedSubvolumeId !== undefined
        && subvolumeDescriptor.subvolumeId !== expectedSubvolumeId
        ) {
          throw new HizoFSCorruptionError({
            message: 'HizoFS head resolves to a different subvolume identity',
            cause: undefined,
          });
        }
      }
      const commit = await commitStore.read({
        objectId: superblock.activeCommitObjectId,
      });
      if (commit.subvolumeId !== subvolumeDescriptor.subvolumeId) {
        throw new HizoFSCorruptionError({
          message: 'HizoFS mutable commit belongs to a different subvolume',
          cause: undefined,
        });
      }
      await validateHizoFSCommitRoot({
        commit,
        inodeIndex,
        inodeStore,
        validatedRootCache,
      });
      return freezeHizoFSActiveState({
        state: {
          superblock,
          subvolumeDescriptorObjectId:
            superblock.subvolumeDescriptorObjectId,
          subvolumeDescriptor,
          commitObjectId: superblock.activeCommitObjectId,
          commit,
          stateSelection:
            index === 0 && candidateSet.unusableSlotCount === 0
              ? 'current'
              : 'fallback',
        },
      });
    } catch (error) {
      if (error instanceof HizoFSUnsupportedFormatError) {
        // A newer unsupported generation must not be silently interpreted as
        // an older writable filesystem.
        throw error;
      }
      rejected.push(error);
    }
  }

  throw new HizoFSCorruptionError({
    message: 'No complete HizoFS superblock generation remains',
    cause: new AggregateError(rejected),
  });
}

export async function loadHizoFSFixedSubvolumeState({
  subvolumeDescriptorObjectId,
  commitStore,
  subvolumeDescriptorStore,
  inodeIndex,
  inodeStore,
}: {
  subvolumeDescriptorObjectId: string;
  commitStore: HizoFSCommitStore;
  subvolumeDescriptorStore: HizoFSSubvolumeDescriptorStore;
  inodeIndex: HizoFSInodeIndex;
  inodeStore: HizoFSInodeStore;
}): Promise<HizoFSFilesystemState> {
  const subvolumeDescriptor = await subvolumeDescriptorStore.read({
    objectId: subvolumeDescriptorObjectId,
  });
  switch (subvolumeDescriptor.access) {
  case 'read':
    break;
  case 'read_write':
    throw new HizoFSCorruptionError({
      message: 'HizoFS fixed subvolume descriptor unexpectedly permits writes',
      cause: undefined,
    });
  default: {
    const _ex: never = subvolumeDescriptor;
    throw new Error(`Unhandled HizoFS fixed subvolume descriptor: ${String(_ex)}`);
  }
  }
  const commit = await commitStore.read({
    objectId: subvolumeDescriptor.fixedCommitObjectId,
  });
  if (commit.subvolumeId !== subvolumeDescriptor.subvolumeId) {
    throw new HizoFSCorruptionError({
      message: 'HizoFS fixed commit belongs to a different subvolume',
      cause: undefined,
    });
  }
  await validateHizoFSCommitRoot({
    commit,
    inodeIndex,
    inodeStore,
    validatedRootCache: undefined,
  });
  return freezeHizoFSFilesystemState({
    state: {
      subvolumeDescriptorObjectId,
      subvolumeDescriptor,
      commitObjectId: subvolumeDescriptor.fixedCommitObjectId,
      commit,
      stateSelection: 'current',
    },
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
