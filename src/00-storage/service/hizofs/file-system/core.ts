import type {
  HizoFSCommitDto,
  HizoFSSuperblockDto,
} from '@/00-storage/00-dto/hizofs.dto';
import { HizoFSCorruptionError } from '@/00-storage/service/hizofs/errors';
import type { HizoFSObjectStore } from '@/00-storage/service/hizofs/object-store/object-store';
import type { HizoFSSuperblockStore } from '@/00-storage/service/hizofs/object-store/superblock-store';
import { HizoFSCommitStore } from './commit-store';
import type { HizoFSInodeIndex } from './inode-index';
import type { HizoFSInodeStore } from './inode-store';
import { runWithHizoFSMutationLock } from './mutation-lock';

export type HizoFSActiveState = {
  readonly superblock: HizoFSSuperblockDto;
  readonly commitObjectId: string;
  readonly commit: HizoFSCommitDto;
};

export type HizoFSMutationResult<T> = {
  readonly inodeIndexRootObjectId: string;
  readonly result: T;
  readonly changed: 'yes' | 'no';
};

export class HizoFSCore {
  constructor({
    fileSystemId,
    objectStore,
    superblockStore,
    commitStore,
    inodeIndex,
    inodeStore,
  }: {
    fileSystemId: string;
    objectStore: HizoFSObjectStore;
    superblockStore: HizoFSSuperblockStore;
    commitStore: HizoFSCommitStore;
    inodeIndex: HizoFSInodeIndex;
    inodeStore: HizoFSInodeStore;
  }) {
    this.fileSystemId = fileSystemId;
    this.objectStore = objectStore;
    this.superblockStore = superblockStore;
    this.commitStore = commitStore;
    this.inodeIndex = inodeIndex;
    this.inodeStore = inodeStore;
  }

  readonly fileSystemId: string;
  readonly objectStore: HizoFSObjectStore;
  readonly superblockStore: HizoFSSuperblockStore;
  readonly commitStore: HizoFSCommitStore;
  readonly inodeIndex: HizoFSInodeIndex;
  readonly inodeStore: HizoFSInodeStore;

  async loadActiveState(): Promise<HizoFSActiveState> {
    const superblock = await this.superblockStore.read();
    if (superblock === undefined) {
      throw new HizoFSCorruptionError({
        message: 'HizoFS superblock is missing',
        cause: undefined,
      });
    }
    const commit = await this.commitStore.read({
      objectId: superblock.activeCommitObjectId,
    });
    const rootIndexEntry = await this.inodeIndex.get({
      rootObjectId: commit.inodeIndexRootObjectId,
      nodeId: commit.rootDirectoryNodeId,
    });
    if (rootIndexEntry === undefined) {
      throw new HizoFSCorruptionError({
        message: 'HizoFS root directory is absent from the inode index',
        cause: undefined,
      });
    }
    const rootDirectory = await this.inodeStore.readDirectory({
      objectId: rootIndexEntry.inodeObjectId,
    });
    if (rootDirectory.nodeId !== commit.rootDirectoryNodeId) {
      throw new HizoFSCorruptionError({
        message: 'HizoFS root directory inode identity is inconsistent',
        cause: undefined,
      });
    }
    return {
      superblock,
      commitObjectId: superblock.activeCommitObjectId,
      commit,
    };
  }

  async mutate<T>({ operation }: {
    operation: ({ state }: {
      state: HizoFSActiveState;
    }) => Promise<HizoFSMutationResult<T>>;
  }): Promise<T> {
    return runWithHizoFSMutationLock({
      fileSystemId: this.fileSystemId,
      operation: async () => {
        const state = await this.loadActiveState();
        const mutation = await operation({ state });
        switch (mutation.changed) {
        case 'no':
          return mutation.result;
        case 'yes': {
          const commit: HizoFSCommitDto = {
            revision: state.commit.revision + 1,
            rootDirectoryNodeId: state.commit.rootDirectoryNodeId,
            inodeIndexRootObjectId: mutation.inodeIndexRootObjectId,
          };
          const commitObjectId = await this.commitStore.write({ commit });
          await this.superblockStore.write({
            value: {
              sequence: state.superblock.sequence + 1,
              fileSystemId: this.fileSystemId,
              activeCommitObjectId: commitObjectId,
            },
          });
          return mutation.result;
        }
        default: {
          const _ex: never = mutation.changed;
          throw new Error(`Unhandled HizoFS mutation state: ${String(_ex)}`);
        }
        }
      },
    });
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
