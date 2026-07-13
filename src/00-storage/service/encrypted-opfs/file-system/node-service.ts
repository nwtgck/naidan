import type {
  EncryptedOpfsDirectoryInodeDto,
  EncryptedOpfsSymlinkInodeDto,
} from '@/00-storage/00-dto/encrypted-opfs.dto';
import { EncryptedOpfsCorruptionError } from '@/00-storage/service/encrypted-opfs/errors';
import type { EncryptedOpfsActiveState } from './core';
import type { EncryptedOpfsInodeIndex } from './inode-index';
import type {
  EncryptedOpfsFileInodeRecord,
  EncryptedOpfsInodeStore,
} from './inode-store';

export type LoadedEncryptedOpfsFile = EncryptedOpfsFileInodeRecord & {
  readonly inodeObjectId: string;
};

export type LoadedEncryptedOpfsDirectory = {
  readonly inodeObjectId: string;
  readonly inode: EncryptedOpfsDirectoryInodeDto;
};

export type LoadedEncryptedOpfsSymlink = {
  readonly inodeObjectId: string;
  readonly inode: EncryptedOpfsSymlinkInodeDto;
};

export class EncryptedOpfsNodeService {
  constructor({ inodeIndex, inodeStore }: {
    inodeIndex: EncryptedOpfsInodeIndex;
    inodeStore: EncryptedOpfsInodeStore;
  }) {
    this.inodeIndex = inodeIndex;
    this.inodeStore = inodeStore;
  }

  private readonly inodeIndex: EncryptedOpfsInodeIndex;
  private readonly inodeStore: EncryptedOpfsInodeStore;

  async readFile({ state, nodeId }: {
    state: EncryptedOpfsActiveState;
    nodeId: string;
  }): Promise<LoadedEncryptedOpfsFile> {
    const inodeObjectId = await this.requireInodeObjectId({ state, nodeId });
    const record = await this.inodeStore.readFile({ objectId: inodeObjectId });
    if (record.inode.nodeId !== nodeId) {
      throw new EncryptedOpfsCorruptionError({
        message: 'EncryptedOpfs file inode identity does not match the inode index',
        cause: undefined,
      });
    }
    return { inodeObjectId, ...record };
  }

  async readDirectory({ state, nodeId }: {
    state: EncryptedOpfsActiveState;
    nodeId: string;
  }): Promise<LoadedEncryptedOpfsDirectory> {
    const inodeObjectId = await this.requireInodeObjectId({ state, nodeId });
    const inode = await this.inodeStore.readDirectory({ objectId: inodeObjectId });
    if (inode.nodeId !== nodeId) {
      throw new EncryptedOpfsCorruptionError({
        message: 'EncryptedOpfs directory inode identity does not match the inode index',
        cause: undefined,
      });
    }
    return { inodeObjectId, inode };
  }

  async readSymlink({ state, nodeId }: {
    state: EncryptedOpfsActiveState;
    nodeId: string;
  }): Promise<LoadedEncryptedOpfsSymlink> {
    const inodeObjectId = await this.requireInodeObjectId({ state, nodeId });
    const inode = await this.inodeStore.readSymlink({ objectId: inodeObjectId });
    if (inode.nodeId !== nodeId) {
      throw new EncryptedOpfsCorruptionError({
        message: 'EncryptedOpfs symlink inode identity does not match the inode index',
        cause: undefined,
      });
    }
    return { inodeObjectId, inode };
  }

  async setInode({ inodeIndexRootObjectId, nodeId, inodeObjectId }: {
    inodeIndexRootObjectId: string;
    nodeId: string;
    inodeObjectId: string;
  }): Promise<string> {
    return this.inodeIndex.set({
      rootObjectId: inodeIndexRootObjectId,
      entry: { nodeId, inodeObjectId },
    });
  }

  async deleteInode({ inodeIndexRootObjectId, nodeId }: {
    inodeIndexRootObjectId: string;
    nodeId: string;
  }): Promise<string> {
    return this.inodeIndex.delete({
      rootObjectId: inodeIndexRootObjectId,
      nodeId,
    });
  }

  private async requireInodeObjectId({ state, nodeId }: {
    state: EncryptedOpfsActiveState;
    nodeId: string;
  }): Promise<string> {
    const entry = await this.inodeIndex.get({
      rootObjectId: state.commit.inodeIndexRootObjectId,
      nodeId,
    });
    if (entry === undefined) {
      throw new EncryptedOpfsCorruptionError({
        message: `EncryptedOpfs inode is missing from the active index: ${nodeId}`,
        cause: undefined,
      });
    }
    return entry.inodeObjectId;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
