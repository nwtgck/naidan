import {
  segmentIdToLowercaseHex,
  type SegmentId,
} from "@/00-storage/service/hizofs/00-format";
import {
  CandidateSegmentBatch,
  type CandidateSegmentPlanEntry,
} from "@/00-storage/service/hizofs/maintenance/candidate-segment-batch";
import {
  GarbageCollectionMarkCursor,
  type GarbageCollectionMarkAbortReason,
  type GarbageCollectionMarkYieldReason,
  type MaintenanceRecordReader,
} from "@/00-storage/service/hizofs/maintenance/garbage-collection-mark-cursor";
import {
  MaintenanceDiagnostics,
  type MaintenanceYieldReason,
} from "@/00-storage/service/hizofs/diagnostics/maintenance-diagnostics";
import type { HizoFSMaintenancePolicy } from "@/00-storage/service/hizofs/maintenance/maintenance-policy";
import type {
  MaintenanceRootSnapshot,
  MaintenanceRootValidationFailure,
} from "@/00-storage/service/hizofs/maintenance/maintenance-root-snapshot";
import {
  SlicedSweepExecutor,
  type PreparedSegmentDeletionLease,
  type SweepFailureDisposition,
  type SweepYieldReason,
} from "@/00-storage/service/hizofs/maintenance/sliced-sweep-executor";

export type ValidatedGarbageCollectionSweepAuthority =
  | Readonly<{
    reason: MaintenanceRootValidationFailure;
    valid: false;
  }>
  | Readonly<{
    beginDeletion: ({ plan }: { plan: CandidateSegmentPlanEntry }) => Promise<PreparedSegmentDeletionLease>;
    valid: true;
  }>;

export type SlicedGarbageCollectionCycleResult =
  | Readonly<{
    phase: "aborted_after_partial_sweep";
    compactionSegmentIds: readonly SegmentId[];
    removedSegmentIds: readonly SegmentId[];
    retainedSegmentIds: readonly SegmentId[];
  }>
  | Readonly<{
    phase: "aborted_without_deletion";
    reason: GarbageCollectionMarkAbortReason | MaintenanceRootValidationFailure;
  }>
  | Readonly<{
    phase: "completed";
    compactionSegmentIds: readonly SegmentId[];
    removedSegmentIds: readonly SegmentId[];
    retainedSegmentIds: readonly SegmentId[];
  }>
  | Readonly<{
    phase: "marking";
    reason: GarbageCollectionMarkYieldReason;
  }>
  | Readonly<{
    phase: "sweeping";
    reason: SweepYieldReason;
  }>;

export type SlicedGarbageCollectionCycleErrorCode =
  | "cycle_disabled"
  | "invalid_validated_plan";

export class SlicedGarbageCollectionCycleError extends Error {
  readonly code: SlicedGarbageCollectionCycleErrorCode;

  constructor({ code, message }: { code: SlicedGarbageCollectionCycleErrorCode; message: string }) {
    super(message);
    this.name = "SlicedGarbageCollectionCycleError";
    this.code = code;
  }
}

function cloneSegmentId({ segmentId }: { segmentId: SegmentId }): SegmentId {
  return Uint8Array.from(segmentId) as SegmentId;
}

function sortedDetachedSegmentIds({ values }: { values: readonly SegmentId[] }): readonly SegmentId[] {
  return Object.freeze(values
    .map(segmentId => cloneSegmentId({ segmentId }))
    .sort((left, right) => segmentIdToLowercaseHex({ id: left }).localeCompare(segmentIdToLowercaseHex({ id: right }))));
}

function sortedPlanSegmentIds({ entries }: { entries: readonly CandidateSegmentPlanEntry[] }): readonly SegmentId[] {
  return sortedDetachedSegmentIds({ values: entries.map(entry => entry.segmentId) });
}

function markYieldReason({ reason }: { reason: GarbageCollectionMarkYieldReason }): MaintenanceYieldReason {
  switch (reason) {
  case "decoded_record_limit":
  case "new_reference_limit":
    return "slice_work_limit";
  case "foreground_waiter":
  case "soft_time_limit":
    return reason;
  default:
    return reason satisfies never;
  }
}

function sweepYieldReason({ reason }: { reason: SweepYieldReason }): MaintenanceYieldReason {
  switch (reason) {
  case "abort_requested":
  case "foreground_waiter":
  case "soft_time_limit":
    return reason;
  case "slice_removal_limit":
    return "slice_work_limit";
  default:
    return reason satisfies never;
  }
}

export class SlicedGarbageCollectionCycle {
  #capturedSnapshot: MaintenanceRootSnapshot;
  #compactionPlans: readonly CandidateSegmentPlanEntry[] = Object.freeze([]);
  #diagnostics: MaintenanceDiagnostics;
  #markCursor: GarbageCollectionMarkCursor;
  #phase: "marking" | "sweeping" | "terminal" = "marking";
  #policy: HizoFSMaintenancePolicy;
  #retainedPlans: readonly CandidateSegmentPlanEntry[] = Object.freeze([]);
  #sweep: SlicedSweepExecutor | undefined;
  #terminal: SlicedGarbageCollectionCycleResult | undefined;
  #validateAndPrepareSweep: ({ capturedSnapshot, plan }: {
    capturedSnapshot: MaintenanceRootSnapshot;
    plan: readonly CandidateSegmentPlanEntry[];
  }) => Promise<ValidatedGarbageCollectionSweepAuthority>;

  constructor({ capturedSnapshot, policy, reader, validateAndPrepareSweep }: {
    capturedSnapshot: MaintenanceRootSnapshot;
    policy: HizoFSMaintenancePolicy;
    reader: MaintenanceRecordReader;
    validateAndPrepareSweep: ({ capturedSnapshot, plan }: {
      capturedSnapshot: MaintenanceRootSnapshot;
      plan: readonly CandidateSegmentPlanEntry[];
    }) => Promise<ValidatedGarbageCollectionSweepAuthority>;
  }) {
    if (!policy.enabled) {
      throw new SlicedGarbageCollectionCycleError({
        code: "cycle_disabled",
        message: "garbage collection cycle requires an explicitly enabled maintenance policy",
      });
    }
    const candidateBatch = new CandidateSegmentBatch({
      candidates: capturedSnapshot.candidateSegments,
      policy,
    });
    this.#capturedSnapshot = capturedSnapshot;
    this.#diagnostics = new MaintenanceDiagnostics({ maximumEvents: policy.maxDiagnosticEvents });
    this.#markCursor = new GarbageCollectionMarkCursor({
      candidateBatch,
      policy,
      reader,
      roots: capturedSnapshot.roots,
    });
    this.#policy = policy;
    this.#validateAndPrepareSweep = validateAndPrepareSweep;
  }

  diagnostics(): ReturnType<MaintenanceDiagnostics["snapshot"]> {
    return this.#diagnostics.snapshot();
  }

  #recordYield({ reason }: { reason: MaintenanceYieldReason }): void {
    this.#diagnostics.record({ event: { reason, type: "yielded" } });
  }

  #terminalSweepResult({ phase, removedSegmentIds, retainedSegmentIds }: {
    phase: "aborted_after_partial_sweep" | "completed";
    removedSegmentIds: readonly SegmentId[];
    retainedSegmentIds: readonly SegmentId[];
  }): SlicedGarbageCollectionCycleResult {
    const result = Object.freeze({
      compactionSegmentIds: sortedPlanSegmentIds({ entries: this.#compactionPlans }),
      phase,
      removedSegmentIds: sortedDetachedSegmentIds({ values: removedSegmentIds }),
      retainedSegmentIds: sortedDetachedSegmentIds({ values: [
        ...this.#retainedPlans.map(entry => entry.segmentId),
        ...retainedSegmentIds,
      ] }),
    });
    this.#diagnostics.record({ event: { removedSegments: result.removedSegmentIds.length, type: "sweep_progress" } });
    switch (phase) {
    case "aborted_after_partial_sweep":
      break;
    case "completed":
      this.#diagnostics.record({ event: { phase: "completed", type: "phase_started" } });
      break;
    default:
      phase satisfies never;
    }
    this.#phase = "terminal";
    this.#terminal = result;
    return result;
  }

  async runSlice({ classifySweepFailure, hasForegroundWaiter, now, removeSegment, signal }: {
    classifySweepFailure: ({ cause, segmentId }: { cause: unknown; segmentId: SegmentId }) => SweepFailureDisposition;
    hasForegroundWaiter: () => boolean;
    now: () => number;
    removeSegment: ({ segmentId }: { segmentId: SegmentId }) => Promise<void>;
    signal: AbortSignal | undefined;
  }): Promise<SlicedGarbageCollectionCycleResult> {
    switch (this.#phase) {
    case "terminal": {
      if (this.#terminal === undefined) {
        throw new SlicedGarbageCollectionCycleError({
          code: "invalid_validated_plan",
          message: "terminal garbage collection phase is missing its immutable result",
        });
      }
      return this.#terminal;
    }
    case "marking": {
      if (this.#diagnostics.snapshot().length === 0) {
        this.#diagnostics.record({ event: { phase: "marking", type: "phase_started" } });
      }
      const mark = await this.#markCursor.runSlice({ hasForegroundWaiter, now, signal });
      switch (mark.phase) {
      case "aborted_without_deletion": {
        const terminal = Object.freeze({ phase: mark.phase, reason: mark.reason });
        this.#phase = "terminal";
        this.#terminal = terminal;
        return terminal;
      }
      case "marking":
        this.#recordYield({ reason: markYieldReason({ reason: mark.reason }) });
        return mark;
      case "batch_complete": {
        this.#diagnostics.record({ event: { phase: "planning_sweep", type: "phase_started" } });
        this.#compactionPlans = Object.freeze(mark.plan.filter(entry => entry.disposition === "compact"));
        this.#retainedPlans = Object.freeze(mark.plan.filter(entry => entry.disposition === "retain"));
        this.#diagnostics.record({ event: { phase: "validating", type: "phase_started" } });
        const validation = await this.#validateAndPrepareSweep({
          capturedSnapshot: this.#capturedSnapshot,
          plan: mark.plan,
        });
        if (!validation.valid) {
          const terminal = Object.freeze({ phase: "aborted_without_deletion" as const, reason: validation.reason });
          this.#phase = "terminal";
          this.#terminal = terminal;
          return terminal;
        }
        const removals = mark.plan
          .filter(entry => entry.disposition === "remove")
          .map(plan => ({
            acquireDeletionLease: async () => await validation.beginDeletion({ plan }),
            plan,
          }));
        this.#sweep = new SlicedSweepExecutor({ policy: this.#policy, preparedRemovals: removals });
        this.#phase = "sweeping";
        this.#diagnostics.record({ event: { phase: "sweeping", type: "phase_started" } });
        break;
      }
      default:
        return mark satisfies never;
      }
      break;
    }
    case "sweeping":
      break;
    default:
      return this.#phase satisfies never;
    }

    const sweepExecutor = this.#sweep;
    if (sweepExecutor === undefined) {
      throw new SlicedGarbageCollectionCycleError({
        code: "invalid_validated_plan",
        message: "validated garbage collection cycle did not create its bounded sweep executor",
      });
    }
    const sweep = await sweepExecutor.runSlice({
      classifyFailure: classifySweepFailure,
      hasForegroundWaiter,
      now,
      removeSegment,
      signal,
    });
    switch (sweep.phase) {
    case "sweeping":
      this.#recordYield({ reason: sweepYieldReason({ reason: sweep.reason }) });
      return sweep;
    case "aborted_after_partial_sweep":
    case "completed":
      return this.#terminalSweepResult({
        phase: sweep.phase,
        removedSegmentIds: sweep.removedSegmentIds,
        retainedSegmentIds: sweep.retainedSegmentIds,
      });
    default:
      return sweep satisfies never;
    }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
