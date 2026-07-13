import {
  EncryptedOpfsDirectoryIndexPageSchemaDto,
  type EncryptedOpfsDirectoryEntryDto,
  type EncryptedOpfsDirectoryIndexPageDto,
} from '@/00-storage/00-dto/encrypted-opfs.dto';
import {
  PersistentEncryptedOpfsIndex,
  type PersistentIndexPage,
  type PersistentIndexPageStore,
} from './persistent-index';
import { compareEncryptedOpfsStrings } from './ordering';
import {
  assertEncryptedOpfsDirectoryEntries,
  assertEncryptedOpfsObjectId,
} from './semantic-validation';
import type { EncryptedOpfsRecordStore } from './record-store';

class DirectoryIndexPageStore implements PersistentIndexPageStore<
  string,
  EncryptedOpfsDirectoryEntryDto
> {
  constructor({ recordStore }: {
    recordStore: EncryptedOpfsRecordStore;
  }) {
    this.recordStore = recordStore;
  }

  private readonly recordStore: EncryptedOpfsRecordStore;

  async readPage({ objectId }: {
    objectId: string;
  }): Promise<PersistentIndexPage<string, EncryptedOpfsDirectoryEntryDto>> {
    const { metadata } = await this.recordStore.read({
      objectId,
      expectedKind: 'directory_index_page',
      schema: EncryptedOpfsDirectoryIndexPageSchemaDto,
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
          upperBound: child.upperBoundName,
          childPageObjectId: child.childPageObjectId,
        })),
      };
    default: {
      const _ex: never = metadata;
      throw new Error(`Unhandled directory index page: ${String(_ex)}`);
    }
    }
  }

  async writePage({ page }: {
    page: PersistentIndexPage<string, EncryptedOpfsDirectoryEntryDto>;
  }): Promise<string> {
    const metadata: EncryptedOpfsDirectoryIndexPageDto = (() => {
      switch (page.type) {
      case 'leaf':
        return { type: 'leaf', entries: page.entries };
      case 'branch':
        return {
          type: 'branch',
          children: page.children.map(child => ({
            upperBoundName: child.upperBound,
            childPageObjectId: child.childPageObjectId,
          })),
        };
      default: {
        const _ex: never = page;
        throw new Error(`Unhandled directory index page: ${String(_ex)}`);
      }
      }
    })();
    assertPage({ page: metadata });
    return this.recordStore.write({
      kind: 'directory_index_page',
      metadata,
      binaryPayload: new Uint8Array(),
    });
  }
}

function assertPage({ page }: {
  page: EncryptedOpfsDirectoryIndexPageDto;
}): void {
  switch (page.type) {
  case 'leaf':
    assertEncryptedOpfsDirectoryEntries({ entries: page.entries });
    break;
  case 'branch': {
    if (page.children.length === 0) {
      throw new Error('EncryptedOpfs directory index branch must contain at least one child');
    }
    let previousUpperBound: string | undefined;
    for (const child of page.children) {
      if (
        previousUpperBound !== undefined
        && compareEncryptedOpfsStrings({ left: previousUpperBound, right: child.upperBoundName }) >= 0
      ) {
        throw new Error('EncryptedOpfs directory index branch bounds must be strictly sorted');
      }
      assertEncryptedOpfsObjectId({
        value: child.childPageObjectId,
        fieldName: 'Directory index childPageObjectId',
      });
      previousUpperBound = child.upperBoundName;
    }
    break;
  }
  default: {
    const _ex: never = page;
    throw new Error(`Unhandled directory index page: ${String(_ex)}`);
  }
  }
}

export class EncryptedOpfsDirectoryIndex {
  constructor({ recordStore, maxPageEntries }: {
    recordStore: EncryptedOpfsRecordStore;
    maxPageEntries: number;
  }) {
    this.pageStore = new DirectoryIndexPageStore({ recordStore });
    this.index = new PersistentEncryptedOpfsIndex({
      pageStore: this.pageStore,
      compare: compareEncryptedOpfsStrings,
      getEntryKey: ({ entry }) => entry.name,
      maxPageEntries,
    });
  }

  private readonly pageStore: DirectoryIndexPageStore;
  private readonly index: PersistentEncryptedOpfsIndex<
    string,
    EncryptedOpfsDirectoryEntryDto
  >;


  async visitReferences({ rootObjectId, visitPageObjectId }: {
    rootObjectId: string;
    visitPageObjectId: ({ objectId }: { objectId: string }) => void;
  }): Promise<void> {
    const visited = new Set<string>();
    const visitPage = async ({ objectId }: { objectId: string }): Promise<void> => {
      if (visited.has(objectId)) {
        throw new Error('EncryptedOpfs directory index contains a page cycle');
      }
      visited.add(objectId);
      visitPageObjectId({ objectId });
      const page = await this.pageStore.readPage({ objectId });
      switch (page.type) {
      case 'leaf':
        return;
      case 'branch':
        for (const child of page.children) {
          await visitPage({ objectId: child.childPageObjectId });
        }
        return;
      default: {
        const _ex: never = page;
        throw new Error(`Unhandled directory index page: ${String(_ex)}`);
      }
      }
    };
    await visitPage({ objectId: rootObjectId });
  }

  createEmpty(): Promise<string> {
    return this.index.createEmpty();
  }

  get({ rootObjectId, name }: {
    rootObjectId: string;
    name: string;
  }): Promise<EncryptedOpfsDirectoryEntryDto | undefined> {
    return this.index.get({ rootObjectId, key: name });
  }

  set({ rootObjectId, entry }: {
    rootObjectId: string;
    entry: EncryptedOpfsDirectoryEntryDto;
  }): Promise<string> {
    return this.index.set({ rootObjectId, entry });
  }

  delete({ rootObjectId, name }: {
    rootObjectId: string;
    name: string;
  }): Promise<string> {
    return this.index.delete({ rootObjectId, key: name });
  }

  entries({ rootObjectId }: {
    rootObjectId: string;
  }): AsyncIterable<EncryptedOpfsDirectoryEntryDto> {
    return this.index.entries({ rootObjectId });
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
