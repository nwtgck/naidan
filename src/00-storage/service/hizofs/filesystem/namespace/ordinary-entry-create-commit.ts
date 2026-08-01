import type {
  DirectoryInodeEntry,
  FileSystemCommitPayload,
  InodeNumber,
  MutationId,
  TimestampMilliseconds,
} from "@/00-storage/service/hizofs/00-format";
import type { DirectoryPageTreePageStore } from "@/00-storage/service/hizofs/filesystem/mutation/directory-page-tree";
import type { RootInodeTablePageStore } from "@/00-storage/service/hizofs/filesystem/mutation/root-inode-table-mutation";
import { prepareInlineDirectoryCreateCommit } from "@/00-storage/service/hizofs/filesystem/namespace/inline-directory-create-commit";
import type {
  OrdinaryEntryCreatePlan,
  OrdinaryEntryCreateRequest,
  OrdinaryEntryCreateTarget,
} from "@/00-storage/service/hizofs/filesystem/namespace/ordinary-entry-create-plan";
import { prepareTreeBackedDirectoryCreateCommit } from "@/00-storage/service/hizofs/filesystem/namespace/tree-backed-directory-create-commit";

export type PreparedOrdinaryEntryCreateCommit = Readonly<{
  commitPayload: FileSystemCommitPayload;
  plan: OrdinaryEntryCreatePlan;
}>;

/**
 * Selects the logical directory representation while remaining independent of
 * authenticated storage and publication authority. The worker composition root
 * owns the higher-authority wiring from these page-store capabilities to the
 * durable metadata writer and Superblock publication gate.
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
  switch (parent.content.type) {
  case "inline": return await prepareInlineDirectoryCreateCommit({
    baseCommit,
    knownInodeNumbers,
    mutationId,
    operationTimestamp,
    pageStore: inodeTablePageStore,
    parent,
    request,
    target,
  });
  case "tree": return await prepareTreeBackedDirectoryCreateCommit({
    baseCommit,
    directoryPageStore,
    inodeTablePageStore,
    knownInodeNumbers,
    mutationId,
    operationTimestamp,
    parent,
    request,
    target,
  });
  default: return parent.content satisfies never;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
