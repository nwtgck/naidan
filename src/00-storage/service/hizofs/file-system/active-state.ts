import {
  HizoFSCommitSchemaDto,
  HizoFSSuperblockSchemaDto,
  type HizoFSCommitDto,
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

export type HizoFSActiveState = {
  readonly superblock: HizoFSSuperblockDto;
  readonly commitObjectId: string;
  readonly commit: HizoFSCommitDto;
  readonly mode: 'current' | 'fallback_read_only';
};

export const HizoFSActiveStateSchema: z.ZodType<HizoFSActiveState> = z.object({
  superblock: HizoFSSuperblockSchemaDto,
  commitObjectId: z.string(),
  commit: HizoFSCommitSchemaDto,
  mode: z.enum(['current', 'fallback_read_only']),
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
    commitObjectId,
    commit,
    mode,
    ...unhandledState
  } = state;
  unhandledState satisfies Record<PropertyKey, never>;
  const {
    sequence,
    fileSystemId,
    activeCommitObjectId,
    ...unhandledSuperblock
  } = superblock;
  unhandledSuperblock satisfies Record<PropertyKey, never>;
  const {
    revision,
    publicationId,
    rootDirectoryNodeId,
    inodeIndexRootObjectId,
    ...unhandledCommit
  } = commit;
  unhandledCommit satisfies Record<PropertyKey, never>;

  return Object.freeze({
    superblock: Object.freeze({
      sequence,
      fileSystemId,
      activeCommitObjectId,
    }),
    commitObjectId,
    commit: Object.freeze({
      revision,
      publicationId,
      rootDirectoryNodeId,
      inodeIndexRootObjectId,
    }),
    mode,
  });
}

export async function validateHizoFSCommitRoot({
  commit,
  inodeIndex,
  inodeStore,
}: {
  commit: HizoFSCommitDto;
  inodeIndex: HizoFSInodeIndex;
  inodeStore: HizoFSInodeStore;
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
  const rootDirectory = await inodeStore.readDirectory({
    objectId: rootIndexEntry.inodeObjectId,
  });
  if (rootDirectory.nodeId !== commit.rootDirectoryNodeId) {
    throw new HizoFSCorruptionError({
      message: 'HizoFS root directory inode identity is inconsistent',
      cause: undefined,
    });
  }
}

export async function loadHizoFSActiveStateFromStores({
  superblockStore,
  commitStore,
  inodeIndex,
  inodeStore,
}: {
  superblockStore: HizoFSSuperblockStore;
  commitStore: HizoFSCommitStore;
  inodeIndex: HizoFSInodeIndex;
  inodeStore: HizoFSInodeStore;
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
      const commit = await commitStore.read({
        objectId: superblock.activeCommitObjectId,
      });
      await validateHizoFSCommitRoot({
        commit,
        inodeIndex,
        inodeStore,
      });
      return freezeHizoFSActiveState({
        state: {
          superblock,
          commitObjectId: superblock.activeCommitObjectId,
          commit,
          mode:
            index === 0 && candidateSet.unusableSlotCount === 0
              ? 'current'
              : 'fallback_read_only',
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

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
