import {
  createFileSystemCommitPayload,
  type DirectoryInodeEntry,
  type FileSystemCommitPayload,
  type MutationId,
  type TimestampMilliseconds,
} from "@/00-storage/service/hizofs/00-format";
import type { DirectoryPageTreePageStore } from "@/00-storage/service/hizofs/filesystem/mutation/directory-page-tree";
import {
  applyRootInodeTableMutations,
  prepareRootInodeTableMutation,
  type RootInodeTableMutation,
  type RootInodeTablePageStore,
} from "@/00-storage/service/hizofs/filesystem/mutation/root-inode-table-mutation";
import {
  prepareOrdinaryEntryRemovalMutation,
  type OrdinaryEntryRemovalMutation,
} from "@/00-storage/service/hizofs/filesystem/namespace/ordinary-entry-removal-mutation";
import type { OrdinaryEntryRemovalPlan } from "@/00-storage/service/hizofs/filesystem/namespace/ordinary-entry-removal-plan";

export type PreparedOrdinaryEntryRemovalCommit = Readonly<{
  commitPayload: FileSystemCommitPayload;
  mutation: OrdinaryEntryRemovalMutation;
  plan: OrdinaryEntryRemovalPlan;
}>;

function deletionChanges({ inodeNumbers }: {
  inodeNumbers: OrdinaryEntryRemovalPlan["removedInodeNumbersPostOrder"];
}): readonly RootInodeTableMutation[] {
  return inodeNumbers.map(inodeNumber => ({ key: inodeNumber, type: "delete" }));
}

/**
 * Applies recursive inode removal in bounded unpublished B-tree batches. Only
 * the final root is placed in one new Commit, so crash visibility remains
 * atomic while large recursive removals avoid one unbounded mutation array.
 */
export async function prepareOrdinaryEntryRemovalCommit({
  baseCommit,
  directoryPageStore,
  inodeTablePageStore,
  mutationId,
  operationTimestamp,
  parent,
  plan,
}: {
  baseCommit: FileSystemCommitPayload;
  directoryPageStore: DirectoryPageTreePageStore;
  inodeTablePageStore: RootInodeTablePageStore;
  mutationId: MutationId;
  operationTimestamp: TimestampMilliseconds;
  parent: DirectoryInodeEntry;
  plan: OrdinaryEntryRemovalPlan;
}): Promise<PreparedOrdinaryEntryRemovalCommit> {
  const firstBatch = plan.deleteBatches[0];
  if (firstBatch === undefined || firstBatch.length === 0) {
    throw new TypeError("ordinary removal plan must contain one non-empty delete batch");
  }
  const mutation = await prepareOrdinaryEntryRemovalMutation({
    directoryPageStore,
    operationTimestamp,
    parent,
    plan,
  });
  const firstPrepared = await prepareRootInodeTableMutation({
    baseCommit,
    changes: [mutation.parentChange, ...deletionChanges({ inodeNumbers: firstBatch })],
    mutationId,
    pageStore: inodeTablePageStore,
  });
  const firstCommitPayload = (() => {
    switch (firstPrepared.type) {
    case "prepared": return firstPrepared.commitPayload;
    case "unchanged":
      throw new Error("ordinary removal unexpectedly produced no initial Inode Table change");
    default: {
      const _exhaustive: never = firstPrepared;
      throw new Error(`Unhandled root Inode Table mutation type: ${
        ((_exhaustive satisfies never) as { readonly type: string }).type
      }`);
    }
    }
  })();

  let rootReference = firstCommitPayload.rootInodeTableRootHomeRef;
  for (const batch of plan.deleteBatches.slice(1)) {
    if (batch.length === 0) throw new TypeError("ordinary removal delete batch cannot be empty");
    rootReference = await applyRootInodeTableMutations({
      changes: deletionChanges({ inodeNumbers: batch }),
      pageStore: inodeTablePageStore,
      rootReference,
    });
  }
  return {
    commitPayload: createFileSystemCommitPayload({ payload: {
      ...firstCommitPayload,
      rootInodeTableRootHomeRef: rootReference,
    } }),
    mutation,
    plan,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
