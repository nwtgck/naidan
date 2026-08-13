import { COMMON_PAGE_HEADER_SIZE } from "@/00-storage/service/hizofs/00-format";
import { describe, expect, it } from "vitest";
import {
  CanonicalBTreeWriter,
  type ImmutableBTreeMutation,
} from "@/00-storage/service/hizofs/indexes/canonical-btree-writer";
import {
  ImmutableBTreeReader,
  type ImmutableBTreePage,
} from "@/00-storage/service/hizofs/indexes/immutable-btree-reader";
import type { ImmutableBTreeDiagnosticsObservation } from "@/00-storage/service/hizofs/indexes/diagnostics-hooks";

type Entry = Readonly<{ key: number; payload: string }>;
type Page = ImmutableBTreePage<number, Entry, string>;

class MemoryPageStore {
  readonly pages = new Map<string, Page>();
  readonly writes: Readonly<{ isRoot: boolean; page: Page }>[] = [];
  private nextReference = 1;

  async readPage({ isRoot: _isRoot, reference }: { isRoot: boolean; reference: string }): Promise<Page> {
    const page = this.pages.get(reference);
    if (page === undefined) throw new Error(`missing page ${reference}`);
    return page;
  }

  async writePage({ isRoot, page }: { isRoot: boolean; page: Page }): Promise<string> {
    const reference = `page-${this.nextReference}`;
    this.nextReference += 1;
    this.pages.set(reference, page);
    this.writes.push({ isRoot, page });
    return reference;
  }
}

function entrySize({ entry }: { entry: Entry }): number {
  return 4 + entry.payload.length;
}

function setup({ maximumPageByteLength = 24, maximumLeafEntryCount, maximumRootLeafEntryCount }: {
  maximumPageByteLength?: number;
  maximumLeafEntryCount?: number;
  maximumRootLeafEntryCount?: number;
} = {}) {
  const store = new MemoryPageStore();
  const writer = new CanonicalBTreeWriter<number, Entry, string>({
    compareKeys: ({ left, right }) => left - right,
    encodedBranchChildByteLength: () => 8,
    encodedLeafEntryByteLength: entrySize,
    entriesEqual: ({ left, right }) => left.key === right.key && left.payload === right.payload,
    getEntryKey: ({ entry }) => entry.key,
    maximumPageByteLength,
    ...(maximumLeafEntryCount === undefined ? {} : { maximumLeafEntryCount }),
    ...(maximumRootLeafEntryCount === undefined ? {} : { maximumRootLeafEntryCount }),
    pageStore: store,
  });
  const reader = new ImmutableBTreeReader<number, Entry, string>({
    compareKeys: ({ left, right }) => left - right,
    getEntryKey: ({ entry }) => entry.key,
    pageReader: ({ isRoot, reference }) => store.readPage({ isRoot, reference }),
    referenceIdentity: ({ reference }) => reference,
  });
  return { reader, store, writer };
}

async function collect({ reader, rootReference }: {
  reader: ImmutableBTreeReader<number, Entry, string>;
  rootReference: string;
}): Promise<readonly Entry[]> {
  const entries: Entry[] = [];
  for await (const entry of reader.entries({ rootReference })) entries.push(entry);
  return entries;
}

describe("canonical immutable B-tree writer", () => {
  it("rejects an invalid claimed loaded page byte length before rewriting", async () => {
    const page: Page = { entries: [{ key: 1, payload: "x" }], level: 0, type: "leaf" };
    let writes = 0;
    const writer = new CanonicalBTreeWriter<number, Entry, string>({
      compareKeys: ({ left, right }) => left - right,
      encodedBranchChildByteLength: () => 8,
      encodedLeafEntryByteLength: entrySize,
      entriesEqual: ({ left, right }) => left.key === right.key && left.payload === right.payload,
      getEntryKey: ({ entry }) => entry.key,
      maximumPageByteLength: 16_384,
      pageStore: {
        readPage: async () => page,
        readPageForUpdate: async () => ({
          encodedByteLength: COMMON_PAGE_HEADER_SIZE - 1,
          localStructureValidated: true as const,
          page,
        }),
        writePage: async () => {
          writes += 1;
          return "next";
        },
      },
    });

    await expect(writer.applyChanges({
      changes: [{ entry: { key: 1, payload: "updated" }, type: "set" }],
      rootReference: "root",
    })).rejects.toThrow("validated B-tree page byte length");
    expect(writes).toBe(0);
  });

  it("does not repeat local ordering validation for an authenticated update page", async () => {
    const entries = Array.from({ length: 64 }, (_, key): Entry => ({ key, payload: "x" }));
    const page: Page = { entries, level: 0, type: "leaf" };
    let comparisonCount = 0;
    const writer = new CanonicalBTreeWriter<number, Entry, string>({
      compareKeys: ({ left, right }) => {
        comparisonCount += 1;
        return left - right;
      },
      encodedBranchChildByteLength: () => 8,
      encodedLeafEntryByteLength: entrySize,
      entriesEqual: ({ left, right }) => left.key === right.key && left.payload === right.payload,
      getEntryKey: ({ entry }) => entry.key,
      maximumLeafEntryCount: 128,
      maximumPageByteLength: 16_384,
      maximumRootLeafEntryCount: 128,
      pageStore: {
        readPage: async () => page,
        readPageForUpdate: async () => ({
          encodedByteLength: COMMON_PAGE_HEADER_SIZE + entries.reduce((total, entry) => total + entrySize({ entry }), 0),
          localStructureValidated: true as const,
          page,
        }),
        writePage: async () => "next",
      },
    });

    await writer.applyChanges({
      changes: [{ entry: { key: 62, payload: "updated" }, type: "set" }],
      rootReference: "root",
    });

    expect(comparisonCount).toBeLessThan(25);
  });

  it("reuses exact loaded page byte length for ordinary no-split leaf updates", async () => {
    const entries = Array.from({ length: 32 }, (_, key): Entry => ({ key, payload: "x" }));
    const page: Page = { entries, level: 0, type: "leaf" };
    let sizeCalls = 0;
    let written: Page | undefined;
    const pageStore = {
      readPage: async () => page,
      readPageForUpdate: async () => ({
        encodedByteLength: COMMON_PAGE_HEADER_SIZE + entries.reduce((total, entry) => total + entrySize({ entry }), 0),
        localStructureValidated: true as const,
        page,
      }),
      writePage: async ({ page: next }: { isRoot: boolean; page: Page }) => {
        written = next;
        return "next";
      },
    };
    const writer = new CanonicalBTreeWriter<number, Entry, string>({
      compareKeys: ({ left, right }) => left - right,
      encodedBranchChildByteLength: () => 8,
      encodedLeafEntryByteLength: ({ entry }) => {
        sizeCalls += 1;
        return entrySize({ entry });
      },
      entriesEqual: ({ left, right }) => left.key === right.key && left.payload === right.payload,
      getEntryKey: ({ entry }) => entry.key,
      maximumLeafEntryCount: 64,
      maximumPageByteLength: 16_384,
      maximumRootLeafEntryCount: 64,
      pageStore,
    });

    await writer.applyChanges({
      changes: [{ entry: { key: 30, payload: "updated" }, type: "set" }],
      rootReference: "root",
    });

    expect(written).toMatchObject({ type: "leaf" });
    expect(sizeCalls).toBeLessThanOrEqual(2);
  });

  it("reuses exact loaded page byte length for ordinary no-split branch rewrites", async () => {
    const pages = new Map<string, Page>();
    const children = Array.from({ length: 32 }, (_, key) => {
      const reference = `leaf-${key}`;
      pages.set(reference, { entries: [{ key, payload: "x" }], level: 0, type: "leaf" });
      return { childPageReference: reference, upperBound: key };
    });
    pages.set("root", { children, level: 1, type: "branch" });
    let branchSizeCalls = 0;
    let nextReference = 0;
    const pageStore = {
      readPage: async ({ reference }: { isRoot: boolean; reference: string }) => {
        const page = pages.get(reference);
        if (page === undefined) throw new Error(`missing page ${reference}`);
        return page;
      },
      readPageForUpdate: async ({ reference }: { isRoot: boolean; reference: string }) => {
        const page = pages.get(reference);
        if (page === undefined) throw new Error(`missing page ${reference}`);
        return {
          encodedByteLength: page.type === "leaf"
            ? COMMON_PAGE_HEADER_SIZE + page.entries.reduce((total, entry) => total + entrySize({ entry }), 0)
            : COMMON_PAGE_HEADER_SIZE + page.children.length * 8,
          localStructureValidated: true as const,
          page,
        };
      },
      writePage: async ({ page }: { isRoot: boolean; page: Page }) => {
        const reference = `next-${nextReference}`;
        nextReference += 1;
        pages.set(reference, page);
        return reference;
      },
    };
    const writer = new CanonicalBTreeWriter<number, Entry, string>({
      compareKeys: ({ left, right }) => left - right,
      encodedBranchChildByteLength: () => {
        branchSizeCalls += 1;
        return 8;
      },
      encodedLeafEntryByteLength: entrySize,
      entriesEqual: ({ left, right }) => left.key === right.key && left.payload === right.payload,
      getEntryKey: ({ entry }) => entry.key,
      maximumLeafEntryCount: 64,
      maximumPageByteLength: 16_384,
      maximumRootLeafEntryCount: 64,
      pageStore,
    });

    const root = await writer.applyChanges({
      changes: [{ entry: { key: 30, payload: "updated" }, type: "set" }],
      rootReference: "root",
    });

    const rewritten = pages.get(root);
    expect(rewritten).toMatchObject({ type: "branch" });
    expect(branchSizeCalls).toBeLessThanOrEqual(2);
  });

  it("rejects duplicate keys in the two-mutation fast path", async () => {
    const { writer } = setup({ maximumPageByteLength: 16_384 });
    const root = await writer.createEmpty();

    await expect(writer.applyChanges({
      changes: [
        { entry: { key: 7, payload: "first" }, type: "set" },
        { entry: { key: 7, payload: "second" }, type: "set" },
      ],
      rootReference: root,
    })).rejects.toThrow("one B-tree mutation batch may change each key only once");
  });

  it("reuses exact loaded byte length across ordinary few-key leaf mutations", async () => {
    const entries = Array.from({ length: 64 }, (_, key): Entry => ({ key, payload: "x" }));
    const page: Page = { entries, level: 0, type: "leaf" };
    let sizeCalls = 0;
    let written: Page | undefined;
    const pageStore = {
      readPage: async () => page,
      readPageForUpdate: async () => ({
        encodedByteLength: COMMON_PAGE_HEADER_SIZE + entries.reduce((total, entry) => total + entrySize({ entry }), 0),
        localStructureValidated: true as const,
        page,
      }),
      writePage: async ({ page: next }: { isRoot: boolean; page: Page }) => {
        written = next;
        return "next";
      },
    };
    const writer = new CanonicalBTreeWriter<number, Entry, string>({
      compareKeys: ({ left, right }) => left - right,
      encodedBranchChildByteLength: () => 8,
      encodedLeafEntryByteLength: ({ entry }) => {
        sizeCalls += 1;
        return entrySize({ entry });
      },
      entriesEqual: ({ left, right }) => left.key === right.key && left.payload === right.payload,
      getEntryKey: ({ entry }) => entry.key,
      maximumLeafEntryCount: 128,
      maximumPageByteLength: 16_384,
      maximumRootLeafEntryCount: 128,
      pageStore,
    });

    await writer.applyChanges({
      changes: [
        { entry: { key: 30, payload: "updated-30" }, type: "set" },
        { entry: { key: 64, payload: "inserted-64" }, type: "set" },
      ],
      rootReference: "root",
    });

    expect(written).toMatchObject({ type: "leaf" });
    if (written?.type !== "leaf") throw new Error("expected written leaf");
    expect(written.entries).toHaveLength(65);
    expect(written.entries.at(-1)).toEqual({ key: 64, payload: "inserted-64" });
    expect(sizeCalls).toBeLessThanOrEqual(4);
  });

  it("uses binary search for the ordinary single-key leaf mutation path", async () => {
    const store = new MemoryPageStore();
    let comparisonCount = 0;
    const writer = new CanonicalBTreeWriter<number, Entry, string>({
      compareKeys: ({ left, right }) => {
        comparisonCount += 1;
        return left - right;
      },
      encodedBranchChildByteLength: () => 8,
      encodedLeafEntryByteLength: entrySize,
      entriesEqual: ({ left, right }) => left.key === right.key && left.payload === right.payload,
      getEntryKey: ({ entry }) => entry.key,
      maximumLeafEntryCount: 128,
      maximumPageByteLength: 16_384,
      maximumRootLeafEntryCount: 128,
      pageStore: store,
    });
    let root = await writer.createEmpty();
    root = await writer.applyChanges({
      changes: Array.from({ length: 64 }, (_, key): ImmutableBTreeMutation<number, Entry> => ({
        entry: { key, payload: "x" },
        type: "set",
      })),
      rootReference: root,
    });

    comparisonCount = 0;
    root = await writer.applyChanges({
      changes: [{ entry: { key: 62, payload: "updated" }, type: "set" }],
      rootReference: root,
    });

    expect(comparisonCount).toBeLessThan(90);
    const rootPage = await store.readPage({ isRoot: true, reference: root });
    expect(rootPage.type).toBe("leaf");
    if (rootPage.type !== "leaf") throw new Error("expected one root leaf");
    expect(rootPage.entries[62]).toEqual({ key: 62, payload: "updated" });
  });

  it("batches sorted changes and uses deterministic encoded-byte-balanced splits", async () => {
    const { reader, store, writer } = setup();
    const empty = await writer.createEmpty();
    store.writes.length = 0;
    const root = await writer.applyChanges({
      changes: [
        { entry: { key: 3, payload: "cccccc" }, type: "set" },
        { entry: { key: 1, payload: "aa" }, type: "set" },
        { entry: { key: 2, payload: "bbbb" }, type: "set" },
      ],
      rootReference: empty,
    });

    expect(await collect({ reader, rootReference: root })).toEqual([
      { key: 1, payload: "aa" },
      { key: 2, payload: "bbbb" },
      { key: 3, payload: "cccccc" },
    ]);
    expect(store.writes.map(({ page }) => page.type === "leaf" ? page.entries.map((entry) => entry.key) : page.children.map((child) => child.upperBound))).toEqual([
      [1, 2],
      [3],
      [2, 3],
    ]);
  });

  it("bounds leaf entries without imposing the leaf packing target on branch fanout", async () => {
    const { reader, store, writer } = setup({ maximumPageByteLength: 1_024, maximumLeafEntryCount: 3 });
    let root = await writer.createEmpty();
    root = await writer.applyChanges({
      changes: Array.from({ length: 10 }, (_, key): ImmutableBTreeMutation<number, Entry> => ({
        entry: { key, payload: "x" },
        type: "set",
      })),
      rootReference: root,
    });

    expect(await collect({ reader, rootReference: root })).toHaveLength(10);
    for (const { page } of store.writes) {
      if (page.type === "leaf") expect(page.entries.length).toBeLessThanOrEqual(3);
    }
    const rootPage = await store.readPage({ isRoot: true, reference: root });
    expect(rootPage.type).toBe("branch");
    if (rootPage.type !== "branch") throw new Error("expected high-fanout branch root");
    expect(rootPage.level).toBe(1);
    expect(rootPage.children.length).toBeGreaterThan(3);
  });

  it("keeps a larger root leaf but uses the smaller child limit after branching", async () => {
    const { reader, store, writer } = setup({
      maximumLeafEntryCount: 3,
      maximumPageByteLength: 1_024,
      maximumRootLeafEntryCount: 6,
    });
    let root = await writer.createEmpty();
    root = await writer.applyChanges({
      changes: Array.from({ length: 6 }, (_, key): ImmutableBTreeMutation<number, Entry> => ({
        entry: { key, payload: "x" },
        type: "set",
      })),
      rootReference: root,
    });
    const sixEntryRoot = await store.readPage({ isRoot: true, reference: root });
    expect(sixEntryRoot).toMatchObject({ level: 0, type: "leaf" });
    if (sixEntryRoot.type !== "leaf") throw new Error("expected root leaf below explicit root limit");
    expect(sixEntryRoot.entries).toHaveLength(6);

    store.writes.length = 0;
    root = await writer.applyChanges({
      changes: [{ entry: { key: 6, payload: "x" }, type: "set" }],
      rootReference: root,
    });
    expect(await collect({ reader, rootReference: root })).toHaveLength(7);
    const splitRoot = await store.readPage({ isRoot: true, reference: root });
    expect(splitRoot).toMatchObject({ level: 1, type: "branch" });
    const nonRootLeaves = store.writes.filter(({ isRoot, page }) => !isRoot && page.type === "leaf");
    expect(nonRootLeaves.length).toBeGreaterThan(1);
    expect(nonRootLeaves.every(({ page }) => page.type === "leaf" && page.entries.length <= 3)).toBe(true);
  });

  it("rejects a root-leaf limit smaller than the child-leaf limit", () => {
    const store = new MemoryPageStore();
    expect(() => new CanonicalBTreeWriter<number, Entry, string>({
      compareKeys: ({ left, right }) => left - right,
      encodedBranchChildByteLength: () => 8,
      encodedLeafEntryByteLength: entrySize,
      getEntryKey: ({ entry }) => entry.key,
      maximumLeafEntryCount: 4,
      maximumPageByteLength: 1_024,
      maximumRootLeafEntryCount: 3,
      pageStore: store,
    })).toThrow("no smaller than the leaf limit");
  });

  it("rejects a non-positive leaf entry packing limit", () => {
    const store = new MemoryPageStore();
    expect(() => new CanonicalBTreeWriter<number, Entry, string>({
      compareKeys: ({ left, right }) => left - right,
      encodedBranchChildByteLength: () => 8,
      encodedLeafEntryByteLength: entrySize,
      getEntryKey: ({ entry }) => entry.key,
      maximumPageByteLength: 1_024,
      maximumLeafEntryCount: 0,
      pageStore: store,
    })).toThrow("positive safe integer");
  });

  it("removes empty children, collapses a single-child root, and does not eagerly merge underfilled siblings", async () => {
    const { reader, store, writer } = setup({ maximumPageByteLength: 20 });
    let root = await writer.createEmpty();
    root = await writer.applyChanges({
      changes: [1, 2, 3, 4].map((key): ImmutableBTreeMutation<number, Entry> => ({
        entry: { key, payload: "xxxx" },
        type: "set",
      })),
      rootReference: root,
    });
    const splitRoot = root;

    store.writes.length = 0;
    root = await writer.applyChanges({
      changes: [{ key: 1, type: "delete" }],
      rootReference: root,
    });
    const pageAfterOneDelete = await store.readPage({ isRoot: true, reference: root });
    expect(pageAfterOneDelete.type).toBe("branch");
    if (pageAfterOneDelete.type !== "branch") throw new Error("expected branch root");
    expect(pageAfterOneDelete.children).toHaveLength(2);
    expect(store.writes).toHaveLength(2);
    expect(root).not.toBe(splitRoot);

    root = await writer.applyChanges({
      changes: [{ key: 2, type: "delete" }],
      rootReference: root,
    });
    expect(await collect({ reader, rootReference: root })).toEqual([
      { key: 3, payload: "xxxx" },
      { key: 4, payload: "xxxx" },
    ]);
    const collapsed = await store.readPage({ isRoot: true, reference: root });
    expect(collapsed.type).toBe("leaf");
  });

  it("does not rewrite the tree for no-op deletes or byte-identical sets", async () => {
    const { store, writer } = setup();
    let root = await writer.createEmpty();
    root = await writer.applyChanges({
      changes: [{ entry: { key: 1, payload: "same" }, type: "set" }],
      rootReference: root,
    });
    store.writes.length = 0;
    const unchanged = await writer.applyChanges({
      changes: [
        { key: 999, type: "delete" },
        { entry: { key: 1, payload: "same" }, type: "set" },
      ],
      rootReference: root,
    });
    expect(unchanged).toBe(root);
    expect(store.writes).toEqual([]);
  });

  it("measures each leaf item once while choosing multi-page split boundaries", async () => {
    const store = new MemoryPageStore();
    let measurementCount = 0;
    const writer = new CanonicalBTreeWriter<number, Entry, string>({
      compareKeys: ({ left, right }: { left: number; right: number }) => left - right,
      encodedBranchChildByteLength: () => 8,
      encodedLeafEntryByteLength: ({ entry }: { entry: Entry }) => {
        measurementCount += 1;
        return entrySize({ entry });
      },
      getEntryKey: ({ entry }: { entry: Entry }) => entry.key,
      maximumPageByteLength: 40,
      pageStore: store,
    });
    const empty = await writer.createEmpty();
    await writer.applyChanges({
      changes: Array.from({ length: 200 }, (_, key): ImmutableBTreeMutation<number, Entry> => ({
        entry: { key, payload: "xxxx" },
        type: "set",
      })),
      rootReference: empty,
    });
    expect(measurementCount).toBe(200);
  });

  it("reports one owner operation without exposing B+tree values or double-counting empty-root rebuilds", async () => {
    const observations: ImmutableBTreeDiagnosticsObservation[] = [];
    const store = Object.assign(new MemoryPageStore(), {
      operationDiagnostics: {
        operation: "update" as const,
        port: {
          recordIndexOperation: (observation: (typeof observations)[number]) => {
            observations.push(observation);
          },
        },
      },
    });
    const writer = new CanonicalBTreeWriter<number, Entry, string>({
      compareKeys: ({ left, right }) => left - right,
      encodedBranchChildByteLength: () => 8,
      encodedLeafEntryByteLength: entrySize,
      entriesEqual: ({ left, right }) => left.key === right.key && left.payload === right.payload,
      getEntryKey: ({ entry }) => entry.key,
      maximumPageByteLength: 24,
      pageStore: store,
    });

    let root = await writer.createEmpty();
    root = await writer.applyChanges({
      changes: [{ entry: { key: 1, payload: "value" }, type: "set" }],
      rootReference: root,
    });
    await writer.applyChanges({ changes: [{ key: 1, type: "delete" }], rootReference: root });

    expect(observations.map(({ operation }) => operation)).toEqual(["build", "update", "update"]);
    expect(observations.every(({ durationMs }) => Number.isFinite(durationMs) && durationMs >= 0)).toBe(true);
    expect(observations.map(({ structural }) => structural)).toEqual([
      {
        inputMutations: 0,
        maximumPageLevel: 0,
        pageReads: 0,
        pageWrites: 1,
        rootCollapses: 0,
        splitOperations: 0,
        splitOutputPages: 0,
        unchangedPageReuses: 0,
      },
      {
        inputMutations: 1,
        maximumPageLevel: 0,
        pageReads: 1,
        pageWrites: 1,
        rootCollapses: 0,
        splitOperations: 0,
        splitOutputPages: 0,
        unchangedPageReuses: 0,
      },
      {
        inputMutations: 1,
        maximumPageLevel: 0,
        pageReads: 1,
        pageWrites: 1,
        rootCollapses: 0,
        splitOperations: 0,
        splitOutputPages: 0,
        unchangedPageReuses: 0,
      },
    ]);
    expect(Object.keys(observations[0] ?? {})).toEqual(["durationMs", "operation", "structural"]);
  });

  it("passes root context to the page store for empty roots and split roots", async () => {
    const { store, writer } = setup({ maximumPageByteLength: 20 });
    let root = await writer.createEmpty();
    expect(store.writes.at(-1)).toMatchObject({ isRoot: true, page: { type: "leaf" } });

    store.writes.length = 0;
    root = await writer.applyChanges({
      changes: [1, 2, 3, 4].map((key): ImmutableBTreeMutation<number, Entry> => ({
        entry: { key, payload: "xxxx" },
        type: "set",
      })),
      rootReference: root,
    });
    expect(root).toBeDefined();
    expect(store.writes.filter(({ isRoot }) => isRoot)).toHaveLength(1);
    expect(store.writes.at(-1)?.isRoot).toBe(true);
    expect(store.writes.slice(0, -1).every(({ isRoot }) => !isRoot)).toBe(true);
  });

  it("matches a reference Map across deterministic mixed count-bounded mutation batches", async () => {
    const { reader, writer } = setup({ maximumPageByteLength: 1_024, maximumLeafEntryCount: 5 });
    let root = await writer.createEmpty();
    const model = new Map<number, Entry>();
    let state = 0x12345678;
    const next = (): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state;
    };

    for (let round = 0; round < 40; round += 1) {
      const changes: ImmutableBTreeMutation<number, Entry>[] = [];
      const used = new Set<number>();
      while (changes.length < 5) {
        const key = next() % 30;
        if (used.has(key)) continue;
        used.add(key);
        if ((next() & 3) === 0) {
          changes.push({ key, type: "delete" });
          model.delete(key);
        } else {
          const entry = { key, payload: "x".repeat(1 + (next() % 9)) };
          changes.push({ entry, type: "set" });
          model.set(key, entry);
        }
      }
      root = await writer.applyChanges({ changes, rootReference: root });
      const sortedModel = [...model.values()].sort((left, right) => left.key - right.key);
      expect(await collect({ reader, rootReference: root })).toEqual(sortedModel);
      for (const key of [0, 7, 19, 31]) {
        const expectedFloor = sortedModel.findLast((entry) => entry.key <= key);
        await expect(reader.seekFloor({ key, rootReference: root })).resolves.toEqual(expectedFloor);
      }
      await expect(reader.validateStructure({ rootReference: root })).resolves.toMatchObject({ entryCount: model.size });
    }
  });
});
