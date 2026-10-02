import { describe, expect, it } from "vitest";
import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createHomeRecordReference,
  createInodeNumber,
  createPhysicalRecordReference,
  createUInt64,
  encodeDirectoryPage,
  parseSegmentId,
  type DirectoryPage,
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
import { projectMaintenanceRecordChildren } from "@/00-storage/service/hizofs/maintenance/maintenance-record-child-projection";
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

function directoryRecordGraph() {
  const references: HomeRecordReference[] = [];
  const records = new Map<string, Uint8Array>();
  const reads: { reference: HomeRecordReference; pageRole: MaintenanceTraversalItem["pageRole"] }[] = [];
  const id = segmentId({ seed: 50 });
  const addPage = ({ isRoot, page }: { isRoot: boolean; page: DirectoryPage }): HomeRecordReference => {
    const reference = createHomeRecordReference({ fields: {
      byteOffset: createUInt64({ value: 64n + BigInt(references.length) * 256n }),
      frameLength: 256,
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.directory_page,
      segmentId: id,
    } });
    references.push(reference);
    records.set(reference.byteOffset.toString(), encodeDirectoryPage({ isRoot, page }));
    return reference;
  };
  const addLeaf = ({ name }: { name: string }): HomeRecordReference => addPage({
    isRoot: false,
    page: { entries: [{
      inodeKind: "file",
      inodeNumber: createInodeNumber({ value: 2n }),
      name,
      targetType: "inode",
    }], level: 0, type: "leaf" },
  });
  const createCursor = ({ policy, roots }: {
    policy: ReturnType<typeof createMaintenancePolicy>;
    roots: readonly MaintenanceTraversalItem[];
  }) => new GarbageCollectionMarkCursor({
    candidateBatch: new CandidateSegmentBatch({
      candidates: [{
        frameCount: references.length,
        frameOrdinalAuthority: createCandidateFrameOrdinalAuthority({
          frames: references.map(reference => ({
            frameLength: reference.frameLength,
            physicalOffset: reference.byteOffset,
            recordKind: reference.recordKind,
          })),
          segmentId: id,
        }),
        ownership: "sealed",
        segmentId: id,
        totalFrameBytes: references.length * 256,
      }],
      policy,
    }),
    policy,
    reader: { readRecord: async ({ item }) => {
      if (item.kind !== "logical_home") throw new Error("directory graph contains only logical records");
      const plaintext = records.get(item.reference.byteOffset.toString());
      if (plaintext === undefined) throw new Error("directory graph record is missing");
      reads.push({ pageRole: item.pageRole, reference: item.reference });
      return {
        bytesRead: item.reference.frameLength,
        childItems: projectMaintenanceRecordChildren({ item, plaintext }),
        physicalReference: createPhysicalRecordReference({ fields: item.reference }),
      };
    } },
    roots,
  });
  return { addLeaf, addPage, createCursor, reads };
}

function directoryRoot({ reference }: { reference: HomeRecordReference }): MaintenanceTraversalItem {
  return createLogicalMaintenanceTraversalItem({ pageRole: "root", reference });
}

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

  it.each(["old_then_new", "new_then_old"] as const)("retains shared pages after root collapse in %s order", async order => {
    const graph = directoryRecordGraph();
    const promotedLeaf = graph.addLeaf({ name: "a" });
    const removedLeaf = graph.addLeaf({ name: "z" });
    const oldRoot = graph.addPage({ isRoot: true, page: {
      entries: [
        { childPageHomeRef: promotedLeaf, upperBoundName: "a" },
        { childPageHomeRef: removedLeaf, upperBoundName: "z" },
      ],
      level: 1,
      type: "branch",
    } });
    // Root collapse reuses the surviving child while a retained older tree still points to it as a non-root page.
    const roots = order === "old_then_new" ? [oldRoot, promotedLeaf] : [promotedLeaf, oldRoot];
    const cursor = graph.createCursor({ policy: createMaintenancePolicy(), roots: roots.map(reference => directoryRoot({ reference })) });
    const result = await cursor.runSlice({ hasForegroundWaiter: noForeground, now: constantNow, signal: undefined });
    expect(result).toMatchObject({ phase: "batch_complete", plan: [{ disposition: "retain", liveFrameCount: 3 }] });
    expect(graph.reads.filter(read => read.reference.byteOffset === promotedLeaf.byteOffset).map(read => read.pageRole).sort())
      .toEqual(["non_root", "root"]);
  });

  it("revisits evicted pages instead of limiting the graph to the completed memo size", async () => {
    const graph = directoryRecordGraph();
    const first = graph.addLeaf({ name: "a" });
    const second = graph.addLeaf({ name: "z" });
    const root = graph.addPage({ isRoot: true, page: {
      entries: [{ childPageHomeRef: first, upperBoundName: "a" }, { childPageHomeRef: second, upperBoundName: "z" }],
      level: 1,
      type: "branch",
    } });
    const cursor = graph.createCursor({
      policy: createMaintenancePolicy({ maxCompletedMemoEntries: 1 }),
      roots: [directoryRoot({ reference: root }), directoryRoot({ reference: first }), directoryRoot({ reference: root })],
    });
    expect(await cursor.runSlice({ hasForegroundWaiter: noForeground, now: constantNow, signal: undefined }))
      .toMatchObject({ phase: "batch_complete", plan: [{ disposition: "retain", liveFrameCount: 3 }] });
    expect(cursor.diagnostics().completedMemoSize).toBe(1);
    expect(graph.reads.filter(read => read.reference.byteOffset === root.byteOffset)).toHaveLength(2);
  });

  it("rejects an empty non-root leaf even after the same page was memoized as a valid root", async () => {
    const graph = directoryRecordGraph();
    const empty = graph.addPage({ isRoot: true, page: { entries: [], level: 0, type: "leaf" } });
    const parent = graph.addPage({ isRoot: true, page: {
      entries: [{ childPageHomeRef: empty, upperBoundName: "a" }], level: 1, type: "branch",
    } });
    const cursor = graph.createCursor({
      policy: createMaintenancePolicy(),
      roots: [directoryRoot({ reference: empty }), directoryRoot({ reference: parent })],
    });
    expect(await cursor.runSlice({ hasForegroundWaiter: noForeground, now: constantNow, signal: undefined }))
      .toEqual({ phase: "aborted_without_deletion", reason: "invalid_record_result" });
    expect(graph.reads.filter(read => read.reference.byteOffset === empty.byteOffset).map(read => read.pageRole))
      .toEqual(["root", "non_root"]);
  });

  it("rejects a page reached with a non-page role at the codec boundary", async () => {
    const graph = directoryRecordGraph();
    const leaf = graph.addLeaf({ name: "a" });
    const cursor = graph.createCursor({
      policy: createMaintenancePolicy(),
      roots: [createLogicalMaintenanceTraversalItem({ pageRole: "not_page", reference: leaf })],
    });
    expect(await cursor.runSlice({ hasForegroundWaiter: noForeground, now: constantNow, signal: undefined }))
      .toEqual({ phase: "aborted_without_deletion", reason: "invalid_record_result" });
  });

  it("rejects a cycle that changes a root page's traversal role", async () => {
    const graph = directoryRecordGraph();
    const self = createHomeRecordReference({ fields: {
      byteOffset: createUInt64({ value: 64n }),
      frameLength: 256,
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.directory_page,
      segmentId: segmentId({ seed: 50 }),
    } });
    const root = graph.addPage({ isRoot: true, page: {
      entries: [{ childPageHomeRef: self, upperBoundName: "a" }], level: 1, type: "branch",
    } });
    const cursor = graph.createCursor({ policy: createMaintenancePolicy(), roots: [directoryRoot({ reference: root })] });
    expect(await cursor.runSlice({ hasForegroundWaiter: noForeground, now: constantNow, signal: undefined }))
      .toEqual({ phase: "aborted_without_deletion", reason: "cycle_detected" });
  });

  it("keeps the traversal depth limit for codec-projected children", async () => {
    const graph = directoryRecordGraph();
    const leaf = graph.addLeaf({ name: "a" });
    const root = graph.addPage({ isRoot: true, page: {
      entries: [{ childPageHomeRef: leaf, upperBoundName: "a" }], level: 1, type: "branch",
    } });
    const cursor = graph.createCursor({
      policy: createMaintenancePolicy({ maxTraversalDepth: 1 }),
      roots: [directoryRoot({ reference: root })],
    });
    expect(await cursor.runSlice({ hasForegroundWaiter: noForeground, now: constantNow, signal: undefined }))
      .toEqual({ phase: "aborted_without_deletion", reason: "traversal_depth_exceeded" });
  });

  it("keeps the cycle hard budget when the completed memo evicts records", async () => {
    const graph = directoryRecordGraph();
    const first = graph.addLeaf({ name: "a" });
    const second = graph.addLeaf({ name: "z" });
    const cursor = graph.createCursor({
      policy: createMaintenancePolicy({ maxCompletedMemoEntries: 1, maxDecodedRecordsPerCycle: 2 }),
      roots: [directoryRoot({ reference: first }), directoryRoot({ reference: second }), directoryRoot({ reference: first })],
    });
    expect(await cursor.runSlice({ hasForegroundWaiter: noForeground, now: constantNow, signal: undefined }))
      .toEqual({ phase: "aborted_without_deletion", reason: "hard_budget_exceeded" });
    expect(graph.reads).toHaveLength(3);
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
