import { COMMON_PAGE_HEADER_SIZE, HIZOFS_V1_FORMAT_CONSTANTS } from "@/00-storage/service/hizofs/00-format";
import {
  measureImmutableBTreeOperation,
  type ImmutableBTreeDiagnosticOperation,
  type ImmutableBTreeDiagnosticsPort,
  type MutableImmutableBTreeStructuralDiagnostics,
} from "@/00-storage/service/hizofs/indexes/diagnostics-hooks";
import {
  assertLocallyValidImmutableBTreePage,
  findBranchChildIndex,
  findLeafEntryIndex,
  immutableBTreePageMaximumKey,
  type CompareImmutableBTreeKeys,
  type GetImmutableBTreeEntryKey,
  type ImmutableBTreeBranchChild,
  type ImmutableBTreePage,
} from "@/00-storage/service/hizofs/indexes/ordering";

export type ImmutableBTreeMutation<TKey, TEntry> =
  | Readonly<{ entry: TEntry; type: "set" }>
  | Readonly<{ key: TKey; type: "delete" }>;

export type ImmutableBTreePageStore<TKey, TEntry, TReference> = Readonly<{
  operationDiagnostics?: Readonly<{
    operation: ImmutableBTreeDiagnosticOperation;
    port: ImmutableBTreeDiagnosticsPort;
  }>;
  readPage: ({ isRoot, reference }: { isRoot: boolean; reference: TReference }) => Promise<ImmutableBTreePage<TKey, TEntry, TReference>>;
  writePage: ({ isRoot, page }: { isRoot: boolean; page: ImmutableBTreePage<TKey, TEntry, TReference> }) => Promise<TReference>;
}>;

type ReferenceSummary<TKey, TReference> = Readonly<{
  level: number;
  reference: TReference;
  upperBound?: TKey;
}>;

type MutationResult<TKey, TReference> = Readonly<{
  changed: boolean;
  references: readonly ReferenceSummary<TKey, TReference>[];
}>;

const DEFAULT_MAXIMUM_PAGE_BYTE_LENGTH = HIZOFS_V1_FORMAT_CONSTANTS.limits.metadataPlaintextBytes;

export class CanonicalBTreeWriter<TKey, TEntry, TReference> {
  private readonly compareKeys: CompareImmutableBTreeKeys<TKey>;
  private readonly encodedBranchChildByteLength: ({ child }: { child: ImmutableBTreeBranchChild<TKey, TReference> }) => number;
  private readonly encodedLeafEntryByteLength: ({ entry }: { entry: TEntry }) => number;
  private readonly entriesEqual: ({ left, right }: { left: TEntry; right: TEntry }) => boolean;
  private readonly getEntryKey: GetImmutableBTreeEntryKey<TKey, TEntry>;
  private readonly maximumPageByteLength: number;
  private readonly maximumLeafEntryCount: number;
  private readonly maximumRootLeafEntryCount: number;
  private readonly pageStore: ImmutableBTreePageStore<TKey, TEntry, TReference>;

  constructor({
    compareKeys,
    encodedBranchChildByteLength,
    encodedLeafEntryByteLength,
    entriesEqual = ({ left, right }) => Object.is(left, right),
    getEntryKey,
    maximumPageByteLength = DEFAULT_MAXIMUM_PAGE_BYTE_LENGTH,
    maximumLeafEntryCount = Number.MAX_SAFE_INTEGER,
    maximumRootLeafEntryCount = maximumLeafEntryCount,
    pageStore,
  }: {
    compareKeys: CompareImmutableBTreeKeys<TKey>;
    encodedBranchChildByteLength: ({ child }: { child: ImmutableBTreeBranchChild<TKey, TReference> }) => number;
    encodedLeafEntryByteLength: ({ entry }: { entry: TEntry }) => number;
    entriesEqual?: ({ left, right }: { left: TEntry; right: TEntry }) => boolean;
    getEntryKey: GetImmutableBTreeEntryKey<TKey, TEntry>;
    maximumPageByteLength?: number;
    maximumLeafEntryCount?: number;
    maximumRootLeafEntryCount?: number;
    pageStore: ImmutableBTreePageStore<TKey, TEntry, TReference>;
  }) {
    if (!Number.isSafeInteger(maximumPageByteLength) || maximumPageByteLength < 1) {
      throw new RangeError("B-tree maximum page byte length must be a positive safe integer");
    }
    if (!Number.isSafeInteger(maximumLeafEntryCount) || maximumLeafEntryCount < 1) {
      throw new RangeError("B-tree maximum leaf entry count must be a positive safe integer");
    }
    if (!Number.isSafeInteger(maximumRootLeafEntryCount) || maximumRootLeafEntryCount < maximumLeafEntryCount) {
      throw new RangeError("B-tree maximum root-leaf entry count must be a safe integer no smaller than the leaf limit");
    }
    this.compareKeys = compareKeys;
    this.encodedBranchChildByteLength = encodedBranchChildByteLength;
    this.encodedLeafEntryByteLength = encodedLeafEntryByteLength;
    this.entriesEqual = entriesEqual;
    this.getEntryKey = getEntryKey;
    this.maximumPageByteLength = maximumPageByteLength;
    this.maximumLeafEntryCount = maximumLeafEntryCount;
    this.maximumRootLeafEntryCount = maximumRootLeafEntryCount;
    this.pageStore = pageStore;
  }

  private mutationKey({ mutation }: { mutation: ImmutableBTreeMutation<TKey, TEntry> }): TKey {
    switch (mutation.type) {
    case "delete": return mutation.key;
    case "set": return this.getEntryKey({ entry: mutation.entry });
    default: return mutation satisfies never;
    }
  }

  private sortedUniqueMutations({ changes }: {
    changes: readonly ImmutableBTreeMutation<TKey, TEntry>[];
  }): readonly ImmutableBTreeMutation<TKey, TEntry>[] {
    // WHY: ordinary namespace and inode updates overwhelmingly carry one key.
    // A single mutation is already sorted and unique, so copying and invoking
    // Array.sort only creates hot-path work without strengthening validation.
    if (changes.length <= 1) return changes;
    const sorted = [...changes].sort((left, right) => this.compareKeys({
      left: this.mutationKey({ mutation: left }),
      right: this.mutationKey({ mutation: right }),
    }));
    let previous: TKey | undefined;
    for (const mutation of sorted) {
      const key = this.mutationKey({ mutation });
      if (previous !== undefined && this.compareKeys({ left: previous, right: key }) === 0) {
        throw new TypeError("one B-tree mutation batch may change each key only once");
      }
      previous = key;
    }
    return sorted;
  }

  private validatedItemByteLength({ byteLength }: { byteLength: number }): number {
    if (!Number.isSafeInteger(byteLength) || byteLength < 1) {
      throw new RangeError("encoded B-tree item byte length must be a positive safe integer");
    }
    return byteLength;
  }

  private splitItems<TItem>({ itemByteLength, items, maximumItemCount }: {
    itemByteLength: ({ item }: { item: TItem }) => number;
    items: readonly TItem[];
    maximumItemCount: number;
  }): readonly (readonly TItem[])[] {
    if (items.length === 0) return [];
    const prefixByteLengths = new Array<number>(items.length + 1).fill(0);
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (item === undefined) throw new Error("B-tree item-size index invariant failed");
      const previous = prefixByteLengths[index];
      if (previous === undefined) throw new Error("B-tree item-size prefix invariant failed");
      prefixByteLengths[index + 1] = previous + this.validatedItemByteLength({ byteLength: itemByteLength({ item }) });
    }
    const rangeByteLength = ({ end, start }: { end: number; start: number }): number => {
      const endLength = prefixByteLengths[end];
      const startLength = prefixByteLengths[start];
      if (endLength === undefined || startLength === undefined) throw new Error("B-tree item-size range invariant failed");
      return COMMON_PAGE_HEADER_SIZE + endLength - startLength;
    };
    const rangeFits = ({ end, start }: { end: number; start: number }): boolean => (
      end - start <= maximumItemCount
      && rangeByteLength({ end, start }) <= this.maximumPageByteLength
    );
    const splitRange = ({ end, start }: { end: number; start: number }): readonly (readonly TItem[])[] => {
      if (rangeFits({ end, start })) {
        // WHY: the common no-split case already owns an immutable item array.
        // Preserve that array rather than cloning every page solely to wrap it
        // as one split group. Actual split ranges still receive independent
        // slices below.
        return start === 0 && end === items.length ? [items] : [items.slice(start, end)];
      }
      if (end - start === 1) throw new RangeError("one B-tree item exceeds the maximum page byte length");
      let selectedBoundary: number | undefined;
      let selectedMaximum = Number.POSITIVE_INFINITY;
      let selectedBothFit = false;
      for (let boundary = start + 1; boundary < end; boundary += 1) {
        const leftLength = rangeByteLength({ end: boundary, start });
        const rightLength = rangeByteLength({ end, start: boundary });
        const bothFit = rangeFits({ end: boundary, start }) && rangeFits({ end, start: boundary });
        const maximum = Math.max(leftLength, rightLength);
        const leftItemCount = boundary - start;
        const selectedLeftItemCount = selectedBoundary === undefined ? Number.POSITIVE_INFINITY : selectedBoundary - start;
        if (
          selectedBoundary === undefined
          || (bothFit && !selectedBothFit)
          || (bothFit === selectedBothFit && maximum < selectedMaximum)
          || (bothFit === selectedBothFit && maximum === selectedMaximum && leftItemCount < selectedLeftItemCount)
        ) {
          selectedBoundary = boundary;
          selectedMaximum = maximum;
          selectedBothFit = bothFit;
        }
      }
      if (selectedBoundary === undefined) throw new Error("B-tree split search found no non-empty boundary");
      return [
        ...splitRange({ end: selectedBoundary, start }),
        ...splitRange({ end, start: selectedBoundary }),
      ];
    };
    return splitRange({ end: items.length, start: 0 });
  }

  private async writeLeafGroups({ entries, isRootWhenSingleGroup, structural }: {
    entries: readonly TEntry[];
    isRootWhenSingleGroup: boolean;
    structural: MutableImmutableBTreeStructuralDiagnostics | undefined;
  }): Promise<readonly ReferenceSummary<TKey, TReference>[]> {
    const splitWithLimit = ({ maximumItemCount }: { maximumItemCount: number }) => this.splitItems({
      itemByteLength: ({ item }) => this.encodedLeafEntryByteLength({ entry: item }),
      items: entries,
      maximumItemCount,
    });
    // WHY: a root leaf has no parent page to rewrite. Some index owners can
    // therefore keep a larger single-page root while using smaller leaves once
    // the tree branches. If the root no longer fits its explicit root limit,
    // re-split using the ordinary child-leaf limit so no non-root leaf exceeds
    // the owner's bounded Copy-on-Write packing policy.
    const rootGroups = isRootWhenSingleGroup && this.maximumRootLeafEntryCount !== this.maximumLeafEntryCount
      ? splitWithLimit({ maximumItemCount: this.maximumRootLeafEntryCount })
      : undefined;
    const groups = rootGroups !== undefined && rootGroups.length === 1
      ? rootGroups
      : splitWithLimit({ maximumItemCount: this.maximumLeafEntryCount });
    if (structural !== undefined && groups.length > 1) {
      structural.splitOperations += 1;
      structural.splitOutputPages += groups.length;
    }
    const references: ReferenceSummary<TKey, TReference>[] = [];
    for (const group of groups) {
      const page = { entries: group, level: 0, type: "leaf" } as const;
      if (structural !== undefined) structural.pageWrites += 1;
      const reference = await this.pageStore.writePage({
        isRoot: isRootWhenSingleGroup && groups.length === 1,
        page,
      });
      const upperBoundEntry = group.at(-1);
      if (upperBoundEntry === undefined) throw new Error("B-tree split produced an empty leaf");
      references.push({
        level: 0,
        reference,
        upperBound: this.getEntryKey({ entry: upperBoundEntry }),
      });
    }
    return references;
  }

  private async writeBranchGroups({ children, isRootWhenSingleGroup, level, structural }: {
    children: readonly ImmutableBTreeBranchChild<TKey, TReference>[];
    isRootWhenSingleGroup: boolean;
    level: number;
    structural: MutableImmutableBTreeStructuralDiagnostics | undefined;
  }): Promise<readonly ReferenceSummary<TKey, TReference>[]> {
    const groups = this.splitItems({
      itemByteLength: ({ item }) => this.encodedBranchChildByteLength({ child: item }),
      items: children,
      maximumItemCount: Number.MAX_SAFE_INTEGER,
    });
    if (structural !== undefined) {
      structural.maximumPageLevel = Math.max(structural.maximumPageLevel, level);
      if (groups.length > 1) {
        structural.splitOperations += 1;
        structural.splitOutputPages += groups.length;
      }
    }
    const references: ReferenceSummary<TKey, TReference>[] = [];
    for (const group of groups) {
      const page = { children: group, level, type: "branch" } as const;
      if (structural !== undefined) structural.pageWrites += 1;
      const reference = await this.pageStore.writePage({
        isRoot: isRootWhenSingleGroup && groups.length === 1,
        page,
      });
      const upperBound = group.at(-1)?.upperBound;
      if (upperBound === undefined) throw new Error("B-tree split produced an empty branch");
      references.push({ level, reference, upperBound });
    }
    return references;
  }


  private appendMissingKeyMutation({ mutation, target }: {
    mutation: ImmutableBTreeMutation<TKey, TEntry>;
    target: TEntry[];
  }): boolean {
    switch (mutation.type) {
    case "delete": return false;
    case "set": target.push(mutation.entry); return true;
    default: {
      const exhaustive: never = mutation;
      throw new Error(`Unhandled B-tree mutation: ${((exhaustive satisfies never) as { readonly type: string }).type}`);
    }
    }
  }

  private applyExistingKeyMutation({ existing, mutation, target }: {
    existing: TEntry;
    mutation: ImmutableBTreeMutation<TKey, TEntry>;
    target: TEntry[];
  }): boolean {
    switch (mutation.type) {
    case "delete": return true;
    case "set":
      target.push(mutation.entry);
      return !this.entriesEqual({ left: existing, right: mutation.entry });
    default: {
      const exhaustive: never = mutation;
      throw new Error(`Unhandled B-tree mutation: ${((exhaustive satisfies never) as { readonly type: string }).type}`);
    }
    }
  }

  private mergeLeafChanges({ changes, entries }: {
    changes: readonly ImmutableBTreeMutation<TKey, TEntry>[];
    entries: readonly TEntry[];
  }): Readonly<{ changed: boolean; entries: readonly TEntry[] }> {
    const onlyChange = changes.length === 1 ? changes[0] : undefined;
    if (onlyChange !== undefined) return this.mergeSingleLeafChange({ entries, mutation: onlyChange });
    const next: TEntry[] = [];
    let changed = false;
    let entryIndex = 0;
    let changeIndex = 0;
    while (entryIndex < entries.length || changeIndex < changes.length) {
      const entry = entries[entryIndex];
      const change = changes[changeIndex];
      if (entry === undefined) {
        if (change === undefined) break;
        const mutationChanged = this.appendMissingKeyMutation({ mutation: change, target: next });
        changed ||= mutationChanged;
        changeIndex += 1;
        continue;
      }
      if (change === undefined) {
        next.push(...entries.slice(entryIndex));
        break;
      }
      const entryKey = this.getEntryKey({ entry });
      const changeKey = this.mutationKey({ mutation: change });
      const comparison = this.compareKeys({ left: entryKey, right: changeKey });
      if (comparison < 0) {
        next.push(entry);
        entryIndex += 1;
      } else if (comparison > 0) {
        const mutationChanged = this.appendMissingKeyMutation({ mutation: change, target: next });
        changed ||= mutationChanged;
        changeIndex += 1;
      } else {
        const mutationChanged = this.applyExistingKeyMutation({ existing: entry, mutation: change, target: next });
        changed ||= mutationChanged;
        entryIndex += 1;
        changeIndex += 1;
      }
    }
    return { changed, entries: next };
  }

  private mergeSingleLeafChange({ entries, mutation }: {
    entries: readonly TEntry[];
    mutation: ImmutableBTreeMutation<TKey, TEntry>;
  }): Readonly<{ changed: boolean; entries: readonly TEntry[] }> {
    const key = this.mutationKey({ mutation });
    const index = findLeafEntryIndex({
      compareKeys: this.compareKeys,
      entries,
      getEntryKey: this.getEntryKey,
      key,
    });
    const existing = entries[index];
    const matches = existing !== undefined && this.compareKeys({ left: this.getEntryKey({ entry: existing }), right: key }) === 0;
    switch (mutation.type) {
    case "delete": {
      if (!matches) return { changed: false, entries };
      const next = [...entries];
      next.splice(index, 1);
      return { changed: true, entries: next };
    }
    case "set": {
      if (matches) {
        if (existing === undefined) throw new Error("matched B-tree entry is missing");
        if (this.entriesEqual({ left: existing, right: mutation.entry })) return { changed: false, entries };
        const next = [...entries];
        next[index] = mutation.entry;
        return { changed: true, entries: next };
      }
      const next = [...entries];
      next.splice(index, 0, mutation.entry);
      return { changed: true, entries: next };
    }
    default: return mutation satisfies never;
    }
  }

  private async mutatePage({ changes, isRoot, reference, structural }: {
    changes: readonly ImmutableBTreeMutation<TKey, TEntry>[];
    isRoot: boolean;
    reference: TReference;
    structural: MutableImmutableBTreeStructuralDiagnostics | undefined;
  }): Promise<MutationResult<TKey, TReference>> {
    const page = await this.pageStore.readPage({ isRoot, reference });
    if (structural !== undefined) {
      structural.pageReads += 1;
      structural.maximumPageLevel = Math.max(structural.maximumPageLevel, page.level);
    }
    assertLocallyValidImmutableBTreePage({
      compareKeys: this.compareKeys,
      getEntryKey: this.getEntryKey,
      isRoot,
      page,
    });
    switch (page.type) {
    case "leaf": {
      const merged = this.mergeLeafChanges({ changes, entries: page.entries });
      if (!merged.changed) {
        if (structural !== undefined) structural.unchangedPageReuses += 1;
        return {
          changed: false,
          references: [{
            level: 0,
            reference,
            upperBound: immutableBTreePageMaximumKey({ getEntryKey: this.getEntryKey, page }),
          }],
        };
      }
      if (merged.entries.length === 0) {
        if (!isRoot) return { changed: true, references: [] };
        return {
          changed: true,
          references: [{
            level: 0,
            reference: await this.writeEmptyRootPage({ structural }),
          }],
        };
      }
      return {
        changed: true,
        references: await this.writeLeafGroups({
          entries: merged.entries,
          isRootWhenSingleGroup: isRoot,
          structural,
        }),
      };
    }
    case "branch": {
      const changesByChild = new Map<number, ImmutableBTreeMutation<TKey, TEntry>[]>();
      for (const change of changes) {
        const key = this.mutationKey({ mutation: change });
        const found = findBranchChildIndex({ children: page.children, compareKeys: this.compareKeys, key });
        if (found >= page.children.length) {
          switch (change.type) {
          case "delete": continue;
          case "set": break;
          default: {
            const exhaustive: never = change;
            throw new Error(`Unhandled B-tree mutation: ${((exhaustive satisfies never) as { readonly type: string }).type}`);
          }
          }
        }
        const childIndex = Math.min(found, page.children.length - 1);
        const bucket = changesByChild.get(childIndex) ?? [];
        bucket.push(change);
        changesByChild.set(childIndex, bucket);
      }
      if (changesByChild.size === 0) {
        const upperBound = page.children.at(-1)?.upperBound;
        if (upperBound === undefined) throw new Error("non-empty B-tree branch has no upper bound");
        return { changed: false, references: [{ level: page.level, reference, upperBound }] };
      }
      let changed = false;
      const nextChildren: ImmutableBTreeBranchChild<TKey, TReference>[] = [];
      for (let index = 0; index < page.children.length; index += 1) {
        const child = page.children[index];
        if (child === undefined) throw new Error("B-tree child index invariant failed");
        const childChanges = changesByChild.get(index);
        if (childChanges === undefined) {
          nextChildren.push(child);
          continue;
        }
        const result = await this.mutatePage({
          changes: childChanges,
          isRoot: false,
          reference: child.childPageReference,
          structural,
        });
        changed ||= result.changed;
        for (const replacement of result.references) {
          if (replacement.upperBound === undefined) throw new Error("non-root B-tree replacement is empty");
          if (replacement.level !== page.level - 1) throw new TypeError("B-tree replacement changed child level");
          nextChildren.push({
            childPageReference: replacement.reference,
            upperBound: replacement.upperBound,
          });
        }
      }
      if (!changed) {
        if (structural !== undefined) structural.unchangedPageReuses += 1;
        const upperBound = page.children.at(-1)?.upperBound;
        if (upperBound === undefined) throw new Error("non-empty B-tree branch has no upper bound");
        return { changed: false, references: [{ level: page.level, reference, upperBound }] };
      }
      if (nextChildren.length === 0) return { changed: true, references: [] };
      if (isRoot && nextChildren.length === 1) {
        if (structural !== undefined) structural.rootCollapses += 1;
        const onlyChild = nextChildren[0];
        if (onlyChild === undefined) throw new Error("B-tree root collapse child invariant failed");
        return {
          changed: true,
          references: [{
            level: page.level - 1,
            reference: onlyChild.childPageReference,
            upperBound: onlyChild.upperBound,
          }],
        };
      }
      return {
        changed: true,
        references: await this.writeBranchGroups({
          children: nextChildren,
          isRootWhenSingleGroup: isRoot,
          level: page.level,
          structural,
        }),
      };
    }
    default: return page satisfies never;
    }
  }

  private async writeEmptyRootPage({ structural }: {
    structural: MutableImmutableBTreeStructuralDiagnostics | undefined;
  }): Promise<TReference> {
    if (structural !== undefined) structural.pageWrites += 1;
    return await this.pageStore.writePage({
      isRoot: true,
      page: { entries: [], level: 0, type: "leaf" },
    });
  }

  private async buildRoot({ references, structural }: {
    references: readonly ReferenceSummary<TKey, TReference>[];
    structural: MutableImmutableBTreeStructuralDiagnostics | undefined;
  }): Promise<TReference> {
    if (references.length === 0) return await this.writeEmptyRootPage({ structural });
    let current = references;
    while (current.length > 1) {
      const childLevel = current[0]?.level;
      if (childLevel === undefined) throw new Error("B-tree root construction has no child level");
      const children: ImmutableBTreeBranchChild<TKey, TReference>[] = current.map((item) => {
        if (item.level !== childLevel) throw new TypeError("B-tree root construction mixed child levels");
        if (item.upperBound === undefined) throw new TypeError("B-tree root construction received an empty child");
        return { childPageReference: item.reference, upperBound: item.upperBound };
      });
      current = await this.writeBranchGroups({
        children,
        isRootWhenSingleGroup: true,
        level: childLevel + 1,
        structural,
      });
    }
    const root = current[0];
    if (root === undefined) throw new Error("B-tree root construction produced no root");
    return root.reference;
  }

  async createEmpty(): Promise<TReference> {
    return await measureImmutableBTreeOperation({
      diagnostics: this.pageStore.operationDiagnostics?.port,
      operation: "build",
      run: async ({ structural }) => await this.writeEmptyRootPage({ structural }),
    });
  }

  async applyChanges({ changes, rootReference }: {
    changes: readonly ImmutableBTreeMutation<TKey, TEntry>[];
    rootReference: TReference;
  }): Promise<TReference> {
    if (changes.length === 0) return rootReference;
    return await measureImmutableBTreeOperation({
      diagnostics: this.pageStore.operationDiagnostics?.port,
      operation: this.pageStore.operationDiagnostics?.operation ?? "update",
      run: async ({ structural }) => {
        const sorted = this.sortedUniqueMutations({ changes });
        if (structural !== undefined) structural.inputMutations = sorted.length;
        const result = await this.mutatePage({
          changes: sorted,
          isRoot: true,
          reference: rootReference,
          structural,
        });
        if (!result.changed) return rootReference;
        return await this.buildRoot({ references: result.references, structural });
      },
    });
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
