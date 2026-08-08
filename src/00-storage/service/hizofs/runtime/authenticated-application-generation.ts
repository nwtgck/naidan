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

export type MaterializedWorkingGenerationRootAuthority = Readonly<{
  commitReference: HomeRecordReference;
  type: "materialized_commit";
}>;

export type DirectWorkingGenerationRootAuthority = Readonly<{
  nestedSubvolumeTableRootHomeRef: HomeRecordReference | null;
  rootInodeTableRootHomeRef: HomeRecordReference;
  type: "direct_working_pages";
}>;

export type WorkingGenerationRootAuthority =
  | MaterializedWorkingGenerationRootAuthority
  | DirectWorkingGenerationRootAuthority;

export type AuthenticatedApplicationGenerationDescriptor = Readonly<{
  commit: FileSystemCommitPayload;
  commitReference: HomeRecordReference;
  durableAuthority: AuthenticatedDurableApplicationGenerationAuthority;
  superblock: OpenedSuperblockCopies;
  workingIdentity: WorkingGenerationIdentity;
  workingRootAuthority: WorkingGenerationRootAuthority;
}>;

export type AuthenticatedStagedApplicationGenerationDescriptor = Readonly<{
  commit: FileSystemCommitPayload;
  durableAuthority: AuthenticatedDurableApplicationGenerationAuthority;
  superblock: OpenedSuperblockCopies;
  workingIdentity: WorkingGenerationIdentity;
  workingRootAuthority: DirectWorkingGenerationRootAuthority;
}>;

export type AuthenticatedWorkingApplicationGenerationDescriptor =
  | AuthenticatedApplicationGenerationDescriptor
  | AuthenticatedStagedApplicationGenerationDescriptor;

export function requireMaterializedApplicationGenerationDescriptor({ descriptor }: {
  descriptor: AuthenticatedWorkingApplicationGenerationDescriptor;
}): AuthenticatedApplicationGenerationDescriptor {
  if ("commitReference" in descriptor) return descriptor;
  throw new TypeError("working application generation has not materialized a Commit reference");
}

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

function assertWorkingApplicationGenerationIdentity({ commit, workingIdentity }: {
  commit: FileSystemCommitPayload;
  workingIdentity: WorkingGenerationIdentity;
}): void {
  const expectedWorkingIdentity = createWorkingGenerationIdentity({
    authorityEpoch: workingIdentity.authorityEpoch,
    generationNumber: workingIdentity.generationNumber,
    mutationId: commit.mutationId,
  });
  if (!sameWorkingGenerationIdentity({ left: workingIdentity, right: expectedWorkingIdentity })) {
    throw new TypeError("working application generation identity does not match its mutation payload");
  }
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
  assertWorkingApplicationGenerationIdentity({ commit, workingIdentity });
  return Object.freeze({
    commit,
    commitReference,
    durableAuthority,
    superblock: durableAuthority.superblock,
    workingIdentity,
    workingRootAuthority: Object.freeze({
      commitReference,
      type: "materialized_commit" as const,
    }),
  });
}

export function createAuthenticatedStagedApplicationGenerationDescriptor({
  commit,
  durableAuthority,
  workingIdentity,
}: {
  commit: FileSystemCommitPayload;
  durableAuthority: AuthenticatedDurableApplicationGenerationAuthority;
  workingIdentity: WorkingGenerationIdentity;
}): AuthenticatedStagedApplicationGenerationDescriptor {
  assertAuthenticatedDurableApplicationGenerationAuthority({ authority: durableAuthority });
  assertWorkingApplicationGenerationIdentity({ commit, workingIdentity });
  return Object.freeze({
    commit,
    durableAuthority,
    superblock: durableAuthority.superblock,
    workingIdentity,
    workingRootAuthority: Object.freeze({
      nestedSubvolumeTableRootHomeRef: commit.nestedSubvolumeTableRootHomeRef,
      rootInodeTableRootHomeRef: commit.rootInodeTableRootHomeRef,
      type: "direct_working_pages" as const,
    }),
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
