import {
  createFileSystemCommitPayload,
  type DirectoryInodeEntry,
  type FileSystemCommitPayload,
  type InodeNumber,
  type MutationId,
  type TimestampMilliseconds,
} from "@/00-storage/service/hizofs/00-format";
import type { DirectoryPageTreePageStore } from "@/00-storage/service/hizofs/filesystem/mutation/directory-page-tree";
import {
  prepareRootInodeTableMutation,
  type RootInodeTablePageStore,
} from "@/00-storage/service/hizofs/filesystem/mutation/root-inode-table-mutation";
import {
  prepareWholeFileReflinkMutation,
  type WholeFileReflinkMutation,
} from "@/00-storage/service/hizofs/filesystem/reflink/whole-file-reflink-mutation";
import {
  prepareWholeFileReflinkPlan,
  type WholeFileReflinkPlan,
  type WholeFileReflinkSource,
  type WholeFileReflinkTarget,
} from "@/00-storage/service/hizofs/filesystem/reflink/whole-file-reflink-plan";

export type PreparedWholeFileReflinkCommit = Readonly<{
  commitPayload: FileSystemCommitPayload;
  mutation: WholeFileReflinkMutation;
  plan: WholeFileReflinkPlan;
}>;

export async function prepareWholeFileReflinkCommit({
  baseCommit,
  destinationParent,
  directoryPageStore,
  inodeTablePageStore,
  maximumKnownInodeNumber,
  mutationId,
  operationTimestamp,
  source,
  target,
}: {
  baseCommit: FileSystemCommitPayload;
  destinationParent: DirectoryInodeEntry;
  directoryPageStore: DirectoryPageTreePageStore;
  inodeTablePageStore: RootInodeTablePageStore;
  maximumKnownInodeNumber: InodeNumber | undefined;
  mutationId: MutationId;
  operationTimestamp: TimestampMilliseconds;
  source: WholeFileReflinkSource;
  target: WholeFileReflinkTarget;
}): Promise<PreparedWholeFileReflinkCommit> {
  const plan = prepareWholeFileReflinkPlan({
    maximumKnownInodeNumber,
    nextInodeNumber: baseCommit.nextInodeNumber,
    operationTimestamp,
    source,
    target,
  });
  const mutation = await prepareWholeFileReflinkMutation({
    destinationParent,
    directoryPageStore,
    operationTimestamp,
    plan,
  });
  const prepared = await prepareRootInodeTableMutation({
    baseCommit,
    changes: mutation.rootInodeTableChanges,
    mutationId,
    pageStore: inodeTablePageStore,
  });
  switch (prepared.type) {
  case "prepared": return {
    commitPayload: createFileSystemCommitPayload({ payload: {
      ...prepared.commitPayload,
      nextInodeNumber: plan.nextInodeNumber,
    } }),
    mutation,
    plan,
  };
  case "unchanged": throw new Error("whole-file reflink unexpectedly produced no Inode Table change");
  default: return prepared satisfies never;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
