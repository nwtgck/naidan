import {
  UINT64_MAXIMUM,
  createInodeRevision,
  assertInodeLeafEntryFitsMetadataPage,
  type DirectoryInodeEntry,
  type DirectoryLeafEntry,
  type HomeRecordReference,
} from "@/00-storage/service/hizofs/00-format";
import {
  createDirectoryPageTreeOperation,
  type DirectoryPageTreeOperation,
  type DirectoryPageTreePageStore,
} from "@/00-storage/service/hizofs/filesystem/mutation/directory-page-tree";
import type { RootInodeTableMutation } from "@/00-storage/service/hizofs/filesystem/mutation/root-inode-table-mutation";
import type { OrdinaryEntryCreatePlan } from "@/00-storage/service/hizofs/filesystem/namespace/ordinary-entry-create-plan";
import { runtimeHomeRecordReferenceIdentity } from "@/00-storage/service/hizofs/authenticated-store/runtime-home-record-reference-identity";

export type TreeBackedDirectoryCreateMutationErrorCode =
  | "destination_exists"
  | "parent_identity_mismatch"
  | "parent_inline_not_supported"
  | "parent_revision_exhausted";

export class TreeBackedDirectoryCreateMutationError extends Error {
  readonly code: TreeBackedDirectoryCreateMutationErrorCode;

  constructor({ code, message }: {
    code: TreeBackedDirectoryCreateMutationErrorCode;
    message: string;
  }) {
    super(message);
    this.name = "TreeBackedDirectoryCreateMutationError";
    this.code = code;
  }
}

export type TreeBackedDirectoryCreateMutation = Readonly<{
  changes: readonly RootInodeTableMutation[];
  updatedParent: DirectoryInodeEntry;
}>;

type CapturedDirectoryPageStore = Readonly<{
  pageStore: DirectoryPageTreePageStore;
  release: () => void;
}>;

function createCapturedDirectoryPageStore({ pageStore }: {
  pageStore: DirectoryPageTreePageStore;
}): CapturedDirectoryPageStore {
  type Page = Awaited<ReturnType<DirectoryPageTreePageStore["readPage"]>>;
  type LoadedPage = Exclude<
    Awaited<ReturnType<NonNullable<DirectoryPageTreePageStore["readPageForUpdate"]>>>,
    undefined
  >;
  const pages = new Map<string, Page>();
  const loadedPages = new Map<string, LoadedPage>();
  let released = false;
  const identity = ({ isRoot, reference }: { isRoot: boolean; reference: HomeRecordReference }): string => (
    `${isRoot ? "root" : "non_root"}:${runtimeHomeRecordReferenceIdentity({ reference })}`
  );
  const release = (): void => {
    if (released) return;
    released = true;
    pages.clear();
    loadedPages.clear();
  };
  return Object.freeze({
    pageStore: {
      operationDiagnostics: pageStore.operationDiagnostics,
      readPage: async ({ isRoot, reference }) => {
        if (released) throw new TypeError("captured Directory page store is released");
        const key = identity({ isRoot, reference });
        const captured = pages.get(key);
        if (captured !== undefined) return captured;
        const updateReader = pageStore.readPageForUpdate;
        if (updateReader !== undefined) {
          const loaded = await updateReader({ isRoot, reference });
          if (released) throw new TypeError("captured Directory page store was released while reading");
          if (loaded !== undefined) {
            pages.set(key, loaded.page);
            loadedPages.set(key, loaded);
            return loaded.page;
          }
        }
        const page = await pageStore.readPage({ isRoot, reference });
        if (released) throw new TypeError("captured Directory page store was released while reading");
        pages.set(key, page);
        return page;
      },
      ...(pageStore.readPageForUpdate === undefined ? {} : {
        readPageForUpdate: async ({ isRoot, reference }: { isRoot: boolean; reference: HomeRecordReference }) => {
          if (released) throw new TypeError("captured Directory page store is released");
          const key = identity({ isRoot, reference });
          const captured = loadedPages.get(key);
          if (captured !== undefined) return captured;
          const loaded = await pageStore.readPageForUpdate?.({ isRoot, reference });
          if (released) throw new TypeError("captured Directory page store was released while reading");
          if (loaded === undefined) return undefined;
          pages.set(key, loaded.page);
          loadedPages.set(key, loaded);
          return loaded;
        },
      }),
      writePage: async ({ isRoot, page }) => {
        if (released) throw new TypeError("captured Directory page store is released");
        return await pageStore.writePage({ isRoot, page });
      },
    },
    release,
  });
}

/**
 * Captures one destination lookup against an immutable tree root and keeps the
 * exact parent/page-store capability with that result. The private constructor
 * prevents callers from fabricating an "absent" result to skip the required
 * lookup before a create mutation.
 */
export class CapturedTreeBackedDirectoryCreateDestination {
  readonly destinationExists: boolean;
  readonly existingEntry: DirectoryLeafEntry | undefined;
  private readonly entryName: string;
  private readonly operation: DirectoryPageTreeOperation;
  private readonly parent: DirectoryInodeEntry;
  private readonly releaseCapturedPages: () => void;
  private readonly rootReference: HomeRecordReference;

  private constructor({ entryName, existingEntry, operation, parent, releaseCapturedPages, rootReference }: {
    entryName: string;
    existingEntry: DirectoryLeafEntry | undefined;
    operation: DirectoryPageTreeOperation;
    parent: DirectoryInodeEntry;
    releaseCapturedPages: () => void;
    rootReference: HomeRecordReference;
  }) {
    this.destinationExists = existingEntry !== undefined;
    this.existingEntry = existingEntry;
    this.entryName = entryName;
    this.operation = operation;
    this.parent = parent;
    this.releaseCapturedPages = releaseCapturedPages;
    this.rootReference = rootReference;
  }

  static async capture({ entryName, pageStore, parent }: {
    entryName: string;
    pageStore: DirectoryPageTreePageStore;
    parent: DirectoryInodeEntry;
  }): Promise<CapturedTreeBackedDirectoryCreateDestination> {
    const rootReference = (() => {
      switch (parent.content.type) {
      case "tree": return parent.content.directoryTreeRootHomeRef;
      case "inline": throw new TreeBackedDirectoryCreateMutationError({
        code: "parent_inline_not_supported",
        message: "inline directory creation requires the inline directory mutation executor",
      });
      default: return parent.content satisfies never;
      }
    })();
    // WHY: the destination lookup and the immediately following Copy-on-Write
    // update traverse the same immutable root. Retain only the pages read by
    // this one capture so the update can reuse their authenticated decode
    // instead of reading the exact same references twice. The capture is
    // released after preparation and never becomes cross-mutation state.
    const captured = createCapturedDirectoryPageStore({ pageStore });
    const operation = createDirectoryPageTreeOperation({ pageStore: captured.pageStore });
    const releaseCapturedOperation = (): void => {
      operation.dispose();
      captured.release();
    };
    try {
      const existing = await operation.readEntry({ name: entryName, rootReference });
      return new CapturedTreeBackedDirectoryCreateDestination({
        entryName,
        existingEntry: existing,
        operation,
        parent,
        releaseCapturedPages: releaseCapturedOperation,
        rootReference,
      });
    } catch (cause: unknown) {
      releaseCapturedOperation();
      throw cause;
    }
  }

  release(): void {
    this.releaseCapturedPages();
  }

  async prepareMutation({ plan }: {
    plan: OrdinaryEntryCreatePlan;
  }): Promise<TreeBackedDirectoryCreateMutation> {
    try {
      if (this.parent.inodeNumber !== plan.parentDirectoryInodeNumber) {
        throw new TreeBackedDirectoryCreateMutationError({
          code: "parent_identity_mismatch",
          message: "tree-backed directory create plan does not target the captured parent inode",
        });
      }
      if (this.parent.inodeRevision === UINT64_MAXIMUM) {
        throw new TreeBackedDirectoryCreateMutationError({
          code: "parent_revision_exhausted",
          message: "tree-backed directory parent revision is exhausted",
        });
      }
      if (plan.directoryEntry.name !== this.entryName) {
        throw new TypeError("tree-backed directory create plan does not match the captured destination name");
      }
      if (this.destinationExists) {
        throw new TreeBackedDirectoryCreateMutationError({
          code: "destination_exists",
          message: "tree-backed directory destination changed after creation planning",
        });
      }
      const nextRootReference = await this.operation.applyMutations({
        changes: [{ entry: plan.directoryEntry, type: "set" }],
        rootReference: this.rootReference,
      });
      if (nextRootReference === this.rootReference) {
        throw new Error("tree-backed directory creation unexpectedly produced no Directory Page change");
      }
      const updatedParent: DirectoryInodeEntry = {
        ...this.parent,
        content: {
          directoryTreeRootHomeRef: nextRootReference,
          type: "tree",
        },
        inodeRevision: createInodeRevision({ value: this.parent.inodeRevision + 1n }),
        timestamps: {
          ...this.parent.timestamps,
          modifiedAt: plan.inode.timestamps.modifiedAt,
        },
      };

      // The authoritative inode codec validates the replacement Directory root
      // reference and all persisted parent fields before the Inode Table changes exist.
      assertInodeLeafEntryFitsMetadataPage({ entry: updatedParent });

      return {
        changes: [
          { entry: updatedParent, type: "set" },
          { entry: plan.inode, type: "set" },
        ],
        updatedParent,
      };
    } finally {
      this.releaseCapturedPages();
    }
  }
}

export async function prepareTreeBackedDirectoryCreateMutation({ pageStore, parent, plan }: {
  pageStore: DirectoryPageTreePageStore;
  parent: DirectoryInodeEntry;
  plan: OrdinaryEntryCreatePlan;
}): Promise<TreeBackedDirectoryCreateMutation> {
  // Keep the standalone mutation helper defensive: callers that do not own an
  // earlier capture must still verify the destination exactly once.
  const capturedDestination = await CapturedTreeBackedDirectoryCreateDestination.capture({
    entryName: plan.directoryEntry.name,
    pageStore,
    parent,
  });
  return await capturedDestination.prepareMutation({ plan });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
