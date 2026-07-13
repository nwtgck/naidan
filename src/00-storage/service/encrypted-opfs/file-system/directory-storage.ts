import type {
  EncryptedOpfsDirectoryEntryDto,
  EncryptedOpfsDirectoryInodeDto,
} from '@/00-storage/00-dto/encrypted-opfs.dto';
import type { EncryptedOpfsDirectoryIndex } from './directory-index';
import type { EncryptedOpfsInodeStore } from './inode-store';
import { compareEncryptedOpfsStrings } from './ordering';
import { assertEncryptedOpfsEntryName } from './semantic-validation';

export type EncryptedOpfsDirectoryChange =
  | {
      readonly type: 'set';
      readonly entry: EncryptedOpfsDirectoryEntryDto;
    }
  | {
      readonly type: 'delete';
      readonly name: string;
    };

export class EncryptedOpfsDirectoryStorage {
  constructor({ inodeStore, directoryIndex, inlineEntryLimit }: {
    inodeStore: EncryptedOpfsInodeStore;
    directoryIndex: EncryptedOpfsDirectoryIndex;
    inlineEntryLimit: number;
  }) {
    if (!Number.isSafeInteger(inlineEntryLimit) || inlineEntryLimit < 1) {
      throw new Error('EncryptedOpfs inline directory entry limit must be a positive integer');
    }
    this.inodeStore = inodeStore;
    this.directoryIndex = directoryIndex;
    this.inlineEntryLimit = inlineEntryLimit;
  }

  private readonly inodeStore: EncryptedOpfsInodeStore;
  private readonly directoryIndex: EncryptedOpfsDirectoryIndex;
  private readonly inlineEntryLimit: number;

  async getEntry({ inode, name }: {
    inode: EncryptedOpfsDirectoryInodeDto;
    name: string;
  }): Promise<EncryptedOpfsDirectoryEntryDto | undefined> {
    assertEncryptedOpfsEntryName({ name });
    switch (inode.storage.type) {
    case 'inline': {
      const index = findEntryIndex({ entries: inode.storage.entries, name });
      const entry = inode.storage.entries[index];
      return entry?.name === name ? entry : undefined;
    }
    case 'indexed':
      return this.directoryIndex.get({
        rootObjectId: inode.storage.directoryIndexRootObjectId,
        name,
      });
    default: {
      const _ex: never = inode.storage;
      throw new Error(`Unhandled EncryptedOpfs directory storage: ${String(_ex)}`);
    }
    }
  }

  async *entries({ inode }: {
    inode: EncryptedOpfsDirectoryInodeDto;
  }): AsyncIterable<EncryptedOpfsDirectoryEntryDto> {
    switch (inode.storage.type) {
    case 'inline':
      for (const entry of inode.storage.entries) {
        yield entry;
      }
      break;
    case 'indexed':
      yield* this.directoryIndex.entries({
        rootObjectId: inode.storage.directoryIndexRootObjectId,
      });
      break;
    default: {
      const _ex: never = inode.storage;
      throw new Error(`Unhandled EncryptedOpfs directory storage: ${String(_ex)}`);
    }
    }
  }

  async isEmpty({ inode }: {
    inode: EncryptedOpfsDirectoryInodeDto;
  }): Promise<boolean> {
    for await (const _entry of this.entries({ inode })) {
      return false;
    }
    return true;
  }

  async writeChangedInode({ inode, changes, modifiedAt }: {
    inode: EncryptedOpfsDirectoryInodeDto;
    changes: readonly EncryptedOpfsDirectoryChange[];
    modifiedAt: number;
  }): Promise<{
    readonly inode: EncryptedOpfsDirectoryInodeDto;
    readonly inodeObjectId: string;
  }> {
    let storage: EncryptedOpfsDirectoryInodeDto['storage'];
    switch (inode.storage.type) {
    case 'inline': {
      const entries = [...inode.storage.entries];
      for (const change of changes) {
        applyInlineChange({ entries, change });
      }
      if (entries.length <= this.inlineEntryLimit) {
        storage = { type: 'inline', entries };
        break;
      }
      let rootObjectId = await this.directoryIndex.createEmpty();
      for (const entry of entries) {
        rootObjectId = await this.directoryIndex.set({ rootObjectId, entry });
      }
      storage = {
        type: 'indexed',
        directoryIndexRootObjectId: rootObjectId,
      };
      break;
    }
    case 'indexed': {
      let rootObjectId = inode.storage.directoryIndexRootObjectId;
      for (const change of changes) {
        switch (change.type) {
        case 'set':
          rootObjectId = await this.directoryIndex.set({
            rootObjectId,
            entry: change.entry,
          });
          break;
        case 'delete':
          rootObjectId = await this.directoryIndex.delete({
            rootObjectId,
            name: change.name,
          });
          break;
        default: {
          const _ex: never = change;
          throw new Error(`Unhandled directory change: ${String(_ex)}`);
        }
        }
      }
      storage = {
        type: 'indexed',
        directoryIndexRootObjectId: rootObjectId,
      };
      break;
    }
    default: {
      const _ex: never = inode.storage;
      throw new Error(`Unhandled EncryptedOpfs directory storage: ${String(_ex)}`);
    }
    }

    const nextInode: EncryptedOpfsDirectoryInodeDto = {
      nodeId: inode.nodeId,
      revision: inode.revision + 1,
      createdAt: inode.createdAt,
      modifiedAt,
      storage,
    };
    return {
      inode: nextInode,
      inodeObjectId: await this.inodeStore.writeDirectory({ inode: nextInode }),
    };
  }
}

function applyInlineChange({ entries, change }: {
  entries: EncryptedOpfsDirectoryEntryDto[];
  change: EncryptedOpfsDirectoryChange;
}): void {
  switch (change.type) {
  case 'set': {
    assertEncryptedOpfsEntryName({ name: change.entry.name });
    const index = findEntryIndex({ entries, name: change.entry.name });
    if (entries[index]?.name === change.entry.name) {
      entries[index] = change.entry;
    } else {
      entries.splice(index, 0, change.entry);
    }
    break;
  }
  case 'delete': {
    const index = findEntryIndex({ entries, name: change.name });
    if (entries[index]?.name === change.name) {
      entries.splice(index, 1);
    }
    break;
  }
  default: {
    const _ex: never = change;
    throw new Error(`Unhandled directory change: ${String(_ex)}`);
  }
  }
}

function findEntryIndex({ entries, name }: {
  entries: readonly EncryptedOpfsDirectoryEntryDto[];
  name: string;
}): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = entries[middle];
    if (
      candidate !== undefined
      && compareEncryptedOpfsStrings({ left: candidate.name, right: name }) < 0
    ) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
