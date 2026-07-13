import type {
  EncryptedOpfsCommitDto,
  EncryptedOpfsSuperblockDto,
} from '@/00-storage/00-dto/encrypted-opfs.dto';
import { EncryptedOpfsCorruptionError } from '@/00-storage/service/encrypted-opfs/errors';
import type { EncryptedOpfsObjectStore } from '@/00-storage/service/encrypted-opfs/object-store/object-store';
import type { EncryptedOpfsSuperblockStore } from '@/00-storage/service/encrypted-opfs/object-store/superblock-store';
import { EncryptedOpfsCommitStore } from './commit-store';
import type { EncryptedOpfsInodeIndex } from './inode-index';
import type { EncryptedOpfsInodeStore } from './inode-store';
import { runWithEncryptedOpfsMutationLock } from './mutation-lock';

export type EncryptedOpfsActiveState = {
  readonly superblock: EncryptedOpfsSuperblockDto;
  readonly commitObjectId: string;
  readonly commit: EncryptedOpfsCommitDto;
};

export type EncryptedOpfsMutationResult<T> = {
  readonly inodeIndexRootObjectId: string;
  readonly result: T;
  readonly changed: 'yes' | 'no';
};

export class EncryptedOpfsCore {
  constructor({
    fileSystemId,
    objectStore,
    superblockStore,
    commitStore,
    inodeIndex,
    inodeStore,
  }: {
    fileSystemId: string;
    objectStore: EncryptedOpfsObjectStore;
    superblockStore: EncryptedOpfsSuperblockStore;
    commitStore: EncryptedOpfsCommitStore;
    inodeIndex: EncryptedOpfsInodeIndex;
    inodeStore: EncryptedOpfsInodeStore;
  }) {
    this.fileSystemId = fileSystemId;
    this.objectStore = objectStore;
    this.superblockStore = superblockStore;
    this.commitStore = commitStore;
    this.inodeIndex = inodeIndex;
    this.inodeStore = inodeStore;
  }

  readonly fileSystemId: string;
  readonly objectStore: EncryptedOpfsObjectStore;
  readonly superblockStore: EncryptedOpfsSuperblockStore;
  readonly commitStore: EncryptedOpfsCommitStore;
  readonly inodeIndex: EncryptedOpfsInodeIndex;
  readonly inodeStore: EncryptedOpfsInodeStore;

  async loadActiveState(): Promise<EncryptedOpfsActiveState> {
    const superblock = await this.superblockStore.read();
    if (superblock === undefined) {
      throw new EncryptedOpfsCorruptionError({
        message: 'EncryptedOpfs superblock is missing',
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
      throw new EncryptedOpfsCorruptionError({
        message: 'EncryptedOpfs root directory is absent from the inode index',
        cause: undefined,
      });
    }
    const rootDirectory = await this.inodeStore.readDirectory({
      objectId: rootIndexEntry.inodeObjectId,
    });
    if (rootDirectory.nodeId !== commit.rootDirectoryNodeId) {
      throw new EncryptedOpfsCorruptionError({
        message: 'EncryptedOpfs root directory inode identity is inconsistent',
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
      state: EncryptedOpfsActiveState;
    }) => Promise<EncryptedOpfsMutationResult<T>>;
  }): Promise<T> {
    return runWithEncryptedOpfsMutationLock({
      fileSystemId: this.fileSystemId,
      operation: async () => {
        const state = await this.loadActiveState();
        const mutation = await operation({ state });
        switch (mutation.changed) {
        case 'no':
          return mutation.result;
        case 'yes': {
          const commit: EncryptedOpfsCommitDto = {
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
          throw new Error(`Unhandled EncryptedOpfs mutation state: ${String(_ex)}`);
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
