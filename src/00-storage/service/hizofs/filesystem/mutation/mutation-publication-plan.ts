import {
  createCommitSequence,
  createPublicationSequence,
  UINT64_MAXIMUM,
  type CommitSequence,
  type PublicationSequence,
} from "@/00-storage/service/hizofs/00-format";

export type MutationPublicationPlan = Readonly<{
  firstPublicationSequence: PublicationSequence;
  newCommitSequence: CommitSequence;
  secondPublicationSequence: PublicationSequence;
}>;

export function prepareMutationPublicationPlan({
  baseCommitSequence,
  maximumStructurallyObservedPublicationSequence,
}: {
  baseCommitSequence: CommitSequence;
  maximumStructurallyObservedPublicationSequence: PublicationSequence;
}): MutationPublicationPlan {
  if (baseCommitSequence === UINT64_MAXIMUM) {
    throw new RangeError("Commit Sequence space is exhausted; mutation requires read-only export");
  }
  if (maximumStructurallyObservedPublicationSequence > UINT64_MAXIMUM - 2n) {
    throw new RangeError("Publication Sequence space cannot reserve two fresh copies; mutation requires read-only export");
  }
  return {
    firstPublicationSequence: createPublicationSequence({ value: maximumStructurallyObservedPublicationSequence + 1n }),
    newCommitSequence: createCommitSequence({ value: baseCommitSequence + 1n }),
    secondPublicationSequence: createPublicationSequence({ value: maximumStructurallyObservedPublicationSequence + 2n }),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
