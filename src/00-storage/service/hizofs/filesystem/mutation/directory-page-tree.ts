import {
  COMMON_PAGE_HEADER_SIZE,
  compareUnsignedBytes,
  encodeDirectoryEntry,
  encodeDirectoryPage,
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
  return new CanonicalBTreeWriter({
    compareKeys: compareDirectoryNames,
    encodedBranchChildByteLength: ({ child }) => encodeDirectoryPage({
      isRoot: false,
      page: {
        entries: [{
          childPageHomeRef: child.childPageReference,
          upperBoundName: child.upperBound,
        }],
        level: 1,
        type: "branch",
      },
    }).byteLength - COMMON_PAGE_HEADER_SIZE,
    encodedLeafEntryByteLength: ({ entry }) => encodeDirectoryEntry({ entry }).byteLength,
    entriesEqual: ({ left, right }) => bytesEqual({
      left: encodeDirectoryEntry({ entry: left }),
      right: encodeDirectoryEntry({ entry: right }),
    }),
    getEntryKey: ({ entry }) => entry.name,
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
