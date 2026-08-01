import { describe, expect, it } from "vitest";
import {
  createHomeRecordReference,
  createInodeNumber,
  createSubvolumeId,
  createUInt64,
  HIZOFS_V1_FORMAT_CONSTANTS,
  parseSegmentId,
  UINT64_MAXIMUM,
  type NestedSubvolumeLeafEntry,
} from "@/00-storage/service/hizofs/00-format";
import type { ContainerCoordinationKey } from "@/00-storage/service/hizofs/filesystem/container-coordination-key";
import {
  finalizeRecursiveSubvolumeSnapshotRows,
  prepareRecursiveSubvolumeSnapshotPlan,
} from "@/00-storage/service/hizofs/filesystem/subvolume/recursive-subvolume-snapshot-plan";
import type { SubvolumeTopologyMount } from "@/00-storage/service/hizofs/filesystem/subvolume/subvolume-topology";

function rootReference(seed: number) {
  return createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: BigInt(seed * 64) }),
    frameLength: 96,
    recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
    segmentId: parseSegmentId({
      bytes: Uint8Array.from({ length: 16 }, (_, index) => (seed + index) & 0xff),
    }),
  } });
}

function nested({ id, parentId, name }: { id: number; parentId: number; name: string }): NestedSubvolumeLeafEntry {
  return {
    access: id % 2 === 0 ? "read_write" : "read",
    entryName: name,
    inodeTableRootHomeRef: rootReference(id),
    parentDirectoryInodeNumber: createInodeNumber({ value: BigInt(200 + id) }),
    parentSubvolumeId: createSubvolumeId({ value: BigInt(parentId) }),
    rootDirectoryInodeNumber: createInodeNumber({ value: BigInt(100 + id) }),
    subvolumeId: createSubvolumeId({ value: BigInt(id) }),
  };
}

function coordinationKey(): ContainerCoordinationKey {
  return Object.freeze({}) as ContainerCoordinationKey;
}

const containerKey = coordinationKey();
const rootSubvolumeId = createSubvolumeId({ value: 1n });
const sourceRoot = {
  access: "read_write" as const,
  containerCoordinationKey: containerKey,
  inodeTableRootHomeRef: rootReference(1),
  rootDirectoryInodeNumber: createInodeNumber({ value: 101n }),
  subvolumeId: createSubvolumeId({ value: 1n }),
};

function mount({ source }: { source: NestedSubvolumeLeafEntry }): SubvolumeTopologyMount {
  return {
    entry: { name: source.entryName, subvolumeId: source.subvolumeId, targetType: "subvolume" },
    parentDirectoryInodeNumber: source.parentDirectoryInodeNumber,
    parentSubvolumeId: source.parentSubvolumeId,
  };
}

function input({
  destinationExists = false,
  maxTopologyEntries = 100,
  nextSubvolumeId = 20n,
  parentAccess = "read_write",
  requestedAccess = "read",
  sourceTopologyRows = [
    nested({ id: 2, parentId: 1, name: "workspace" }),
    nested({ id: 3, parentId: 2, name: "archive" }),
  ],
  sourceTopologyMounts = sourceTopologyRows.map(source => mount({ source })),
  targetContainerKey = containerKey,
}: Readonly<{
  destinationExists?: boolean;
  maxTopologyEntries?: number;
  nextSubvolumeId?: bigint;
  parentAccess?: "read" | "read_write";
  requestedAccess?: "read" | "read_write";
  sourceTopologyMounts?: readonly SubvolumeTopologyMount[];
  sourceTopologyRows?: readonly NestedSubvolumeLeafEntry[];
  targetContainerKey?: ContainerCoordinationKey;
}> = {}) {
  return {
    maxTopologyEntries,
    nextSubvolumeId: createSubvolumeId({ value: nextSubvolumeId }),
    rootSubvolumeId,
    sourceRoot,
    sourceTopologyMounts,
    sourceTopologyRows,
    target: {
      containerCoordinationKey: targetContainerKey,
      destinationExists,
      entryName: "snapshot",
      parentAccess,
      parentDirectoryInodeNumber: createInodeNumber({ value: 50n }),
      parentSubvolumeId: createSubvolumeId({ value: 10n }),
      requestedAccess,
    },
  } as const;
}

function errorCode(parameters: Parameters<typeof prepareRecursiveSubvolumeSnapshotPlan>[0]): string | undefined {
  try {
    prepareRecursiveSubvolumeSnapshotPlan(parameters);
    return undefined;
  } catch (error: unknown) {
    return error instanceof Error && "code" in error ? String(error.code) : undefined;
  }
}

describe("Recursive Subvolume snapshot plan", () => {
  it("assigns fresh identities and requires COW for every parent containing rewritten mounts", () => {
    const sourceRows = [
      nested({ id: 3, parentId: 2, name: "archive" }),
      nested({ id: 2, parentId: 1, name: "workspace" }),
    ];
    const plan = prepareRecursiveSubvolumeSnapshotPlan(input({
      sourceTopologyMounts: sourceRows.map(source => mount({ source })),
      sourceTopologyRows: sourceRows,
    }));

    expect(plan.directoryEntry).toEqual({ name: "snapshot", subvolumeId: 20n, targetType: "subvolume" });
    expect(plan.nextSubvolumeId).toBe(23n);
    expect(plan.sourceToSnapshotSubvolumeIds).toEqual([
      { snapshotSubvolumeId: 20n, sourceSubvolumeId: 1n },
      { snapshotSubvolumeId: 21n, sourceSubvolumeId: 2n },
      { snapshotSubvolumeId: 22n, sourceSubvolumeId: 3n },
    ]);
    expect(plan.snapshotRowDrafts.map(draft => ({
      access: draft.access,
      entryName: draft.entryName,
      parentSubvolumeId: draft.parentSubvolumeId,
      subvolumeId: draft.subvolumeId,
      rootPlanType: draft.inodeTableRootPlan.type,
    }))).toEqual([
      { access: "read", entryName: "snapshot", parentSubvolumeId: 10n, rootPlanType: "rewrite_mount_entries", subvolumeId: 20n },
      { access: "read", entryName: "workspace", parentSubvolumeId: 20n, rootPlanType: "rewrite_mount_entries", subvolumeId: 21n },
      { access: "read", entryName: "archive", parentSubvolumeId: 21n, rootPlanType: "share", subvolumeId: 22n },
    ]);
    expect(plan.snapshotRowDrafts[0]?.inodeTableRootPlan).toEqual({
      rewrites: [{
        entryName: "workspace",
        parentDirectoryInodeNumber: sourceRows[1]?.parentDirectoryInodeNumber,
        snapshotChildSubvolumeId: 21n,
        sourceChildSubvolumeId: 2n,
      }],
      sourceInodeTableRootHomeRef: sourceRoot.inodeTableRootHomeRef,
      type: "rewrite_mount_entries",
    });
    expect(plan.snapshotRowDrafts[1]?.inodeTableRootPlan).toEqual({
      rewrites: [{
        entryName: "archive",
        parentDirectoryInodeNumber: sourceRows[0]?.parentDirectoryInodeNumber,
        snapshotChildSubvolumeId: 22n,
        sourceChildSubvolumeId: 3n,
      }],
      sourceInodeTableRootHomeRef: sourceRows[1]?.inodeTableRootHomeRef,
      type: "rewrite_mount_entries",
    });

    const rewrittenRoot = rootReference(30);
    const rewrittenChild = rootReference(31);
    const rows = finalizeRecursiveSubvolumeSnapshotRows({
      plan,
      rewrittenInodeTableRoots: [
        { inodeTableRootHomeRef: rewrittenRoot, snapshotSubvolumeId: createSubvolumeId({ value: 20n }) },
        { inodeTableRootHomeRef: rewrittenChild, snapshotSubvolumeId: createSubvolumeId({ value: 21n }) },
      ],
    });
    expect(rows.map(row => row.inodeTableRootHomeRef)).toEqual([
      rewrittenRoot,
      rewrittenChild,
      sourceRows[0]?.inodeTableRootHomeRef,
    ]);
  });

  it("rejects missing, duplicate, or unexpected rewritten roots", () => {
    const plan = prepareRecursiveSubvolumeSnapshotPlan(input());
    expect(() => finalizeRecursiveSubvolumeSnapshotRows({
      plan,
      rewrittenInodeTableRoots: [],
    })).toThrowError(expect.objectContaining({ code: "missing_rewritten_inode_table_root" }));
    const replacement = {
      inodeTableRootHomeRef: rootReference(30),
      snapshotSubvolumeId: createSubvolumeId({ value: 20n }),
    };
    expect(() => finalizeRecursiveSubvolumeSnapshotRows({
      plan,
      rewrittenInodeTableRoots: [replacement, replacement],
    })).toThrowError(expect.objectContaining({ code: "duplicate_rewritten_inode_table_root" }));
    expect(() => finalizeRecursiveSubvolumeSnapshotRows({
      plan,
      rewrittenInodeTableRoots: [
        replacement,
        { inodeTableRootHomeRef: rootReference(31), snapshotSubvolumeId: createSubvolumeId({ value: 21n }) },
        { inodeTableRootHomeRef: rootReference(32), snapshotSubvolumeId: createSubvolumeId({ value: 22n }) },
      ],
    })).toThrowError(expect.objectContaining({ code: "unexpected_rewritten_inode_table_root" }));
  });

  it("starts an independently writable lineage uniformly across the graph", () => {
    const plan = prepareRecursiveSubvolumeSnapshotPlan(input({ requestedAccess: "read_write" }));
    expect(plan.snapshotRowDrafts.every(entry => entry.access === "read_write")).toBe(true);
  });

  it("rejects mutable-parent, collision, and physical-container violations", () => {
    expect(errorCode(input({ parentAccess: "read" }))).toBe("parent_read_only");
    expect(errorCode(input({ destinationExists: true }))).toBe("destination_exists");
    expect(errorCode(input({ targetContainerKey: coordinationKey() }))).toBe("cross_device");
  });

  it("rejects allocator regression and graph-sized exhaustion before assigning identities", () => {
    expect(errorCode(input({ nextSubvolumeId: 10n }))).toBe("allocator_regression");
    expect(errorCode(input({ nextSubvolumeId: UINT64_MAXIMUM - 1n }))).toBe("allocator_exhausted");
  });

  it("rejects duplicate identities and cycles in the captured source topology", () => {
    const duplicate = nested({ id: 2, parentId: 1, name: "duplicate" });
    expect(errorCode(input({
      sourceTopologyMounts: [mount({ source: duplicate }), mount({ source: duplicate })],
      sourceTopologyRows: [duplicate, duplicate],
    })))
      .toBe("duplicate_subvolume_identity");
    const first = nested({ id: 2, parentId: 3, name: "first" });
    const second = nested({ id: 3, parentId: 2, name: "second" });
    expect(errorCode(input({
      sourceTopologyMounts: [mount({ source: first }), mount({ source: second })],
      sourceTopologyRows: [first, second],
    }))).toBe("topology_cycle");
  });

  it("captures every valid descendant when the pinned source is the implicit root", () => {
    const sibling = nested({ id: 8, parentId: 1, name: "sibling" });
    const siblingChild = nested({ id: 9, parentId: 8, name: "sibling-child" });
    const rows = [
      nested({ id: 2, parentId: 1, name: "child" }),
      sibling,
      siblingChild,
    ];
    const plan = prepareRecursiveSubvolumeSnapshotPlan(input({
      sourceTopologyMounts: rows.map(source => mount({ source })),
      sourceTopologyRows: rows,
    }));
    expect(plan.sourceToSnapshotSubvolumeIds.map(entry => entry.sourceSubvolumeId)).toEqual([1n, 2n, 8n, 9n]);
  });

  it("rejects captured topology beyond the explicit memory bound", () => {
    expect(errorCode(input({ maxTopologyEntries: 1 }))).toBe("topology_limit_exceeded");
    expect(errorCode(input({ maxTopologyEntries: 0 }))).toBe("invalid_topology_limit");
  });

  it("rejects a row/mount disagreement before planning any snapshot rewrite", () => {
    const child = nested({ id: 2, parentId: 1, name: "child" });
    expect(errorCode(input({
      sourceTopologyMounts: [{
        ...mount({ source: child }),
        entry: { name: "stale", subvolumeId: child.subvolumeId, targetType: "subvolume" },
      }],
      sourceTopologyRows: [child],
    }))).toBe("row_mount_disagreement");
  });
});
