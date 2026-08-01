import { describe, expect, it } from "vitest";
import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  UINT64_MAXIMUM,
  createCommitSequence,
  createFeatureBits,
  createHomeRecordReference,
  createPhysicalRecordReference,
  createPublicationSequence,
  createUInt64,
  createUnlockSequence,
  parseMutationId,
  parseSegmentId,
} from "@/00-storage/service/hizofs/00-format";
import type { SuperblockLogicalState } from "@/00-storage/service/hizofs/authenticated-store/superblock-store";
import {
  RelocationPublicationPlanError,
  prepareRelocationPublicationPlan,
} from "@/00-storage/service/hizofs/maintenance/relocation-publication-plan";

function logicalState(): SuperblockLogicalState {
  return {
    activeCommitHomeRef: createHomeRecordReference({ fields: {
      byteOffset: createUInt64({ value: 64n }),
      frameLength: 96,
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
      segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(1) }),
    } }),
    activeCommitSequence: createCommitSequence({ value: 7n }),
    activeMutationId: parseMutationId({ bytes: new Uint8Array(16).fill(2) }),
    fallbackCommitHomeRef: null,
    minimumUnlockSequence: createUnlockSequence({ value: 3n }),
    relocationIndexRootPhysicalRef: null,
    requiredFeatureBits: createFeatureBits({ value: 0n }),
  };
}

function relocationRoot({ offset = 64n, seed = 9 }: { offset?: bigint; seed?: number } = {}) {
  return createPhysicalRecordReference({ fields: {
    byteOffset: createUInt64({ value: offset }),
    frameLength: 96,
    recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.relocation_index_page,
    segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(seed) }),
  } });
}

describe("relocation publication plan", () => {
  it("reserves F+1/F+2 while preserving every logical authority except relocation root", () => {
    const base = logicalState();
    const root = relocationRoot();
    const plan = prepareRelocationPublicationPlan({
      baseLogicalState: base,
      maximumStructurallyObservedPublicationSequence: createPublicationSequence({ value: 10n }),
      relocationIndexRootPhysicalRef: root,
    });
    expect(plan.firstPublicationSequence).toBe(11n);
    expect(plan.secondPublicationSequence).toBe(12n);
    expect(plan.logicalState).toEqual({ ...base, relocationIndexRootPhysicalRef: root });
    expect(plan.logicalState.activeCommitHomeRef).not.toBe(base.activeCommitHomeRef);
    expect(plan.logicalState.activeMutationId).not.toBe(base.activeMutationId);
  });

  it("allows clearing an existing relocation root", () => {
    const base = { ...logicalState(), relocationIndexRootPhysicalRef: relocationRoot() };
    expect(prepareRelocationPublicationPlan({
      baseLogicalState: base,
      maximumStructurallyObservedPublicationSequence: createPublicationSequence({ value: 2n }),
      relocationIndexRootPhysicalRef: null,
    }).logicalState.relocationIndexRootPhysicalRef).toBeNull();
  });

  it("rejects no-op, wrong-kind, and exhausted publication plans", () => {
    const base = logicalState();
    expect(() => prepareRelocationPublicationPlan({
      baseLogicalState: base,
      maximumStructurallyObservedPublicationSequence: createPublicationSequence({ value: 2n }),
      relocationIndexRootPhysicalRef: null,
    })).toThrowError(RelocationPublicationPlanError);
    const wrongKind = createPhysicalRecordReference({ fields: {
      ...relocationRoot(),
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
    } });
    expect(() => prepareRelocationPublicationPlan({
      baseLogicalState: base,
      maximumStructurallyObservedPublicationSequence: createPublicationSequence({ value: 2n }),
      relocationIndexRootPhysicalRef: wrongKind,
    })).toThrowError(RelocationPublicationPlanError);
    expect(() => prepareRelocationPublicationPlan({
      baseLogicalState: base,
      maximumStructurallyObservedPublicationSequence: createPublicationSequence({ value: UINT64_MAXIMUM - 1n }),
      relocationIndexRootPhysicalRef: relocationRoot(),
    })).toThrow("Publication Sequence space");
  });
});
