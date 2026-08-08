import {
  UINT64_MAXIMUM,
  compareUnsignedBytes,
  createInodeRevision,
  encodeDirectoryEntry,
  encodeFilenameComponent,
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
import type { WholeFileReflinkPlan } from "@/00-storage/service/hizofs/filesystem/reflink/whole-file-reflink-plan";

export type WholeFileReflinkMutationErrorCode =
  | "destination_changed"
  | "destination_parent_identity_mismatch"
  | "parent_revision_exhausted";

export class WholeFileReflinkMutationError extends Error {
  readonly code: WholeFileReflinkMutationErrorCode;

  constructor({ code, message }: { code: WholeFileReflinkMutationErrorCode; message: string }) {
    super(message);
    this.name = "WholeFileReflinkMutationError";
    this.code = code;
  }
}

export type WholeFileReflinkMutation = Readonly<{
  rootInodeTableChanges: readonly RootInodeTableMutation[];
  updatedDestinationParent: DirectoryInodeEntry;
}>;

function entriesEqual({ left, right }: {
  left: DirectoryLeafEntry;
  right: DirectoryLeafEntry;
}): boolean {
  const leftBytes = encodeDirectoryEntry({ entry: left });
  const rightBytes = encodeDirectoryEntry({ entry: right });
  return leftBytes.byteLength === rightBytes.byteLength
    && leftBytes.every((byte, index) => byte === rightBytes[index]);
}

function requireDestinationBinding({ entry, plan }: {
  entry: DirectoryLeafEntry | undefined;
  plan: WholeFileReflinkPlan;
}): void {
  if (plan.expectedDestinationEntry === null) {
    if (entry === undefined) return;
  } else if (
    entry !== undefined
    && entriesEqual({ left: entry, right: plan.expectedDestinationEntry })
  ) {
    return;
  }
  throw new WholeFileReflinkMutationError({
    code: "destination_changed",
    message: "whole-file reflink destination changed after planning",
  });
}

function compareDirectoryEntries({ left, right }: {
  left: DirectoryLeafEntry;
  right: DirectoryLeafEntry;
}): number {
  return compareUnsignedBytes({
    left: encodeFilenameComponent({ value: left.name }),
    right: encodeFilenameComponent({ value: right.name }),
  });
}

export async function prepareWholeFileReflinkMutation({
  destinationParent,
  directoryPageStore,
  operationTimestamp,
  plan,
}: {
  destinationParent: DirectoryInodeEntry;
  directoryPageStore: DirectoryPageTreePageStore;
  operationTimestamp: TimestampMilliseconds;
  plan: WholeFileReflinkPlan;
}): Promise<WholeFileReflinkMutation> {
  if (destinationParent.inodeNumber !== plan.destinationParentDirectoryInodeNumber) {
    throw new WholeFileReflinkMutationError({
      code: "destination_parent_identity_mismatch",
      message: "whole-file reflink plan does not target the captured destination parent",
    });
  }
  if (destinationParent.inodeRevision === UINT64_MAXIMUM) {
    throw new WholeFileReflinkMutationError({
      code: "parent_revision_exhausted",
      message: "whole-file reflink destination parent revision is exhausted",
    });
  }

  const content: DirectoryInodeEntry["content"] = await (async () => {
    switch (destinationParent.content.type) {
    case "inline": {
      const current = destinationParent.content.entries.find(entry => entry.name === plan.directoryEntry.name);
      requireDestinationBinding({ entry: current, plan });
      const nextByName = new Map(destinationParent.content.entries.map(entry => [entry.name, entry]));
      nextByName.set(plan.directoryEntry.name, plan.directoryEntry);
      return {
        entries: [...nextByName.values()].sort((left, right) => compareDirectoryEntries({ left, right })),
        type: "inline",
      };
    }
    case "tree": {
      const currentRoot = destinationParent.content.directoryTreeRootHomeRef;
      const current = await readDirectoryPageTreeEntry({
        name: plan.directoryEntry.name,
        pageStore: directoryPageStore,
        rootReference: currentRoot,
      });
      requireDestinationBinding({ entry: current, plan });
      const nextRoot = await applyDirectoryPageTreeMutations({
        changes: [{ entry: plan.directoryEntry, type: "set" }],
        pageStore: directoryPageStore,
        rootReference: currentRoot,
      });
      if (nextRoot === currentRoot) {
        throw new Error("whole-file reflink unexpectedly produced no Directory Page change");
      }
      return { directoryTreeRootHomeRef: nextRoot, type: "tree" };
    }
    default: return destinationParent.content satisfies never;
    }
  })();

  const updatedDestinationParent: DirectoryInodeEntry = {
    ...destinationParent,
    content,
    inodeRevision: createInodeRevision({ value: destinationParent.inodeRevision + 1n }),
    timestamps: { ...destinationParent.timestamps, modifiedAt: operationTimestamp },
  };
  assertInodeLeafEntryFitsMetadataPage({ entry: updatedDestinationParent });

  return {
    rootInodeTableChanges: [
      { entry: updatedDestinationParent, type: "set" },
      { entry: plan.inode, type: "set" },
      ...(plan.replacedInodeNumber === null
        ? []
        : [{ key: plan.replacedInodeNumber, type: "delete" } as const]),
    ],
    updatedDestinationParent,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  entriesEqual,
};
