import { describe, expect, it } from "vitest";
import { parseSegmentId, segmentIdToLowercaseHex } from "@/00-storage/service/hizofs/00-format";
import type { CandidateSegmentPlanEntry } from "@/00-storage/service/hizofs/maintenance/candidate-segment-batch";
import { createMaintenancePolicy } from "@/00-storage/service/hizofs/maintenance/maintenance-policy";
import {
  SlicedSweepExecutor,
  SlicedSweepExecutorError,
  type PreparedSegmentRemoval,
} from "@/00-storage/service/hizofs/maintenance/sliced-sweep-executor";

function plan({ seed }: { seed: number }): CandidateSegmentPlanEntry {
  return {
    disposition: "remove",
    frameCount: 2,
    liveBytes: 0,
    liveFrameCount: 0,
    ownership: "sealed",
    segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(seed) }),
    totalFrameBytes: 256,
  };
}

function prepared({ events, seed }: { events: string[]; seed: number }): PreparedSegmentRemoval {
  return {
    acquireDeletionLease: async () => ({ release: () => events.push(`release:${seed}`) }),
    plan: plan({ seed }),
  };
}

function ids(values: readonly Uint8Array[]): string[] {
  return values.map(value => segmentIdToLowercaseHex({ id: value as ReturnType<typeof parseSegmentId> }));
}

const noForeground = () => false;
const constantNow = () => 0;
const retainFailure = () => "retain_and_continue" as const;

describe("sliced sweep executor", () => {
  it("settles each started remove and releases its deletion lease", async () => {
    const events: string[] = [];
    const executor = new SlicedSweepExecutor({
      policy: createMaintenancePolicy({ maxRemovalsPerSlice: 4, removeConcurrency: 2 }),
      preparedRemovals: [prepared({ events, seed: 2 }), prepared({ events, seed: 1 })],
    });
    const result = await executor.runSlice({
      classifyFailure: retainFailure,
      hasForegroundWaiter: noForeground,
      now: constantNow,
      removeSegment: async ({ segmentId }) => {
        events.push(`remove:${segmentId[0]}`);
      },
      signal: undefined,
    });
    expect(result.phase).toBe("completed");
    if (result.phase !== "completed") expect.unreachable("sweep must complete");
    expect(ids(result.removedSegmentIds)).toEqual(ids([plan({ seed: 1 }).segmentId, plan({ seed: 2 }).segmentId]));
    expect(events).toEqual(["remove:1", "remove:2", "release:1", "release:2"]);
  });

  it("yields before starting work when foreground is waiting", async () => {
    const events: string[] = [];
    const executor = new SlicedSweepExecutor({ policy: createMaintenancePolicy(), preparedRemovals: [prepared({ events, seed: 1 })] });
    expect(await executor.runSlice({
      classifyFailure: retainFailure,
      hasForegroundWaiter: () => true,
      now: constantNow,
      removeSegment: async () => {
        events.push("remove");
      },
      signal: undefined,
    })).toEqual({ phase: "sweeping", reason: "foreground_waiter" });
    expect(events).toEqual([]);
  });

  it("respects the per-slice removal bound and resumes", async () => {
    const events: string[] = [];
    const executor = new SlicedSweepExecutor({
      policy: createMaintenancePolicy({ maxRemovalsPerSlice: 1, removeConcurrency: 1 }),
      preparedRemovals: [prepared({ events, seed: 1 }), prepared({ events, seed: 2 })],
    });
    expect(await executor.runSlice({
      classifyFailure: retainFailure,
      hasForegroundWaiter: noForeground,
      now: constantNow,
      removeSegment: async () => undefined,
      signal: undefined,
    })).toEqual({ phase: "sweeping", reason: "slice_removal_limit" });
    expect((await executor.runSlice({
      classifyFailure: retainFailure,
      hasForegroundWaiter: noForeground,
      now: constantNow,
      removeSegment: async () => undefined,
      signal: undefined,
    })).phase).toBe("completed");
  });

  it("preserves remove and deletion-lease cleanup failures for classification", async () => {
    const removeFailure = new Error("segment removal failed");
    const releaseFailure = new Error("deletion lease release failed");
    let classifiedCause: unknown;
    const executor = new SlicedSweepExecutor({
      policy: createMaintenancePolicy({ maxRemovalsPerSlice: 1, removeConcurrency: 1 }),
      preparedRemovals: [{
        acquireDeletionLease: async () => ({ release: () => {
          throw releaseFailure;
        } }),
        plan: plan({ seed: 1 }),
      }],
    });

    const result = await executor.runSlice({
      classifyFailure: ({ cause }) => {
        classifiedCause = cause;
        return "retain_and_continue";
      },
      hasForegroundWaiter: noForeground,
      now: constantNow,
      removeSegment: async () => {
        throw removeFailure;
      },
      signal: undefined,
    });

    expect(result.phase).toBe("completed");
    if (result.phase !== "completed") expect.unreachable("sweep must complete");
    expect(result.removedSegmentIds).toHaveLength(0);
    expect(result.retainedSegmentIds).toHaveLength(1);
    expect(classifiedCause).toEqual(expect.objectContaining({
      errors: [removeFailure, releaseFailure],
    }));
  });

  it("classifies lease cleanup failure after a successful physical removal", async () => {
    const releaseFailure = new Error("deletion lease release failed");
    let classifiedCause: unknown;
    const executor = new SlicedSweepExecutor({
      policy: createMaintenancePolicy({ maxRemovalsPerSlice: 1, removeConcurrency: 1 }),
      preparedRemovals: [{
        acquireDeletionLease: async () => ({ release: () => {
          throw releaseFailure;
        } }),
        plan: plan({ seed: 1 }),
      }],
    });

    const result = await executor.runSlice({
      classifyFailure: ({ cause }) => {
        classifiedCause = cause;
        return "retain_and_continue";
      },
      hasForegroundWaiter: noForeground,
      now: constantNow,
      removeSegment: async () => undefined,
      signal: undefined,
    });

    expect(result.phase).toBe("completed");
    if (result.phase !== "completed") expect.unreachable("sweep must complete");
    expect(result.removedSegmentIds).toHaveLength(0);
    expect(result.retainedSegmentIds).toHaveLength(1);
    expect(classifiedCause).toBe(releaseFailure);
  });

  it("retains a failed segment and continues when the classifier permits", async () => {
    const events: string[] = [];
    const executor = new SlicedSweepExecutor({
      policy: createMaintenancePolicy({ maxRemovalsPerSlice: 4, removeConcurrency: 1 }),
      preparedRemovals: [prepared({ events, seed: 1 }), prepared({ events, seed: 2 })],
    });
    const result = await executor.runSlice({
      classifyFailure: retainFailure,
      hasForegroundWaiter: noForeground,
      now: constantNow,
      removeSegment: async ({ segmentId }) => {
        if (segmentId[0] === 1) throw new Error("transient remove failure");
      },
      signal: undefined,
    });
    expect(result.phase).toBe("completed");
    if (result.phase !== "completed") expect.unreachable("sweep must complete");
    expect(result.removedSegmentIds).toHaveLength(1);
    expect(result.retainedSegmentIds).toHaveLength(1);
    expect(events).toEqual(["release:1", "release:2"]);
  });

  it("stops scheduling after an abort-class failure while retaining unstarted segments", async () => {
    const events: string[] = [];
    const executor = new SlicedSweepExecutor({
      policy: createMaintenancePolicy({ maxRemovalsPerSlice: 4, removeConcurrency: 1 }),
      preparedRemovals: [prepared({ events, seed: 1 }), prepared({ events, seed: 2 }), prepared({ events, seed: 3 })],
    });
    const result = await executor.runSlice({
      classifyFailure: () => "abort_cycle",
      hasForegroundWaiter: noForeground,
      now: constantNow,
      removeSegment: async () => {
        throw new Error("fatal backend failure");
      },
      signal: undefined,
    });
    expect(result.phase).toBe("aborted_after_partial_sweep");
    if (result.phase !== "aborted_after_partial_sweep") expect.unreachable("sweep must abort");
    expect(result.removedSegmentIds).toHaveLength(0);
    expect(result.retainedSegmentIds).toHaveLength(3);
    expect(events).toEqual(["release:1"]);
  });

  it("rejects partial-live compaction entries at the sweep boundary", () => {
    const invalid = { ...plan({ seed: 1 }), disposition: "compact" as const, liveFrameCount: 1, liveBytes: 128 };
    expect(() => new SlicedSweepExecutor({
      policy: createMaintenancePolicy(),
      preparedRemovals: [{ acquireDeletionLease: async () => ({ release: () => undefined }), plan: invalid }],
    })).toThrowError(SlicedSweepExecutorError);
  });
});
