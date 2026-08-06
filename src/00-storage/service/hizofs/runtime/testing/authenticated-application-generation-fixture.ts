import {
  createCommitSequence,
  createFeatureBits,
  createFileSystemCommitPayload,
  createHomeRecordReference,
  createInodeNumber,
  createPublicationSequence,
  createSubvolumeId,
  createUInt64,
  createUnlockSequence,
  HIZOFS_V1_FORMAT_CONSTANTS,
  parseMutationId,
  parsePublicationId,
  parseSegmentId,
  type OpenedSuperblockCopies,
} from "@/00-storage/service/hizofs/00-format";
import {
  createAuthenticatedDurableApplicationGenerationAuthority,
  type AuthenticatedDurableApplicationGenerationAuthority,
} from "@/00-storage/service/hizofs/runtime/authenticated-application-generation";

function commitReference() {
  return createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: 64n }),
    frameLength: 96,
    recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
    segmentId: parseSegmentId({ bytes: Uint8Array.from({ length: 16 }, (_, index) => index + 1) }),
  } });
}

function inodeTableReference() {
  return createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: 128n }),
    frameLength: 96,
    recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
    segmentId: parseSegmentId({ bytes: Uint8Array.from({ length: 16 }, (_, index) => index + 17) }),
  } });
}

export function createTestingAuthenticatedDurableApplicationGenerationAuthority():
AuthenticatedDurableApplicationGenerationAuthority {
  const commitReferenceValue = commitReference();
  const mutationId = parseMutationId({ bytes: new Uint8Array(16).fill(1) });
  const commit = createFileSystemCommitPayload({ payload: {
    commitSequence: createCommitSequence({ value: 7n }),
    mutationId,
    nestedSubvolumeTableRootHomeRef: null,
    nextInodeNumber: createInodeNumber({ value: 2n }),
    nextSubvolumeId: createSubvolumeId({ value: 2n }),
    rootDirectoryInodeNumber: createInodeNumber({ value: 1n }),
    rootInodeTableRootHomeRef: inodeTableReference(),
  } });
  const logicalState = Object.freeze({
    activeCommitHomeRef: commitReferenceValue,
    activeCommitSequence: commit.commitSequence,
    activeMutationId: mutationId,
    fallbackCommitHomeRef: null,
    minimumUnlockSequence: createUnlockSequence({ value: 1n }),
    relocationIndexRootPhysicalRef: null,
    requiredFeatureBits: createFeatureBits({ value: 0n }),
  });
  const superblock: OpenedSuperblockCopies = Object.freeze({
    authenticatedLogicalStates: Object.freeze([logicalState, logicalState]),
    copyState: "normal",
    historicalRootFeatureState: "supported_or_absent",
    logicalState,
    maximumStructurallyObservedPublicationSequence: createPublicationSequence({ value: 1n }),
    selectedCopy: 0,
    selectedPublicationId: parsePublicationId({ bytes: new Uint8Array(16).fill(3) }),
    selectedPublicationSequence: createPublicationSequence({ value: 1n }),
  });
  return createAuthenticatedDurableApplicationGenerationAuthority({
    commit,
    commitReference: commitReferenceValue,
    superblock,
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
