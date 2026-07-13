import {
  EncryptedOpfsFileExtentPageSchemaDto,
  type EncryptedOpfsFileExtentDto,
  type EncryptedOpfsFileExtentPageDto,
} from '@/00-storage/00-dto/encrypted-opfs.dto';
import {
  PersistentEncryptedOpfsIndex,
  type PersistentIndexPage,
  type PersistentIndexPageStore,
} from './persistent-index';
import { compareEncryptedOpfsNumbers } from './ordering';
import {
  assertEncryptedOpfsNonNegativeSafeInteger,
  assertEncryptedOpfsObjectId,
} from './semantic-validation';
import type { EncryptedOpfsRecordStore } from './record-store';

class ExtentIndexPageStore implements PersistentIndexPageStore<
  number,
  EncryptedOpfsFileExtentDto
> {
  constructor({ recordStore }: {
    recordStore: EncryptedOpfsRecordStore;
  }) {
    this.recordStore = recordStore;
  }

  private readonly recordStore: EncryptedOpfsRecordStore;

  async readPage({ objectId }: {
    objectId: string;
  }): Promise<PersistentIndexPage<number, EncryptedOpfsFileExtentDto>> {
    const { metadata } = await this.recordStore.read({
      objectId,
      expectedKind: 'file_extent_page',
      schema: EncryptedOpfsFileExtentPageSchemaDto,
      binaryPayload: 'forbidden',
    });
    assertPage({ page: metadata });
    switch (metadata.type) {
    case 'leaf':
      return { type: 'leaf', entries: metadata.extents };
    case 'branch':
      return {
        type: 'branch',
        children: metadata.children.map(child => ({
          upperBound: child.upperBoundChunkIndex,
          childPageObjectId: child.childPageObjectId,
        })),
      };
    default: {
      const _ex: never = metadata;
      throw new Error(`Unhandled extent index page: ${String(_ex)}`);
    }
    }
  }

  async writePage({ page }: {
    page: PersistentIndexPage<number, EncryptedOpfsFileExtentDto>;
  }): Promise<string> {
    const metadata: EncryptedOpfsFileExtentPageDto = (() => {
      switch (page.type) {
      case 'leaf':
        return { type: 'leaf', extents: page.entries };
      case 'branch':
        return {
          type: 'branch',
          children: page.children.map(child => ({
            upperBoundChunkIndex: child.upperBound,
            childPageObjectId: child.childPageObjectId,
          })),
        };
      default: {
        const _ex: never = page;
        throw new Error(`Unhandled extent index page: ${String(_ex)}`);
      }
      }
    })();
    assertPage({ page: metadata });
    return this.recordStore.write({
      kind: 'file_extent_page',
      metadata,
      binaryPayload: new Uint8Array(),
    });
  }
}

function assertPage({ page }: {
  page: EncryptedOpfsFileExtentPageDto;
}): void {
  switch (page.type) {
  case 'leaf': {
    let previousChunkIndex: number | undefined;
    for (const extent of page.extents) {
      assertEncryptedOpfsNonNegativeSafeInteger({
        value: extent.chunkIndex,
        fieldName: 'Extent chunkIndex',
      });
      assertEncryptedOpfsObjectId({
        value: extent.chunkObjectId,
        fieldName: 'Extent chunkObjectId',
      });
      if (previousChunkIndex !== undefined && previousChunkIndex >= extent.chunkIndex) {
        throw new Error('EncryptedOpfs extent index leaf entries must be strictly sorted');
      }
      previousChunkIndex = extent.chunkIndex;
    }
    break;
  }
  case 'branch': {
    if (page.children.length === 0) {
      throw new Error('EncryptedOpfs extent index branch must contain at least one child');
    }
    let previousUpperBound: number | undefined;
    for (const child of page.children) {
      assertEncryptedOpfsNonNegativeSafeInteger({
        value: child.upperBoundChunkIndex,
        fieldName: 'Extent upperBoundChunkIndex',
      });
      assertEncryptedOpfsObjectId({
        value: child.childPageObjectId,
        fieldName: 'Extent childPageObjectId',
      });
      if (previousUpperBound !== undefined && previousUpperBound >= child.upperBoundChunkIndex) {
        throw new Error('EncryptedOpfs extent index branch bounds must be strictly sorted');
      }
      previousUpperBound = child.upperBoundChunkIndex;
    }
    break;
  }
  default: {
    const _ex: never = page;
    throw new Error(`Unhandled extent index page: ${String(_ex)}`);
  }
  }
}

export class EncryptedOpfsExtentIndex {
  constructor({ recordStore, maxPageEntries }: {
    recordStore: EncryptedOpfsRecordStore;
    maxPageEntries: number;
  }) {
    this.pageStore = new ExtentIndexPageStore({ recordStore });
    this.index = new PersistentEncryptedOpfsIndex({
      pageStore: this.pageStore,
      compare: compareEncryptedOpfsNumbers,
      getEntryKey: ({ entry }) => entry.chunkIndex,
      maxPageEntries,
    });
  }

  private readonly pageStore: ExtentIndexPageStore;
  private readonly index: PersistentEncryptedOpfsIndex<number, EncryptedOpfsFileExtentDto>;


  async visitReferences({ rootObjectId, visitPageObjectId, visitChunkObjectId }: {
    rootObjectId: string;
    visitPageObjectId: ({ objectId }: { objectId: string }) => void;
    visitChunkObjectId: ({ objectId, chunkIndex }: { objectId: string; chunkIndex: number }) => void;
  }): Promise<void> {
    const visited = new Set<string>();
    const visitPage = async ({ objectId }: { objectId: string }): Promise<void> => {
      if (visited.has(objectId)) {
        throw new Error('EncryptedOpfs extent index contains a page cycle');
      }
      visited.add(objectId);
      visitPageObjectId({ objectId });
      const page = await this.pageStore.readPage({ objectId });
      switch (page.type) {
      case 'leaf':
        for (const extent of page.entries) {
          visitChunkObjectId({
            objectId: extent.chunkObjectId,
            chunkIndex: extent.chunkIndex,
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
        throw new Error(`Unhandled extent index page: ${String(_ex)}`);
      }
      }
    };
    await visitPage({ objectId: rootObjectId });
  }

  createEmpty(): Promise<string> {
    return this.index.createEmpty();
  }

  get({ rootObjectId, chunkIndex }: {
    rootObjectId: string;
    chunkIndex: number;
  }): Promise<EncryptedOpfsFileExtentDto | undefined> {
    return this.index.get({ rootObjectId, key: chunkIndex });
  }

  set({ rootObjectId, extent }: {
    rootObjectId: string;
    extent: EncryptedOpfsFileExtentDto;
  }): Promise<string> {
    return this.index.set({ rootObjectId, entry: extent });
  }

  delete({ rootObjectId, chunkIndex }: {
    rootObjectId: string;
    chunkIndex: number;
  }): Promise<string> {
    return this.index.delete({ rootObjectId, key: chunkIndex });
  }

  entries({ rootObjectId }: {
    rootObjectId: string;
  }): AsyncIterable<EncryptedOpfsFileExtentDto> {
    return this.index.entries({ rootObjectId });
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
