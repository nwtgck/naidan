import {
  type FileSystemCommitPayload,
  type HomeRecordReference,
  type PublicationSequence,
} from "@/00-storage/service/hizofs/00-format";
import type { OpenedSuperblockCopies } from "@/00-storage/service/hizofs/authenticated-store/superblock-store";
import { prepareMutationPublicationPlan } from "./mutation-publication-plan";

export type PublishedPreparedMutationCommit = Readonly<{
  commitHomeRef: HomeRecordReference;
  superblock: OpenedSuperblockCopies;
}>;

export type PreparedMutationCommitPublicationRequest = Readonly<{
  base: OpenedSuperblockCopies;
  beforeFirstAuthorityWrite: () => void;
  commitPayload: FileSystemCommitPayload;
  firstPublicationSequence: PublicationSequence;
  secondPublicationSequence: PublicationSequence;
}>;

export type PublishPreparedMutationCommit = ({
  base,
  beforeFirstAuthorityWrite,
  commitPayload,
  firstPublicationSequence,
  secondPublicationSequence,
}: PreparedMutationCommitPublicationRequest) => Promise<PublishedPreparedMutationCommit>;

export type PreparedMutationCommitPublicationPort = Readonly<{
  publish: PublishPreparedMutationCommit;
}>;

export async function publishPreparedMutationCommit({
  assertPublicationAllowed,
  base,
  commitPayload,
  publicationPort,
}: {
  assertPublicationAllowed: () => void;
  base: OpenedSuperblockCopies;
  commitPayload: FileSystemCommitPayload;
  publicationPort: PreparedMutationCommitPublicationPort;
}): Promise<PublishedPreparedMutationCommit> {
  const plan = prepareMutationPublicationPlan({
    baseCommitSequence: base.logicalState.activeCommitSequence,
    maximumStructurallyObservedPublicationSequence: base.maximumStructurallyObservedPublicationSequence,
  });
  if (commitPayload.commitSequence !== plan.newCommitSequence) {
    throw new RangeError("prepared Commit Sequence does not match the mutation publication plan");
  }
  if (commitPayload.mutationId.every((byte, index) => byte === base.logicalState.activeMutationId[index])) {
    throw new TypeError("prepared Commit requires a fresh Mutation ID");
  }
  assertPublicationAllowed();
  let finalGateFailed = false;
  let finalGateFailure: unknown;
  try {
    return await publicationPort.publish({
      base,
      beforeFirstAuthorityWrite: () => {
        try {
          assertPublicationAllowed();
        } catch (cause: unknown) {
          finalGateFailed = true;
          finalGateFailure = cause;
          throw cause;
        }
      },
      commitPayload,
      firstPublicationSequence: plan.firstPublicationSequence,
      secondPublicationSequence: plan.secondPublicationSequence,
    });
  } catch (cause: unknown) {
    if (finalGateFailed) throw finalGateFailure;
    throw cause;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
