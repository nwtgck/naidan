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
  type RootInodeTableMutation,
  type RootInodeTablePageStore,
} from "@/00-storage/service/hizofs/filesystem/mutation/root-inode-table-mutation";
import {
  inlineDirectoryCreateCandidateFits,
  prepareInlineDirectoryCreateCandidateParent,
  prepareInlineDirectoryCreateMutationFromCandidate,
} from "@/00-storage/service/hizofs/filesystem/namespace/inline-directory-create-mutation";
import {
  prepareInlineDirectoryPromotionCreateMutation,
} from "@/00-storage/service/hizofs/filesystem/namespace/inline-directory-promotion-create-mutation";
import {
  prepareOrdinaryEntryCreatePlan,
  type OrdinaryEntryCreatePlan,
  type OrdinaryEntryCreateRequest,
  type OrdinaryEntryCreateTarget,
} from "@/00-storage/service/hizofs/filesystem/namespace/ordinary-entry-create-plan";
import { prepareTreeBackedDirectoryCreateMutation } from "@/00-storage/service/hizofs/filesystem/namespace/tree-backed-directory-create-mutation";

export type PreparedOrdinaryEntryCreateCommit = Readonly<{
  commitPayload: FileSystemCommitPayload;
  plan: OrdinaryEntryCreatePlan;
  updatedParent: DirectoryInodeEntry;
}>;

type PreparedOrdinaryEntryCreateMutation = Readonly<{
  changes: readonly RootInodeTableMutation[];
  updatedParent: DirectoryInodeEntry;
}>;

/**
 * Selects the logical directory representation while remaining independent of
 * authenticated storage and publication authority. Inline directories promote
 * to a private immutable Directory Page root before the replacement parent is
 * included in the same unpublished Commit as the newly allocated inode.
 */
export async function prepareOrdinaryEntryCreateCommit({
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
}>): Promise<PreparedOrdinaryEntryCreateCommit> {
  const plan = prepareOrdinaryEntryCreatePlan({
    knownInodeNumbers,
    nextInodeNumber: baseCommit.nextInodeNumber,
    operationTimestamp,
    request,
    target,
  });
  const mutation: PreparedOrdinaryEntryCreateMutation = await (async () => {
    switch (parent.content.type) {
    case "inline": {
      const candidateParent = prepareInlineDirectoryCreateCandidateParent({ parent, plan });
      if (inlineDirectoryCreateCandidateFits({ candidateParent })) {
        return prepareInlineDirectoryCreateMutationFromCandidate({ candidateParent, plan });
      }
      return await prepareInlineDirectoryPromotionCreateMutation({
        candidateParent,
        pageStore: directoryPageStore,
        plan,
      });
    }
    case "tree": return await prepareTreeBackedDirectoryCreateMutation({
      pageStore: directoryPageStore,
      parent,
      plan,
    });
    default: return parent.content satisfies never;
    }
  })();
  const prepared = await prepareRootInodeTableMutation({
    baseCommit,
    changes: mutation.changes,
    mutationId,
    pageStore: inodeTablePageStore,
  });
  switch (prepared.type) {
  case "unchanged":
    throw new Error("ordinary entry creation unexpectedly produced no Inode Table change");
  case "prepared": return {
    commitPayload: createFileSystemCommitPayload({ payload: {
      ...prepared.commitPayload,
      nextInodeNumber: plan.nextInodeNumber,
    } }),
    plan,
    updatedParent: mutation.updatedParent,
  };
  default: return prepared satisfies never;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
