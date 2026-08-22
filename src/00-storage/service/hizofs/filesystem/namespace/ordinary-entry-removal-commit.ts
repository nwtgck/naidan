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
  applyRootInodeTableMutations,
  prepareRootInodeTableMutation,
  type RootInodeTableMutation,
  type RootInodeTablePageStore,
} from "@/00-storage/service/hizofs/filesystem/mutation/root-inode-table-mutation";
import {
  prepareOrdinaryEntryRemovalMutation,
  type OrdinaryEntryRemovalMutation,
} from "@/00-storage/service/hizofs/filesystem/namespace/ordinary-entry-removal-mutation";
import {
  streamOrdinaryEntryRemovalInodeBatches,
  type OpenOrdinaryRemovalDirectory,
  type OrdinaryEntryRemovalSource,
  type OrdinaryEntryRemovalTarget,
} from "@/00-storage/service/hizofs/filesystem/namespace/ordinary-entry-removal-plan";

export type PreparedOrdinaryEntryRemovalCommit = Readonly<{
  commitPayload: FileSystemCommitPayload;
  mutation: OrdinaryEntryRemovalMutation;
  target: OrdinaryEntryRemovalTarget;
}>;

function deletionChanges({ inodeNumbers }: {
  inodeNumbers: readonly InodeNumber[];
}): readonly RootInodeTableMutation[] {
  return inodeNumbers.map(inodeNumber => ({ key: inodeNumber, type: "delete" }));
}

/**
 * Builds one recursive-removal candidate without retaining a subtree-sized
 * inode list. Directory traversal yields bounded deletion batches and each
 * batch advances one unpublished candidate Inode Table root. Only the final
 * root is returned for publication.
 */
export async function prepareOrdinaryEntryRemovalCommit({
  baseCommit,
  directoryPageStore,
  inodeTablePageStore,
  mutationId,
  openDirectory,
  operationTimestamp,
  parent,
  recursive,
  source,
  target,
}: {
  baseCommit: FileSystemCommitPayload;
  directoryPageStore: DirectoryPageTreePageStore;
  inodeTablePageStore: RootInodeTablePageStore;
  mutationId: MutationId;
  openDirectory: OpenOrdinaryRemovalDirectory;
  operationTimestamp: TimestampMilliseconds;
  parent: DirectoryInodeEntry;
  recursive: boolean;
  source: OrdinaryEntryRemovalSource;
  target: OrdinaryEntryRemovalTarget;
}): Promise<PreparedOrdinaryEntryRemovalCommit> {
  const mutation = await prepareOrdinaryEntryRemovalMutation({
    directoryPageStore,
    operationTimestamp,
    parent,
    plan: target,
  });
  let preparedCommitPayload: FileSystemCommitPayload | undefined;
  let candidateRootReference = baseCommit.rootInodeTableRootHomeRef;
  let batchCount = 0;
  for await (const inodeNumbers of streamOrdinaryEntryRemovalInodeBatches({
    deleteBatchSize: target.deleteBatchSize,
    openDirectory,
    recursive,
    source,
  })) {
    if (inodeNumbers.length === 0) throw new Error("ordinary removal streamed an empty inode batch");
    if (batchCount === 0) {
      const prepared = await prepareRootInodeTableMutation({
        baseCommit,
        changes: [mutation.parentChange, ...deletionChanges({ inodeNumbers })],
        mutationId,
        pageStore: inodeTablePageStore,
      });
      switch (prepared.type) {
      case "prepared":
        preparedCommitPayload = prepared.commitPayload;
        candidateRootReference = prepared.commitPayload.rootInodeTableRootHomeRef;
        break;
      case "unchanged":
        throw new Error("ordinary removal unexpectedly produced no initial Inode Table change");
      default: prepared satisfies never;
      }
    } else {
      candidateRootReference = await applyRootInodeTableMutations({
        changes: deletionChanges({ inodeNumbers }),
        pageStore: inodeTablePageStore,
        rootReference: candidateRootReference,
      });
    }
    batchCount += 1;
  }
  if (preparedCommitPayload === undefined || batchCount === 0) {
    throw new Error("ordinary removal traversal produced no inode deletion batch");
  }
  return {
    commitPayload: createFileSystemCommitPayload({ payload: {
      ...preparedCommitPayload,
      rootInodeTableRootHomeRef: candidateRootReference,
    } }),
    mutation,
    target,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
