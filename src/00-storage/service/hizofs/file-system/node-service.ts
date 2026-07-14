import type {
  HizoFSDirectoryInodeDto,
  HizoFSSymlinkInodeDto,
} from '@/00-storage/00-dto/hizofs.dto';
import { HizoFSCorruptionError } from '@/00-storage/service/hizofs/errors';
import type { HizoFSActiveState } from './core';
import type { HizoFSInodeIndex } from './inode-index';
import type {
  HizoFSFileInodeRecord,
  HizoFSInodeStore,
} from './inode-store';

export type LoadedHizoFSFile = HizoFSFileInodeRecord & {
  readonly inodeObjectId: string;
};

export type LoadedHizoFSDirectory = {
  readonly inodeObjectId: string;
  readonly inode: HizoFSDirectoryInodeDto;
};

export type LoadedHizoFSSymlink = {
  readonly inodeObjectId: string;
  readonly inode: HizoFSSymlinkInodeDto;
};

export class HizoFSNodeService {
  constructor({ inodeIndex, inodeStore }: {
    inodeIndex: HizoFSInodeIndex;
    inodeStore: HizoFSInodeStore;
  }) {
    this.inodeIndex = inodeIndex;
    this.inodeStore = inodeStore;
  }

  private readonly inodeIndex: HizoFSInodeIndex;
  private readonly inodeStore: HizoFSInodeStore;

  async readFile({ state, nodeId }: {
    state: HizoFSActiveState;
    nodeId: string;
  }): Promise<LoadedHizoFSFile> {
    const inodeObjectId = await this.requireInodeObjectId({ state, nodeId });
    const record = await this.inodeStore.readFile({ objectId: inodeObjectId });
    if (record.inode.nodeId !== nodeId) {
      throw new HizoFSCorruptionError({
        message: 'HizoFS file inode identity does not match the inode index',
        cause: undefined,
      });
    }
    return { inodeObjectId, ...record };
  }

  async readDirectory({ state, nodeId }: {
    state: HizoFSActiveState;
    nodeId: string;
  }): Promise<LoadedHizoFSDirectory> {
    const inodeObjectId = await this.requireInodeObjectId({ state, nodeId });
    const inode = await this.inodeStore.readDirectory({ objectId: inodeObjectId });
    if (inode.nodeId !== nodeId) {
      throw new HizoFSCorruptionError({
        message: 'HizoFS directory inode identity does not match the inode index',
        cause: undefined,
      });
    }
    return { inodeObjectId, inode };
  }

  async readSymlink({ state, nodeId }: {
    state: HizoFSActiveState;
    nodeId: string;
  }): Promise<LoadedHizoFSSymlink> {
    const inodeObjectId = await this.requireInodeObjectId({ state, nodeId });
    const inode = await this.inodeStore.readSymlink({ objectId: inodeObjectId });
    if (inode.nodeId !== nodeId) {
      throw new HizoFSCorruptionError({
        message: 'HizoFS symlink inode identity does not match the inode index',
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
    state: HizoFSActiveState;
    nodeId: string;
  }): Promise<string> {
    const entry = await this.inodeIndex.get({
      rootObjectId: state.commit.inodeIndexRootObjectId,
      nodeId,
    });
    if (entry === undefined) {
      throw new HizoFSCorruptionError({
        message: `HizoFS inode is missing from the active index: ${nodeId}`,
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
