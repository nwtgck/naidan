import { describe, expect, it } from "vitest";
import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createHomeRecordReference,
  createPhysicalRecordReference,
  createUInt64,
  parseSegmentId,
  type HomeRecordReference,
  type PhysicalRecordReference,
  type SegmentId,
} from "@/00-storage/service/hizofs/00-format";
import { CandidateSegmentBatch } from "@/00-storage/service/hizofs/maintenance/candidate-segment-batch";
import { createCandidateFrameOrdinalAuthority } from "@/00-storage/service/hizofs/authenticated-store/candidate-frame-ordinal-authority";
import {
  GarbageCollectionMarkCursor,
  type ResolvedMaintenanceRecord,
} from "@/00-storage/service/hizofs/maintenance/garbage-collection-mark-cursor";
import { createMaintenancePolicy } from "@/00-storage/service/hizofs/maintenance/maintenance-policy";
import {
  createLogicalMaintenanceTraversalItem,
  createPhysicalRelocationMaintenanceTraversalItem,
  maintenanceTraversalReferenceIdentity,
  type MaintenanceTraversalItem,
} from "@/00-storage/service/hizofs/maintenance/maintenance-traversal-item";

function segmentId({ seed }: { seed: number }): SegmentId {
  return parseSegmentId({ bytes: Uint8Array.from({ length: 16 }, (_, index) => (seed + index) & 0xff) });
}

function homeReference({ offset, segmentSeed = 1 }: { offset: bigint; segmentSeed?: number }): HomeRecordReference {
  return createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: 64n + offset * 8n }),
    frameLength: 128,
    recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
    segmentId: segmentId({ seed: segmentSeed }),
  } });
}

function physicalReference({ offset, recordKind = HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page, segmentSeed = 50 }: {
  offset: bigint;
  recordKind?: number;
  segmentSeed?: number;
}): PhysicalRecordReference {
  return createPhysicalRecordReference({ fields: {
    byteOffset: createUInt64({ value: 64n + offset * 128n }),
    frameLength: 128,
    recordKind,
    segmentId: segmentId({ seed: segmentSeed }),
  } });
}

function logicalItem({ offset }: { offset: bigint }) {
  return createLogicalMaintenanceTraversalItem({ pageRole: "non_root", reference: homeReference({ offset }) });
}

function relocationItem({ offset, pageRole }: { offset: bigint; pageRole: "non_root" | "root" }) {
  return createPhysicalRelocationMaintenanceTraversalItem({
    pageRole,
    reference: physicalReference({
      offset,
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.relocation_index_page,
    }),
  });
}

function identity({ item }: { item: MaintenanceTraversalItem }): string {
  return maintenanceTraversalReferenceIdentity({ item });
}

function resolved({ children = [], ordinal, physical = physicalReference({ offset: BigInt(ordinal) }) }: {
  children?: readonly MaintenanceTraversalItem[];
  ordinal: number;
  physical?: PhysicalRecordReference;
}): ResolvedMaintenanceRecord {
  return {
    bytesRead: 128,
    childItems: children,
    physicalReference: physical,
  };
}

function setup({
  candidateRecordKinds = [],
  graph,
  policy = createMaintenancePolicy(),
  roots = [logicalItem({ offset: 1n })],
}: {
  candidateRecordKinds?: readonly number[];
  graph: ReadonlyMap<string, ResolvedMaintenanceRecord>;
  policy?: ReturnType<typeof createMaintenancePolicy>;
  roots?: readonly MaintenanceTraversalItem[];
}) {
  const reads: string[] = [];
  const batch = new CandidateSegmentBatch({
    candidates: [{
      frameCount: 8,
      frameOrdinalAuthority: createCandidateFrameOrdinalAuthority({
        frames: Array.from({ length: 8 }, (_, ordinal) => ({
          frameLength: 128,
          physicalOffset: 64n + BigInt(ordinal * 128),
          recordKind: candidateRecordKinds[ordinal]
            ?? HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
        })),
        segmentId: segmentId({ seed: 50 }),
      }),
      ownership: "sealed",
      segmentId: segmentId({ seed: 50 }),
      totalFrameBytes: 1024,
    }],
    policy,
  });
  const cursor = new GarbageCollectionMarkCursor({
    candidateBatch: batch,
    policy,
    reader: { readRecord: async ({ item }) => {
      const key = identity({ item });
      reads.push(key);
      const value = graph.get(key);
      if (value === undefined) throw new Error("missing graph record");
      return value;
    } },
    roots,
  });
  return { cursor, reads };
}

const noForeground = () => false;
const constantNow = () => 0;

describe("resumable garbage collection mark cursor", () => {
  it("traverses typed logical references and marks only the candidate batch", async () => {
    const root = logicalItem({ offset: 1n });
    const child = logicalItem({ offset: 2n });
    const outside = logicalItem({ offset: 3n });
    const graph = new Map([
      [identity({ item: root }), resolved({ children: [child, outside], ordinal: 0 })],
      [identity({ item: child }), resolved({ ordinal: 1 })],
      [identity({ item: outside }), resolved({ ordinal: 0, physical: physicalReference({ offset: 0n, segmentSeed: 70 }) })],
    ]);
    const { cursor } = setup({ graph, roots: [root] });
    const result = await cursor.runSlice({ hasForegroundWaiter: noForeground, now: constantNow, signal: undefined });
    expect(result).toMatchObject({ phase: "batch_complete" });
    if (result.phase !== "batch_complete") expect.unreachable("mark must complete");
    expect(result.plan[0]).toMatchObject({ disposition: "compact", liveBytes: 256, liveFrameCount: 2 });
    expect(cursor.diagnostics()).toMatchObject({
      budget: { bytesRead: 384, decodedRecords: 3, followedEdges: 2 },
      currentPathSize: 0,
      phase: "batch_complete",
      stackDepth: 0,
    });
  });

  it("traverses physical relocation root and non-root pages with parent-derived roles", async () => {
    const root = relocationItem({ offset: 0n, pageRole: "root" });
    const child = relocationItem({ offset: 1n, pageRole: "non_root" });
    const graph = new Map([
      [identity({ item: root }), resolved({ children: [child], ordinal: 0, physical: root.reference })],
      [identity({ item: child }), resolved({ ordinal: 1, physical: child.reference })],
    ]);
    const { cursor } = setup({
      candidateRecordKinds: [
        HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.relocation_index_page,
        HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.relocation_index_page,
      ],
      graph,
      roots: [root],
    });
    const result = await cursor.runSlice({ hasForegroundWaiter: noForeground, now: constantNow, signal: undefined });
    expect(result.phase).toBe("batch_complete");
    expect(cursor.diagnostics().budget).toMatchObject({ decodedRecords: 2, followedEdges: 1 });
  });

  it("fails closed when one reference is assigned conflicting page roles", () => {
    const root = relocationItem({ offset: 0n, pageRole: "root" });
    const nonRoot = relocationItem({ offset: 0n, pageRole: "non_root" });
    expect(() => setup({ graph: new Map(), roots: [root, nonRoot] })).toThrowError(TypeError);
  });

  it("fails closed when a physical item resolves a different physical record", async () => {
    const root = relocationItem({ offset: 0n, pageRole: "root" });
    const graph = new Map([[identity({ item: root }), resolved({
      ordinal: 0,
      physical: physicalReference({
        offset: 1n,
        recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.relocation_index_page,
      }),
    })]]);
    const { cursor } = setup({ graph, roots: [root] });
    expect(await cursor.runSlice({ hasForegroundWaiter: noForeground, now: constantNow, signal: undefined }))
      .toEqual({ phase: "aborted_without_deletion", reason: "invalid_record_result" });
  });

  it("yields at decoded-record and queued-reference boundaries and resumes", async () => {
    const root = logicalItem({ offset: 1n });
    const child = logicalItem({ offset: 2n });
    const graph = new Map([
      [identity({ item: root }), resolved({ children: [child], ordinal: 0 })],
      [identity({ item: child }), resolved({ ordinal: 1 })],
    ]);
    const { cursor } = setup({
      graph,
      policy: createMaintenancePolicy({ maxDecodedRecordsPerSlice: 1, maxNewReferencesPerSlice: 1 }),
      roots: [root],
    });
    expect(await cursor.runSlice({ hasForegroundWaiter: noForeground, now: constantNow, signal: undefined }))
      .toEqual({ phase: "marking", reason: "decoded_record_limit" });
    expect(await cursor.runSlice({ hasForegroundWaiter: noForeground, now: constantNow, signal: undefined }))
      .toEqual({ phase: "batch_complete", plan: expect.any(Array) });
  });

  it("gives foreground work priority without consuming mark work", async () => {
    const root = logicalItem({ offset: 1n });
    const { cursor, reads } = setup({ graph: new Map([[identity({ item: root }), resolved({ ordinal: 0 })]]), roots: [root] });
    expect(await cursor.runSlice({ hasForegroundWaiter: () => true, now: constantNow, signal: undefined }))
      .toEqual({ phase: "marking", reason: "foreground_waiter" });
    expect(reads).toEqual([]);
  });

  it("yields after a soft wall-time boundary only at a complete cursor step", async () => {
    const root = logicalItem({ offset: 1n });
    const child = logicalItem({ offset: 2n });
    const graph = new Map([
      [identity({ item: root }), resolved({ children: [child], ordinal: 0 })],
      [identity({ item: child }), resolved({ ordinal: 1 })],
    ]);
    const { cursor } = setup({ graph, roots: [root] });
    let ticks = 0;
    expect(await cursor.runSlice({
      hasForegroundWaiter: noForeground,
      now: () => (ticks++ === 0 ? 0 : 8),
      signal: undefined,
    })).toEqual({ phase: "marking", reason: "soft_time_limit" });
    expect(cursor.diagnostics().stackDepth).toBeGreaterThan(0);
  });

  it("fails closed on an exact current-path cycle", async () => {
    const first = logicalItem({ offset: 1n });
    const second = logicalItem({ offset: 2n });
    const graph = new Map([
      [identity({ item: first }), resolved({ children: [second], ordinal: 0 })],
      [identity({ item: second }), resolved({ children: [first], ordinal: 1 })],
    ]);
    const { cursor } = setup({ graph, roots: [first] });
    expect(await cursor.runSlice({ hasForegroundWaiter: noForeground, now: constantNow, signal: undefined }))
      .toEqual({ phase: "aborted_without_deletion", reason: "cycle_detected" });
  });

  it("fails closed when a cycle hard budget is exceeded", async () => {
    const root = logicalItem({ offset: 1n });
    const child = logicalItem({ offset: 2n });
    const graph = new Map([
      [identity({ item: root }), resolved({ children: [child], ordinal: 0 })],
      [identity({ item: child }), resolved({ ordinal: 1 })],
    ]);
    const { cursor } = setup({ graph, policy: createMaintenancePolicy({ maxDecodedRecordsPerCycle: 1 }), roots: [root] });
    expect(await cursor.runSlice({ hasForegroundWaiter: noForeground, now: constantNow, signal: undefined }))
      .toEqual({ phase: "aborted_without_deletion", reason: "hard_budget_exceeded" });
  });

  it("fails closed on explicit abort and remains terminal", async () => {
    const root = logicalItem({ offset: 1n });
    const { cursor } = setup({ graph: new Map([[identity({ item: root }), resolved({ ordinal: 0 })]]), roots: [root] });
    const controller = new AbortController();
    controller.abort();
    const first = await cursor.runSlice({ hasForegroundWaiter: noForeground, now: constantNow, signal: controller.signal });
    expect(first).toEqual({ phase: "aborted_without_deletion", reason: "abort_requested" });
    expect(await cursor.runSlice({ hasForegroundWaiter: noForeground, now: constantNow, signal: undefined })).toEqual(first);
  });

  it("uses the exact completed memo to skip repeated roots", async () => {
    const root = logicalItem({ offset: 1n });
    const { cursor, reads } = setup({
      graph: new Map([[identity({ item: root }), resolved({ ordinal: 0 })]]),
      roots: [root, root],
    });
    expect((await cursor.runSlice({ hasForegroundWaiter: noForeground, now: constantNow, signal: undefined })).phase)
      .toBe("batch_complete");
    expect(reads).toHaveLength(1);
    expect(cursor.diagnostics().budget.revisitEncounters).toBe(1);
  });

  it("rejects an unbounded root snapshot before allocating traversal state", () => {
    const root = logicalItem({ offset: 1n });
    expect(() => setup({
      graph: new Map(),
      policy: createMaintenancePolicy({ maxCapturedRoots: 1 }),
      roots: [root, root],
    })).toThrowError(RangeError);
  });
});
