import {
  UINT64_MAXIMUM,
  createInodeRevision,
  encodeInodeLeafPage,
  type DirectoryInodeEntry,
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

export async function prepareTreeBackedDirectoryCreateMutation({ pageStore, parent, plan }: {
  pageStore: DirectoryPageTreePageStore;
  parent: DirectoryInodeEntry;
  plan: OrdinaryEntryCreatePlan;
}): Promise<TreeBackedDirectoryCreateMutation> {
  if (parent.inodeNumber !== plan.parentDirectoryInodeNumber) {
    throw new TreeBackedDirectoryCreateMutationError({
      code: "parent_identity_mismatch",
      message: "tree-backed directory create plan does not target the captured parent inode",
    });
  }
  if (parent.inodeRevision === UINT64_MAXIMUM) {
    throw new TreeBackedDirectoryCreateMutationError({
      code: "parent_revision_exhausted",
      message: "tree-backed directory parent revision is exhausted",
    });
  }
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
    name: plan.directoryEntry.name,
    pageStore,
    rootReference,
  });
  if (existing !== undefined) {
    throw new TreeBackedDirectoryCreateMutationError({
      code: "destination_exists",
      message: "tree-backed directory destination changed after creation planning",
    });
  }
  const nextRootReference = await applyDirectoryPageTreeMutations({
    changes: [{ entry: plan.directoryEntry, type: "set" }],
    pageStore,
    rootReference,
  });
  if (nextRootReference === rootReference) {
    throw new Error("tree-backed directory creation unexpectedly produced no Directory Page change");
  }
  const updatedParent: DirectoryInodeEntry = {
    ...parent,
    content: {
      directoryTreeRootHomeRef: nextRootReference,
      type: "tree",
    },
    inodeRevision: createInodeRevision({ value: parent.inodeRevision + 1n }),
    timestamps: {
      ...parent.timestamps,
      modifiedAt: plan.inode.timestamps.modifiedAt,
    },
  };

  // The authoritative inode codec validates the replacement Directory root
  // reference and all persisted parent fields before the Inode Table changes exist.
  encodeInodeLeafPage({ entries: [updatedParent], isRoot: false });

  return {
    changes: [
      { entry: updatedParent, type: "set" },
      { entry: plan.inode, type: "set" },
    ],
    updatedParent,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
