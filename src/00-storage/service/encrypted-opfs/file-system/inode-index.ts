import {
  EncryptedOpfsInodeIndexPageSchemaDto,
  type EncryptedOpfsInodeIndexPageDto,
} from '@/00-storage/00-dto/encrypted-opfs.dto';
import { validateEncryptedOpfsStableId } from '@/00-storage/service/encrypted-opfs/id';
import {
  PersistentEncryptedOpfsIndex,
  type PersistentIndexPage,
  type PersistentIndexPageStore,
} from './persistent-index';
import { compareEncryptedOpfsStrings } from './ordering';
import { assertEncryptedOpfsObjectId } from './semantic-validation';
import type { EncryptedOpfsRecordStore } from './record-store';

export type EncryptedOpfsInodeIndexEntry = {
  readonly nodeId: string;
  readonly inodeObjectId: string;
};

class InodeIndexPageStore implements PersistentIndexPageStore<
  string,
  EncryptedOpfsInodeIndexEntry
> {
  constructor({ recordStore }: {
    recordStore: EncryptedOpfsRecordStore;
  }) {
    this.recordStore = recordStore;
  }

  private readonly recordStore: EncryptedOpfsRecordStore;

  async readPage({ objectId }: {
    objectId: string;
  }): Promise<PersistentIndexPage<string, EncryptedOpfsInodeIndexEntry>> {
    const { metadata } = await this.recordStore.read({
      objectId,
      expectedKind: 'inode_index_page',
      schema: EncryptedOpfsInodeIndexPageSchemaDto,
      binaryPayload: 'forbidden',
    });
    assertPage({ page: metadata });
    switch (metadata.type) {
    case 'leaf':
      return { type: 'leaf', entries: metadata.entries };
    case 'branch':
      return {
        type: 'branch',
        children: metadata.children.map(child => ({
          upperBound: child.upperBoundNodeId,
          childPageObjectId: child.childPageObjectId,
        })),
      };
    default: {
      const _ex: never = metadata;
      throw new Error(`Unhandled inode index page: ${String(_ex)}`);
    }
    }
  }

  async writePage({ page }: {
    page: PersistentIndexPage<string, EncryptedOpfsInodeIndexEntry>;
  }): Promise<string> {
    const metadata: EncryptedOpfsInodeIndexPageDto = (() => {
      switch (page.type) {
      case 'leaf':
        return { type: 'leaf', entries: page.entries };
      case 'branch':
        return {
          type: 'branch',
          children: page.children.map(child => ({
            upperBoundNodeId: child.upperBound,
            childPageObjectId: child.childPageObjectId,
          })),
        };
      default: {
        const _ex: never = page;
        throw new Error(`Unhandled inode index page: ${String(_ex)}`);
      }
      }
    })();
    assertPage({ page: metadata });
    return this.recordStore.write({
      kind: 'inode_index_page',
      metadata,
      binaryPayload: new Uint8Array(),
    });
  }
}

function assertPage({ page }: {
  page: EncryptedOpfsInodeIndexPageDto;
}): void {
  switch (page.type) {
  case 'leaf': {
    let previousNodeId: string | undefined;
    for (const entry of page.entries) {
      validateEncryptedOpfsStableId({
        value: entry.nodeId,
        fieldName: 'Inode index nodeId',
      });
      assertEncryptedOpfsObjectId({
        value: entry.inodeObjectId,
        fieldName: 'Inode index inodeObjectId',
      });
      if (
        previousNodeId !== undefined
        && compareEncryptedOpfsStrings({ left: previousNodeId, right: entry.nodeId }) >= 0
      ) {
        throw new Error('EncryptedOpfs inode index leaf entries must be strictly sorted');
      }
      previousNodeId = entry.nodeId;
    }
    break;
  }
  case 'branch': {
    if (page.children.length === 0) {
      throw new Error('EncryptedOpfs inode index branch must contain at least one child');
    }
    let previousUpperBound: string | undefined;
    for (const child of page.children) {
      validateEncryptedOpfsStableId({
        value: child.upperBoundNodeId,
        fieldName: 'Inode index upperBoundNodeId',
      });
      assertEncryptedOpfsObjectId({
        value: child.childPageObjectId,
        fieldName: 'Inode index childPageObjectId',
      });
      if (
        previousUpperBound !== undefined
        && compareEncryptedOpfsStrings({
          left: previousUpperBound,
          right: child.upperBoundNodeId,
        }) >= 0
      ) {
        throw new Error('EncryptedOpfs inode index branch bounds must be strictly sorted');
      }
      previousUpperBound = child.upperBoundNodeId;
    }
    break;
  }
  default: {
    const _ex: never = page;
    throw new Error(`Unhandled inode index page: ${String(_ex)}`);
  }
  }
}

export class EncryptedOpfsInodeIndex {
  constructor({ recordStore, maxPageEntries }: {
    recordStore: EncryptedOpfsRecordStore;
    maxPageEntries: number;
  }) {
    this.pageStore = new InodeIndexPageStore({ recordStore });
    this.index = new PersistentEncryptedOpfsIndex({
      pageStore: this.pageStore,
      compare: compareEncryptedOpfsStrings,
      getEntryKey: ({ entry }) => entry.nodeId,
      maxPageEntries,
    });
  }

  private readonly pageStore: InodeIndexPageStore;
  private readonly index: PersistentEncryptedOpfsIndex<
    string,
    EncryptedOpfsInodeIndexEntry
  >;


  async visitReferences({ rootObjectId, visitPageObjectId, visitInodeObjectId }: {
    rootObjectId: string;
    visitPageObjectId: ({ objectId }: { objectId: string }) => void;
    visitInodeObjectId: ({ objectId, nodeId }: { objectId: string; nodeId: string }) => void;
  }): Promise<void> {
    const visited = new Set<string>();
    const visitPage = async ({ objectId }: { objectId: string }): Promise<void> => {
      if (visited.has(objectId)) {
        throw new Error('EncryptedOpfs inode index contains a page cycle');
      }
      visited.add(objectId);
      visitPageObjectId({ objectId });
      const page = await this.pageStore.readPage({ objectId });
      switch (page.type) {
      case 'leaf':
        for (const entry of page.entries) {
          visitInodeObjectId({
            objectId: entry.inodeObjectId,
            nodeId: entry.nodeId,
          });
        }
        return;
      case 'branch':
        for (const child of page.children) {
          await visitPage({ objectId: child.childPageObjectId });
        }
        return;
      default: {
        const _ex: never = page;
        throw new Error(`Unhandled inode index page: ${String(_ex)}`);
      }
      }
    };
    await visitPage({ objectId: rootObjectId });
  }

  createEmpty(): Promise<string> {
    return this.index.createEmpty();
  }

  get({ rootObjectId, nodeId }: {
    rootObjectId: string;
    nodeId: string;
  }): Promise<EncryptedOpfsInodeIndexEntry | undefined> {
    return this.index.get({ rootObjectId, key: nodeId });
  }

  set({ rootObjectId, entry }: {
    rootObjectId: string;
    entry: EncryptedOpfsInodeIndexEntry;
  }): Promise<string> {
    return this.index.set({ rootObjectId, entry });
  }

  delete({ rootObjectId, nodeId }: {
    rootObjectId: string;
    nodeId: string;
  }): Promise<string> {
    return this.index.delete({ rootObjectId, key: nodeId });
  }

  entries({ rootObjectId }: {
    rootObjectId: string;
  }): AsyncIterable<EncryptedOpfsInodeIndexEntry> {
    return this.index.entries({ rootObjectId });
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
