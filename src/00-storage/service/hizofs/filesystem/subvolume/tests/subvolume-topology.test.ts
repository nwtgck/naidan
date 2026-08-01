import { describe, expect, it } from "vitest";
import {
  createHomeRecordReference,
  createInodeNumber,
  createSubvolumeId,
  createUInt64,
  HIZOFS_V1_FORMAT_CONSTANTS,
  parseSegmentId,
  type NestedSubvolumeLeafEntry,
} from "@/00-storage/service/hizofs/00-format";
import {
  validateSubvolumeTopology,
  type SubvolumeTopologyMount,
} from "@/00-storage/service/hizofs/filesystem/subvolume/subvolume-topology";

const rootSubvolumeId = createSubvolumeId({ value: 1n });

function row({ id, name, parentId }: { id: number; name: string; parentId: number }): NestedSubvolumeLeafEntry {
  return {
    access: "read_write",
    entryName: name,
    inodeTableRootHomeRef: createHomeRecordReference({ fields: {
      byteOffset: createUInt64({ value: BigInt(id * 64) }),
      frameLength: 96,
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
      segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(id) }),
    } }),
    parentDirectoryInodeNumber: createInodeNumber({ value: BigInt(parentId * 100 + id) }),
    parentSubvolumeId: createSubvolumeId({ value: BigInt(parentId) }),
    rootDirectoryInodeNumber: createInodeNumber({ value: BigInt(1_000 + id) }),
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

function code({ mounts, rows }: {
  mounts: readonly SubvolumeTopologyMount[];
  rows: readonly NestedSubvolumeLeafEntry[];
}): string | undefined {
  try {
    validateSubvolumeTopology({ maxTopologyEntries: 100, mounts, rootSubvolumeId, rows });
    return undefined;
  } catch (error: unknown) {
    return error instanceof Error && "code" in error ? String(error.code) : undefined;
  }
}

describe("Subvolume topology validation", () => {
  it("accepts one exact row/mount pair per root-reachable nested Subvolume", () => {
    const parent = row({ id: 2, name: "parent", parentId: 1 });
    const child = row({ id: 3, name: "child", parentId: 2 });
    const topology = validateSubvolumeTopology({
      maxTopologyEntries: 2,
      mounts: [mount({ source: child }), mount({ source: parent })],
      rootSubvolumeId,
      rows: [child, parent],
    });

    expect(topology.childrenOf({ parentSubvolumeId: rootSubvolumeId }).map(value => value.subvolumeId)).toEqual([2n]);
    expect(topology.childrenOf({ parentSubvolumeId: parent.subvolumeId }).map(value => value.subvolumeId)).toEqual([3n]);
    expect(topology.mountFor({ subvolumeId: child.subvolumeId })?.entry.name).toBe("child");
  });

  it("rejects missing, orphan, duplicate, and disagreeing mounts", () => {
    const left = row({ id: 2, name: "left", parentId: 1 });
    const right = row({ id: 3, name: "right", parentId: 1 });
    expect(code({ mounts: [], rows: [left] })).toBe("missing_mount");
    expect(code({ mounts: [mount({ source: left })], rows: [] })).toBe("orphan_mount");
    expect(code({ mounts: [mount({ source: left }), mount({ source: left })], rows: [left] })).toBe("duplicate_mount_identity");
    expect(code({ mounts: [mount({ source: left })], rows: [left, left] })).toBe("duplicate_subvolume_identity");
    expect(code({
      mounts: [{ ...mount({ source: left }), entry: { name: "wrong", subvolumeId: left.subvolumeId, targetType: "subvolume" } }],
      rows: [left],
    })).toBe("row_mount_disagreement");
    expect(code({
      mounts: [mount({ source: left }), { ...mount({ source: right }), entry: { name: left.entryName, subvolumeId: right.subvolumeId, targetType: "subvolume" }, parentDirectoryInodeNumber: left.parentDirectoryInodeNumber }],
      rows: [left, right],
    })).toBe("duplicate_mount_location");
  });

  it("rejects root rows, root mounts, orphan parents, and disconnected cycles", () => {
    const rootRow = row({ id: 1, name: "root", parentId: 1 });
    expect(code({ mounts: [mount({ source: rootRow })], rows: [rootRow] })).toBe("root_row_present");

    const child = row({ id: 2, name: "child", parentId: 1 });
    expect(code({ mounts: [{ ...mount({ source: child }), entry: { name: "root", subvolumeId: rootSubvolumeId, targetType: "subvolume" } }], rows: [child] }))
      .toBe("root_mount_present");

    const orphan = row({ id: 2, name: "orphan", parentId: 9 });
    expect(code({ mounts: [mount({ source: orphan })], rows: [orphan] })).toBe("orphan_parent");

    const first = row({ id: 2, name: "first", parentId: 3 });
    const second = row({ id: 3, name: "second", parentId: 2 });
    expect(code({ mounts: [mount({ source: first }), mount({ source: second })], rows: [first, second] }))
      .toBe("topology_cycle");
  });

  it("enforces an explicit bound independently for rows and mounts", () => {
    const child = row({ id: 2, name: "child", parentId: 1 });
    expect(() => validateSubvolumeTopology({ maxTopologyEntries: 0, mounts: [], rootSubvolumeId, rows: [] }))
      .toThrowError(expect.objectContaining({ code: "invalid_topology_limit" }));
    expect(() => validateSubvolumeTopology({ maxTopologyEntries: 1, mounts: [mount({ source: child }), mount({ source: child })], rootSubvolumeId, rows: [child] }))
      .toThrowError(expect.objectContaining({ code: "topology_limit_exceeded" }));
  });
});
