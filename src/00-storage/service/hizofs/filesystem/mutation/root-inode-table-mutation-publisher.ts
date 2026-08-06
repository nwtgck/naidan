import type {
  FileSystemCommitPayload,
  MutationId,
} from "@/00-storage/service/hizofs/00-format";
import type { OpenedSuperblockCopies } from "@/00-storage/service/hizofs/authenticated-store/superblock-store";
import {
  publishPreparedMutationCommit,
  type PreparedMutationCommitPublicationPort,
  type PublishedPreparedMutationCommit,
} from "./prepared-mutation-commit-publisher";
import {
  createRootInodeTablePageStore,
  prepareRootInodeTableMutation,
  type RootInodeTableMutation,
  type RootInodeTablePagePort,
} from "./root-inode-table-mutation";

export type PublishedRootInodeTableMutation =
  | Readonly<{ type: "unchanged" }>
  | Readonly<{
    commitPayload: FileSystemCommitPayload;
    publication: PublishedPreparedMutationCommit;
    type: "published";
  }>;

function bytesEqual({ left, right }: { left: Uint8Array; right: Uint8Array }): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

export async function publishRootInodeTableMutation({
  assertPublicationAllowed,
  baseCommit,
  baseSuperblock,
  changes,
  mutationId,
  pagePort,
  publicationPort,
}: {
  assertPublicationAllowed: () => void;
  baseCommit: FileSystemCommitPayload;
  baseSuperblock: OpenedSuperblockCopies;
  changes: readonly RootInodeTableMutation[];
  mutationId: MutationId;
  pagePort: RootInodeTablePagePort;
  publicationPort: PreparedMutationCommitPublicationPort;
}): Promise<PublishedRootInodeTableMutation> {
  if (baseCommit.commitSequence !== baseSuperblock.logicalState.activeCommitSequence
    || !bytesEqual({ left: baseCommit.mutationId, right: baseSuperblock.logicalState.activeMutationId })) {
    throw new TypeError("base Commit does not match the selected Superblock authority");
  }
  assertPublicationAllowed();
  const prepared = await prepareRootInodeTableMutation({
    baseCommit,
    changes,
    mutationId,
    pageStore: createRootInodeTablePageStore({ pagePort }),
  });
  switch (prepared.type) {
  case "unchanged": return prepared;
  case "prepared": {
    const publication = await publishPreparedMutationCommit({
      assertPublicationAllowed,
      base: baseSuperblock,
      commitPayload: prepared.commitPayload,
      onCandidatePrepared: undefined,
      publicationPort,
    });
    return {
      commitPayload: prepared.commitPayload,
      publication,
      type: "published",
    };
  }
  default: return prepared satisfies never;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
