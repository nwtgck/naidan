import {
  compareFilenameComponentsByUtf8,
  UINT64_MAXIMUM,
  createInodeRevision,
  encodeDirectoryEntry,
  assertInodeLeafEntryFitsMetadataPage,
  type DirectoryInodeEntry,
  type DirectoryLeafEntry,
  type TimestampMilliseconds,
} from "@/00-storage/service/hizofs/00-format";
import {
  applyDirectoryPageTreeMutations,
  readDirectoryPageTreeEntry,
  type DirectoryPageTreeMutation,
  type DirectoryPageTreePageStore,
} from "@/00-storage/service/hizofs/filesystem/mutation/directory-page-tree";
import type { RootInodeTableMutation } from "@/00-storage/service/hizofs/filesystem/mutation/root-inode-table-mutation";
import type { OrdinaryEntryMovePlan } from "@/00-storage/service/hizofs/filesystem/namespace/ordinary-entry-move-plan";
import { promiseAllKeyed } from "@/utils/promise";

export type OrdinaryEntryMoveMutationErrorCode =
  | "destination_changed"
  | "destination_parent_identity_mismatch"
  | "parent_revision_exhausted"
  | "same_parent_revision_mismatch"
  | "source_changed"
  | "source_parent_identity_mismatch";

export class OrdinaryEntryMoveMutationError extends Error {
  readonly code: OrdinaryEntryMoveMutationErrorCode;

  constructor({ code, message }: { code: OrdinaryEntryMoveMutationErrorCode; message: string }) {
    super(message);
    this.name = "OrdinaryEntryMoveMutationError";
    this.code = code;
  }
}

export type OrdinaryEntryMoveMutation = Readonly<{
  rootInodeTableChanges: readonly RootInodeTableMutation[];
  updatedDestinationParent: DirectoryInodeEntry;
  updatedSourceParent: DirectoryInodeEntry;
}>;

function entryBytes({ entry }: { entry: DirectoryLeafEntry }): Uint8Array {
  return encodeDirectoryEntry({ entry });
}

function entriesEqual({ left, right }: {
  left: DirectoryLeafEntry;
  right: DirectoryLeafEntry;
}): boolean {
  const leftBytes = entryBytes({ entry: left });
  const rightBytes = entryBytes({ entry: right });
  return leftBytes.byteLength === rightBytes.byteLength
    && leftBytes.every((byte, index) => byte === rightBytes[index]);
}

function compareDirectoryEntries({ left, right }: {
  left: DirectoryLeafEntry;
  right: DirectoryLeafEntry;
}): number {
  return compareFilenameComponentsByUtf8({ left: left.name, right: right.name });
}

function expectedSourceBinding({ plan }: { plan: OrdinaryEntryMovePlan }): DirectoryLeafEntry {
  return { ...plan.destinationBinding, name: plan.sourceRemovalName };
}

function requireSourceBinding({ entry, plan }: {
  entry: DirectoryLeafEntry | undefined;
  plan: OrdinaryEntryMovePlan;
}): void {
  const expected = expectedSourceBinding({ plan });
  if (entry !== undefined && entriesEqual({ left: entry, right: expected })) return;
  throw new OrdinaryEntryMoveMutationError({
    code: "source_changed",
    message: "ordinary move source binding changed after planning",
  });
}

function requireDestinationBinding({ entry, plan }: {
  entry: DirectoryLeafEntry | undefined;
  plan: OrdinaryEntryMovePlan;
}): void {
  if (plan.replacedInodeNumber === undefined) {
    if (entry === undefined) return;
    throw new OrdinaryEntryMoveMutationError({
      code: "destination_changed",
      message: "ordinary move destination appeared after planning",
    });
  }
  if (entry?.targetType === "inode" && entry.inodeNumber === plan.replacedInodeNumber) return;
  throw new OrdinaryEntryMoveMutationError({
    code: "destination_changed",
    message: "ordinary move replacement destination changed after planning",
  });
}

function incrementParent({ operationTimestamp, parent }: {
  operationTimestamp: TimestampMilliseconds;
  parent: DirectoryInodeEntry;
}): Pick<DirectoryInodeEntry, "inodeRevision" | "timestamps"> {
  if (parent.inodeRevision === UINT64_MAXIMUM) {
    throw new OrdinaryEntryMoveMutationError({
      code: "parent_revision_exhausted",
      message: "ordinary move parent revision is exhausted",
    });
  }
  return {
    inodeRevision: createInodeRevision({ value: parent.inodeRevision + 1n }),
    timestamps: { ...parent.timestamps, modifiedAt: operationTimestamp },
  };
}

async function mutateParent({ changes, destinationName, directoryPageStore, operationTimestamp, parent, plan, sourceName }: {
  changes: readonly DirectoryPageTreeMutation[];
  destinationName: string | undefined;
  directoryPageStore: DirectoryPageTreePageStore;
  operationTimestamp: TimestampMilliseconds;
  parent: DirectoryInodeEntry;
  plan: OrdinaryEntryMovePlan;
  sourceName: string | undefined;
}): Promise<DirectoryInodeEntry> {
  const content: DirectoryInodeEntry["content"] = await (async () => {
    switch (parent.content.type) {
    case "inline": {
      const source = sourceName === undefined
        ? undefined
        : parent.content.entries.find(entry => entry.name === sourceName);
      const destination = destinationName === undefined
        ? undefined
        : parent.content.entries.find(entry => entry.name === destinationName);
      if (sourceName !== undefined) requireSourceBinding({ entry: source, plan });
      if (destinationName !== undefined) requireDestinationBinding({ entry: destination, plan });

      const nextByName = new Map(parent.content.entries.map(entry => [entry.name, entry]));
      for (const change of changes) {
        switch (change.type) {
        case "delete": nextByName.delete(change.key); break;
        case "set": nextByName.set(change.entry.name, change.entry); break;
        default: change satisfies never;
        }
      }
      return {
        entries: [...nextByName.values()].sort((left, right) => compareDirectoryEntries({ left, right })),
        type: "inline",
      };
    }
    case "tree": {
      const currentRoot = parent.content.directoryTreeRootHomeRef;
      const { destination, source } = await promiseAllKeyed({
        destination: destinationName === undefined
          ? Promise.resolve(undefined)
          : readDirectoryPageTreeEntry({ name: destinationName, pageStore: directoryPageStore, rootReference: currentRoot }),
        source: sourceName === undefined
          ? Promise.resolve(undefined)
          : readDirectoryPageTreeEntry({ name: sourceName, pageStore: directoryPageStore, rootReference: currentRoot }),
      });
      if (sourceName !== undefined) requireSourceBinding({ entry: source, plan });
      if (destinationName !== undefined) requireDestinationBinding({ entry: destination, plan });
      const nextRoot = await applyDirectoryPageTreeMutations({
        changes,
        pageStore: directoryPageStore,
        rootReference: currentRoot,
      });
      if (nextRoot === currentRoot) {
        throw new Error("ordinary move unexpectedly produced no Directory Page change");
      }
      return { directoryTreeRootHomeRef: nextRoot, type: "tree" };
    }
    default: return parent.content satisfies never;
    }
  })();

  const updated: DirectoryInodeEntry = {
    ...parent,
    ...incrementParent({ operationTimestamp, parent }),
    content,
  };
  assertInodeLeafEntryFitsMetadataPage({ entry: updated });
  return updated;
}

/**
 * Applies both namespace bindings before preparing one Root Inode Table change
 * set. Same-parent renames increment that parent exactly once; cross-directory
 * moves update both parents while keeping all page roots unpublished until the
 * caller creates and publishes a single Commit.
 */
export async function prepareOrdinaryEntryMoveMutation({
  destinationParent,
  directoryPageStore,
  operationTimestamp,
  plan,
  sourceParent,
}: {
  destinationParent: DirectoryInodeEntry;
  directoryPageStore: DirectoryPageTreePageStore;
  operationTimestamp: TimestampMilliseconds;
  plan: OrdinaryEntryMovePlan;
  sourceParent: DirectoryInodeEntry;
}): Promise<OrdinaryEntryMoveMutation> {
  if (sourceParent.inodeNumber !== plan.sourceParentDirectoryInodeNumber) {
    throw new OrdinaryEntryMoveMutationError({
      code: "source_parent_identity_mismatch",
      message: "ordinary move plan does not target the captured source parent",
    });
  }
  if (destinationParent.inodeNumber !== plan.destinationParentDirectoryInodeNumber) {
    throw new OrdinaryEntryMoveMutationError({
      code: "destination_parent_identity_mismatch",
      message: "ordinary move plan does not target the captured destination parent",
    });
  }

  const sameParent = sourceParent.inodeNumber === destinationParent.inodeNumber;
  if (sameParent && sourceParent.inodeRevision !== destinationParent.inodeRevision) {
    throw new OrdinaryEntryMoveMutationError({
      code: "same_parent_revision_mismatch",
      message: "same-parent ordinary move received inconsistent parent revisions",
    });
  }

  const updatedSourceParent = await mutateParent({
    changes: sameParent
      ? [
        { key: plan.sourceRemovalName, type: "delete" },
        { entry: plan.destinationBinding, type: "set" },
      ]
      : [{ key: plan.sourceRemovalName, type: "delete" }],
    destinationName: sameParent ? plan.destinationBinding.name : undefined,
    directoryPageStore,
    operationTimestamp,
    parent: sourceParent,
    plan,
    sourceName: plan.sourceRemovalName,
  });

  const updatedDestinationParent = sameParent
    ? updatedSourceParent
    : await mutateParent({
      changes: [{ entry: plan.destinationBinding, type: "set" }],
      destinationName: plan.destinationBinding.name,
      directoryPageStore,
      operationTimestamp,
      parent: destinationParent,
      plan,
      sourceName: undefined,
    });

  const rootInodeTableChanges: RootInodeTableMutation[] = [
    { entry: updatedSourceParent, type: "set" },
    ...(sameParent ? [] : [{ entry: updatedDestinationParent, type: "set" } as const]),
    ...(plan.replacedInodeNumber === undefined
      ? []
      : [{ key: plan.replacedInodeNumber, type: "delete" } as const]),
  ];
  return {
    rootInodeTableChanges,
    updatedDestinationParent,
    updatedSourceParent,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
