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
  prepareOrdinaryEntryCreatePlan,
  type OrdinaryEntryCreatePlan,
  type OrdinaryEntryCreateRequest,
  type OrdinaryEntryCreateTarget,
} from "@/00-storage/service/hizofs/filesystem/namespace/ordinary-entry-create-plan";
import { prepareTreeBackedDirectoryCreateMutation } from "@/00-storage/service/hizofs/filesystem/namespace/tree-backed-directory-create-mutation";

export type PreparedTreeBackedDirectoryCreateCommit = Readonly<{
  commitPayload: FileSystemCommitPayload;
  plan: OrdinaryEntryCreatePlan;
}>;

export async function prepareTreeBackedDirectoryCreateCommit({
  baseCommit,
  directoryPageStore,
  inodeTablePageStore,
  knownInodeNumbers,
  mutationId,
  operationTimestamp,
  parent,
  request,
  target,
}: Readonly<{
  baseCommit: FileSystemCommitPayload;
  directoryPageStore: DirectoryPageTreePageStore;
  inodeTablePageStore: RootInodeTablePageStore;
  knownInodeNumbers: readonly InodeNumber[];
  mutationId: MutationId;
  operationTimestamp: TimestampMilliseconds;
  parent: DirectoryInodeEntry;
  request: OrdinaryEntryCreateRequest;
  target: OrdinaryEntryCreateTarget;
}>): Promise<PreparedTreeBackedDirectoryCreateCommit> {
  const plan = prepareOrdinaryEntryCreatePlan({
    knownInodeNumbers,
    nextInodeNumber: baseCommit.nextInodeNumber,
    operationTimestamp,
    request,
    target,
  });
  const mutation = await prepareTreeBackedDirectoryCreateMutation({
    pageStore: directoryPageStore,
    parent,
    plan,
  });
  const prepared = await prepareRootInodeTableMutation({
    baseCommit,
    changes: mutation.changes,
    mutationId,
    pageStore: inodeTablePageStore,
  });
  switch (prepared.type) {
  case "unchanged":
    throw new Error("tree-backed directory creation unexpectedly produced no Inode Table change");
  case "prepared": return {
    commitPayload: createFileSystemCommitPayload({ payload: {
      ...prepared.commitPayload,
      nextInodeNumber: plan.nextInodeNumber,
    } }),
    plan,
  };
  default: return prepared satisfies never;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
