import type {
  DirectoryInodeEntry,
  FileSystemCommitPayload,
  MutationId,
  TimestampMilliseconds,
} from "@/00-storage/service/hizofs/00-format";
import type { DirectoryPageTreePageStore } from "@/00-storage/service/hizofs/filesystem/mutation/directory-page-tree";
import {
  prepareRootInodeTableMutation,
  type RootInodeTablePageStore,
} from "@/00-storage/service/hizofs/filesystem/mutation/root-inode-table-mutation";
import {
  prepareOrdinaryEntryMoveMutation,
  type OrdinaryEntryMoveMutation,
} from "@/00-storage/service/hizofs/filesystem/namespace/ordinary-entry-move-mutation";
import type { OrdinaryEntryMovePlan } from "@/00-storage/service/hizofs/filesystem/namespace/ordinary-entry-move-plan";

export type PreparedOrdinaryEntryMoveCommit = Readonly<{
  commitPayload: FileSystemCommitPayload;
  mutation: OrdinaryEntryMoveMutation;
  plan: OrdinaryEntryMovePlan;
}>;

export async function prepareOrdinaryEntryMoveCommit({
  baseCommit,
  destinationParent,
  directoryPageStore,
  inodeTablePageStore,
  mutationId,
  operationTimestamp,
  plan,
  sourceParent,
}: {
  baseCommit: FileSystemCommitPayload;
  destinationParent: DirectoryInodeEntry;
  directoryPageStore: DirectoryPageTreePageStore;
  inodeTablePageStore: RootInodeTablePageStore;
  mutationId: MutationId;
  operationTimestamp: TimestampMilliseconds;
  plan: OrdinaryEntryMovePlan;
  sourceParent: DirectoryInodeEntry;
}): Promise<PreparedOrdinaryEntryMoveCommit> {
  const mutation = await prepareOrdinaryEntryMoveMutation({
    destinationParent,
    directoryPageStore,
    operationTimestamp,
    plan,
    sourceParent,
  });
  const prepared = await prepareRootInodeTableMutation({
    baseCommit,
    changes: mutation.rootInodeTableChanges,
    mutationId,
    pageStore: inodeTablePageStore,
  });
  switch (prepared.type) {
  case "prepared": return { commitPayload: prepared.commitPayload, mutation, plan };
  case "unchanged": throw new Error("ordinary move unexpectedly produced no Inode Table change");
  default: return prepared satisfies never;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
