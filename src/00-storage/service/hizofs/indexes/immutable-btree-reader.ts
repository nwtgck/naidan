import {
  assertLocallyValidImmutableBTreePage,
  findBranchChildIndex,
  findLeafEntryIndex,
  immutableBTreePageMaximumKey,
  type CompareImmutableBTreeKeys,
  type GetImmutableBTreeEntryKey,
  type ImmutableBTreeBranchPage,
  type ImmutableBTreePage,
} from "@/00-storage/service/hizofs/indexes/ordering";

export type {
  ImmutableBTreeBranchChild,
  ImmutableBTreeBranchPage,
  ImmutableBTreeLeafPage,
  ImmutableBTreePage,
} from "@/00-storage/service/hizofs/indexes/ordering";

export type ImmutableBTreePageReader<TKey, TEntry, TReference> = ({ isRoot, reference }: Readonly<{
  isRoot: boolean;
  reference: TReference;
}>) => Promise<ImmutableBTreePage<TKey, TEntry, TReference>>;

type BranchCursorFrame<TKey, TReference> = Readonly<{
  page: ImmutableBTreeBranchPage<TKey, TReference>;
  pageReferenceIdentity: string;
  selectedChildIndex: number;
}>;

type LeafCursor<TKey, TEntry, TReference> = Readonly<{
  entryIndex: number;
  leaf: Readonly<{ entries: readonly TEntry[]; level: 0; type: "leaf" }>;
  leafReferenceIdentity: string;
  stack: readonly BranchCursorFrame<TKey, TReference>[];
}>;

type PageReadExpectation<TKey> = Readonly<{
  expectedLevel?: number;
  expectedUpperBound?: TKey;
  isRoot: boolean;
}>;

export class ImmutableBTreeReader<TKey, TEntry, TReference> {
  readonly #compareKeys: CompareImmutableBTreeKeys<TKey>;
  readonly #getEntryKey: GetImmutableBTreeEntryKey<TKey, TEntry>;
  readonly #pageReader: ImmutableBTreePageReader<TKey, TEntry, TReference>;
  readonly #referenceIdentity: ({ reference }: { reference: TReference }) => string;

  constructor({ compareKeys, getEntryKey, pageReader, referenceIdentity }: {
    compareKeys: CompareImmutableBTreeKeys<TKey>;
    getEntryKey: GetImmutableBTreeEntryKey<TKey, TEntry>;
    pageReader: ImmutableBTreePageReader<TKey, TEntry, TReference>;
    referenceIdentity: ({ reference }: { reference: TReference }) => string;
  }) {
    this.#compareKeys = compareKeys;
    this.#getEntryKey = getEntryKey;
    this.#pageReader = pageReader;
    this.#referenceIdentity = referenceIdentity;
  }

  async #readPage({ expectation, reference, visited }: {
    expectation: PageReadExpectation<TKey>;
    reference: TReference;
    visited: Set<string>;
  }): Promise<ImmutableBTreePage<TKey, TEntry, TReference>> {
    const identity = this.#referenceIdentity({ reference });
    if (visited.has(identity)) throw new TypeError("B-tree contains a cycle or duplicate page reference");
    visited.add(identity);
    const page = await this.#pageReader({ isRoot: expectation.isRoot, reference });
    assertLocallyValidImmutableBTreePage({
      compareKeys: this.#compareKeys,
      getEntryKey: this.#getEntryKey,
      isRoot: expectation.isRoot,
      page,
    });
    if (expectation.expectedLevel !== undefined && page.level !== expectation.expectedLevel) {
      throw new TypeError("B-tree child level does not equal parent level minus one");
    }
    if (expectation.expectedUpperBound !== undefined) {
      const maximum = immutableBTreePageMaximumKey({ getEntryKey: this.#getEntryKey, page });
      if (maximum === undefined || this.#compareKeys({ left: maximum, right: expectation.expectedUpperBound }) !== 0) {
        throw new TypeError("B-tree child upper bound does not match its subtree maximum");
      }
    }
    return page;
  }

  async get({ key, rootReference }: { key: TKey; rootReference: TReference }): Promise<TEntry | undefined> {
    const visited = new Set<string>();
    let expectation: PageReadExpectation<TKey> = { isRoot: true };
    let reference = rootReference;
    while (true) {
      const page = await this.#readPage({ expectation, reference, visited });
      switch (page.type) {
      case "leaf": {
        const index = findLeafEntryIndex({
          compareKeys: this.#compareKeys,
          entries: page.entries,
          getEntryKey: this.#getEntryKey,
          key,
        });
        const entry = page.entries[index];
        return entry !== undefined && this.#compareKeys({ left: this.#getEntryKey({ entry }), right: key }) === 0
          ? entry
          : undefined;
      }
      case "branch": {
        const index = findBranchChildIndex({ children: page.children, compareKeys: this.#compareKeys, key });
        const child = page.children[index];
        if (child === undefined) return undefined;
        reference = child.childPageReference;
        expectation = {
          expectedLevel: page.level - 1,
          expectedUpperBound: child.upperBound,
          isRoot: false,
        };
        break;
      }
      default: return page satisfies never;
      }
    }
  }

  async #descendToCandidateLeaf({ key, rootReference, visited }: {
    key: TKey;
    rootReference: TReference;
    visited: Set<string>;
  }): Promise<Readonly<{
    insertionIndex: number;
    leaf: LeafCursor<TKey, TEntry, TReference>["leaf"];
    leafReferenceIdentity: string;
    stack: readonly BranchCursorFrame<TKey, TReference>[];
  }>> {
    const stack: BranchCursorFrame<TKey, TReference>[] = [];
    let expectation: PageReadExpectation<TKey> = { isRoot: true };
    let reference = rootReference;
    while (true) {
      const pageReferenceIdentity = this.#referenceIdentity({ reference });
      const page = await this.#readPage({ expectation, reference, visited });
      switch (page.type) {
      case "leaf": {
        const insertionIndex = findLeafEntryIndex({
          compareKeys: this.#compareKeys,
          entries: page.entries,
          getEntryKey: this.#getEntryKey,
          key,
        });
        return { insertionIndex, leaf: page, leafReferenceIdentity: pageReferenceIdentity, stack };
      }
      case "branch": {
        const lowerBound = findBranchChildIndex({ children: page.children, compareKeys: this.#compareKeys, key });
        const selectedChildIndex = Math.min(lowerBound, page.children.length - 1);
        const child = page.children[selectedChildIndex];
        if (child === undefined) throw new Error("non-empty B-tree branch has no selectable child");
        stack.push({ page, pageReferenceIdentity, selectedChildIndex });
        reference = child.childPageReference;
        expectation = {
          expectedLevel: page.level - 1,
          expectedUpperBound: child.upperBound,
          isRoot: false,
        };
        break;
      }
      default: return page satisfies never;
      }
    }
  }

  async #descendRightmost({ initialStack, reference, upperBound, visited }: {
    initialStack: readonly BranchCursorFrame<TKey, TReference>[];
    reference: TReference;
    upperBound: TKey;
    visited: Set<string>;
  }): Promise<LeafCursor<TKey, TEntry, TReference>> {
    const stack = [...initialStack];
    let expectation: PageReadExpectation<TKey> = { expectedUpperBound: upperBound, isRoot: false };
    let currentReference = reference;
    while (true) {
      const pageReferenceIdentity = this.#referenceIdentity({ reference: currentReference });
      const page = await this.#readPage({ expectation, reference: currentReference, visited });
      switch (page.type) {
      case "leaf": return { entryIndex: page.entries.length - 1, leaf: page, leafReferenceIdentity: pageReferenceIdentity, stack };
      case "branch": {
        const selectedChildIndex = page.children.length - 1;
        const child = page.children[selectedChildIndex];
        if (child === undefined) throw new Error("non-empty B-tree branch has no rightmost child");
        stack.push({ page, pageReferenceIdentity, selectedChildIndex });
        currentReference = child.childPageReference;
        expectation = {
          expectedLevel: page.level - 1,
          expectedUpperBound: child.upperBound,
          isRoot: false,
        };
        break;
      }
      default: return page satisfies never;
      }
    }
  }

  async #locateFloorCursor({ key, rootReference }: {
    key: TKey;
    rootReference: TReference;
  }): Promise<Readonly<{ cursor?: LeafCursor<TKey, TEntry, TReference>; firstCandidate?: LeafCursor<TKey, TEntry, TReference> }>> {
    const visited = new Set<string>();
    const candidate = await this.#descendToCandidateLeaf({ key, rootReference, visited });
    const exact = candidate.leaf.entries[candidate.insertionIndex];
    if (exact !== undefined && this.#compareKeys({ left: this.#getEntryKey({ entry: exact }), right: key }) === 0) {
      return { cursor: { entryIndex: candidate.insertionIndex, leaf: candidate.leaf, leafReferenceIdentity: candidate.leafReferenceIdentity, stack: candidate.stack } };
    }
    if (candidate.insertionIndex > 0) {
      return { cursor: { entryIndex: candidate.insertionIndex - 1, leaf: candidate.leaf, leafReferenceIdentity: candidate.leafReferenceIdentity, stack: candidate.stack } };
    }
    const firstCandidate = candidate.leaf.entries.length === 0
      ? undefined
      : { entryIndex: 0, leaf: candidate.leaf, leafReferenceIdentity: candidate.leafReferenceIdentity, stack: candidate.stack };
    const mutableStack = [...candidate.stack];
    while (mutableStack.length > 0) {
      const frame = mutableStack.pop();
      if (frame === undefined) throw new Error("B-tree cursor stack invariant failed");
      if (frame.selectedChildIndex === 0) continue;
      const previousIndex = frame.selectedChildIndex - 1;
      const previousChild = frame.page.children[previousIndex];
      if (previousChild === undefined) throw new Error("B-tree previous-child cursor invariant failed");
      const parentStack = [...mutableStack, { page: frame.page, pageReferenceIdentity: frame.pageReferenceIdentity, selectedChildIndex: previousIndex }];
      return {
        cursor: await this.#descendRightmost({
          initialStack: parentStack,
          reference: previousChild.childPageReference,
          upperBound: previousChild.upperBound,
          visited,
        }),
        firstCandidate,
      };
    }
    return { firstCandidate };
  }

  async seekFloor({ key, rootReference }: { key: TKey; rootReference: TReference }): Promise<TEntry | undefined> {
    const located = await this.#locateFloorCursor({ key, rootReference });
    return located.cursor?.leaf.entries[located.cursor.entryIndex];
  }

  async #nextLeaf({ cursor, visited }: {
    cursor: LeafCursor<TKey, TEntry, TReference>;
    visited: Set<string>;
  }): Promise<LeafCursor<TKey, TEntry, TReference> | undefined> {
    const stack = [...cursor.stack];
    while (stack.length > 0) {
      const frame = stack.pop();
      if (frame === undefined) throw new Error("B-tree successor stack invariant failed");
      const nextIndex = frame.selectedChildIndex + 1;
      const nextChild = frame.page.children[nextIndex];
      if (nextChild === undefined) continue;
      stack.push({ page: frame.page, pageReferenceIdentity: frame.pageReferenceIdentity, selectedChildIndex: nextIndex });
      let reference = nextChild.childPageReference;
      let expectation: PageReadExpectation<TKey> = {
        expectedLevel: frame.page.level - 1,
        expectedUpperBound: nextChild.upperBound,
        isRoot: false,
      };
      while (true) {
        const pageReferenceIdentity = this.#referenceIdentity({ reference });
        const page = await this.#readPage({ expectation, reference, visited });
        switch (page.type) {
        case "leaf": return { entryIndex: 0, leaf: page, leafReferenceIdentity: pageReferenceIdentity, stack };
        case "branch": {
          const child = page.children[0];
          if (child === undefined) throw new Error("non-empty B-tree branch has no leftmost child");
          stack.push({ page, pageReferenceIdentity, selectedChildIndex: 0 });
          reference = child.childPageReference;
          expectation = {
            expectedLevel: page.level - 1,
            expectedUpperBound: child.upperBound,
            isRoot: false,
          };
          break;
        }
        default: return page satisfies never;
        }
      }
    }
    return undefined;
  }

  async *entriesFromFloor({ key, rootReference }: {
    key: TKey;
    rootReference: TReference;
  }): AsyncIterable<TEntry> {
    const located = await this.#locateFloorCursor({ key, rootReference });
    let cursor = located.cursor ?? located.firstCandidate;
    if (cursor === undefined) return;
    const visited = new Set<string>([
      ...cursor.stack.map((frame) => frame.pageReferenceIdentity),
      cursor.leafReferenceIdentity,
    ]);
    let previousKey: TKey | undefined;
    while (cursor !== undefined) {
      for (let index = cursor.entryIndex; index < cursor.leaf.entries.length; index += 1) {
        const entry = cursor.leaf.entries[index];
        if (entry === undefined) throw new Error("B-tree leaf iteration invariant failed");
        const entryKey = this.#getEntryKey({ entry });
        if (previousKey !== undefined && this.#compareKeys({ left: previousKey, right: entryKey }) >= 0) {
          throw new TypeError("B-tree range traversal encountered overlapping sibling keys");
        }
        previousKey = entryKey;
        yield entry;
      }
      cursor = await this.#nextLeaf({ cursor, visited });
    }
  }

  async *entries({ rootReference }: { rootReference: TReference }): AsyncIterable<TEntry> {
    const visited = new Set<string>();
    let previousKey: TKey | undefined;
    const walk = async function* (this: ImmutableBTreeReader<TKey, TEntry, TReference>, {
      expectation,
      reference,
    }: {
      expectation: PageReadExpectation<TKey>;
      reference: TReference;
    }): AsyncIterable<TEntry> {
      const page = await this.#readPage({ expectation, reference, visited });
      switch (page.type) {
      case "leaf":
        for (const entry of page.entries) {
          const entryKey = this.#getEntryKey({ entry });
          if (previousKey !== undefined && this.#compareKeys({ left: previousKey, right: entryKey }) >= 0) {
            throw new TypeError("B-tree iteration encountered overlapping sibling keys");
          }
          previousKey = entryKey;
          yield entry;
        }
        return;
      case "branch":
        for (const child of page.children) {
          yield* walk.call(this, {
            expectation: {
              expectedLevel: page.level - 1,
              expectedUpperBound: child.upperBound,
              isRoot: false,
            },
            reference: child.childPageReference,
          });
        }
        return;
      default: return page satisfies never;
      }
    };
    yield* walk.call(this, { expectation: { isRoot: true }, reference: rootReference });
  }

  async validateStructure({ rootReference }: { rootReference: TReference }): Promise<Readonly<{
    depth: number;
    entryCount: number;
    pageCount: number;
  }>> {
    const visited = new Set<string>();
    const visit = async ({ expectation, reference }: {
      expectation: PageReadExpectation<TKey>;
      reference: TReference;
    }): Promise<Readonly<{
      depth: number;
      entryCount: number;
      maximumKey?: TKey;
      minimumKey?: TKey;
      pageCount: number;
    }>> => {
      const page = await this.#readPage({ expectation, reference, visited });
      switch (page.type) {
      case "leaf": {
        const first = page.entries[0];
        const last = page.entries.at(-1);
        return {
          depth: 1,
          entryCount: page.entries.length,
          maximumKey: last === undefined ? undefined : this.#getEntryKey({ entry: last }),
          minimumKey: first === undefined ? undefined : this.#getEntryKey({ entry: first }),
          pageCount: 1,
        };
      }
      case "branch": {
        let depth: number | undefined;
        let entryCount = 0;
        let pageCount = 1;
        let minimumKey: TKey | undefined;
        let previousMaximum: TKey | undefined;
        for (const child of page.children) {
          const result = await visit({
            expectation: {
              expectedLevel: page.level - 1,
              expectedUpperBound: child.upperBound,
              isRoot: false,
            },
            reference: child.childPageReference,
          });
          if (result.minimumKey === undefined || result.maximumKey === undefined) {
            throw new TypeError("B-tree branch references an empty subtree");
          }
          if (depth === undefined) depth = result.depth;
          else if (depth !== result.depth) throw new TypeError("B-tree leaves do not share one depth");
          if (previousMaximum !== undefined && this.#compareKeys({ left: previousMaximum, right: result.minimumKey }) >= 0) {
            throw new TypeError("B-tree sibling key ranges overlap");
          }
          minimumKey ??= result.minimumKey;
          previousMaximum = result.maximumKey;
          entryCount += result.entryCount;
          pageCount += result.pageCount;
        }
        return {
          depth: (depth ?? 0) + 1,
          entryCount,
          maximumKey: previousMaximum,
          minimumKey,
          pageCount,
        };
      }
      default: return page satisfies never;
      }
    };
    const result = await visit({ expectation: { isRoot: true }, reference: rootReference });
    return { depth: result.depth, entryCount: result.entryCount, pageCount: result.pageCount };
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
