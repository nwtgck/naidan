import {
  UINT64_MAXIMUM,
  createInodeRevision,
  assertInodeLeafEntryFitsMetadataPage,
  type DirectoryInodeEntry,
  type DirectoryLeafEntry,
  type HomeRecordReference,
} from "@/00-storage/service/hizofs/00-format";
import {
  applyDirectoryPageTreeMutations,
  readDirectoryPageTreeEntry,
  type DirectoryPageTreePageStore,
} from "@/00-storage/service/hizofs/filesystem/mutation/directory-page-tree";
import type { RootInodeTableMutation } from "@/00-storage/service/hizofs/filesystem/mutation/root-inode-table-mutation";
import type { OrdinaryEntryCreatePlan } from "@/00-storage/service/hizofs/filesystem/namespace/ordinary-entry-create-plan";

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
  private readonly pageStore: DirectoryPageTreePageStore;
  private readonly parent: DirectoryInodeEntry;
  private readonly rootReference: HomeRecordReference;

  private constructor({ entryName, existingEntry, pageStore, parent, rootReference }: {
    entryName: string;
    existingEntry: DirectoryLeafEntry | undefined;
    pageStore: DirectoryPageTreePageStore;
    parent: DirectoryInodeEntry;
    rootReference: HomeRecordReference;
  }) {
    this.destinationExists = existingEntry !== undefined;
    this.existingEntry = existingEntry;
    this.entryName = entryName;
    this.pageStore = pageStore;
    this.parent = parent;
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
    const existing = await readDirectoryPageTreeEntry({
      name: entryName,
      pageStore,
      rootReference,
    });
    return new CapturedTreeBackedDirectoryCreateDestination({
      entryName,
      existingEntry: existing,
      pageStore,
      parent,
      rootReference,
    });
  }

  async prepareMutation({ plan }: {
    plan: OrdinaryEntryCreatePlan;
  }): Promise<TreeBackedDirectoryCreateMutation> {
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
    const nextRootReference = await applyDirectoryPageTreeMutations({
      changes: [{ entry: plan.directoryEntry, type: "set" }],
      pageStore: this.pageStore,
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
