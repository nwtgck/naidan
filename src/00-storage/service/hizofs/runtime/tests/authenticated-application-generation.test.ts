import { describe, expect, it } from "vitest";
import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createCommitSequence,
  createFeatureBits,
  createFileSystemCommitPayload,
  createHomeRecordReference,
  createInodeNumber,
  createPublicationSequence,
  createSubvolumeId,
  createUInt64,
  createUnlockSequence,
  parseMutationId,
  parsePublicationId,
  parseSegmentId,
  type OpenedSuperblockCopies,
} from "@/00-storage/service/hizofs/00-format";
import {
  createAuthenticatedDurableApplicationGenerationAuthority,
  createAuthenticatedStagedApplicationGenerationDescriptor,
} from "@/00-storage/service/hizofs/runtime/authenticated-application-generation";
import {
  createSuccessorWorkingGenerationIdentity,
  createWorkingGenerationAuthorityEpoch,
  createWorkingGenerationIdentity,
  createWorkingGenerationNumber,
} from "@/00-storage/service/hizofs/runtime/application-generation-identity";

function reference({ kind, offset }: { kind: number; offset: bigint }) {
  return createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: offset }),
    frameLength: 128,
    recordKind: kind,
    segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(Number(offset % 251n) + 1) }),
  } });
}

function durableFixture() {
  const mutationId = parseMutationId({ bytes: new Uint8Array(16).fill(3) });
  const commitReference = reference({
    kind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
    offset: 64n,
  });
  const commit = createFileSystemCommitPayload({ payload: {
    commitSequence: createCommitSequence({ value: 1n }),
    mutationId,
    nestedSubvolumeTableRootHomeRef: null,
    nextInodeNumber: createInodeNumber({ value: 2n }),
    nextSubvolumeId: createSubvolumeId({ value: 2n }),
    rootDirectoryInodeNumber: createInodeNumber({ value: 1n }),
    rootInodeTableRootHomeRef: reference({
      kind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
      offset: 192n,
    }),
  } });
  const logicalState = Object.freeze({
    activeCommitHomeRef: commitReference,
    activeCommitSequence: commit.commitSequence,
    activeMutationId: mutationId,
    fallbackCommitHomeRef: null,
    minimumUnlockSequence: createUnlockSequence({ value: 1n }),
    relocationIndexRootPhysicalRef: null,
    requiredFeatureBits: createFeatureBits({ value: 0n }),
  });
  const superblock: OpenedSuperblockCopies = Object.freeze({
    authenticatedLogicalStates: Object.freeze([logicalState]),
    copyState: "normal",
    historicalRootFeatureState: "supported_or_absent",
    logicalState,
    maximumStructurallyObservedPublicationSequence: createPublicationSequence({ value: 1n }),
    selectedCopy: 0,
    selectedPublicationId: parsePublicationId({ bytes: new Uint8Array(16).fill(4) }),
    selectedPublicationSequence: createPublicationSequence({ value: 1n }),
  });
  return createAuthenticatedDurableApplicationGenerationAuthority({ commit, commitReference, superblock });
}

describe("authenticated staged application generation", () => {
  it("roots a working generation directly in its staged metadata pages", () => {
    const durableAuthority = durableFixture();
    const mutationId = parseMutationId({ bytes: new Uint8Array(16).fill(9) });
    const commit = createFileSystemCommitPayload({ payload: {
      ...durableAuthority.commit,
      commitSequence: createCommitSequence({ value: 2n }),
      mutationId,
      rootInodeTableRootHomeRef: reference({
        kind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
        offset: 320n,
      }),
    } });
    const baseWorking = createWorkingGenerationIdentity({
      authorityEpoch: createWorkingGenerationAuthorityEpoch(),
      generationNumber: createWorkingGenerationNumber({ value: 0n }),
      mutationId: durableAuthority.commit.mutationId,
    });

    const staged = createAuthenticatedStagedApplicationGenerationDescriptor({
      commit,
      durableAuthority,
      workingIdentity: createSuccessorWorkingGenerationIdentity({ mutationId, previous: baseWorking }),
    });

    expect(staged.superblock).toBe(durableAuthority.superblock);
    expect(staged.workingRootAuthority).toEqual({
      nestedSubvolumeTableRootHomeRef: null,
      rootInodeTableRootHomeRef: commit.rootInodeTableRootHomeRef,
      type: "direct_working_pages",
    });
    expect("commitReference" in staged).toBe(false);
  });

  it("rejects a staged descriptor whose working identity names another mutation", () => {
    const durableAuthority = durableFixture();
    const commit = createFileSystemCommitPayload({ payload: {
      ...durableAuthority.commit,
      commitSequence: createCommitSequence({ value: 2n }),
      mutationId: parseMutationId({ bytes: new Uint8Array(16).fill(9) }),
    } });
    const wrongIdentity = createWorkingGenerationIdentity({
      authorityEpoch: createWorkingGenerationAuthorityEpoch(),
      generationNumber: createWorkingGenerationNumber({ value: 1n }),
      mutationId: parseMutationId({ bytes: new Uint8Array(16).fill(10) }),
    });

    expect(() => createAuthenticatedStagedApplicationGenerationDescriptor({
      commit,
      durableAuthority,
      workingIdentity: wrongIdentity,
    })).toThrow("working application generation identity does not match its mutation payload");
  });
});
