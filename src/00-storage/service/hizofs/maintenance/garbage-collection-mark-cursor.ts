import type { PhysicalRecordReference } from "@/00-storage/service/hizofs/00-format";
import { BoundedCompletedReferenceMemo } from "@/00-storage/service/hizofs/maintenance/bounded-completed-reference-memo";
import {
  CandidateSegmentBatch,
  type CandidateSegmentPlanEntry,
} from "@/00-storage/service/hizofs/maintenance/candidate-segment-batch";
import {
  MaintenanceCycleBudget,
  type MaintenanceCycleBudgetSnapshot,
} from "@/00-storage/service/hizofs/maintenance/maintenance-cycle-budget";
import type { HizoFSMaintenancePolicy } from "@/00-storage/service/hizofs/maintenance/maintenance-policy";
import {
  cloneMaintenanceTraversalItem,
  maintenanceTraversalReferenceIdentity,
  samePhysicalReference,
  type MaintenanceTraversalItem,
} from "@/00-storage/service/hizofs/maintenance/maintenance-traversal-item";

export type ResolvedMaintenanceRecord = Readonly<{
  bytesRead: number;
  childItems: readonly MaintenanceTraversalItem[];
  physicalReference: PhysicalRecordReference;
}>;

export interface MaintenanceRecordReader {
  readRecord({ item }: {
    item: MaintenanceTraversalItem;
  }): Promise<ResolvedMaintenanceRecord>;
}

export type GarbageCollectionMarkAbortReason =
  | "abort_requested"
  | "cycle_detected"
  | "hard_budget_exceeded"
  | "invalid_record_result"
  | "record_read_failed"
  | "traversal_depth_exceeded";

export type GarbageCollectionMarkYieldReason =
  | "decoded_record_limit"
  | "foreground_waiter"
  | "new_reference_limit"
  | "soft_time_limit";

export type GarbageCollectionMarkSliceResult =
  | Readonly<{
    phase: "aborted_without_deletion";
    reason: GarbageCollectionMarkAbortReason;
  }>
  | Readonly<{
    phase: "batch_complete";
    plan: readonly CandidateSegmentPlanEntry[];
  }>
  | Readonly<{
    phase: "marking";
    reason: GarbageCollectionMarkYieldReason;
  }>;

export type GarbageCollectionMarkDiagnostics = Readonly<{
  budget: MaintenanceCycleBudgetSnapshot;
  completedMemoSize: number;
  currentPathSize: number;
  phase: "aborted_without_deletion" | "batch_complete" | "marking";
  stackDepth: number;
}>;

type TraversalFrame = {
  childItems: readonly MaintenanceTraversalItem[] | undefined;
  depth: number;
  item: MaintenanceTraversalItem;
  nextChildIndex: number;
};

function checkedResolvedRecord({ item, record }: {
  item: MaintenanceTraversalItem;
  record: ResolvedMaintenanceRecord;
}): ResolvedMaintenanceRecord {
  if (!Number.isSafeInteger(record.bytesRead) || record.bytesRead <= 0) {
    throw new TypeError("maintenance record read byte count must be a positive safe integer");
  }
  if (!Array.isArray(record.childItems)) {
    throw new TypeError("maintenance record child items must be a bounded array");
  }
  if (item.kind === "physical_relocation_page"
    && !samePhysicalReference({ left: item.reference, right: record.physicalReference })) {
    throw new TypeError("physical maintenance traversal resolved a different physical record");
  }
  return {
    bytesRead: record.bytesRead,
    childItems: Object.freeze(record.childItems.map(child => cloneMaintenanceTraversalItem({ item: child }))),
    physicalReference: record.physicalReference,
  };
}

export class GarbageCollectionMarkCursor {
  private abortReason: GarbageCollectionMarkAbortReason | undefined;
  private budget: MaintenanceCycleBudget;
  private candidateBatch: CandidateSegmentBatch;
  private completedMemo: BoundedCompletedReferenceMemo;
  private currentPath = new Set<string>();
  private observedRoles = new Map<string, MaintenanceTraversalItem["pageRole"]>();
  private phase: "aborted_without_deletion" | "batch_complete" | "marking" = "marking";
  private policy: HizoFSMaintenancePolicy;
  private reader: MaintenanceRecordReader;
  private stack: TraversalFrame[];

  constructor({ candidateBatch, policy, reader, roots }: {
    candidateBatch: CandidateSegmentBatch;
    policy: HizoFSMaintenancePolicy;
    reader: MaintenanceRecordReader;
    roots: readonly MaintenanceTraversalItem[];
  }) {
    if (roots.length < 1 || roots.length > policy.maxCapturedRoots) {
      throw new RangeError("captured maintenance roots exceed the explicit runtime bound");
    }
    this.budget = new MaintenanceCycleBudget({ policy });
    this.candidateBatch = candidateBatch;
    this.completedMemo = new BoundedCompletedReferenceMemo({ maxEntries: policy.maxCompletedMemoEntries });
    this.policy = policy;
    this.reader = reader;
    for (const item of roots) this.recordRoleOrThrow({ item });
    this.stack = roots.slice().reverse().map(item => ({
      childItems: undefined,
      depth: 0,
      item: cloneMaintenanceTraversalItem({ item }),
      nextChildIndex: 0,
    }));
  }

  private recordRoleOrThrow({ item }: { item: MaintenanceTraversalItem }): void {
    const identity = maintenanceTraversalReferenceIdentity({ item });
    const previous = this.observedRoles.get(identity);
    if (previous !== undefined && previous !== item.pageRole) {
      throw new TypeError("maintenance traversal assigns conflicting page roles to one reference");
    }
    if (previous === undefined && this.observedRoles.size >= this.policy.maxCompletedMemoEntries) {
      throw new RangeError("maintenance traversal role memo exceeds its explicit bound");
    }
    this.observedRoles.set(identity, item.pageRole);
  }

  private abort({ reason }: { reason: GarbageCollectionMarkAbortReason }): GarbageCollectionMarkSliceResult {
    this.abortReason = reason;
    this.phase = "aborted_without_deletion";
    this.stack = [];
    this.currentPath.clear();
    this.observedRoles.clear();
    return Object.freeze({ phase: "aborted_without_deletion", reason });
  }

  diagnostics(): GarbageCollectionMarkDiagnostics {
    return Object.freeze({
      budget: this.budget.snapshot(),
      completedMemoSize: this.completedMemo.size,
      currentPathSize: this.currentPath.size,
      phase: this.phase,
      stackDepth: this.stack.length,
    });
  }

  async runSlice({ hasForegroundWaiter, now, signal }: {
    hasForegroundWaiter: () => boolean;
    now: () => number;
    signal: AbortSignal | undefined;
  }): Promise<GarbageCollectionMarkSliceResult> {
    switch (this.phase) {
    case "aborted_without_deletion":
      return Object.freeze({
        phase: "aborted_without_deletion",
        reason: this.abortReason ?? "invalid_record_result",
      });
    case "batch_complete":
      return Object.freeze({ phase: "batch_complete", plan: this.candidateBatch.plan() });
    case "marking":
      break;
    default:
      this.phase satisfies never;
    }
    const startedAt = now();
    if (!Number.isFinite(startedAt)) return this.abort({ reason: "invalid_record_result" });
    let decodedRecords = 0;
    let newlyQueuedReferences = 0;
    let madeProgress = false;

    while (this.stack.length > 0) {
      if (signal?.aborted === true) return this.abort({ reason: "abort_requested" });
      if (hasForegroundWaiter()) {
        return Object.freeze({ phase: "marking", reason: "foreground_waiter" });
      }
      if (madeProgress) {
        const elapsed = now() - startedAt;
        if (!Number.isFinite(elapsed) || elapsed < 0) return this.abort({ reason: "invalid_record_result" });
        if (elapsed >= this.policy.softSliceMilliseconds) {
          return Object.freeze({ phase: "marking", reason: "soft_time_limit" });
        }
      }

      const frame = this.stack[this.stack.length - 1];
      if (frame === undefined) return this.abort({ reason: "invalid_record_result" });
      const identity = maintenanceTraversalReferenceIdentity({ item: frame.item });

      if (frame.childItems === undefined) {
        if (this.completedMemo.has({ item: frame.item })) {
          try {
            this.budget.consumeRevisitEncounter();
          } catch {
            return this.abort({ reason: "hard_budget_exceeded" });
          }
          this.stack.pop();
          madeProgress = true;
          continue;
        }
        if (this.currentPath.has(identity)) return this.abort({ reason: "cycle_detected" });
        if (frame.depth >= this.policy.maxTraversalDepth) {
          return this.abort({ reason: "traversal_depth_exceeded" });
        }
        if (decodedRecords >= this.policy.maxDecodedRecordsPerSlice) {
          return Object.freeze({ phase: "marking", reason: "decoded_record_limit" });
        }
        let resolved: ResolvedMaintenanceRecord;
        try {
          resolved = checkedResolvedRecord({
            item: frame.item,
            record: await this.reader.readRecord({ item: cloneMaintenanceTraversalItem({ item: frame.item }) }),
          });
          this.budget.consumeDecodedRecord({ bytesRead: resolved.bytesRead });
          this.candidateBatch.markLive({ physicalReference: resolved.physicalReference });
          for (const child of resolved.childItems) this.recordRoleOrThrow({ item: child });
        } catch (cause: unknown) {
          if (cause instanceof TypeError) return this.abort({ reason: "invalid_record_result" });
          if (cause instanceof RangeError) return this.abort({ reason: "hard_budget_exceeded" });
          const name = cause instanceof Error ? cause.name : "";
          if (name.includes("Budget") || name.includes("CandidateSegment")) {
            return this.abort({ reason: "hard_budget_exceeded" });
          }
          return this.abort({ reason: "record_read_failed" });
        }
        this.currentPath.add(identity);
        frame.childItems = resolved.childItems;
        frame.nextChildIndex = 0;
        decodedRecords += 1;
        madeProgress = true;
        continue;
      }

      if (frame.nextChildIndex < frame.childItems.length) {
        if (newlyQueuedReferences >= this.policy.maxNewReferencesPerSlice) {
          return Object.freeze({ phase: "marking", reason: "new_reference_limit" });
        }
        const child = frame.childItems[frame.nextChildIndex];
        if (child === undefined) return this.abort({ reason: "invalid_record_result" });
        try {
          this.budget.consumeFollowedEdge();
        } catch {
          return this.abort({ reason: "hard_budget_exceeded" });
        }
        frame.nextChildIndex += 1;
        this.stack.push({
          childItems: undefined,
          depth: frame.depth + 1,
          item: cloneMaintenanceTraversalItem({ item: child }),
          nextChildIndex: 0,
        });
        newlyQueuedReferences += 1;
        madeProgress = true;
        continue;
      }

      this.currentPath.delete(identity);
      this.completedMemo.remember({ item: frame.item });
      this.stack.pop();
      madeProgress = true;
    }

    this.phase = "batch_complete";
    return Object.freeze({ phase: "batch_complete", plan: this.candidateBatch.plan() });
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
