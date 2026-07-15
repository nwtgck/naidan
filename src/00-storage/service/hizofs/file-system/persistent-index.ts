type PersistentIndexLeafPage<TEntry> = {
  readonly type: "leaf";
  readonly entries: readonly TEntry[];
};

type PersistentIndexBranchChild<TKey> = {
  readonly upperBound: TKey;
  readonly childPageObjectId: string;
};

type PersistentIndexBranchPage<TKey> = {
  readonly type: "branch";
  readonly children: readonly PersistentIndexBranchChild<TKey>[];
};

export type PersistentIndexPage<TKey, TEntry> =
  PersistentIndexLeafPage<TEntry> | PersistentIndexBranchPage<TKey>;

export interface PersistentIndexPageStore<TKey, TEntry> {
  readPage({
    objectId,
  }: {
    objectId: string;
  }): Promise<PersistentIndexPage<TKey, TEntry>>;

  writePage({
    page,
  }: {
    page: PersistentIndexPage<TKey, TEntry>;
  }): Promise<string>;
}

type PageReference<TKey> = {
  readonly objectId: string;
  readonly upperBound: TKey;
};

type DeleteResult<TKey> = {
  readonly changed: boolean;
  readonly reference: PageReference<TKey> | undefined;
};

export class PersistentHizoFSIndex<TKey, TEntry> {
  constructor({
    pageStore,
    compare,
    getEntryKey,
    maxPageEntries,
  }: {
    pageStore: PersistentIndexPageStore<TKey, TEntry>;
    compare: ({ left, right }: { left: TKey; right: TKey }) => number;
    getEntryKey: ({ entry }: { entry: TEntry }) => TKey;
    maxPageEntries: number;
  }) {
    if (!Number.isSafeInteger(maxPageEntries) || maxPageEntries < 2) {
      throw new Error(
        "Persistent index maxPageEntries must be an integer of at least 2",
      );
    }
    this.pageStore = pageStore;
    this.compare = compare;
    this.getEntryKey = getEntryKey;
    this.maxPageEntries = maxPageEntries;
  }

  private readonly pageStore: PersistentIndexPageStore<TKey, TEntry>;
  private readonly compare: ({
    left,
    right,
  }: {
    left: TKey;
    right: TKey;
  }) => number;
  private readonly getEntryKey: ({ entry }: { entry: TEntry }) => TKey;
  private readonly maxPageEntries: number;

  async createEmpty(): Promise<string> {
    return this.pageStore.writePage({
      page: {
        type: "leaf",
        entries: [],
      },
    });
  }

  async get({
    rootObjectId,
    key,
  }: {
    rootObjectId: string;
    key: TKey;
  }): Promise<TEntry | undefined> {
    let objectId = rootObjectId;
    while (true) {
      const page = await this.pageStore.readPage({ objectId });
      switch (page.type) {
      case "leaf": {
        const index = this.findEntryIndex({ entries: page.entries, key });
        const entry = page.entries[index];
        return entry !== undefined &&
            this.compare({ left: this.getEntryKey({ entry }), right: key }) ===
              0
          ? entry
          : undefined;
      }
      case "branch": {
        const child = this.findChild({ children: page.children, key });
        if (child === undefined) {
          return undefined;
        }
        objectId = child.childPageObjectId;
        break;
      }
      default: {
        const _ex: never = page;
        throw new Error(`Unhandled persistent index page: ${String(_ex)}`);
      }
      }
    }
  }

  async set({
    rootObjectId,
    entry,
  }: {
    rootObjectId: string;
    entry: TEntry;
  }): Promise<string> {
    const references = await this.insertIntoPage({
      objectId: rootObjectId,
      entry,
    });
    if (references.length === 1) {
      const reference = references[0];
      if (reference === undefined) {
        throw new Error(
          "Persistent index insertion returned no root reference",
        );
      }
      return reference.objectId;
    }
    return this.pageStore.writePage({
      page: {
        type: "branch",
        children: references.map((reference) => ({
          upperBound: reference.upperBound,
          childPageObjectId: reference.objectId,
        })),
      },
    });
  }

  async delete({
    rootObjectId,
    key,
  }: {
    rootObjectId: string;
    key: TKey;
  }): Promise<string> {
    const result = await this.deleteFromPage({ objectId: rootObjectId, key });
    if (!result.changed) {
      return rootObjectId;
    }
    if (result.reference === undefined) {
      return this.createEmpty();
    }

    let reference = result.reference;
    while (true) {
      const page = await this.pageStore.readPage({
        objectId: reference.objectId,
      });
      if (page.type !== "branch" || page.children.length !== 1) {
        return reference.objectId;
      }
      const onlyChild = page.children[0];
      if (onlyChild === undefined) {
        return this.createEmpty();
      }
      reference = {
        objectId: onlyChild.childPageObjectId,
        upperBound: onlyChild.upperBound,
      };
    }
  }

  async *entries({
    rootObjectId,
  }: {
    rootObjectId: string;
  }): AsyncIterable<TEntry> {
    yield* this.readEntriesFromPage({ objectId: rootObjectId });
  }

  private async *readEntriesFromPage({
    objectId,
  }: {
    objectId: string;
  }): AsyncIterable<TEntry> {
    const page = await this.pageStore.readPage({ objectId });
    switch (page.type) {
    case "leaf":
      for (const entry of page.entries) {
        yield entry;
      }
      break;
    case "branch":
      for (const child of page.children) {
        yield* this.readEntriesFromPage({
          objectId: child.childPageObjectId,
        });
      }
      break;
    default: {
      const _ex: never = page;
      throw new Error(`Unhandled persistent index page: ${String(_ex)}`);
    }
    }
  }

  async buildFromSortedEntries({
    entries,
  }: {
    entries: AsyncIterable<TEntry> | Iterable<TEntry>;
  }): Promise<string> {
    const leafReferences: PageReference<TKey>[] = [];
    let group: TEntry[] = [];
    let previousKey: TKey | undefined;
    for await (const entry of entries) {
      const key = this.getEntryKey({ entry });
      if (
        previousKey !== undefined &&
        this.compare({ left: previousKey, right: key }) >= 0
      ) {
        throw new Error(
          "Persistent index bulk input must be strictly sorted and unique",
        );
      }
      previousKey = key;
      group.push(entry);
      if (group.length === this.maxPageEntries) {
        leafReferences.push(await this.writeLeafGroup({ entries: group }));
        group = [];
      }
    }
    if (group.length > 0) {
      leafReferences.push(await this.writeLeafGroup({ entries: group }));
    }
    if (leafReferences.length === 0) {
      return this.createEmpty();
    }
    return this.buildRootFromReferences({ references: leafReferences });
  }

  async deleteMany({
    rootObjectId,
    keys,
  }: {
    rootObjectId: string;
    keys: ReadonlySet<TKey>;
  }): Promise<string> {
    if (keys.size === 0) {
      return rootObjectId;
    }
    const sortedKeys = [...keys].sort((left, right) =>
      this.compare({ left, right })
    );
    const result = await this.deleteManyFromPage({
      objectId: rootObjectId,
      keys: sortedKeys,
    });
    if (!result.changed) {
      return rootObjectId;
    }
    if (result.reference === undefined) {
      return this.createEmpty();
    }

    let reference = result.reference;
    while (true) {
      const page = await this.pageStore.readPage({
        objectId: reference.objectId,
      });
      if (page.type !== "branch" || page.children.length !== 1) {
        return reference.objectId;
      }
      const onlyChild = page.children[0];
      if (onlyChild === undefined) {
        return this.createEmpty();
      }
      reference = {
        objectId: onlyChild.childPageObjectId,
        upperBound: onlyChild.upperBound,
      };
    }
  }

  async truncateAtOrAfter({
    rootObjectId,
    key,
  }: {
    rootObjectId: string;
    key: TKey;
  }): Promise<string> {
    const result = await this.truncatePage({ objectId: rootObjectId, key });
    if (!result.changed) {
      return rootObjectId;
    }
    if (result.reference === undefined) {
      return this.createEmpty();
    }
    let reference = result.reference;
    while (true) {
      const page = await this.pageStore.readPage({
        objectId: reference.objectId,
      });
      if (page.type !== "branch" || page.children.length !== 1) {
        return reference.objectId;
      }
      const child = page.children[0];
      if (child === undefined) {
        return this.createEmpty();
      }
      reference = {
        objectId: child.childPageObjectId,
        upperBound: child.upperBound,
      };
    }
  }

  async validateStructure({ rootObjectId }: { rootObjectId: string }): Promise<{
    readonly pageCount: number;
    readonly entryCount: number;
    readonly depth: number;
  }> {
    const visited = new Set<string>();
    const visit = async ({
      objectId,
    }: {
      objectId: string;
    }): Promise<{
      readonly upperBound: TKey | undefined;
      readonly pageCount: number;
      readonly entryCount: number;
      readonly depth: number;
    }> => {
      if (visited.has(objectId)) {
        throw new Error(
          "Persistent index contains a cycle or duplicate page reference",
        );
      }
      visited.add(objectId);
      const page = await this.pageStore.readPage({ objectId });
      switch (page.type) {
      case "leaf": {
        let previous: TKey | undefined;
        for (const entry of page.entries) {
          const key = this.getEntryKey({ entry });
          if (
            previous !== undefined &&
              this.compare({ left: previous, right: key }) >= 0
          ) {
            throw new Error(
              "Persistent index leaf entries are not strictly sorted",
            );
          }
          previous = key;
        }
        return {
          upperBound: previous,
          pageCount: 1,
          entryCount: page.entries.length,
          depth: 1,
        };
      }
      case "branch": {
        if (page.children.length === 0) {
          throw new Error("Persistent index branch has no children");
        }
        let previousBound: TKey | undefined;
        let expectedDepth: number | undefined;
        let pageCount = 1;
        let entryCount = 0;
        for (const child of page.children) {
          if (
            previousBound !== undefined &&
              this.compare({ left: previousBound, right: child.upperBound }) >=
                0
          ) {
            throw new Error(
              "Persistent index branch bounds are not strictly sorted",
            );
          }
          const childResult = await visit({
            objectId: child.childPageObjectId,
          });
          if (childResult.upperBound === undefined) {
            throw new Error(
              "Persistent index branch references an empty subtree",
            );
          }
          if (
            this.compare({
              left: childResult.upperBound,
              right: child.upperBound,
            }) !== 0
          ) {
            throw new Error(
              "Persistent index branch upper bound does not match its child subtree",
            );
          }
          if (expectedDepth === undefined) {
            expectedDepth = childResult.depth;
          } else if (expectedDepth !== childResult.depth) {
            throw new Error(
              "Persistent index leaves are not at one consistent depth",
            );
          }
          previousBound = child.upperBound;
          pageCount += childResult.pageCount;
          entryCount += childResult.entryCount;
        }
        return {
          upperBound: previousBound,
          pageCount,
          entryCount,
          depth: (expectedDepth ?? 0) + 1,
        };
      }
      default: {
        const _ex: never = page;
        throw new Error(`Unhandled persistent index page: ${String(_ex)}`);
      }
      }
    };
    const result = await visit({ objectId: rootObjectId });
    return {
      pageCount: result.pageCount,
      entryCount: result.entryCount,
      depth: result.depth,
    };
  }

  private async writeLeafGroup({
    entries,
  }: {
    entries: readonly TEntry[];
  }): Promise<PageReference<TKey>> {
    const last = entries.at(-1);
    if (last === undefined) {
      throw new Error("Persistent index cannot write an empty bulk leaf");
    }
    const objectId = await this.pageStore.writePage({
      page: { type: "leaf", entries },
    });
    return {
      objectId,
      upperBound: this.getEntryKey({ entry: last }),
    };
  }

  private async buildRootFromReferences({
    references,
  }: {
    references: readonly PageReference<TKey>[];
  }): Promise<string> {
    let level = references;
    while (level.length > 1) {
      const next: PageReference<TKey>[] = [];
      for (
        let offset = 0;
        offset < level.length;
        offset += this.maxPageEntries
      ) {
        const group = level.slice(offset, offset + this.maxPageEntries);
        const last = group.at(-1);
        if (last === undefined) {
          throw new Error("Persistent index bulk branch group is empty");
        }
        const objectId = await this.pageStore.writePage({
          page: {
            type: "branch",
            children: group.map((reference) => ({
              upperBound: reference.upperBound,
              childPageObjectId: reference.objectId,
            })),
          },
        });
        next.push({ objectId, upperBound: last.upperBound });
      }
      level = next;
    }
    const root = level[0];
    if (root === undefined) {
      throw new Error("Persistent index bulk build produced no root");
    }
    return root.objectId;
  }

  private async deleteManyFromPage({
    objectId,
    keys,
  }: {
    objectId: string;
    keys: readonly TKey[];
  }): Promise<DeleteResult<TKey>> {
    if (keys.length === 0) {
      const page = await this.pageStore.readPage({ objectId });
      return {
        changed: false,
        reference: await this.referenceForPage({ objectId, page }),
      };
    }

    const page = await this.pageStore.readPage({ objectId });
    switch (page.type) {
    case "leaf": {
      const entries: TEntry[] = [];
      let keyIndex = 0;
      let changed = false;
      for (const entry of page.entries) {
        const entryKey = this.getEntryKey({ entry });
        while (
          keyIndex < keys.length &&
            this.compare({ left: keys[keyIndex] as TKey, right: entryKey }) < 0
        ) {
          keyIndex += 1;
        }
        const key = keys[keyIndex];
        if (
          key !== undefined &&
            this.compare({ left: key, right: entryKey }) === 0
        ) {
          changed = true;
          keyIndex += 1;
        } else {
          entries.push(entry);
        }
      }
      if (!changed) {
        return {
          changed: false,
          reference: await this.referenceForPage({ objectId, page }),
        };
      }
      if (entries.length === 0) {
        return { changed: true, reference: undefined };
      }
      const nextObjectId = await this.pageStore.writePage({
        page: { type: "leaf", entries },
      });
      const last = entries.at(-1);
      if (last === undefined) {
        throw new Error("Persistent index batch deletion produced an empty leaf");
      }
      return {
        changed: true,
        reference: {
          objectId: nextObjectId,
          upperBound: this.getEntryKey({ entry: last }),
        },
      };
    }
    case "branch": {
      const groupedKeys = new Map<number, TKey[]>();
      for (const key of keys) {
        const childIndex = this.findChildIndex({
          children: page.children,
          key,
        });
        if (childIndex >= page.children.length) {
          continue;
        }
        const group = groupedKeys.get(childIndex);
        if (group === undefined) {
          groupedKeys.set(childIndex, [key]);
        } else {
          group.push(key);
        }
      }
      if (groupedKeys.size === 0) {
        return {
          changed: false,
          reference: await this.referenceForPage({ objectId, page }),
        };
      }

      let changed = false;
      const children: PersistentIndexBranchChild<TKey>[] = [];
      for (let childIndex = 0; childIndex < page.children.length; childIndex += 1) {
        const child = page.children[childIndex];
        if (child === undefined) {
          continue;
        }
        const childKeys = groupedKeys.get(childIndex);
        if (childKeys === undefined) {
          children.push(child);
          continue;
        }
        const result = await this.deleteManyFromPage({
          objectId: child.childPageObjectId,
          keys: childKeys,
        });
        changed ||= result.changed;
        if (result.reference !== undefined) {
          children.push({
            upperBound: result.reference.upperBound,
            childPageObjectId: result.reference.objectId,
          });
        }
      }
      if (!changed) {
        return {
          changed: false,
          reference: await this.referenceForPage({ objectId, page }),
        };
      }
      if (children.length === 0) {
        return { changed: true, reference: undefined };
      }
      const nextObjectId = await this.pageStore.writePage({
        page: { type: "branch", children },
      });
      return {
        changed: true,
        reference: {
          objectId: nextObjectId,
          upperBound: children.at(-1)!.upperBound,
        },
      };
    }
    default: {
      const _ex: never = page;
      throw new Error(`Unhandled persistent index page: ${String(_ex)}`);
    }
    }
  }

  private async truncatePage({
    objectId,
    key,
  }: {
    objectId: string;
    key: TKey;
  }): Promise<DeleteResult<TKey>> {
    const page = await this.pageStore.readPage({ objectId });
    switch (page.type) {
    case "leaf": {
      const index = this.findEntryIndex({ entries: page.entries, key });
      if (index === page.entries.length) {
        return {
          changed: false,
          reference: await this.referenceForPage({ objectId, page }),
        };
      }
      if (index === 0) {
        return { changed: true, reference: undefined };
      }
      const entries = page.entries.slice(0, index);
      const newObjectId = await this.pageStore.writePage({
        page: { type: "leaf", entries },
      });
      const last = entries.at(-1);
      if (last === undefined) {
        return { changed: true, reference: undefined };
      }
      return {
        changed: true,
        reference: {
          objectId: newObjectId,
          upperBound: this.getEntryKey({ entry: last }),
        },
      };
    }
    case "branch": {
      const childIndex = this.findChildIndex({
        children: page.children,
        key,
      });
      if (childIndex === page.children.length) {
        return {
          changed: false,
          reference: await this.referenceForPage({ objectId, page }),
        };
      }
      const child = page.children[childIndex];
      if (child === undefined) {
        return {
          changed: false,
          reference: await this.referenceForPage({ objectId, page }),
        };
      }
      const truncatedChild = await this.truncatePage({
        objectId: child.childPageObjectId,
        key,
      });
      const children = [...page.children.slice(0, childIndex)];
      if (truncatedChild.reference !== undefined) {
        children.push({
          upperBound: truncatedChild.reference.upperBound,
          childPageObjectId: truncatedChild.reference.objectId,
        });
      }
      if (children.length === 0) {
        return { changed: true, reference: undefined };
      }
      const newObjectId = await this.pageStore.writePage({
        page: { type: "branch", children },
      });
      return {
        changed: true,
        reference: {
          objectId: newObjectId,
          upperBound: children.at(-1)!.upperBound,
        },
      };
    }
    default: {
      const _ex: never = page;
      throw new Error(`Unhandled persistent index page: ${String(_ex)}`);
    }
    }
  }

  private async insertIntoPage({
    objectId,
    entry,
  }: {
    objectId: string;
    entry: TEntry;
  }): Promise<readonly PageReference<TKey>[]> {
    const page = await this.pageStore.readPage({ objectId });
    switch (page.type) {
    case "leaf": {
      const entries = [...page.entries];
      const key = this.getEntryKey({ entry });
      const index = this.findEntryIndex({ entries, key });
      const existing = entries[index];
      if (
        existing !== undefined &&
          this.compare({
            left: this.getEntryKey({ entry: existing }),
            right: key,
          }) === 0
      ) {
        entries[index] = entry;
      } else {
        entries.splice(index, 0, entry);
      }
      return this.writeSplitLeafPages({ entries });
    }
    case "branch": {
      const key = this.getEntryKey({ entry });
      let childIndex = this.findChildIndex({ children: page.children, key });
      if (childIndex === page.children.length) {
        childIndex = Math.max(0, page.children.length - 1);
      }
      const child = page.children[childIndex];
      if (child === undefined) {
        throw new Error("Persistent index branch has no child");
      }
      const replacement = await this.insertIntoPage({
        objectId: child.childPageObjectId,
        entry,
      });
      const children = [
        ...page.children.slice(0, childIndex),
        ...replacement.map((reference) => ({
          upperBound: reference.upperBound,
          childPageObjectId: reference.objectId,
        })),
        ...page.children.slice(childIndex + 1),
      ];
      return this.writeSplitBranchPages({ children });
    }
    default: {
      const _ex: never = page;
      throw new Error(`Unhandled persistent index page: ${String(_ex)}`);
    }
    }
  }

  private async deleteFromPage({
    objectId,
    key,
  }: {
    objectId: string;
    key: TKey;
  }): Promise<DeleteResult<TKey>> {
    const page = await this.pageStore.readPage({ objectId });
    switch (page.type) {
    case "leaf": {
      const index = this.findEntryIndex({ entries: page.entries, key });
      const existing = page.entries[index];
      if (
        existing === undefined ||
          this.compare({
            left: this.getEntryKey({ entry: existing }),
            right: key,
          }) !== 0
      ) {
        return {
          changed: false,
          reference: await this.referenceForPage({ objectId, page }),
        };
      }
      const entries = [...page.entries];
      entries.splice(index, 1);
      if (entries.length === 0) {
        return { changed: true, reference: undefined };
      }
      const newObjectId = await this.pageStore.writePage({
        page: { type: "leaf", entries },
      });
      return {
        changed: true,
        reference: {
          objectId: newObjectId,
          upperBound: this.getEntryKey({
            entry: entries[entries.length - 1] as TEntry,
          }),
        },
      };
    }
    case "branch": {
      const childIndex = this.findChildIndex({
        children: page.children,
        key,
      });
      const child = page.children[childIndex];
      if (child === undefined) {
        return {
          changed: false,
          reference: await this.referenceForPage({ objectId, page }),
        };
      }
      const result = await this.deleteFromPage({
        objectId: child.childPageObjectId,
        key,
      });
      if (!result.changed) {
        return {
          changed: false,
          reference: await this.referenceForPage({ objectId, page }),
        };
      }
      const children = [...page.children];
      if (result.reference === undefined) {
        children.splice(childIndex, 1);
      } else {
        children[childIndex] = {
          upperBound: result.reference.upperBound,
          childPageObjectId: result.reference.objectId,
        };
      }
      if (children.length === 0) {
        return { changed: true, reference: undefined };
      }
      const newObjectId = await this.pageStore.writePage({
        page: { type: "branch", children },
      });
      return {
        changed: true,
        reference: {
          objectId: newObjectId,
          upperBound: children[children.length - 1]!.upperBound,
        },
      };
    }
    default: {
      const _ex: never = page;
      throw new Error(`Unhandled persistent index page: ${String(_ex)}`);
    }
    }
  }

  private async writeSplitLeafPages({
    entries,
  }: {
    entries: readonly TEntry[];
  }): Promise<readonly PageReference<TKey>[]> {
    const groups = this.split({ values: entries });
    const references: PageReference<TKey>[] = [];
    for (const group of groups) {
      const objectId = await this.pageStore.writePage({
        page: { type: "leaf", entries: group },
      });
      const last = group[group.length - 1];
      if (last === undefined) {
        throw new Error(
          "Persistent index attempted to write an empty split leaf",
        );
      }
      references.push({
        objectId,
        upperBound: this.getEntryKey({ entry: last }),
      });
    }
    return references;
  }

  private async writeSplitBranchPages({
    children,
  }: {
    children: readonly PersistentIndexBranchChild<TKey>[];
  }): Promise<readonly PageReference<TKey>[]> {
    const groups = this.split({ values: children });
    const references: PageReference<TKey>[] = [];
    for (const group of groups) {
      const objectId = await this.pageStore.writePage({
        page: { type: "branch", children: group },
      });
      const last = group[group.length - 1];
      if (last === undefined) {
        throw new Error(
          "Persistent index attempted to write an empty split branch",
        );
      }
      references.push({ objectId, upperBound: last.upperBound });
    }
    return references;
  }

  private split<T>({
    values,
  }: {
    values: readonly T[];
  }): readonly (readonly T[])[] {
    if (values.length <= this.maxPageEntries) {
      return [values];
    }
    const splitIndex = Math.ceil(values.length / 2);
    return [values.slice(0, splitIndex), values.slice(splitIndex)];
  }

  private async referenceForPage({
    objectId,
    page,
  }: {
    objectId: string;
    page: PersistentIndexPage<TKey, TEntry>;
  }): Promise<PageReference<TKey> | undefined> {
    switch (page.type) {
    case "leaf": {
      const entry = page.entries[page.entries.length - 1];
      return entry === undefined
        ? undefined
        : { objectId, upperBound: this.getEntryKey({ entry }) };
    }
    case "branch": {
      const child = page.children[page.children.length - 1];
      return child === undefined
        ? undefined
        : { objectId, upperBound: child.upperBound };
    }
    default: {
      const _ex: never = page;
      throw new Error(`Unhandled persistent index page: ${String(_ex)}`);
    }
    }
  }

  private findEntryIndex({
    entries,
    key,
  }: {
    entries: readonly TEntry[];
    key: TKey;
  }): number {
    let low = 0;
    let high = entries.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = entries[middle];
      if (
        candidate !== undefined &&
        this.compare({
          left: this.getEntryKey({ entry: candidate }),
          right: key,
        }) < 0
      ) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  }

  private findChild({
    children,
    key,
  }: {
    children: readonly PersistentIndexBranchChild<TKey>[];
    key: TKey;
  }): PersistentIndexBranchChild<TKey> | undefined {
    return children[this.findChildIndex({ children, key })];
  }

  private findChildIndex({
    children,
    key,
  }: {
    children: readonly PersistentIndexBranchChild<TKey>[];
    key: TKey;
  }): number {
    let low = 0;
    let high = children.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = children[middle];
      if (
        candidate !== undefined &&
        this.compare({ left: candidate.upperBound, right: key }) < 0
      ) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
