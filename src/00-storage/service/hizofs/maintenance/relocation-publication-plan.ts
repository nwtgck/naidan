import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  UINT64_MAXIMUM,
  compareUnsignedBytes,
  createFeatureBits,
  createHomeRecordReference,
  createPhysicalRecordReference,
  createPublicationSequence,
  createUnlockSequence,
  parseMutationId,
  type PhysicalRecordReference,
  type PublicationSequence,
} from "@/00-storage/service/hizofs/00-format";
import type { SuperblockLogicalState } from "@/00-storage/service/hizofs/authenticated-store/superblock-store";

export type RelocationPublicationPlan = Readonly<{
  firstPublicationSequence: PublicationSequence;
  logicalState: SuperblockLogicalState;
  secondPublicationSequence: PublicationSequence;
}>;

export type RelocationPublicationPlanErrorCode =
  | "invalid_relocation_root"
  | "no_logical_change";

export class RelocationPublicationPlanError extends Error {
  readonly code: RelocationPublicationPlanErrorCode;

  constructor({ code, message }: { code: RelocationPublicationPlanErrorCode; message: string }) {
    super(message);
    this.name = "RelocationPublicationPlanError";
    this.code = code;
  }
}

function sameOptionalPhysicalReference({ left, right }: {
  left: PhysicalRecordReference | null;
  right: PhysicalRecordReference | null;
}): boolean {
  if (left === null || right === null) return left === right;
  return left.byteOffset === right.byteOffset
    && left.frameLength === right.frameLength
    && left.recordKind === right.recordKind
    && compareUnsignedBytes({ left: left.segmentId, right: right.segmentId }) === 0;
}

function cloneOptionalPhysicalReference({ reference }: {
  reference: PhysicalRecordReference | null;
}): PhysicalRecordReference | null {
  return reference === null ? null : createPhysicalRecordReference({ fields: reference });
}

function cloneLogicalState({ baseLogicalState, relocationIndexRootPhysicalRef }: {
  baseLogicalState: SuperblockLogicalState;
  relocationIndexRootPhysicalRef: PhysicalRecordReference | null;
}): SuperblockLogicalState {
  return Object.freeze({
    activeCommitHomeRef: createHomeRecordReference({ fields: baseLogicalState.activeCommitHomeRef }),
    activeCommitSequence: baseLogicalState.activeCommitSequence,
    activeMutationId: parseMutationId({ bytes: baseLogicalState.activeMutationId }),
    fallbackCommitHomeRef: baseLogicalState.fallbackCommitHomeRef === null
      ? null
      : createHomeRecordReference({ fields: baseLogicalState.fallbackCommitHomeRef }),
    minimumUnlockSequence: createUnlockSequence({ value: baseLogicalState.minimumUnlockSequence }),
    relocationIndexRootPhysicalRef: cloneOptionalPhysicalReference({ reference: relocationIndexRootPhysicalRef }),
    requiredFeatureBits: createFeatureBits({ value: baseLogicalState.requiredFeatureBits }),
  });
}

export function prepareRelocationPublicationPlan({
  baseLogicalState,
  maximumStructurallyObservedPublicationSequence,
  relocationIndexRootPhysicalRef,
}: {
  baseLogicalState: SuperblockLogicalState;
  maximumStructurallyObservedPublicationSequence: PublicationSequence;
  relocationIndexRootPhysicalRef: PhysicalRecordReference | null;
}): RelocationPublicationPlan {
  if (relocationIndexRootPhysicalRef !== null
    && relocationIndexRootPhysicalRef.recordKind !== HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.relocation_index_page) {
    throw new RelocationPublicationPlanError({
      code: "invalid_relocation_root",
      message: "relocation publication root must identify a physical-only Relocation Index page",
    });
  }
  if (sameOptionalPhysicalReference({
    left: baseLogicalState.relocationIndexRootPhysicalRef,
    right: relocationIndexRootPhysicalRef,
  })) {
    throw new RelocationPublicationPlanError({
      code: "no_logical_change",
      message: "relocation publication must change the authoritative Relocation Index root",
    });
  }
  if (maximumStructurallyObservedPublicationSequence > UINT64_MAXIMUM - 2n) {
    throw new RangeError("Publication Sequence space cannot reserve two fresh copies; maintenance must stop");
  }
  return Object.freeze({
    firstPublicationSequence: createPublicationSequence({
      value: maximumStructurallyObservedPublicationSequence + 1n,
    }),
    logicalState: cloneLogicalState({ baseLogicalState, relocationIndexRootPhysicalRef }),
    secondPublicationSequence: createPublicationSequence({
      value: maximumStructurallyObservedPublicationSequence + 2n,
    }),
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
