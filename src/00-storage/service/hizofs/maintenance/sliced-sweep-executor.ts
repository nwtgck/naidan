import {
  segmentIdToLowercaseHex,
  type SegmentId,
} from "@/00-storage/service/hizofs/00-format";
import type { CandidateSegmentPlanEntry } from "@/00-storage/service/hizofs/maintenance/candidate-segment-batch";
import type { HizoFSMaintenancePolicy } from "@/00-storage/service/hizofs/maintenance/maintenance-policy";

export type PreparedSegmentDeletionLease = Readonly<{
  release: () => void;
}>;

export type PreparedSegmentRemoval = Readonly<{
  acquireDeletionLease: () => Promise<PreparedSegmentDeletionLease>;
  plan: CandidateSegmentPlanEntry;
}>;

export type SweepFailureDisposition = "abort_cycle" | "retain_and_continue";

export type SweepYieldReason =
  | "abort_requested"
  | "foreground_waiter"
  | "slice_removal_limit"
  | "soft_time_limit";

export type SlicedSweepResult =
  | Readonly<{
    phase: "aborted_after_partial_sweep";
    removedSegmentIds: readonly SegmentId[];
    retainedSegmentIds: readonly SegmentId[];
  }>
  | Readonly<{
    phase: "completed";
    removedSegmentIds: readonly SegmentId[];
    retainedSegmentIds: readonly SegmentId[];
  }>
  | Readonly<{
    phase: "sweeping";
    reason: SweepYieldReason;
  }>;

export type SlicedSweepExecutorErrorCode =
  | "duplicate_segment"
  | "invalid_plan";

export class SlicedSweepExecutorError extends Error {
  readonly code: SlicedSweepExecutorErrorCode;

  constructor({ code, message }: { code: SlicedSweepExecutorErrorCode; message: string }) {
    super(message);
    this.name = "SlicedSweepExecutorError";
    this.code = code;
  }
}

type RemovalState = {
  acquireDeletionLease: () => Promise<PreparedSegmentDeletionLease>;
  plan: CandidateSegmentPlanEntry;
};

function cloneSegmentId({ segmentId }: { segmentId: SegmentId }): SegmentId {
  return Uint8Array.from(segmentId) as SegmentId;
}

async function releaseLease({ lease }: { lease: PreparedSegmentDeletionLease }): Promise<void> {
  lease.release();
}

type SweepRemovalOutcome =
  | Readonly<{ segmentId: SegmentId; status: "removed" }>
  | Readonly<{ cause: unknown; segmentId: SegmentId; status: "failed" }>;

/**
 * Physical removal and deletion-lease cleanup form one segment outcome. A
 * cleanup failure means removal cannot be reported as durably settled, while a
 * preceding remove failure must remain available to the cycle classifier.
 */
async function removePreparedSegment({ removeSegment, state }: {
  removeSegment: ({ segmentId }: { segmentId: SegmentId }) => Promise<void>;
  state: RemovalState;
}): Promise<SweepRemovalOutcome> {
  const segmentId = cloneSegmentId({ segmentId: state.plan.segmentId });
  let lease: PreparedSegmentDeletionLease;
  try {
    lease = await state.acquireDeletionLease();
  } catch (cause: unknown) {
    return { cause, segmentId, status: "failed" };
  }

  let failure: { cause: unknown } | undefined;
  try {
    await removeSegment({ segmentId });
  } catch (cause: unknown) {
    failure = { cause };
  }
  try {
    await releaseLease({ lease });
  } catch (cleanupFailure: unknown) {
    failure = failure === undefined
      ? { cause: cleanupFailure }
      : {
        cause: new AggregateError(
          [failure.cause, cleanupFailure],
          "segment removal and deletion-lease cleanup both failed",
        ),
      };
  }
  return failure === undefined
    ? { segmentId, status: "removed" }
    : { cause: failure.cause, segmentId, status: "failed" };
}

export class SlicedSweepExecutor {
  #aborted = false;
  #nextIndex = 0;
  #policy: HizoFSMaintenancePolicy;
  #removals: readonly RemovalState[];
  #removed = new Map<string, SegmentId>();
  #retained = new Map<string, SegmentId>();

  constructor({ policy, preparedRemovals }: {
    policy: HizoFSMaintenancePolicy;
    preparedRemovals: readonly PreparedSegmentRemoval[];
  }) {
    const unique = new Map<string, RemovalState>();
    for (const prepared of preparedRemovals) {
      if (prepared.plan.disposition !== "remove" || prepared.plan.liveFrameCount !== 0 || prepared.plan.liveBytes !== 0) {
        throw new SlicedSweepExecutorError({
          code: "invalid_plan",
          message: "sweep may receive only validated whole-dead segment plans",
        });
      }
      const identity = segmentIdToLowercaseHex({ id: prepared.plan.segmentId });
      if (unique.has(identity)) {
        throw new SlicedSweepExecutorError({
          code: "duplicate_segment",
          message: "sweep plan contains one segment more than once",
        });
      }
      unique.set(identity, { acquireDeletionLease: prepared.acquireDeletionLease, plan: prepared.plan });
    }
    this.#policy = policy;
    this.#removals = Object.freeze([...unique.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, state]) => state));
  }

  #terminal({ phase }: { phase: "aborted_after_partial_sweep" | "completed" }): SlicedSweepResult {
    return Object.freeze({
      phase,
      removedSegmentIds: Object.freeze([...this.#removed.values()].map(segmentId => cloneSegmentId({ segmentId }))),
      retainedSegmentIds: Object.freeze([...this.#retained.values()].map(segmentId => cloneSegmentId({ segmentId }))),
    });
  }

  async runSlice({ classifyFailure, hasForegroundWaiter, now, removeSegment, signal }: {
    classifyFailure: ({ cause, segmentId }: { cause: unknown; segmentId: SegmentId }) => SweepFailureDisposition;
    hasForegroundWaiter: () => boolean;
    now: () => number;
    removeSegment: ({ segmentId }: { segmentId: SegmentId }) => Promise<void>;
    signal: AbortSignal | undefined;
  }): Promise<SlicedSweepResult> {
    if (this.#aborted) return this.#terminal({ phase: "aborted_after_partial_sweep" });
    if (this.#nextIndex >= this.#removals.length) return this.#terminal({ phase: "completed" });
    const startedAt = now();
    if (!Number.isFinite(startedAt)) throw new TypeError("sweep clock must return a finite value");
    let startedThisSlice = 0;

    while (this.#nextIndex < this.#removals.length) {
      if (signal?.aborted === true) return Object.freeze({ phase: "sweeping", reason: "abort_requested" });
      if (hasForegroundWaiter()) return Object.freeze({ phase: "sweeping", reason: "foreground_waiter" });
      if (startedThisSlice >= this.#policy.maxRemovalsPerSlice) {
        return Object.freeze({ phase: "sweeping", reason: "slice_removal_limit" });
      }
      if (startedThisSlice > 0) {
        const elapsed = now() - startedAt;
        if (!Number.isFinite(elapsed) || elapsed < 0) throw new TypeError("sweep clock must be monotonic and finite");
        if (elapsed >= this.#policy.softSliceMilliseconds) {
          return Object.freeze({ phase: "sweeping", reason: "soft_time_limit" });
        }
      }
      const remainingInSlice = this.#policy.maxRemovalsPerSlice - startedThisSlice;
      const waveSize = Math.min(
        this.#policy.removeConcurrency,
        remainingInSlice,
        this.#removals.length - this.#nextIndex,
      );
      const wave = this.#removals.slice(this.#nextIndex, this.#nextIndex + waveSize);
      this.#nextIndex += wave.length;
      startedThisSlice += wave.length;
      const outcomes = await Promise.all(wave.map(async state => await removePreparedSegment({
        removeSegment,
        state,
      })));
      for (const outcome of outcomes) {
        const identity = segmentIdToLowercaseHex({ id: outcome.segmentId });
        switch (outcome.status) {
        case "removed":
          this.#removed.set(identity, cloneSegmentId({ segmentId: outcome.segmentId }));
          break;
        case "failed": {
          this.#retained.set(identity, cloneSegmentId({ segmentId: outcome.segmentId }));
          const disposition = classifyFailure({ cause: outcome.cause, segmentId: cloneSegmentId({ segmentId: outcome.segmentId }) });
          switch (disposition) {
          case "abort_cycle":
            this.#aborted = true;
            break;
          case "retain_and_continue":
            break;
          default:
            disposition satisfies never;
          }
          break;
        }
        default: outcome satisfies never;
        }
      }
      if (this.#aborted) {
        for (const remaining of this.#removals.slice(this.#nextIndex)) {
          const identity = segmentIdToLowercaseHex({ id: remaining.plan.segmentId });
          this.#retained.set(identity, cloneSegmentId({ segmentId: remaining.plan.segmentId }));
        }
        this.#nextIndex = this.#removals.length;
        return this.#terminal({ phase: "aborted_after_partial_sweep" });
      }
    }
    return this.#terminal({ phase: "completed" });
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
