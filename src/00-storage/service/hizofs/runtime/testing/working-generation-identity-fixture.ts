import {
  createCommitSequence,
  parseMutationId,
} from "@/00-storage/service/hizofs/00-format";
import {
  createDurableGenerationIdentity,
  createSuccessorWorkingGenerationIdentity,
  createWorkingGenerationAuthorityEpoch,
  createWorkingGenerationIdentity,
  createWorkingGenerationNumber,
} from "@/00-storage/service/hizofs/runtime/application-generation-identity";
import { createTestingHomeRecordReference } from "@/00-storage/service/hizofs/runtime/testing/home-record-reference-fixture";

export function createTestingWorkingCandidateIdentities() {
  const baseReference = createTestingHomeRecordReference({ offset: 64n });
  const baseMutationId = parseMutationId({ bytes: new Uint8Array(16).fill(1) });
  const baseWorking = createWorkingGenerationIdentity({
    authorityEpoch: createWorkingGenerationAuthorityEpoch(),
    generationNumber: createWorkingGenerationNumber({ value: 0n }),
    mutationId: baseMutationId,
  });
  const candidateReference = createTestingHomeRecordReference({ offset: 160n });
  const candidateMutationId = parseMutationId({ bytes: new Uint8Array(16).fill(2) });
  const conflictingReference = createTestingHomeRecordReference({ offset: 256n });
  const conflictingMutationId = parseMutationId({ bytes: new Uint8Array(16).fill(3) });
  return {
    candidateDurable: createDurableGenerationIdentity({
      commitReference: candidateReference,
      commitSequence: createCommitSequence({ value: 8n }),
      mutationId: candidateMutationId,
    }),
    durable: createDurableGenerationIdentity({
      commitReference: baseReference,
      commitSequence: createCommitSequence({ value: 7n }),
      mutationId: baseMutationId,
    }),
    conflictingDurable: createDurableGenerationIdentity({
      commitReference: conflictingReference,
      commitSequence: createCommitSequence({ value: 9n }),
      mutationId: conflictingMutationId,
    }),
    working: createSuccessorWorkingGenerationIdentity({
      mutationId: candidateMutationId,
      previous: baseWorking,
    }),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
