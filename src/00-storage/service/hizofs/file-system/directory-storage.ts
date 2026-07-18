import type {
  HizoFSDirectoryEntryDto,
  HizoFSDirectoryInodeDto,
} from '@/00-storage/00-dto/hizofs.dto';
import type {
  HizoFSDirectoryIndex,
  HizoFSDirectoryIndexLookupCache,
} from './directory-index';
import type { HizoFSInodeStore } from './inode-store';
import { compareHizoFSStrings } from './ordering';
import { assertHizoFSEntryName } from './semantic-validation';

export type HizoFSDirectoryChange =
  | {
      readonly type: 'set';
      readonly entry: HizoFSDirectoryEntryDto;
    }
  | {
      readonly type: 'delete';
      readonly name: string;
    };

export class HizoFSDirectoryStorage {
  constructor({ inodeStore, directoryIndex, inlineEntryLimit }: {
    inodeStore: HizoFSInodeStore;
    directoryIndex: HizoFSDirectoryIndex;
    inlineEntryLimit: number;
  }) {
    if (!Number.isSafeInteger(inlineEntryLimit) || inlineEntryLimit < 1) {
      throw new Error('HizoFS inline directory entry limit must be a positive integer');
    }
    this.inodeStore = inodeStore;
    this.directoryIndex = directoryIndex;
    this.inlineEntryLimit = inlineEntryLimit;
  }

  private readonly inodeStore: HizoFSInodeStore;
  private readonly directoryIndex: HizoFSDirectoryIndex;
  private readonly inlineEntryLimit: number;

  async getEntry({ inode, name }: {
    inode: HizoFSDirectoryInodeDto;
    name: string;
  }): Promise<HizoFSDirectoryEntryDto | undefined> {
    return await this.getEntryInternal({
      inode,
      name,
      lookupCache: undefined,
    });
  }

  async getEntryWithCache({ inode, name, lookupCache }: {
    inode: HizoFSDirectoryInodeDto;
    name: string;
    lookupCache: HizoFSDirectoryIndexLookupCache;
  }): Promise<HizoFSDirectoryEntryDto | undefined> {
    return await this.getEntryInternal({ inode, name, lookupCache });
  }

  private async getEntryInternal({ inode, name, lookupCache }: {
    inode: HizoFSDirectoryInodeDto;
    name: string;
    lookupCache: HizoFSDirectoryIndexLookupCache | undefined;
  }): Promise<HizoFSDirectoryEntryDto | undefined> {
    assertHizoFSEntryName({ name });
    switch (inode.storage.type) {
    case 'inline': {
      const index = findEntryIndex({ entries: inode.storage.entries, name });
      const entry = inode.storage.entries[index];
      return entry?.name === name ? entry : undefined;
    }
    case 'indexed':
      return lookupCache === undefined
        ? this.directoryIndex.get({
          rootObjectId: inode.storage.directoryIndexRootObjectId,
          name,
        })
        : this.directoryIndex.getWithLeafCache({
          rootObjectId: inode.storage.directoryIndexRootObjectId,
          name,
          cache: lookupCache,
        });
    default: {
      const _ex: never = inode.storage;
      throw new Error(`Unhandled HizoFS directory storage: ${String(_ex)}`);
    }
    }
  }

  async *entries({ inode }: {
    inode: HizoFSDirectoryInodeDto;
  }): AsyncIterable<HizoFSDirectoryEntryDto> {
    for await (const batch of this.entryBatches({ inode })) {
      for (const entry of batch) {
        yield entry;
      }
    }
  }

  async *entryBatches({ inode }: {
    inode: HizoFSDirectoryInodeDto;
  }): AsyncIterable<readonly HizoFSDirectoryEntryDto[]> {
    switch (inode.storage.type) {
    case 'inline':
      if (inode.storage.entries.length > 0) {
        yield inode.storage.entries;
      }
      break;
    case 'indexed':
      yield* this.directoryIndex.entryBatches({
        rootObjectId: inode.storage.directoryIndexRootObjectId,
      });
      break;
    default: {
      const _ex: never = inode.storage;
      throw new Error(`Unhandled HizoFS directory storage: ${String(_ex)}`);
    }
    }
  }

  async isEmpty({ inode }: {
    inode: HizoFSDirectoryInodeDto;
  }): Promise<boolean> {
    for await (const _entry of this.entries({ inode })) {
      return false;
    }
    return true;
  }

  async writeChangedInode({ inode, changes, modifiedAt }: {
    inode: HizoFSDirectoryInodeDto;
    changes: readonly HizoFSDirectoryChange[];
    modifiedAt: number;
  }): Promise<{
    readonly inode: HizoFSDirectoryInodeDto;
    readonly inodeObjectId: string;
  }> {
    let storage: HizoFSDirectoryInodeDto['storage'];
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
      const rootObjectId = await this.directoryIndex.buildFromSortedEntries({ entries });
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
          rootObjectId = await this.directoryIndex.setWithRightmostPathCache({
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
      throw new Error(`Unhandled HizoFS directory storage: ${String(_ex)}`);
    }
    }

    const nextInode: HizoFSDirectoryInodeDto = {
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
  entries: HizoFSDirectoryEntryDto[];
  change: HizoFSDirectoryChange;
}): void {
  switch (change.type) {
  case 'set': {
    assertHizoFSEntryName({ name: change.entry.name });
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
  entries: readonly HizoFSDirectoryEntryDto[];
  name: string;
}): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = entries[middle];
    if (
      candidate !== undefined
      && compareHizoFSStrings({ left: candidate.name, right: name }) < 0
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
