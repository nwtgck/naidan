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
import { prepareSubvolumeSnapshotPlan } from "@/00-storage/service/hizofs/filesystem/subvolume/subvolume-snapshot-plan";
import type { SubvolumeTopologyMount } from "@/00-storage/service/hizofs/filesystem/subvolume/subvolume-topology";

function inodeTableRoot(seed: number) {
  return createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: BigInt(seed * 64) }),
    frameLength: 96,
    recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
    segmentId: parseSegmentId({ bytes: Uint8Array.from({ length: 16 }, (_, index) => seed + index + 1) }),
  } });
}

const rootReference = inodeTableRoot(1);
const rootSubvolumeId = createSubvolumeId({ value: 1n });

function coordinationKey(): ContainerCoordinationKey {
  return Object.freeze({}) as ContainerCoordinationKey;
}

function topologyRow({ id, name, parentId, root = inodeTableRoot(id), rootInode = id + 100 }: {
  id: number;
  name: string;
  parentId: number;
  root?: ReturnType<typeof inodeTableRoot>;
  rootInode?: number;
}): NestedSubvolumeLeafEntry {
  return {
    access: "read_write",
    entryName: name,
    inodeTableRootHomeRef: root,
    parentDirectoryInodeNumber: createInodeNumber({ value: BigInt(id + 200) }),
    parentSubvolumeId: createSubvolumeId({ value: BigInt(parentId) }),
    rootDirectoryInodeNumber: createInodeNumber({ value: BigInt(rootInode) }),
    subvolumeId: createSubvolumeId({ value: BigInt(id) }),
  };
}

function mount({ source }: { source: NestedSubvolumeLeafEntry }): SubvolumeTopologyMount {
  return {
    entry: { name: source.entryName, subvolumeId: source.subvolumeId, targetType: "subvolume" },
    parentDirectoryInodeNumber: source.parentDirectoryInodeNumber,
    parentSubvolumeId: source.parentSubvolumeId,
  };
}

function snapshotInput({
  container = coordinationKey(),
  destinationExists = false,
  maxTopologyEntries = 100,
  nextSubvolumeId = 8n,
  parentAccess = "read_write",
  parentSubvolumeId = 4n,
  requestedAccess = "read",
  sourceAccess = "read_write",
  sourceContainer = container,
  sourceSubvolumeId = 2n,
  topologyMounts,
  topologyRows,
}: Readonly<{
  container?: ContainerCoordinationKey;
  destinationExists?: boolean;
  maxTopologyEntries?: number;
  nextSubvolumeId?: bigint;
  parentAccess?: "read" | "read_write";
  parentSubvolumeId?: bigint;
  requestedAccess?: "read" | "read_write";
  sourceAccess?: "read" | "read_write";
  sourceContainer?: ContainerCoordinationKey;
  sourceSubvolumeId?: bigint;
  topologyMounts?: readonly SubvolumeTopologyMount[];
  topologyRows?: readonly NestedSubvolumeLeafEntry[];
}> = {}) {
  const sourceRow = sourceSubvolumeId === 1n
    ? undefined
    : topologyRow({
      id: Number(sourceSubvolumeId),
      name: "source",
      parentId: 1,
      root: rootReference,
      rootInode: 3,
    });
  const parentRow = parentSubvolumeId === 1n || parentSubvolumeId === sourceSubvolumeId
    ? undefined
    : topologyRow({ id: Number(parentSubvolumeId), name: "parent", parentId: 1 });
  const resolvedRows = topologyRows ?? [sourceRow, parentRow].filter((value): value is NestedSubvolumeLeafEntry => value !== undefined);
  const resolvedMounts = topologyMounts ?? resolvedRows.map(source => mount({ source }));
  return {
    maxTopologyEntries,
    nextSubvolumeId: createSubvolumeId({ value: nextSubvolumeId }),
    rootSubvolumeId,
    source: {
      access: sourceAccess,
      containerCoordinationKey: sourceContainer,
      inodeTableRootHomeRef: rootReference,
      rootDirectoryInodeNumber: createInodeNumber({ value: 3n }),
      subvolumeId: createSubvolumeId({ value: sourceSubvolumeId }),
    },
    target: {
      containerCoordinationKey: container,
      destinationExists,
      entryName: "snapshot-a",
      parentAccess,
      parentDirectoryInodeNumber: createInodeNumber({ value: 9n }),
      parentSubvolumeId: createSubvolumeId({ value: parentSubvolumeId }),
      requestedAccess,
    },
    topologyMounts: resolvedMounts,
    topologyRows: resolvedRows,
  } as const;
}

describe("Subvolume snapshot plan", () => {
  it("allocates a read-only snapshot while preserving the shared inode graph", () => {
    const plan = prepareSubvolumeSnapshotPlan(snapshotInput());
    expect(plan.snapshot).toMatchObject({
      access: "read",
      entryName: "snapshot-a",
      inodeTableRootHomeRef: rootReference,
      rootDirectoryInodeNumber: 3n,
      subvolumeId: 8n,
    });
    expect(plan.directoryEntry).toEqual({ name: "snapshot-a", subvolumeId: 8n, targetType: "subvolume" });
    expect(plan.nextSubvolumeId).toBe(9n);
  });

  it("creates an independently writable snapshot identity when requested", () => {
    const plan = prepareSubvolumeSnapshotPlan(snapshotInput({ requestedAccess: "read_write" }));
    expect(plan.snapshot.access).toBe("read_write");
    expect(plan.snapshot.inodeTableRootHomeRef).toBe(rootReference);
    expect(plan.snapshot.rootDirectoryInodeNumber).toBe(3n);
  });

  it("can snapshot an immutable source using the requested destination access", () => {
    const plan = prepareSubvolumeSnapshotPlan(snapshotInput({
      requestedAccess: "read_write",
      sourceAccess: "read",
    }));
    expect(plan.snapshot.access).toBe("read_write");
    expect(plan.snapshot.inodeTableRootHomeRef).toBe(rootReference);
  });

  it("requires the recursive planner when the source contains nested mounts", () => {
    const source = topologyRow({ id: 2, name: "source", parentId: 1, root: rootReference, rootInode: 3 });
    const parent = topologyRow({ id: 4, name: "parent", parentId: 1 });
    const child = topologyRow({ id: 5, name: "child", parentId: 2 });
    const rows = [source, parent, child];
    expect(() => prepareSubvolumeSnapshotPlan(snapshotInput({
      topologyMounts: rows.map(value => mount({ source: value })),
      topologyRows: rows,
    })))
      .toThrowError(expect.objectContaining({ code: "recursive_snapshot_required" }));
  });

  it("rejects a read-only parent before preparing a candidate", () => {
    expect(() => prepareSubvolumeSnapshotPlan(snapshotInput({ parentAccess: "read" })))
      .toThrow("read-write parent");
  });

  it("rejects a source from another physical container", () => {
    try {
      prepareSubvolumeSnapshotPlan(snapshotInput({ sourceContainer: coordinationKey() }));
      throw new Error("expected cross-container rejection");
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: "cross_device" });
    }
  });

  it("rejects an existing destination entry", () => {
    try {
      prepareSubvolumeSnapshotPlan(snapshotInput({ destinationExists: true }));
      throw new Error("expected destination collision rejection");
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: "destination_exists" });
    }
  });

  it("rejects an allocator high-water mark that does not exceed known IDs", () => {
    for (const input of [
      snapshotInput({ nextSubvolumeId: 2n, sourceSubvolumeId: 2n }),
      snapshotInput({ nextSubvolumeId: 3n, parentSubvolumeId: 4n }),
    ]) {
      try {
        prepareSubvolumeSnapshotPlan(input);
        throw new Error("expected allocator regression rejection");
      } catch (error: unknown) {
        expect(error).toMatchObject({ code: "allocator_regression" });
      }
    }
  });

  it("rejects exhausted Subvolume ID allocation", () => {
    try {
      prepareSubvolumeSnapshotPlan(snapshotInput({ nextSubvolumeId: UINT64_MAXIMUM }));
      throw new Error("expected allocator exhaustion rejection");
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: "allocator_exhausted" });
    }
  });

  it("uses every captured Subvolume ID when checking allocator freshness", () => {
    const source = topologyRow({ id: 2, name: "source", parentId: 1, root: rootReference, rootInode: 3 });
    const parent = topologyRow({ id: 4, name: "parent", parentId: 1 });
    const unrelated = topologyRow({ id: 10, name: "unrelated", parentId: 1 });
    const rows = [source, parent, unrelated];
    expect(() => prepareSubvolumeSnapshotPlan(snapshotInput({
      nextSubvolumeId: 9n,
      topologyMounts: rows.map(value => mount({ source: value })),
      topologyRows: rows,
    }))).toThrowError(expect.objectContaining({ code: "allocator_regression" }));
  });
});
