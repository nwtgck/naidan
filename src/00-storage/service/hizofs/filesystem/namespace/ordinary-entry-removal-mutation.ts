import {
  UINT64_MAXIMUM,
  createInodeRevision,
  assertInodeLeafEntryFitsMetadataPage,
  type DirectoryInodeEntry,
  type DirectoryLeafEntry,
  type TimestampMilliseconds,
} from "@/00-storage/service/hizofs/00-format";
import {
  applyDirectoryPageTreeMutations,
  readDirectoryPageTreeEntry,
  type DirectoryPageTreePageStore,
} from "@/00-storage/service/hizofs/filesystem/mutation/directory-page-tree";
import type { RootInodeTableMutation } from "@/00-storage/service/hizofs/filesystem/mutation/root-inode-table-mutation";
import type { OrdinaryEntryRemovalTarget } from "@/00-storage/service/hizofs/filesystem/namespace/ordinary-entry-removal-plan";

export type OrdinaryEntryRemovalMutationErrorCode =
  | "parent_identity_mismatch"
  | "parent_revision_exhausted"
  | "source_identity_mismatch"
  | "source_missing";

export class OrdinaryEntryRemovalMutationError extends Error {
  readonly code: OrdinaryEntryRemovalMutationErrorCode;

  constructor({ code, message }: { code: OrdinaryEntryRemovalMutationErrorCode; message: string }) {
    super(message);
    this.name = "OrdinaryEntryRemovalMutationError";
    this.code = code;
  }
}

export type OrdinaryEntryRemovalMutation = Readonly<{
  parentChange: RootInodeTableMutation;
  updatedParent: DirectoryInodeEntry;
}>;

function requireCapturedSource({ entry, plan }: {
  entry: DirectoryLeafEntry | undefined;
  plan: OrdinaryEntryRemovalTarget;
}): void {
  if (entry === undefined) {
    throw new OrdinaryEntryRemovalMutationError({
      code: "source_missing",
      message: "ordinary removal source changed after planning",
    });
  }
  switch (entry.targetType) {
  case "inode":
    if (entry.inodeNumber === plan.sourceInodeNumber) return;
    throw new OrdinaryEntryRemovalMutationError({
      code: "source_identity_mismatch",
      message: "ordinary removal source inode changed after planning",
    });
  case "subvolume":
    throw new OrdinaryEntryRemovalMutationError({
      code: "source_identity_mismatch",
      message: "ordinary removal source became a mounted Subvolume",
    });
  default: return entry satisfies never;
  }
}

/**
 * Removes only the captured parent binding and prepares its replacement inode.
 * Descendant inode deletions remain separate Root Inode Table mutations so the
 * caller can apply bounded batches without publishing an intermediate tree.
 */
export async function prepareOrdinaryEntryRemovalMutation({
  directoryPageStore,
  operationTimestamp,
  parent,
  plan,
}: {
  directoryPageStore: DirectoryPageTreePageStore;
  operationTimestamp: TimestampMilliseconds;
  parent: DirectoryInodeEntry;
  plan: OrdinaryEntryRemovalTarget;
}): Promise<OrdinaryEntryRemovalMutation> {
  if (parent.inodeNumber !== plan.parentDirectoryInodeNumber) {
    throw new OrdinaryEntryRemovalMutationError({
      code: "parent_identity_mismatch",
      message: "ordinary removal plan does not target the captured parent inode",
    });
  }
  if (parent.inodeRevision === UINT64_MAXIMUM) {
    throw new OrdinaryEntryRemovalMutationError({
      code: "parent_revision_exhausted",
      message: "ordinary removal parent revision is exhausted",
    });
  }

  const content: DirectoryInodeEntry["content"] = await (async () => {
    switch (parent.content.type) {
    case "inline": {
      const existing = parent.content.entries.find(entry => entry.name === plan.parentRemovalName);
      requireCapturedSource({ entry: existing, plan });
      return {
        entries: parent.content.entries.filter(entry => entry.name !== plan.parentRemovalName),
        type: "inline",
      };
    }
    case "tree": {
      const currentRoot = parent.content.directoryTreeRootHomeRef;
      const existing = await readDirectoryPageTreeEntry({
        name: plan.parentRemovalName,
        pageStore: directoryPageStore,
        rootReference: currentRoot,
      });
      requireCapturedSource({ entry: existing, plan });
      const nextRoot = await applyDirectoryPageTreeMutations({
        changes: [{ key: plan.parentRemovalName, type: "delete" }],
        pageStore: directoryPageStore,
        rootReference: currentRoot,
      });
      if (nextRoot === currentRoot) {
        throw new Error("tree-backed ordinary removal unexpectedly produced no Directory Page change");
      }
      return { directoryTreeRootHomeRef: nextRoot, type: "tree" };
    }
    default: return parent.content satisfies never;
    }
  })();

  const updatedParent: DirectoryInodeEntry = {
    ...parent,
    content,
    inodeRevision: createInodeRevision({ value: parent.inodeRevision + 1n }),
    timestamps: { ...parent.timestamps, modifiedAt: operationTimestamp },
  };
  assertInodeLeafEntryFitsMetadataPage({ entry: updatedParent });
  return {
    parentChange: { entry: updatedParent, type: "set" },
    updatedParent,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
