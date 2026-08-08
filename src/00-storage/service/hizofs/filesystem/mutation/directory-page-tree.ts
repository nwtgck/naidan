import {
  compareUnsignedBytes,
  encodeDirectoryEntry,
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

function compareDirectoryNames({ left, right }: { left: string; right: string }): number {
  return compareUnsignedBytes({
    left: encodeFilenameComponent({ value: left }),
    right: encodeFilenameComponent({ value: right }),
  });
}

function bytesEqual({ left, right }: { left: Uint8Array; right: Uint8Array }): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
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

function createDirectoryPageTreeReader({ pageStore }: {
  pageStore: DirectoryPageTreePageStore;
}): ImmutableBTreeReader<string, DirectoryLeafEntry, HomeRecordReference> {
  return new ImmutableBTreeReader({
    compareKeys: compareDirectoryNames,
    getEntryKey: ({ entry }) => entry.name,
    operationDiagnostics: pageStore.operationDiagnostics?.port,
    pageReader: pageStore.readPage,
    referenceIdentity,
  });
}

function createDirectoryPageTreeWriter({ pageStore }: {
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
    compareKeys: compareDirectoryNames,
    encodedBranchChildByteLength: ({ child }) => encodedDirectoryBranchEntryByteLength({ entry: {
      childPageHomeRef: child.childPageReference,
      upperBoundName: child.upperBound,
    } }),
    encodedLeafEntryByteLength: ({ entry }) => entryBytes({ entry }).byteLength,
    entriesEqual: ({ left, right }) => bytesEqual({
      left: entryBytes({ entry: left }),
      right: entryBytes({ entry: right }),
    }),
    getEntryKey: ({ entry }) => entry.name,
    maximumLeafEntryCount: DEFAULT_HIZOFS_INDEX_LEAF_ENTRY_LIMITS.directory,
    pageStore,
  });
}

export async function readDirectoryPageTreeEntry({ name, pageStore, rootReference }: {
  name: string;
  pageStore: DirectoryPageTreePageStore;
  rootReference: HomeRecordReference;
}): Promise<DirectoryLeafEntry | undefined> {
  return await createDirectoryPageTreeReader({ pageStore }).get({ key: name, rootReference });
}

export async function applyDirectoryPageTreeMutations({ changes, pageStore, rootReference }: {
  changes: readonly DirectoryPageTreeMutation[];
  pageStore: DirectoryPageTreePageStore;
  rootReference: HomeRecordReference;
}): Promise<HomeRecordReference> {
  return await createDirectoryPageTreeWriter({ pageStore }).applyChanges({ changes, rootReference });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
