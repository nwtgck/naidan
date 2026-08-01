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
import { prepareSubvolumeDeletePlan } from "@/00-storage/service/hizofs/filesystem/subvolume/subvolume-delete-plan";
import type { SubvolumeTopologyMount } from "@/00-storage/service/hizofs/filesystem/subvolume/subvolume-topology";

function inodeTableRoot(seed: number) {
  return createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: BigInt(seed * 64) }),
    frameLength: 96,
    recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
    segmentId: parseSegmentId({
      bytes: Uint8Array.from({ length: 16 }, (_, index) => (seed + index) & 0xff),
    }),
  } });
}

function row({
  id,
  name = `subvolume-${id}`,
  parentId = 1,
  parentInode = 2,
}: Readonly<{
  id: number;
  name?: string;
  parentId?: number;
  parentInode?: number;
}>): NestedSubvolumeLeafEntry {
  return {
    access: "read_write",
    entryName: name,
    inodeTableRootHomeRef: inodeTableRoot(id),
    parentDirectoryInodeNumber: createInodeNumber({ value: BigInt(parentInode) }),
    parentSubvolumeId: createSubvolumeId({ value: BigInt(parentId) }),
    rootDirectoryInodeNumber: createInodeNumber({ value: BigInt(id + 100) }),
    subvolumeId: createSubvolumeId({ value: BigInt(id) }),
  };
}

function errorCode(parameters: Parameters<typeof prepareSubvolumeDeletePlan>[0]): string | undefined {
  try {
    prepareSubvolumeDeletePlan(parameters);
    return undefined;
  } catch (error: unknown) {
    return error instanceof Error && "code" in error ? String(error.code) : undefined;
  }
}

function mount({ source }: { source: NestedSubvolumeLeafEntry }): SubvolumeTopologyMount {
  return {
    entry: { name: source.entryName, subvolumeId: source.subvolumeId, targetType: "subvolume" },
    parentDirectoryInodeNumber: source.parentDirectoryInodeNumber,
    parentSubvolumeId: source.parentSubvolumeId,
  };
}

const rootSubvolumeId = createSubvolumeId({ value: 1n });

function input({
  maxTopologyEntries = 100,
  parentAccess = "read_write",
  recursiveSubvolumes = false,
  target = row({ id: 2, name: "target" }),
  topologyMounts = [mount({ source: target })],
  topologyRows = [target],
}: Readonly<{
  maxTopologyEntries?: number;
  parentAccess?: "read" | "read_write";
  recursiveSubvolumes?: boolean;
  target?: NestedSubvolumeLeafEntry;
  topologyMounts?: readonly SubvolumeTopologyMount[];
  topologyRows?: readonly NestedSubvolumeLeafEntry[];
}> = {}) {
  return {
    maxTopologyEntries,
    parentAccess,
    recursiveSubvolumes,
    rootSubvolumeId,
    target,
    topologyMounts,
    topologyRows,
  } as const;
}

describe("Subvolume delete plan", () => {
  it("deletes a leaf as a topology-only operation", () => {
    const target = row({ id: 2, name: "leaf", parentId: 1, parentInode: 7 });
    const plan = prepareSubvolumeDeletePlan(input({ target }));

    expect(plan.mountEntriesToRemove).toEqual([mount({ source: target })]);
    expect(plan.subvolumeRowsToRemove).toEqual([target]);
    expect(plan.deletedSubvolumeIds).toEqual([2n]);
  });

  it("requires explicit recursive deletion when descendants exist", () => {
    const target = row({ id: 2, name: "parent" });
    const child = row({ id: 3, name: "child", parentId: 2 });

    expect(errorCode(input({
      target,
      topologyMounts: [mount({ source: target }), mount({ source: child })],
      topologyRows: [target, child],
    })))
      .toBe("nested_subvolumes_present");
  });

  it("returns a deterministic descendant-first closure for recursive deletion", () => {
    const target = row({ id: 2, name: "parent" });
    const childB = row({ id: 4, name: "b", parentId: 2 });
    const grandchild = row({ id: 5, name: "grandchild", parentId: 3 });
    const childA = row({ id: 3, name: "a", parentId: 2 });
    const unrelated = row({ id: 9, name: "unrelated", parentId: 1 });

    const plan = prepareSubvolumeDeletePlan(input({
      recursiveSubvolumes: true,
      target,
      topologyMounts: [unrelated, childB, grandchild, target, childA].map(source => mount({ source })),
      topologyRows: [unrelated, childB, grandchild, target, childA],
    }));

    expect(plan.deletedSubvolumeIds).toEqual([5n, 3n, 4n, 2n]);
    expect(plan.subvolumeRowsToRemove.map(entry => entry.subvolumeId)).toEqual([5n, 3n, 4n, 2n]);
  });

  it("uses the target parent authority and rejects the root Subvolume", () => {
    expect(errorCode(input({ parentAccess: "read" }))).toBe("parent_read_only");
    expect(errorCode(input({ target: row({ id: 1 }), topologyMounts: [], topologyRows: [] })))
      .toBe("root_subvolume");
  });

  it("rejects stale target attachments and duplicate identities", () => {
    const target = row({ id: 2, name: "expected" });
    const rebound = row({ id: 2, name: "different" });
    expect(errorCode(input({
      target,
      topologyMounts: [mount({ source: rebound })],
      topologyRows: [rebound],
    }))).toBe("target_not_mounted");
    expect(errorCode(input({
      target,
      topologyMounts: [mount({ source: target }), mount({ source: target })],
      topologyRows: [target, target],
    })))
      .toBe("duplicate_subvolume_identity");
  });

  it("rejects a reachable topology cycle", () => {
    const target = row({ id: 2, parentId: 3 });
    const child = row({ id: 3, parentId: 2 });
    expect(errorCode(input({
      recursiveSubvolumes: true,
      target,
      topologyMounts: [mount({ source: target }), mount({ source: child })],
      topologyRows: [target, child],
    })))
      .toBe("topology_cycle");
  });

  it("rejects topology input beyond the explicit memory bound", () => {
    const target = row({ id: 2 });
    const child = row({ id: 3, parentId: 2 });
    expect(errorCode(input({
      maxTopologyEntries: 1,
      recursiveSubvolumes: true,
      target,
      topologyMounts: [mount({ source: target }), mount({ source: child })],
      topologyRows: [target, child],
    }))).toBe("topology_limit_exceeded");
    expect(errorCode(input({ maxTopologyEntries: 0 }))).toBe("invalid_topology_limit");
  });
});
