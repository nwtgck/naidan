import {
  HizoFSDirectoryIndexPageSchemaDto,
  type HizoFSDirectoryEntryDto,
  type HizoFSDirectoryIndexPageDto,
} from '@/00-storage/00-dto/hizofs.dto';
import {
  PersistentHizoFSIndex,
  type PersistentIndexLeafLookupCache,
  type PersistentIndexPage,
  type PersistentIndexPageStore,
} from './persistent-index';
import { compareHizoFSStrings } from './ordering';
import {
  assertHizoFSDirectoryEntries,
  assertHizoFSObjectId,
} from './semantic-validation';
import type { HizoFSRecordStore } from './record-store';
import type { HizoFSRuntimeDiagnostics } from './diagnostics';

export type HizoFSDirectoryIndexLookupCache =
  PersistentIndexLeafLookupCache<string, HizoFSDirectoryEntryDto>;

class DirectoryIndexPageStore implements PersistentIndexPageStore<
  string,
  HizoFSDirectoryEntryDto
> {
  constructor({ recordStore }: {
    recordStore: HizoFSRecordStore;
  }) {
    this.recordStore = recordStore;
  }

  private readonly recordStore: HizoFSRecordStore;

  async readPage({ objectId }: {
    objectId: string;
  }): Promise<PersistentIndexPage<string, HizoFSDirectoryEntryDto>> {
    const { metadata } = await this.recordStore.read({
      objectId,
      expectedKind: 'directory_index_page',
      schema: HizoFSDirectoryIndexPageSchemaDto,
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
    page: PersistentIndexPage<string, HizoFSDirectoryEntryDto>;
  }): Promise<string> {
    const metadata: HizoFSDirectoryIndexPageDto = (() => {
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
  page: HizoFSDirectoryIndexPageDto;
}): void {
  switch (page.type) {
  case 'leaf':
    assertHizoFSDirectoryEntries({ entries: page.entries });
    break;
  case 'branch': {
    if (page.children.length === 0) {
      throw new Error('HizoFS directory index branch must contain at least one child');
    }
    let previousUpperBound: string | undefined;
    for (const child of page.children) {
      if (
        previousUpperBound !== undefined
        && compareHizoFSStrings({ left: previousUpperBound, right: child.upperBoundName }) >= 0
      ) {
        throw new Error('HizoFS directory index branch bounds must be strictly sorted');
      }
      assertHizoFSObjectId({
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

export class HizoFSDirectoryIndex {
  constructor({ recordStore, maxPageEntries, diagnostics }: {
    recordStore: HizoFSRecordStore;
    maxPageEntries: number;
    diagnostics?: HizoFSRuntimeDiagnostics;
  }) {
    this.pageStore = new DirectoryIndexPageStore({ recordStore });
    this.diagnostics = diagnostics;
    this.index = new PersistentHizoFSIndex({
      pageStore: this.pageStore,
      compare: compareHizoFSStrings,
      getEntryKey: ({ entry }) => entry.name,
      maxPageEntries,
    });
  }

  private readonly pageStore: DirectoryIndexPageStore;
  private readonly diagnostics?: HizoFSRuntimeDiagnostics;
  private readonly index: PersistentHizoFSIndex<
    string,
    HizoFSDirectoryEntryDto
  >;


  async visitReferences({
    rootObjectId,
    visitPageObjectId,
    visitedPageObjectIds,
  }: {
    rootObjectId: string;
    visitPageObjectId: ({ objectId }: { objectId: string }) => void;
    visitedPageObjectIds: Set<string> | undefined;
  }): Promise<void> {
    const completed = visitedPageObjectIds ?? new Set<string>();
    const visiting = new Set<string>();
    const seenInThisTraversal = new Set<string>();
    const visitPage = async ({ objectId }: { objectId: string }): Promise<void> => {
      visitPageObjectId({ objectId });
      if (visiting.has(objectId)) {
        throw new Error('HizoFS directory index contains a page cycle');
      }
      if (seenInThisTraversal.has(objectId)) {
        throw new Error('HizoFS directory index contains a duplicate page reference');
      }
      seenInThisTraversal.add(objectId);
      if (completed.has(objectId)) return;

      visiting.add(objectId);
      try {
        const page = await this.pageStore.readPage({ objectId });
        switch (page.type) {
        case 'leaf':
          break;
        case 'branch':
          for (const child of page.children) {
            await visitPage({ objectId: child.childPageObjectId });
          }
          break;
        default: {
          const _ex: never = page;
          throw new Error(`Unhandled directory index page: ${String(_ex)}`);
        }
        }
      } finally {
        visiting.delete(objectId);
      }
      completed.add(objectId);
    };
    await visitPage({ objectId: rootObjectId });
  }

  createEmpty(): Promise<string> {
    return this.diagnostics === undefined
      ? this.index.createEmpty()
      : this.diagnostics.measureAsync({
        phase: 'index_build',
        operation: async () => this.index.createEmpty(),
      });
  }

  get({ rootObjectId, name }: {
    rootObjectId: string;
    name: string;
  }): Promise<HizoFSDirectoryEntryDto | undefined> {
    return this.index.get({ rootObjectId, key: name });
  }

  getWithLeafCache({ rootObjectId, name, cache }: {
    rootObjectId: string;
    name: string;
    cache: HizoFSDirectoryIndexLookupCache;
  }): Promise<HizoFSDirectoryEntryDto | undefined> {
    return this.index.getWithLeafCache({
      rootObjectId,
      key: name,
      cache,
    });
  }

  set({ rootObjectId, entry }: {
    rootObjectId: string;
    entry: HizoFSDirectoryEntryDto;
  }): Promise<string> {
    return this.diagnostics === undefined
      ? this.index.set({ rootObjectId, entry })
      : this.diagnostics.measureAsync({
        phase: 'index_update',
        operation: async () => this.index.set({ rootObjectId, entry }),
      });
  }

  setWithRightmostPathCache({ rootObjectId, entry }: {
    rootObjectId: string;
    entry: HizoFSDirectoryEntryDto;
  }): Promise<string> {
    return this.diagnostics === undefined
      ? this.index.setWithRightmostPathCache({ rootObjectId, entry })
      : this.diagnostics.measureAsync({
        phase: 'index_update',
        operation: async () => this.index.setWithRightmostPathCache({
          rootObjectId,
          entry,
        }),
      });
  }

  delete({ rootObjectId, name }: {
    rootObjectId: string;
    name: string;
  }): Promise<string> {
    return this.diagnostics === undefined
      ? this.index.delete({ rootObjectId, key: name })
      : this.diagnostics.measureAsync({
        phase: 'index_update',
        operation: async () => this.index.delete({ rootObjectId, key: name }),
      });
  }

  entries({ rootObjectId }: {
    rootObjectId: string;
  }): AsyncIterable<HizoFSDirectoryEntryDto> {
    return this.index.entries({ rootObjectId });
  }

  buildFromSortedEntries({ entries }: {
    entries: AsyncIterable<HizoFSDirectoryEntryDto> | Iterable<HizoFSDirectoryEntryDto>;
  }): Promise<string> {
    return this.diagnostics === undefined
      ? this.index.buildFromSortedEntries({ entries })
      : this.diagnostics.measureAsync({
        phase: 'index_build',
        operation: async () => this.index.buildFromSortedEntries({ entries }),
      });
  }

  validateStructure({ rootObjectId }: {
    rootObjectId: string;
  }): Promise<{
    readonly pageCount: number;
    readonly entryCount: number;
    readonly depth: number;
  }> {
    return this.index.validateStructure({ rootObjectId });
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
