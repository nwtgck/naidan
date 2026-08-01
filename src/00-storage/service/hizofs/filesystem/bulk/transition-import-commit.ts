import {
  createCommitSequence,
  createFileSystemCommitPayload,
  type FileSystemCommitPayload,
  type MutationId,
} from "@/00-storage/service/hizofs/00-format";
import type { SealedStreamingNamespaceImport } from "@/00-storage/service/hizofs/filesystem/bulk/streaming-namespace-import";

function sameMutationId({ left, right }: { left: MutationId; right: MutationId }): boolean {
  return left.every((byte, index) => byte === right[index]);
}

/**
 * Converts one verified private import root into the only Commit payload that
 * may cross the target publication gate. The base generation retains every
 * authority not owned by namespace import; only the imported root, next Inode
 * Number, fresh Mutation ID, and exactly-next Commit Sequence may change.
 */
export function prepareTransitionImportCommit({ baseCommit, mutationId, sealed }: {
  baseCommit: FileSystemCommitPayload;
  mutationId: MutationId;
  sealed: SealedStreamingNamespaceImport;
}): FileSystemCommitPayload {
  if (sameMutationId({ left: baseCommit.mutationId, right: mutationId })) {
    throw new TypeError("transition import Commit requires a fresh Mutation ID");
  }
  return createFileSystemCommitPayload({ payload: {
    ...baseCommit,
    commitSequence: createCommitSequence({ value: baseCommit.commitSequence + 1n }),
    mutationId,
    nextInodeNumber: sealed.nextInodeNumber,
    rootDirectoryInodeNumber: sealed.rootDirectoryInodeNumber,
    rootInodeTableRootHomeRef: sealed.rootInodeTableRootHomeRef,
  } });
}

export const TEST_ONLY = {
};
