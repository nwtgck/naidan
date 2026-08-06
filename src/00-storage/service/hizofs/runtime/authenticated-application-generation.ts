import type {
  FileSystemCommitPayload,
  HomeRecordReference,
  OpenedSuperblockCopies,
} from "@/00-storage/service/hizofs/00-format";
import {
  createDurableGenerationIdentity,
  createWorkingGenerationIdentity,
  sameDurableGenerationIdentity,
  sameWorkingGenerationIdentity,
  type DurableGenerationIdentity,
  type WorkingGenerationIdentity,
} from "@/00-storage/service/hizofs/runtime/application-generation-identity";

export type AuthenticatedDurableApplicationGenerationAuthority = Readonly<{
  commit: FileSystemCommitPayload;
  commitReference: HomeRecordReference;
  identity: DurableGenerationIdentity;
  superblock: OpenedSuperblockCopies;
}>;

export type AuthenticatedApplicationGenerationDescriptor = Readonly<{
  commit: FileSystemCommitPayload;
  commitReference: HomeRecordReference;
  durableAuthority: AuthenticatedDurableApplicationGenerationAuthority;
  superblock: OpenedSuperblockCopies;
  workingIdentity: WorkingGenerationIdentity;
}>;

function assertAuthenticatedDurableApplicationGenerationAuthority({ authority }: {
  authority: AuthenticatedDurableApplicationGenerationAuthority;
}): void {
  const declared = createDurableGenerationIdentity({
    commitReference: authority.commitReference,
    commitSequence: authority.commit.commitSequence,
    mutationId: authority.commit.mutationId,
  });
  const expected = createDurableGenerationIdentity({
    commitReference: authority.superblock.logicalState.activeCommitHomeRef,
    commitSequence: authority.superblock.logicalState.activeCommitSequence,
    mutationId: authority.superblock.logicalState.activeMutationId,
  });
  if (
    !sameDurableGenerationIdentity({ left: authority.identity, right: declared })
    || !sameDurableGenerationIdentity({ left: declared, right: expected })
  ) {
    throw new TypeError("durable application generation does not match its Superblock authority");
  }
}

export function createAuthenticatedDurableApplicationGenerationAuthority({
  commit,
  commitReference,
  superblock,
}: {
  commit: FileSystemCommitPayload;
  commitReference: HomeRecordReference;
  superblock: OpenedSuperblockCopies;
}): AuthenticatedDurableApplicationGenerationAuthority {
  const authority = Object.freeze({
    commit,
    commitReference,
    identity: createDurableGenerationIdentity({
      commitReference,
      commitSequence: commit.commitSequence,
      mutationId: commit.mutationId,
    }),
    superblock,
  });
  assertAuthenticatedDurableApplicationGenerationAuthority({ authority });
  return authority;
}

export function createAuthenticatedApplicationGenerationDescriptor({
  commit,
  commitReference,
  durableAuthority,
  workingIdentity,
}: {
  commit: FileSystemCommitPayload;
  commitReference: HomeRecordReference;
  durableAuthority: AuthenticatedDurableApplicationGenerationAuthority;
  workingIdentity: WorkingGenerationIdentity;
}): AuthenticatedApplicationGenerationDescriptor {
  assertAuthenticatedDurableApplicationGenerationAuthority({ authority: durableAuthority });
  const expectedWorkingIdentity = createWorkingGenerationIdentity({
    authorityEpoch: workingIdentity.authorityEpoch,
    commitReference,
    generationNumber: workingIdentity.generationNumber,
    mutationId: commit.mutationId,
  });
  if (!sameWorkingGenerationIdentity({ left: workingIdentity, right: expectedWorkingIdentity })) {
    throw new TypeError("working application generation identity does not match its candidate Commit");
  }
  return Object.freeze({
    commit,
    commitReference: workingIdentity.commitReference,
    durableAuthority,
    superblock: durableAuthority.superblock,
    workingIdentity,
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
