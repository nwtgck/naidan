import {
  compareUnsignedBytes,
  encodeDirectoryEntry,
  encodedDirectoryLeafEntryByteLength,
  encodedDirectoryBranchEntryByteLength,
  encodeFilenameComponent,
  encodeHomeRecordReference,
  type DirectoryLeafEntry,
  type DirectoryPage,
  type HomeRecordReference,
} from "@/00-storage/service/hizofs/00-format";
import {
  CanonicalBTreeWriter,
  type ImmutableBTreeMutation,
  type ImmutableBTreePageStore,
} from "@/00-storage/service/hizofs/indexes/canonical-btree-writer";
import { DEFAULT_HIZOFS_INDEX_LEAF_ENTRY_LIMITS } from "@/00-storage/service/hizofs/filesystem/mutation/index-leaf-packing-policy";
import type {
  ImmutableBTreeDiagnosticOperation,
  ImmutableBTreeDiagnosticsPort,
} from "@/00-storage/service/hizofs/diagnostics/immutable-btree-diagnostics";
import { ImmutableBTreeReader } from "@/00-storage/service/hizofs/indexes/immutable-btree-reader";
import type { CompareImmutableBTreeKeys } from "@/00-storage/service/hizofs/indexes/ordering";

export type DirectoryPageTreeMutation = ImmutableBTreeMutation<string, DirectoryLeafEntry>;
export type DirectoryPageTreePageStore = ImmutableBTreePageStore<
  string,
  DirectoryLeafEntry,
  HomeRecordReference
>;

export type ReadDirectoryPage = ({
  isRoot,
  reference,
}: {
  isRoot: boolean;
  reference: HomeRecordReference;
}) => Promise<DirectoryPage>;

export type WriteDirectoryPage = ({
  isRoot,
  page,
}: {
  isRoot: boolean;
  page: DirectoryPage;
}) => Promise<HomeRecordReference>;

export type DirectoryPagePort = Readonly<{
  operationDiagnostics?: Readonly<{
    operation: ImmutableBTreeDiagnosticOperation;
    port: ImmutableBTreeDiagnosticsPort;
  }>;
  readPage: ReadDirectoryPage;
  writePage: WriteDirectoryPage;
}>;

function createDirectoryNameComparator(): Readonly<{
  compareKeys: CompareImmutableBTreeKeys<string>;
  dispose: () => void;
}> {
  // WHY: immutable B-tree traversal compares the same page names repeatedly.
  // Keep canonical bytes only for this operation and explicitly zeroize them
  // afterwards; this removes repeated encoding without creating a long-lived
  // plaintext filename cache or changing unsigned UTF-8 ordering.
  const encodedNames = new Map<string, Uint8Array>();
  let disposed = false;
  const encodedName = ({ value }: { value: string }): Uint8Array => {
    if (disposed) throw new Error("directory name comparator is disposed");
    const cached = encodedNames.get(value);
    if (cached !== undefined) return cached;
    const encoded = encodeFilenameComponent({ value });
    encodedNames.set(value, encoded);
    return encoded;
  };
  return {
    compareKeys: ({ left, right }) => compareUnsignedBytes({
      left: encodedName({ value: left }),
      right: encodedName({ value: right }),
    }),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const bytes of encodedNames.values()) bytes.fill(0);
      encodedNames.clear();
    },
  };
}

function bytesEqual({ left, right }: { left: Uint8Array; right: Uint8Array }): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function referenceIdentity({ reference }: { reference: HomeRecordReference }): string {
  let identity = "";
  for (const byte of encodeHomeRecordReference({ reference })) {
    identity += byte.toString(16).padStart(2, "0");
  }
  return identity;
}

export function createDirectoryPageTreePageStore({ pagePort }: {
  pagePort: DirectoryPagePort;
}): DirectoryPageTreePageStore {
  return {
    operationDiagnostics: pagePort.operationDiagnostics,
    readPage: async ({ isRoot, reference }) => {
      const page = await pagePort.readPage({ isRoot, reference });
      switch (page.type) {
      case "leaf": return page;
      case "branch": return {
        children: page.entries.map(entry => ({
          childPageReference: entry.childPageHomeRef,
          upperBound: entry.upperBoundName,
        })),
        level: page.level,
        type: "branch",
      };
      default: return page satisfies never;
      }
    },
    writePage: async ({ isRoot, page }) => {
      switch (page.type) {
      case "leaf": return await pagePort.writePage({ isRoot, page });
      case "branch": return await pagePort.writePage({
        isRoot,
        page: {
          entries: page.children.map(child => ({
            childPageHomeRef: child.childPageReference,
            upperBoundName: child.upperBound,
          })),
          level: page.level,
          type: "branch",
        },
      });
      default: return page satisfies never;
      }
    },
  };
}

function createDirectoryPageTreeReader({ compareKeys, pageStore }: {
  compareKeys: CompareImmutableBTreeKeys<string>;
  pageStore: DirectoryPageTreePageStore;
}): ImmutableBTreeReader<string, DirectoryLeafEntry, HomeRecordReference> {
  return new ImmutableBTreeReader({
    compareKeys,
    getEntryKey: ({ entry }) => entry.name,
    operationDiagnostics: pageStore.operationDiagnostics?.port,
    pageReader: pageStore.readPage,
    referenceIdentity,
  });
}

function createDirectoryPageTreeWriter({ compareKeys, pageStore }: {
  compareKeys: CompareImmutableBTreeKeys<string>;
  pageStore: DirectoryPageTreePageStore;
}): CanonicalBTreeWriter<string, DirectoryLeafEntry, HomeRecordReference> {
  const encodedEntries = new WeakMap<DirectoryLeafEntry, Uint8Array>();
  const entryBytes = ({ entry }: { entry: DirectoryLeafEntry }): Uint8Array => {
    const cached = encodedEntries.get(entry);
    if (cached !== undefined) return cached;
    const encoded = encodeDirectoryEntry({ entry });
    encodedEntries.set(entry, encoded);
    return encoded;
  };
  return new CanonicalBTreeWriter({
    compareKeys,
    encodedBranchChildByteLength: ({ child }) => encodedDirectoryBranchEntryByteLength({ entry: {
      childPageHomeRef: child.childPageReference,
      upperBoundName: child.upperBound,
    } }),
    encodedLeafEntryByteLength: ({ entry }) => encodedDirectoryLeafEntryByteLength({ entry }),
    entriesEqual: ({ left, right }) => bytesEqual({
      left: entryBytes({ entry: left }),
      right: entryBytes({ entry: right }),
    }),
    getEntryKey: ({ entry }) => entry.name,
    maximumLeafEntryCount: DEFAULT_HIZOFS_INDEX_LEAF_ENTRY_LIMITS.directory,
    pageStore,
  });
}

export type DirectoryPageTreeOperation = Readonly<{
  applyMutations({ changes, rootReference }: {
    changes: readonly DirectoryPageTreeMutation[];
    rootReference: HomeRecordReference;
  }): Promise<HomeRecordReference>;
  dispose(): void;
  readEntry({ name, rootReference }: {
    name: string;
    rootReference: HomeRecordReference;
  }): Promise<DirectoryLeafEntry | undefined>;
}>;

export function createDirectoryPageTreeOperation({ pageStore }: {
  pageStore: DirectoryPageTreePageStore;
}): DirectoryPageTreeOperation {
  const comparator = createDirectoryNameComparator();
  let disposed = false;
  const requireActive = (): void => {
    if (disposed) throw new TypeError("Directory Page tree operation is disposed");
  };
  return Object.freeze({
    applyMutations: async ({ changes, rootReference }) => {
      requireActive();
      return await createDirectoryPageTreeWriter({ compareKeys: comparator.compareKeys, pageStore })
        .applyChanges({ changes, rootReference });
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      comparator.dispose();
    },
    readEntry: async ({ name, rootReference }) => {
      requireActive();
      return await createDirectoryPageTreeReader({ compareKeys: comparator.compareKeys, pageStore })
        .get({ key: name, rootReference });
    },
  });
}

export async function readDirectoryPageTreeEntry({ name, pageStore, rootReference }: {
  name: string;
  pageStore: DirectoryPageTreePageStore;
  rootReference: HomeRecordReference;
}): Promise<DirectoryLeafEntry | undefined> {
  const operation = createDirectoryPageTreeOperation({ pageStore });
  try {
    return await operation.readEntry({ name, rootReference });
  } finally {
    operation.dispose();
  }
}

export async function applyDirectoryPageTreeMutations({ changes, pageStore, rootReference }: {
  changes: readonly DirectoryPageTreeMutation[];
  pageStore: DirectoryPageTreePageStore;
  rootReference: HomeRecordReference;
}): Promise<HomeRecordReference> {
  const operation = createDirectoryPageTreeOperation({ pageStore });
  try {
    return await operation.applyMutations({ changes, rootReference });
  } finally {
    operation.dispose();
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
