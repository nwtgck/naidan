import { describe, expect, it, vi } from "vitest";
import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createHomeRecordReference,
  createPhysicalRecordReference,
  createUInt64,
  encodeBase64UrlUnpadded,
  encodeHomeRecordReference,
  parseSegmentId,
  segmentIdToLowercaseHex,
  type HomeRecordReference,
  type SegmentId,
} from "@/00-storage/service/hizofs/00-format";
import type { CapturedCandidateSegment } from "@/00-storage/service/hizofs/maintenance/candidate-segment-batch";
import { createCandidateFrameOrdinalAuthority } from "@/00-storage/service/hizofs/authenticated-store/candidate-frame-ordinal-authority";
import type { ResolvedMaintenanceRecord } from "@/00-storage/service/hizofs/maintenance/garbage-collection-mark-cursor";
import { createMaintenancePolicy } from "@/00-storage/service/hizofs/maintenance/maintenance-policy";
import {
  createLogicalMaintenanceTraversalItem,
  type MaintenanceTraversalItem,
} from "@/00-storage/service/hizofs/maintenance/maintenance-traversal-item";
import { createMaintenanceRootSnapshot } from "@/00-storage/service/hizofs/maintenance/maintenance-root-snapshot";
import {
  SlicedGarbageCollectionCycle,
  type ValidatedGarbageCollectionSweepAuthority,
} from "@/00-storage/service/hizofs/maintenance/sliced-garbage-collection-cycle";

function segmentId({ seed }: { seed: number }): SegmentId {
  return parseSegmentId({ bytes: new Uint8Array(16).fill(seed) });
}

function homeReference({ offset, segmentSeed = 1 }: { offset: bigint; segmentSeed?: number }): HomeRecordReference {
  return createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: 64n + offset * 8n }),
    frameLength: 128,
    recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
    segmentId: segmentId({ seed: segmentSeed }),
  } });
}

function identity({ reference }: { reference: HomeRecordReference }): string {
  return encodeBase64UrlUnpadded({ bytes: encodeHomeRecordReference({ reference }) });
}

function logicalItem({ offset }: { offset: bigint }) {
  return createLogicalMaintenanceTraversalItem({ pageRole: "non_root", reference: homeReference({ offset }) });
}

function resolved({ children = [], ordinal = 0, segmentSeed = 50 }: {
  children?: readonly MaintenanceTraversalItem[];
  ordinal?: number;
  segmentSeed?: number;
} = {}): ResolvedMaintenanceRecord {
  return {
    bytesRead: 128,
    childItems: children,
    physicalReference: createPhysicalRecordReference({ fields: {
      byteOffset: createUInt64({ value: 64n + BigInt(ordinal) * 128n }),
      frameLength: 128,
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
      segmentId: segmentId({ seed: segmentSeed }),
    } }),
  };
}

function candidate({ frameCount = 2, seed }: { frameCount?: number; seed: number }): CapturedCandidateSegment {
  const id = segmentId({ seed });
  return {
    frameCount,
    frameOrdinalAuthority: createCandidateFrameOrdinalAuthority({
      frames: Array.from({ length: frameCount }, (_, ordinal) => ({
        frameLength: 128,
        physicalOffset: 64n + BigInt(ordinal * 128),
        recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
      })),
      segmentId: id,
    }),
    ownership: "sealed",
    segmentId: id,
    totalFrameBytes: frameCount * 128,
  };
}

function setup({ candidates = [candidate({ seed: 50 }), candidate({ seed: 60 })], maxRemovalsPerSlice = 4 }: {
  candidates?: readonly CapturedCandidateSegment[];
  maxRemovalsPerSlice?: number;
} = {}) {
  const root = logicalItem({ offset: 1n });
  const graph = new Map([[identity({ reference: root.reference }), resolved()]]);
  type BeginDeletion = Extract<ValidatedGarbageCollectionSweepAuthority, { valid: true }>["beginDeletion"];
  const beginDeletion = vi.fn<BeginDeletion>(async () => ({ release: vi.fn() }));
  const validateAndPrepareSweep = vi.fn<() => Promise<ValidatedGarbageCollectionSweepAuthority>>(
    async () => ({ beginDeletion, valid: true }),
  );
  const cycle = new SlicedGarbageCollectionCycle({
    capturedSnapshot: createMaintenanceRootSnapshot({ candidateSegments: candidates, maintenanceRootEpoch: 7, roots: [root] }),
    policy: createMaintenancePolicy({ enabled: true, maxRemovalsPerSlice, removeConcurrency: 1 }),
    reader: { readRecord: async ({ item }) => {
      if (item.kind !== "logical_home") throw new Error("unexpected physical traversal item");
      const value = graph.get(identity({ reference: item.reference }));
      if (value === undefined) throw new Error("missing maintenance record");
      return value;
    } },
    validateAndPrepareSweep,
  });
  return { beginDeletion, cycle, validateAndPrepareSweep };
}

const noForeground = () => false;
const constantNow = () => 0;
const retainFailure = () => "retain_and_continue" as const;
const removeSuccess = async () => undefined;

function ids({ values }: { values: readonly SegmentId[] }): string[] {
  return values.map(value => segmentIdToLowercaseHex({ id: value }));
}

describe("sliced garbage collection cycle", () => {
  it("marks, validates, removes only whole-dead segments, and returns compaction candidates", async () => {
    const { beginDeletion, cycle, validateAndPrepareSweep } = setup();
    const result = await cycle.runSlice({
      classifySweepFailure: retainFailure,
      hasForegroundWaiter: noForeground,
      now: constantNow,
      removeSegment: removeSuccess,
      signal: undefined,
    });

    expect(result.phase).toBe("completed");
    if (result.phase !== "completed") expect.unreachable("cycle must complete");
    expect(ids({ values: result.compactionSegmentIds })).toEqual([segmentIdToLowercaseHex({ id: segmentId({ seed: 50 }) })]);
    expect(ids({ values: result.removedSegmentIds })).toEqual([segmentIdToLowercaseHex({ id: segmentId({ seed: 60 }) })]);
    expect(result.retainedSegmentIds).toEqual([]);
    expect(validateAndPrepareSweep).toHaveBeenCalledOnce();
    expect(beginDeletion).toHaveBeenCalledOnce();
    expect(beginDeletion.mock.calls[0]?.[0].plan.disposition).toBe("remove");
    expect(cycle.diagnostics()).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: "marking", type: "phase_started" }),
      expect.objectContaining({ phase: "validating", type: "phase_started" }),
      expect.objectContaining({ phase: "sweeping", type: "phase_started" }),
      expect.objectContaining({ removedSegments: 1, type: "sweep_progress" }),
    ]));
  });

  it("gives foreground work priority before validation and resumes", async () => {
    const { beginDeletion, cycle, validateAndPrepareSweep } = setup();
    expect(await cycle.runSlice({
      classifySweepFailure: retainFailure,
      hasForegroundWaiter: () => true,
      now: constantNow,
      removeSegment: removeSuccess,
      signal: undefined,
    })).toEqual({ phase: "marking", reason: "foreground_waiter" });
    expect(validateAndPrepareSweep).not.toHaveBeenCalled();
    expect(beginDeletion).not.toHaveBeenCalled();
    expect((await cycle.runSlice({
      classifySweepFailure: retainFailure,
      hasForegroundWaiter: noForeground,
      now: constantNow,
      removeSegment: removeSuccess,
      signal: undefined,
    })).phase).toBe("completed");
  });

  it("aborts before deletion when the short-gate validation rejects the captured roots", async () => {
    const { beginDeletion, cycle, validateAndPrepareSweep } = setup();
    validateAndPrepareSweep.mockResolvedValueOnce({ reason: "root_epoch_changed", valid: false });
    expect(await cycle.runSlice({
      classifySweepFailure: retainFailure,
      hasForegroundWaiter: noForeground,
      now: constantNow,
      removeSegment: removeSuccess,
      signal: undefined,
    })).toEqual({ phase: "aborted_without_deletion", reason: "root_epoch_changed" });
    expect(beginDeletion).not.toHaveBeenCalled();
  });

  it("never validates or deletes after a fail-closed mark abort", async () => {
    const root = logicalItem({ offset: 1n });
    const validateAndPrepareSweep = vi.fn();
    const cycle = new SlicedGarbageCollectionCycle({
      capturedSnapshot: createMaintenanceRootSnapshot({
        candidateSegments: [candidate({ seed: 50 })],
        maintenanceRootEpoch: 1,
        roots: [root],
      }),
      policy: createMaintenancePolicy({ enabled: true }),
      reader: { readRecord: async () => {
        throw new Error("record read failed");
      } },
      validateAndPrepareSweep,
    });
    expect(await cycle.runSlice({
      classifySweepFailure: retainFailure,
      hasForegroundWaiter: noForeground,
      now: constantNow,
      removeSegment: removeSuccess,
      signal: undefined,
    })).toEqual({ phase: "aborted_without_deletion", reason: "record_read_failed" });
    expect(validateAndPrepareSweep).not.toHaveBeenCalled();
  });

  it("respects sweep slice limits and resumes without repeating validation", async () => {
    const { beginDeletion, cycle, validateAndPrepareSweep } = setup({
      candidates: [candidate({ seed: 60 }), candidate({ seed: 70 })],
      maxRemovalsPerSlice: 1,
    });
    expect(await cycle.runSlice({
      classifySweepFailure: retainFailure,
      hasForegroundWaiter: noForeground,
      now: constantNow,
      removeSegment: removeSuccess,
      signal: undefined,
    })).toEqual({ phase: "sweeping", reason: "slice_removal_limit" });
    expect(beginDeletion).toHaveBeenCalledOnce();
    expect((await cycle.runSlice({
      classifySweepFailure: retainFailure,
      hasForegroundWaiter: noForeground,
      now: constantNow,
      removeSegment: removeSuccess,
      signal: undefined,
    })).phase).toBe("completed");
    expect(beginDeletion).toHaveBeenCalledTimes(2);
    expect(validateAndPrepareSweep).toHaveBeenCalledOnce();
  });

  it("classifies a synchronous deletion-lease acquisition failure without escaping the sweep", async () => {
    const root = logicalItem({ offset: 1n });
    const leaseFailure = new Error("lease acquisition failed");
    let classifiedCause: unknown;
    const cycle = new SlicedGarbageCollectionCycle({
      capturedSnapshot: createMaintenanceRootSnapshot({
        candidateSegments: [candidate({ seed: 60 })],
        maintenanceRootEpoch: 1,
        roots: [root],
      }),
      policy: createMaintenancePolicy({ enabled: true }),
      reader: { readRecord: async () => resolved({ segmentSeed: 50 }) },
      validateAndPrepareSweep: async () => ({
        beginDeletion: () => {
          throw leaseFailure;
        },
        valid: true,
      }),
    });
    const result = await cycle.runSlice({
      classifySweepFailure: ({ cause }) => {
        classifiedCause = cause;
        return "retain_and_continue";
      },
      hasForegroundWaiter: noForeground,
      now: constantNow,
      removeSegment: removeSuccess,
      signal: undefined,
    });
    expect(result.phase).toBe("completed");
    if (result.phase !== "completed") expect.unreachable("cycle must retain failed lease acquisition");
    expect(result.removedSegmentIds).toEqual([]);
    expect(result.retainedSegmentIds).toHaveLength(1);
    expect(classifiedCause).toBe(leaseFailure);
  });

  it("retains failed removals and remains terminal after completion", async () => {
    const { cycle } = setup({ candidates: [candidate({ seed: 60 })] });
    const failure = new Error("remove failed");
    const first = await cycle.runSlice({
      classifySweepFailure: retainFailure,
      hasForegroundWaiter: noForeground,
      now: constantNow,
      removeSegment: async () => {
        throw failure;
      },
      signal: undefined,
    });
    expect(first.phase).toBe("completed");
    if (first.phase !== "completed") expect.unreachable("cycle must complete with retained failure");
    expect(first.removedSegmentIds).toEqual([]);
    expect(first.retainedSegmentIds).toHaveLength(1);
    expect(await cycle.runSlice({
      classifySweepFailure: retainFailure,
      hasForegroundWaiter: noForeground,
      now: constantNow,
      removeSegment: removeSuccess,
      signal: undefined,
    })).toBe(first);
  });

  it("rejects a disabled maintenance policy", () => {
    const root = logicalItem({ offset: 1n });
    expect(() => new SlicedGarbageCollectionCycle({
      capturedSnapshot: createMaintenanceRootSnapshot({
        candidateSegments: [candidate({ seed: 50 })],
        maintenanceRootEpoch: 1,
        roots: [root],
      }),
      policy: createMaintenancePolicy({ enabled: false }),
      reader: { readRecord: async () => resolved() },
      validateAndPrepareSweep: async () => ({ beginDeletion: async () => ({ release: () => undefined }), valid: true }),
    })).toThrowError(expect.objectContaining({ code: "cycle_disabled" }));
  });
});
