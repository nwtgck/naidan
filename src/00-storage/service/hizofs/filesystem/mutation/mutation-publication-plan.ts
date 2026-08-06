import {
  createCommitSequence,
  createPublicationSequence,
  UINT64_MAXIMUM,
  type CommitSequence,
  type PublicationSequence,
} from "@/00-storage/service/hizofs/00-format";

export type MutationCandidateSequencePlan = Readonly<{
  newCommitSequence: CommitSequence;
}>;

export type MutationSuperblockPublicationPlan = Readonly<{
  firstPublicationSequence: PublicationSequence;
  secondPublicationSequence: PublicationSequence;
}>;

export type MutationPublicationPlan = MutationCandidateSequencePlan & MutationSuperblockPublicationPlan;

export function prepareMutationCandidateSequencePlan({ durableCommitSequence }: {
  durableCommitSequence: CommitSequence;
}): MutationCandidateSequencePlan {
  if (durableCommitSequence === UINT64_MAXIMUM) {
    throw new RangeError("Commit Sequence space is exhausted; mutation requires read-only export");
  }
  return {
    newCommitSequence: createCommitSequence({ value: durableCommitSequence + 1n }),
  };
}

export function prepareMutationSuperblockPublicationPlan({ maximumStructurallyObservedPublicationSequence }: {
  maximumStructurallyObservedPublicationSequence: PublicationSequence;
}): MutationSuperblockPublicationPlan {
  if (maximumStructurallyObservedPublicationSequence > UINT64_MAXIMUM - 2n) {
    throw new RangeError("Publication Sequence space cannot reserve two fresh copies; mutation requires read-only export");
  }
  return {
    firstPublicationSequence: createPublicationSequence({ value: maximumStructurallyObservedPublicationSequence + 1n }),
    secondPublicationSequence: createPublicationSequence({ value: maximumStructurallyObservedPublicationSequence + 2n }),
  };
}

/**
 * Immediate-mode compatibility plan. Delayed publication must reserve the
 * candidate Commit Sequence when opening a dirty epoch and reserve physical
 * Publication Sequences only when that candidate is flushed durably.
 */
export function prepareMutationPublicationPlan({
  baseCommitSequence,
  maximumStructurallyObservedPublicationSequence,
}: {
  baseCommitSequence: CommitSequence;
  maximumStructurallyObservedPublicationSequence: PublicationSequence;
}): MutationPublicationPlan {
  return {
    ...prepareMutationCandidateSequencePlan({ durableCommitSequence: baseCommitSequence }),
    ...prepareMutationSuperblockPublicationPlan({ maximumStructurallyObservedPublicationSequence }),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
