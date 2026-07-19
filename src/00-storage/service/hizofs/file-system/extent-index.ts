import {
  HizoFSFileExtentPageSchemaDto,
  type HizoFSFileExtentDto,
  type HizoFSFileExtentPageDto,
} from "@/00-storage/00-dto/hizofs.dto";
import {
  PersistentHizoFSIndex,
  type PersistentIndexLeafLookupCache,
  type PersistentIndexPage,
  type PersistentIndexPageStore,
} from "./persistent-index";
import { compareHizoFSNumbers } from "./ordering";
import {
  assertHizoFSNonNegativeSafeInteger,
  assertHizoFSObjectId,
} from "./semantic-validation";
import type { HizoFSRecordStore } from "./record-store";
import type { HizoFSRuntimeDiagnostics } from "./diagnostics";

export type HizoFSExtentIndexLookupCache = PersistentIndexLeafLookupCache<
  number,
  HizoFSFileExtentDto
>;

class ExtentIndexPageStore implements PersistentIndexPageStore<
  number,
  HizoFSFileExtentDto
> {
  constructor({ recordStore }: { recordStore: HizoFSRecordStore }) {
    this.recordStore = recordStore;
  }

  private readonly recordStore: HizoFSRecordStore;

  async readPage({
    objectId,
  }: {
    objectId: string;
  }): Promise<PersistentIndexPage<number, HizoFSFileExtentDto>> {
    const { metadata } = await this.recordStore.read({
      objectId,
      expectedKind: "file_extent_page",
      schema: HizoFSFileExtentPageSchemaDto,
      binaryPayload: "forbidden",
    });
    assertPage({ page: metadata });
    switch (metadata.type) {
    case "leaf":
      return { type: "leaf", entries: metadata.extents };
    case "branch":
      return {
        type: "branch",
        children: metadata.children.map((child) => ({
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

  // TODO(hizofs): Encode consecutive chunk references as bounded extent runs
  // once segment placement is stable and benchmarked. Preserve 256 KiB random
  // access, sparse holes, reflink identity, and page-local corruption checks; a
  // run must never require loading or rewriting the complete file extent map.
  async writePage({
    page,
  }: {
    page: PersistentIndexPage<number, HizoFSFileExtentDto>;
  }): Promise<string> {
    const metadata: HizoFSFileExtentPageDto = (() => {
      switch (page.type) {
      case "leaf":
        return { type: "leaf", extents: page.entries };
      case "branch":
        return {
          type: "branch",
          children: page.children.map((child) => ({
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
      kind: "file_extent_page",
      metadata,
      binaryPayload: new Uint8Array(),
    });
  }
}

function assertPage({ page }: { page: HizoFSFileExtentPageDto }): void {
  switch (page.type) {
  case "leaf": {
    let previousChunkIndex: number | undefined;
    for (const extent of page.extents) {
      assertHizoFSNonNegativeSafeInteger({
        value: extent.chunkIndex,
        fieldName: "Extent chunkIndex",
      });
      assertHizoFSObjectId({
        value: extent.chunkObjectId,
        fieldName: "Extent chunkObjectId",
      });
      if (
        previousChunkIndex !== undefined &&
          previousChunkIndex >= extent.chunkIndex
      ) {
        throw new Error(
          "HizoFS extent index leaf entries must be strictly sorted",
        );
      }
      previousChunkIndex = extent.chunkIndex;
    }
    break;
  }
  case "branch": {
    if (page.children.length === 0) {
      throw new Error(
        "HizoFS extent index branch must contain at least one child",
      );
    }
    let previousUpperBound: number | undefined;
    for (const child of page.children) {
      assertHizoFSNonNegativeSafeInteger({
        value: child.upperBoundChunkIndex,
        fieldName: "Extent upperBoundChunkIndex",
      });
      assertHizoFSObjectId({
        value: child.childPageObjectId,
        fieldName: "Extent childPageObjectId",
      });
      if (
        previousUpperBound !== undefined &&
          previousUpperBound >= child.upperBoundChunkIndex
      ) {
        throw new Error(
          "HizoFS extent index branch bounds must be strictly sorted",
        );
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

export class HizoFSExtentIndex {
  constructor({
    recordStore,
    maxPageEntries,
    diagnostics,
  }: {
    recordStore: HizoFSRecordStore;
    maxPageEntries: number;
    diagnostics?: HizoFSRuntimeDiagnostics;
  }) {
    this.pageStore = new ExtentIndexPageStore({ recordStore });
    this.diagnostics = diagnostics;
    this.index = new PersistentHizoFSIndex({
      pageStore: this.pageStore,
      compare: compareHizoFSNumbers,
      getEntryKey: ({ entry }) => entry.chunkIndex,
      maxPageEntries,
    });
  }

  private readonly pageStore: ExtentIndexPageStore;
  private readonly diagnostics?: HizoFSRuntimeDiagnostics;
  private readonly index: PersistentHizoFSIndex<number, HizoFSFileExtentDto>;

  async visitReferences({
    rootObjectId,
    visitPageObjectId,
    visitChunkObjectId,
    visitedPageObjectIds,
  }: {
    rootObjectId: string;
    visitPageObjectId: ({ objectId }: { objectId: string }) => void;
    visitChunkObjectId: ({
      objectId,
      chunkIndex,
    }: {
      objectId: string;
      chunkIndex: number;
    }) => void;
    visitedPageObjectIds: Set<string> | undefined;
  }): Promise<void> {
    const completed = visitedPageObjectIds ?? new Set<string>();
    const visiting = new Set<string>();
    const seenInThisTraversal = new Set<string>();
    const visitPage = async ({
      objectId,
    }: {
      objectId: string;
    }): Promise<void> => {
      visitPageObjectId({ objectId });
      if (visiting.has(objectId)) {
        throw new Error("HizoFS extent index contains a page cycle");
      }
      if (seenInThisTraversal.has(objectId)) {
        throw new Error(
          "HizoFS extent index contains a duplicate page reference",
        );
      }
      seenInThisTraversal.add(objectId);
      if (completed.has(objectId)) return;

      visiting.add(objectId);
      try {
        const page = await this.pageStore.readPage({ objectId });
        switch (page.type) {
        case "leaf":
          for (const extent of page.entries) {
            visitChunkObjectId({
              objectId: extent.chunkObjectId,
              chunkIndex: extent.chunkIndex,
            });
          }
          break;
        case "branch":
          for (const child of page.children) {
            await visitPage({ objectId: child.childPageObjectId });
          }
          break;
        default: {
          const _ex: never = page;
          throw new Error(`Unhandled extent index page: ${String(_ex)}`);
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

  get({
    rootObjectId,
    chunkIndex,
  }: {
    rootObjectId: string;
    chunkIndex: number;
  }): Promise<HizoFSFileExtentDto | undefined> {
    return this.index.get({ rootObjectId, key: chunkIndex });
  }

  getWithLeafCache({
    rootObjectId,
    chunkIndex,
    cache,
  }: {
    rootObjectId: string;
    chunkIndex: number;
    cache: HizoFSExtentIndexLookupCache;
  }): Promise<HizoFSFileExtentDto | undefined> {
    return this.index.getWithLeafCache({
      rootObjectId,
      key: chunkIndex,
      cache,
    });
  }

  set({
    rootObjectId,
    extent,
  }: {
    rootObjectId: string;
    extent: HizoFSFileExtentDto;
  }): Promise<string> {
    return this.diagnostics === undefined
      ? this.index.set({ rootObjectId, entry: extent })
      : this.diagnostics.measureAsync({
        phase: 'index_update',
        operation: async () => this.index.set({ rootObjectId, entry: extent }),
      });
  }

  delete({
    rootObjectId,
    chunkIndex,
  }: {
    rootObjectId: string;
    chunkIndex: number;
  }): Promise<string> {
    return this.diagnostics === undefined
      ? this.index.delete({ rootObjectId, key: chunkIndex })
      : this.diagnostics.measureAsync({
        phase: 'index_update',
        operation: async () => this.index.delete({ rootObjectId, key: chunkIndex }),
      });
  }

  truncateAtOrAfter({
    rootObjectId,
    chunkIndex,
  }: {
    rootObjectId: string;
    chunkIndex: number;
  }): Promise<string> {
    return this.diagnostics === undefined
      ? this.index.truncateAtOrAfter({ rootObjectId, key: chunkIndex })
      : this.diagnostics.measureAsync({
        phase: 'index_update',
        operation: async () => this.index.truncateAtOrAfter({ rootObjectId, key: chunkIndex }),
      });
  }

  buildFromSortedExtents({ extents }: {
    extents: AsyncIterable<HizoFSFileExtentDto> | Iterable<HizoFSFileExtentDto>;
  }): Promise<string> {
    return this.diagnostics === undefined
      ? this.index.buildFromSortedEntries({ entries: extents })
      : this.diagnostics.measureAsync({
        phase: 'index_build',
        operation: async () => this.index.buildFromSortedEntries({ entries: extents }),
      });
  }

  validateStructure({
    rootObjectId,
  }: {
    rootObjectId: string;
  }): Promise<{
    readonly pageCount: number;
    readonly entryCount: number;
    readonly depth: number;
  }> {
    return this.index.validateStructure({ rootObjectId });
  }

  entries({
    rootObjectId,
  }: {
    rootObjectId: string;
  }): AsyncIterable<HizoFSFileExtentDto> {
    return this.index.entries({ rootObjectId });
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
