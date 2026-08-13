import {
  assertFileExtentBranchEntryValid,
  assertFileExtentLeafEntryValid,
  HIZOFS_V1_FORMAT_CONSTANTS,
  sameRecordReferenceFields,
  type FileExtentLeafEntry,
  type FileExtentPage,
  type FileOffset,
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
import { runtimeHomeRecordReferenceIdentity } from "@/00-storage/service/hizofs/authenticated-store/runtime-home-record-reference-identity";

export type FileExtentTreeMutation = ImmutableBTreeMutation<FileOffset, FileExtentLeafEntry>;
export type FileExtentTreePageStore = ImmutableBTreePageStore<
  FileOffset,
  FileExtentLeafEntry,
  HomeRecordReference
>;

export type FileExtentPagePort = Readonly<{
  operationDiagnostics?: Readonly<{
    operation: ImmutableBTreeDiagnosticOperation;
    port: ImmutableBTreeDiagnosticsPort;
  }>;
  readPage: ({ isRoot, reference }: {
    isRoot: boolean;
    reference: HomeRecordReference;
  }) => Promise<FileExtentPage>;
  readPageForUpdate?: ({ isRoot, reference }: {
    isRoot: boolean;
    reference: HomeRecordReference;
  }) => Promise<Readonly<{ encodedByteLength: number; localStructureValidated: true; page: FileExtentPage }> | undefined>;
  writePage: ({ isRoot, page }: {
    isRoot: boolean;
    page: FileExtentPage;
  }) => Promise<HomeRecordReference>;
}>;

function compareOffsets({ left, right }: { left: FileOffset; right: FileOffset }): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function referenceIdentity({ reference }: { reference: HomeRecordReference }): string {
  return runtimeHomeRecordReferenceIdentity({ reference });
}

function entriesEqual({ left, right }: {
  left: FileExtentLeafEntry;
  right: FileExtentLeafEntry;
}): boolean {
  return left.byteLength === right.byteLength
    && left.dataOffset === right.dataOffset
    && left.fileOffset === right.fileOffset
    // WHY: both references crossed their validation/ownership boundary before
    // becoming Extent entries. Equality only needs the complete validated
    // fields; rebuilding persisted bytes and a hex string here adds allocation
    // to every no-change check without providing additional validation.
    && sameRecordReferenceFields({ left: left.fileDataHomeRef, right: right.fileDataHomeRef });
}

export function createFileExtentTreePageStore({ pagePort }: {
  pagePort: FileExtentPagePort;
}): FileExtentTreePageStore {
  const toTreePage = ({ page }: { page: FileExtentPage }): Awaited<ReturnType<FileExtentTreePageStore["readPage"]>> => {
    switch (page.type) {
    case "leaf": return page;
    case "branch": return {
      children: page.entries.map(entry => ({
        childPageReference: entry.childPageHomeRef,
        upperBound: entry.upperBound,
      })),
      level: page.level,
      type: "branch",
    };
    default: return page satisfies never;
    }
  };
  return {
    operationDiagnostics: pagePort.operationDiagnostics,
    readPage: async ({ isRoot, reference }) => toTreePage({
      page: await pagePort.readPage({ isRoot, reference }),
    }),
    ...(pagePort.readPageForUpdate === undefined ? {} : {
      readPageForUpdate: async ({ isRoot, reference }) => {
        const loaded = await pagePort.readPageForUpdate?.({ isRoot, reference });
        if (loaded === undefined) return undefined;
        return Object.freeze({
          encodedByteLength: loaded.encodedByteLength,
          localStructureValidated: true,
          page: toTreePage({ page: loaded.page }),
        });
      },
    }),
    writePage: async ({ isRoot, page }) => {
      switch (page.type) {
      case "leaf": return await pagePort.writePage({ isRoot, page });
      case "branch": return await pagePort.writePage({
        isRoot,
        page: {
          entries: page.children.map(child => ({
            childPageHomeRef: child.childPageReference,
            upperBound: child.upperBound,
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

function createReader({ pageStore }: {
  pageStore: FileExtentTreePageStore;
}): ImmutableBTreeReader<FileOffset, FileExtentLeafEntry, HomeRecordReference> {
  return new ImmutableBTreeReader({
    compareKeys: compareOffsets,
    getEntryKey: ({ entry }) => entry.fileOffset,
    operationDiagnostics: pageStore.operationDiagnostics?.port,
    pageReader: pageStore.readPage,
    referenceIdentity,
  });
}

function createWriter({ pageStore }: {
  pageStore: FileExtentTreePageStore;
}): CanonicalBTreeWriter<FileOffset, FileExtentLeafEntry, HomeRecordReference> {
  return new CanonicalBTreeWriter({
    compareKeys: compareOffsets,
    encodedBranchChildByteLength: ({ child }) => {
      assertFileExtentBranchEntryValid({ entry: {
        childPageHomeRef: child.childPageReference,
        upperBound: child.upperBound,
      } });
      return HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.inodeBranchChild;
    },
    encodedLeafEntryByteLength: ({ entry }) => {
      assertFileExtentLeafEntryValid({ entry });
      return HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.fileExtentLeafEntry;
    },
    entriesEqual,
    getEntryKey: ({ entry }) => entry.fileOffset,
    maximumLeafEntryCount: DEFAULT_HIZOFS_INDEX_LEAF_ENTRY_LIMITS.fileExtent,
    maximumRootLeafEntryCount: DEFAULT_HIZOFS_INDEX_LEAF_ENTRY_LIMITS.fileExtentRootLeaf,
    pageStore,
  });
}

export async function applyFileExtentTreeMutations({ changes, pageStore, rootReference }: {
  changes: readonly FileExtentTreeMutation[];
  pageStore: FileExtentTreePageStore;
  rootReference: HomeRecordReference;
}): Promise<HomeRecordReference> {
  return await createWriter({ pageStore }).applyChanges({ changes, rootReference });
}

export async function* fileExtentEntriesFromFloor({ fileOffset, pageStore, rootReference }: {
  fileOffset: FileOffset;
  pageStore: FileExtentTreePageStore;
  rootReference: HomeRecordReference;
}): AsyncIterable<FileExtentLeafEntry> {
  yield* createReader({ pageStore }).entriesFromFloor({ key: fileOffset, rootReference });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
