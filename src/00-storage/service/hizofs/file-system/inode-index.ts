import {
  HizoFSInodeIndexPageSchemaDto,
  type HizoFSInodeIndexPageDto,
} from "@/00-storage/00-dto/hizofs.dto";
import { validateHizoFSStableId } from "@/00-storage/service/hizofs/id";
import {
  PersistentHizoFSIndex,
  type PersistentIndexPage,
  type PersistentIndexPageStore,
} from "./persistent-index";
import { compareHizoFSStrings } from "./ordering";
import { assertHizoFSObjectId } from "./semantic-validation";
import type { HizoFSRecordStore } from "./record-store";

export type HizoFSInodeIndexEntry = {
  readonly nodeId: string;
  readonly inodeObjectId: string;
};

class InodeIndexPageStore implements PersistentIndexPageStore<
  string,
  HizoFSInodeIndexEntry
> {
  constructor({ recordStore }: { recordStore: HizoFSRecordStore }) {
    this.recordStore = recordStore;
  }

  private readonly recordStore: HizoFSRecordStore;

  async readPage({
    objectId,
  }: {
    objectId: string;
  }): Promise<PersistentIndexPage<string, HizoFSInodeIndexEntry>> {
    const { metadata } = await this.recordStore.read({
      objectId,
      expectedKind: "inode_index_page",
      schema: HizoFSInodeIndexPageSchemaDto,
      binaryPayload: "forbidden",
    });
    assertPage({ page: metadata });
    switch (metadata.type) {
    case "leaf":
      return { type: "leaf", entries: metadata.entries };
    case "branch":
      return {
        type: "branch",
        children: metadata.children.map((child) => ({
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

  async writePage({
    page,
  }: {
    page: PersistentIndexPage<string, HizoFSInodeIndexEntry>;
  }): Promise<string> {
    const metadata: HizoFSInodeIndexPageDto = (() => {
      switch (page.type) {
      case "leaf":
        return { type: "leaf", entries: page.entries };
      case "branch":
        return {
          type: "branch",
          children: page.children.map((child) => ({
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
      kind: "inode_index_page",
      metadata,
      binaryPayload: new Uint8Array(),
    });
  }
}

function assertPage({ page }: { page: HizoFSInodeIndexPageDto }): void {
  switch (page.type) {
  case "leaf": {
    let previousNodeId: string | undefined;
    for (const entry of page.entries) {
      validateHizoFSStableId({
        value: entry.nodeId,
        fieldName: "Inode index nodeId",
      });
      assertHizoFSObjectId({
        value: entry.inodeObjectId,
        fieldName: "Inode index inodeObjectId",
      });
      if (
        previousNodeId !== undefined &&
          compareHizoFSStrings({ left: previousNodeId, right: entry.nodeId }) >=
            0
      ) {
        throw new Error(
          "HizoFS inode index leaf entries must be strictly sorted",
        );
      }
      previousNodeId = entry.nodeId;
    }
    break;
  }
  case "branch": {
    if (page.children.length === 0) {
      throw new Error(
        "HizoFS inode index branch must contain at least one child",
      );
    }
    let previousUpperBound: string | undefined;
    for (const child of page.children) {
      validateHizoFSStableId({
        value: child.upperBoundNodeId,
        fieldName: "Inode index upperBoundNodeId",
      });
      assertHizoFSObjectId({
        value: child.childPageObjectId,
        fieldName: "Inode index childPageObjectId",
      });
      if (
        previousUpperBound !== undefined &&
          compareHizoFSStrings({
            left: previousUpperBound,
            right: child.upperBoundNodeId,
          }) >= 0
      ) {
        throw new Error(
          "HizoFS inode index branch bounds must be strictly sorted",
        );
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

export class HizoFSInodeIndex {
  constructor({
    recordStore,
    maxPageEntries,
  }: {
    recordStore: HizoFSRecordStore;
    maxPageEntries: number;
  }) {
    this.pageStore = new InodeIndexPageStore({ recordStore });
    this.index = new PersistentHizoFSIndex({
      pageStore: this.pageStore,
      compare: compareHizoFSStrings,
      getEntryKey: ({ entry }) => entry.nodeId,
      maxPageEntries,
    });
  }

  private readonly pageStore: InodeIndexPageStore;
  private readonly index: PersistentHizoFSIndex<string, HizoFSInodeIndexEntry>;

  async visitReferences({
    rootObjectId,
    visitPageObjectId,
    visitInodeObjectId,
    visitedPageObjectIds,
  }: {
    rootObjectId: string;
    visitPageObjectId: ({ objectId }: { objectId: string }) => void;
    visitInodeObjectId: ({
      objectId,
      nodeId,
    }: {
      objectId: string;
      nodeId: string;
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
        throw new Error("HizoFS inode index contains a page cycle");
      }
      if (seenInThisTraversal.has(objectId)) {
        throw new Error(
          "HizoFS inode index contains a duplicate page reference",
        );
      }
      seenInThisTraversal.add(objectId);
      if (completed.has(objectId)) return;

      visiting.add(objectId);
      try {
        const page = await this.pageStore.readPage({ objectId });
        switch (page.type) {
        case "leaf":
          for (const entry of page.entries) {
            visitInodeObjectId({
              objectId: entry.inodeObjectId,
              nodeId: entry.nodeId,
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
          throw new Error(`Unhandled inode index page: ${String(_ex)}`);
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
    return this.index.createEmpty();
  }

  get({
    rootObjectId,
    nodeId,
  }: {
    rootObjectId: string;
    nodeId: string;
  }): Promise<HizoFSInodeIndexEntry | undefined> {
    return this.index.get({ rootObjectId, key: nodeId });
  }

  set({
    rootObjectId,
    entry,
  }: {
    rootObjectId: string;
    entry: HizoFSInodeIndexEntry;
  }): Promise<string> {
    return this.index.set({ rootObjectId, entry });
  }

  setMany({
    rootObjectId,
    entries,
  }: {
    rootObjectId: string;
    entries: readonly HizoFSInodeIndexEntry[];
  }): Promise<string> {
    return this.index.setMany({ rootObjectId, entries });
  }

  delete({
    rootObjectId,
    nodeId,
  }: {
    rootObjectId: string;
    nodeId: string;
  }): Promise<string> {
    return this.index.delete({ rootObjectId, key: nodeId });
  }

  deleteMany({
    rootObjectId,
    nodeIds,
  }: {
    rootObjectId: string;
    nodeIds: ReadonlySet<string>;
  }): Promise<string> {
    return this.index.deleteMany({ rootObjectId, keys: nodeIds });
  }

  buildFromSortedEntries({ entries }: {
    entries: AsyncIterable<HizoFSInodeIndexEntry> | Iterable<HizoFSInodeIndexEntry>;
  }): Promise<string> {
    return this.index.buildFromSortedEntries({ entries });
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
  }): AsyncIterable<HizoFSInodeIndexEntry> {
    return this.index.entries({ rootObjectId });
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
