import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createCommitSequence,
  createFileSystemCommitPayload,
  encodeInodeLeafEntry,
  encodedInodeLeafEntryByteLength,
  parseMutationId,
  type FileSystemCommitPayload,
  type HomeRecordReference,
  type InodeBranchPage,
  type InodeLeafEntry,
  type InodeLeafPage,
  type InodeNumber,
  type MutationId,
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

export type RootInodeTableMutation = ImmutableBTreeMutation<InodeNumber, InodeLeafEntry>;
export type RootInodeTablePageStore = ImmutableBTreePageStore<
  InodeNumber,
  InodeLeafEntry,
  HomeRecordReference
>;

export type RootInodeTablePage =
  | InodeLeafPage
  | Readonly<{ entries: InodeBranchPage["entries"]; level: number; type: "branch" }>;

export type ReadRootInodeTablePage = ({
  isRoot,
  reference,
}: {
  isRoot: boolean;
  reference: HomeRecordReference;
}) => Promise<RootInodeTablePage>;

export type WriteRootInodeTablePage = ({
  isRoot,
  page,
}: {
  isRoot: boolean;
  page: RootInodeTablePage;
}) => Promise<HomeRecordReference>;

export type RootInodeTablePagePort = Readonly<{
  operationDiagnostics?: Readonly<{
    operation: ImmutableBTreeDiagnosticOperation;
    port: ImmutableBTreeDiagnosticsPort;
  }>;
  readPage: ReadRootInodeTablePage;
  readPageForUpdate?: ({ isRoot, reference }: {
    isRoot: boolean;
    reference: HomeRecordReference;
  }) => Promise<Readonly<{ encodedByteLength: number; localStructureValidated: true; page: RootInodeTablePage }> | undefined>;
  writePage: WriteRootInodeTablePage;
}>;

export function createRootInodeTablePageStore({ pagePort }: {
  pagePort: RootInodeTablePagePort;
}): RootInodeTablePageStore {
  const toTreePage = ({ page }: { page: RootInodeTablePage }): Awaited<ReturnType<RootInodeTablePageStore["readPage"]>> => {
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

export type PreparedRootInodeTableMutation =
  | Readonly<{ type: "unchanged" }>
  | Readonly<{
    commitPayload: FileSystemCommitPayload;
    type: "prepared";
  }>;

function bytesEqual({ left, right }: { left: Uint8Array; right: Uint8Array }): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function sameMutationId({ left, right }: { left: MutationId; right: MutationId }): boolean {
  return bytesEqual({ left, right });
}

export async function applyRootInodeTableMutations({
  changes,
  pageStore,
  rootReference,
}: {
  changes: readonly RootInodeTableMutation[];
  pageStore: RootInodeTablePageStore;
  rootReference: HomeRecordReference;
}): Promise<HomeRecordReference> {
  const encodedEntries = new WeakMap<InodeLeafEntry, Uint8Array>();
  const entryBytes = ({ entry }: { entry: InodeLeafEntry }): Uint8Array => {
    const cached = encodedEntries.get(entry);
    if (cached !== undefined) return cached;
    const encoded = encodeInodeLeafEntry({ entry });
    encodedEntries.set(entry, encoded);
    return encoded;
  };
  const writer = new CanonicalBTreeWriter<InodeNumber, InodeLeafEntry, HomeRecordReference>({
    compareKeys: ({ left, right }) => left < right ? -1 : left > right ? 1 : 0,
    encodedBranchChildByteLength: () => HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.inodeBranchChild,
    encodedLeafEntryByteLength: ({ entry }) => encodedInodeLeafEntryByteLength({ entry }),
    entriesEqual: ({ left, right }) => left.inodeRevision === right.inodeRevision && bytesEqual({
      left: entryBytes({ entry: left }),
      right: entryBytes({ entry: right }),
    }),
    getEntryKey: ({ entry }) => entry.inodeNumber,
    maximumLeafEntryCount: DEFAULT_HIZOFS_INDEX_LEAF_ENTRY_LIMITS.rootInodeTable,
    pageStore,
  });
  return await writer.applyChanges({ changes, rootReference });
}

export async function prepareRootInodeTableMutation({
  baseCommit,
  changes,
  mutationId,
  pageStore,
}: {
  baseCommit: FileSystemCommitPayload;
  changes: readonly RootInodeTableMutation[];
  mutationId: MutationId;
  pageStore: RootInodeTablePageStore;
}): Promise<PreparedRootInodeTableMutation> {
  const freshMutationId = parseMutationId({ bytes: mutationId });
  if (sameMutationId({ left: baseCommit.mutationId, right: freshMutationId })) {
    throw new TypeError("prepared mutation requires a fresh Mutation ID");
  }
  const nextRoot = await applyRootInodeTableMutations({
    changes,
    pageStore,
    rootReference: baseCommit.rootInodeTableRootHomeRef,
  });
  if (nextRoot === baseCommit.rootInodeTableRootHomeRef) return { type: "unchanged" };
  return {
    commitPayload: createFileSystemCommitPayload({ payload: {
      ...baseCommit,
      commitSequence: createCommitSequence({ value: baseCommit.commitSequence + 1n }),
      mutationId: freshMutationId,
      rootInodeTableRootHomeRef: nextRoot,
    } }),
    type: "prepared",
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
