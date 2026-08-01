export type ImmutableBTreeLeafPage<TEntry> = Readonly<{
  entries: readonly TEntry[];
  level: 0;
  type: "leaf";
}>;

export type ImmutableBTreeBranchChild<TKey, TReference> = Readonly<{
  childPageReference: TReference;
  upperBound: TKey;
}>;

export type ImmutableBTreeBranchPage<TKey, TReference> = Readonly<{
  children: readonly ImmutableBTreeBranchChild<TKey, TReference>[];
  level: number;
  type: "branch";
}>;

export type ImmutableBTreePage<TKey, TEntry, TReference> =
  | ImmutableBTreeLeafPage<TEntry>
  | ImmutableBTreeBranchPage<TKey, TReference>;

export type CompareImmutableBTreeKeys<TKey> = ({ left, right }: Readonly<{
  left: TKey;
  right: TKey;
}>) => number;

export type GetImmutableBTreeEntryKey<TKey, TEntry> = ({ entry }: Readonly<{
  entry: TEntry;
}>) => TKey;

export function lowerBoundIndex<TKey>({ compareKeys, keys, target }: {
  compareKeys: CompareImmutableBTreeKeys<TKey>;
  keys: readonly TKey[];
  target: TKey;
}): number {
  let lower = 0;
  let upper = keys.length;
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    const key = keys[middle];
    if (key === undefined) throw new Error("B-tree binary-search index invariant failed");
    if (compareKeys({ left: key, right: target }) < 0) lower = middle + 1;
    else upper = middle;
  }
  return lower;
}

export function findBranchChildIndex<TKey, TReference>({ children, compareKeys, key }: {
  children: readonly ImmutableBTreeBranchChild<TKey, TReference>[];
  compareKeys: CompareImmutableBTreeKeys<TKey>;
  key: TKey;
}): number {
  let lower = 0;
  let upper = children.length;
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    const child = children[middle];
    if (child === undefined) throw new Error("B-tree child binary-search index invariant failed");
    if (compareKeys({ left: child.upperBound, right: key }) < 0) lower = middle + 1;
    else upper = middle;
  }
  return lower;
}

export function findLeafEntryIndex<TKey, TEntry>({ compareKeys, entries, getEntryKey, key }: {
  compareKeys: CompareImmutableBTreeKeys<TKey>;
  entries: readonly TEntry[];
  getEntryKey: GetImmutableBTreeEntryKey<TKey, TEntry>;
  key: TKey;
}): number {
  let lower = 0;
  let upper = entries.length;
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    const entry = entries[middle];
    if (entry === undefined) throw new Error("B-tree leaf binary-search index invariant failed");
    if (compareKeys({ left: getEntryKey({ entry }), right: key }) < 0) lower = middle + 1;
    else upper = middle;
  }
  return lower;
}

export function assertLocallyValidImmutableBTreePage<TKey, TEntry, TReference>({
  compareKeys,
  getEntryKey,
  isRoot,
  page,
}: {
  compareKeys: CompareImmutableBTreeKeys<TKey>;
  getEntryKey: GetImmutableBTreeEntryKey<TKey, TEntry>;
  isRoot: boolean;
  page: ImmutableBTreePage<TKey, TEntry, TReference>;
}): void {
  switch (page.type) {
  case "leaf": {
    if (page.entries.length === 0 && !isRoot) throw new TypeError("only the root B-tree leaf may be empty");
    let previous: TKey | undefined;
    for (const entry of page.entries) {
      const key = getEntryKey({ entry });
      if (previous !== undefined && compareKeys({ left: previous, right: key }) >= 0) {
        throw new TypeError("B-tree leaf keys must be strictly ascending");
      }
      previous = key;
    }
    return;
  }
  case "branch": {
    if (!Number.isSafeInteger(page.level) || page.level < 1) {
      throw new RangeError("B-tree branch level must be a positive safe integer");
    }
    if (page.children.length === 0) throw new TypeError("B-tree branch must contain at least one child");
    let previous: TKey | undefined;
    for (const child of page.children) {
      if (previous !== undefined && compareKeys({ left: previous, right: child.upperBound }) >= 0) {
        throw new TypeError("B-tree branch upper bounds must be strictly ascending");
      }
      previous = child.upperBound;
    }
    return;
  }
  default: return page satisfies never;
  }
}

export function immutableBTreePageMaximumKey<TKey, TEntry, TReference>({ getEntryKey, page }: {
  getEntryKey: GetImmutableBTreeEntryKey<TKey, TEntry>;
  page: ImmutableBTreePage<TKey, TEntry, TReference>;
}): TKey | undefined {
  switch (page.type) {
  case "leaf": {
    const entry = page.entries.at(-1);
    return entry === undefined ? undefined : getEntryKey({ entry });
  }
  case "branch": return page.children.at(-1)?.upperBound;
  default: return page satisfies never;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
