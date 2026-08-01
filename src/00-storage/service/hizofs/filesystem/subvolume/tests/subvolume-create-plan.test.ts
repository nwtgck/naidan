import { describe, expect, it } from "vitest";
import {
  createHomeRecordReference,
  createInodeNumber,
  createSubvolumeId,
  createTimestampMilliseconds,
  createUInt64,
  HIZOFS_V1_FORMAT_CONSTANTS,
  parseSegmentId,
  UINT64_MAXIMUM,
  type NestedSubvolumeLeafEntry,
} from "@/00-storage/service/hizofs/00-format";
import { prepareSubvolumeCreatePlan } from "@/00-storage/service/hizofs/filesystem/subvolume/subvolume-create-plan";
import type { SubvolumeTopologyMount } from "@/00-storage/service/hizofs/filesystem/subvolume/subvolume-topology";

const rootSubvolumeId = createSubvolumeId({ value: 1n });

function inodeTableRoot({
  recordKind = HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
  seed = 1,
}: {
  recordKind?: number;
  seed?: number;
} = {}) {
  return createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: BigInt(seed * 64) }),
    frameLength: 96,
    recordKind,
    segmentId: parseSegmentId({ bytes: Uint8Array.from({ length: 16 }, (_, index) => seed + index) }),
  } });
}

function topologyRow({ id, parentId = 1, parentInode = id + 10, rootInode = id + 20 }: {
  id: number;
  parentId?: number;
  parentInode?: number;
  rootInode?: number;
}): NestedSubvolumeLeafEntry {
  return {
    access: "read_write",
    entryName: `subvolume-${id}`,
    inodeTableRootHomeRef: inodeTableRoot({ seed: id }),
    parentDirectoryInodeNumber: createInodeNumber({ value: BigInt(parentInode) }),
    parentSubvolumeId: createSubvolumeId({ value: BigInt(parentId) }),
    rootDirectoryInodeNumber: createInodeNumber({ value: BigInt(rootInode) }),
    subvolumeId: createSubvolumeId({ value: BigInt(id) }),
  };
}

function mount({ row }: { row: NestedSubvolumeLeafEntry }): SubvolumeTopologyMount {
  return {
    entry: { name: row.entryName, subvolumeId: row.subvolumeId, targetType: "subvolume" },
    parentDirectoryInodeNumber: row.parentDirectoryInodeNumber,
    parentSubvolumeId: row.parentSubvolumeId,
  };
}

function input({
  destinationExists = false,
  nextInodeNumber = 40n,
  nextSubvolumeId = 8n,
  parentAccess = "read_write",
  parentDirectoryInodeNumber = 5n,
  parentSubvolumeId = 3n,
  requestedAccess = "read_write",
  root = inodeTableRoot(),
  topologyMounts,
  topologyRows,
}: Readonly<{
  destinationExists?: boolean;
  nextInodeNumber?: bigint;
  nextSubvolumeId?: bigint;
  parentAccess?: "read" | "read_write";
  parentDirectoryInodeNumber?: bigint;
  parentSubvolumeId?: bigint;
  requestedAccess?: "read" | "read_write";
  root?: ReturnType<typeof inodeTableRoot>;
  topologyMounts?: readonly SubvolumeTopologyMount[];
  topologyRows?: readonly NestedSubvolumeLeafEntry[];
}> = {}) {
  const defaultParent = topologyRow({ id: 3 });
  const resolvedRows = topologyRows ?? (parentSubvolumeId === 1n ? [] : [defaultParent]);
  return {
    inodeTableRootHomeRef: root,
    maxTopologyEntries: 100,
    nextInodeNumber: createInodeNumber({ value: nextInodeNumber }),
    nextSubvolumeId: createSubvolumeId({ value: nextSubvolumeId }),
    operationTimestamp: createTimestampMilliseconds({ value: 100n }),
    rootSubvolumeId,
    target: {
      destinationExists,
      entryName: "child",
      parentAccess,
      parentDirectoryInodeNumber: createInodeNumber({ value: parentDirectoryInodeNumber }),
      parentSubvolumeId: createSubvolumeId({ value: parentSubvolumeId }),
      requestedAccess,
    },
    topologyMounts: topologyMounts ?? resolvedRows.map(row => mount({ row })),
    topologyRows: resolvedRows,
  } as const;
}

function code(parameters: Parameters<typeof prepareSubvolumeCreatePlan>[0]): string | undefined {
  try {
    prepareSubvolumeCreatePlan(parameters);
    return undefined;
  } catch (error: unknown) {
    return error instanceof Error && "code" in error ? String(error.code) : undefined;
  }
}

describe("Subvolume create plan", () => {
  it("creates an empty read-write Subvolume as one matching row and mount entry", () => {
    const plan = prepareSubvolumeCreatePlan(input());
    expect(plan.directoryEntry).toEqual({ name: "child", subvolumeId: 8n, targetType: "subvolume" });
    expect(plan.subvolume).toMatchObject({
      access: "read_write",
      entryName: "child",
      parentDirectoryInodeNumber: 5n,
      parentSubvolumeId: 3n,
      rootDirectoryInodeNumber: 40n,
      subvolumeId: 8n,
    });
    expect(plan.rootDirectoryInode).toEqual({
      content: { entries: [], type: "inline" },
      inodeKind: "directory",
      inodeNumber: 40n,
      inodeRevision: 1n,
      timestamps: { createdAt: 100n, modifiedAt: 100n },
    });
    expect(plan.nextInodeNumber).toBe(41n);
    expect(plan.nextSubvolumeId).toBe(9n);
  });

  it("allows an empty persisted read-only Subvolume", () => {
    const plan = prepareSubvolumeCreatePlan(input({ requestedAccess: "read" }));
    expect(plan.subvolume.access).toBe("read");
  });

  it("allows creation directly below the implicit root", () => {
    expect(prepareSubvolumeCreatePlan(input({ parentSubvolumeId: 1n })).subvolume.parentSubvolumeId).toBe(1n);
  });

  it("rejects read-only parent authority and destination collisions", () => {
    expect(code(input({ parentAccess: "read" }))).toBe("parent_read_only");
    expect(code(input({ destinationExists: true }))).toBe("destination_exists");
  });

  it("rejects a destination parent absent from the captured topology", () => {
    expect(code(input({ parentSubvolumeId: 4n, topologyMounts: [], topologyRows: [] })))
      .toBe("destination_parent_missing");
  });

  it("rejects exhausted allocators", () => {
    expect(code(input({ nextSubvolumeId: UINT64_MAXIMUM }))).toBe("subvolume_allocator_exhausted");
    expect(code(input({ nextInodeNumber: UINT64_MAXIMUM }))).toBe("inode_allocator_exhausted");
  });

  it("rejects allocator high-water marks behind any captured identity", () => {
    const unrelated = topologyRow({ id: 10, parentInode: 100, rootInode: 200 });
    const rows = [topologyRow({ id: 3 }), unrelated];
    const mounts = rows.map(row => mount({ row }));
    expect(code(input({ nextSubvolumeId: 10n, topologyMounts: mounts, topologyRows: rows })))
      .toBe("allocator_regression");
    expect(code(input({ nextInodeNumber: 200n, topologyMounts: mounts, topologyRows: rows })))
      .toBe("allocator_regression");
  });

  it("rejects a non-Inode-Table root reference", () => {
    expect(code(input({ root: inodeTableRoot({
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.directory_page,
    }) }))).toBe("invalid_inode_table_root");
  });

  it("rejects invalid captured topology before creating a row", () => {
    const parent = topologyRow({ id: 3 });
    expect(() => prepareSubvolumeCreatePlan(input({
      topologyMounts: [{ ...mount({ row: parent }), entry: { ...mount({ row: parent }).entry, name: "wrong" } }],
      topologyRows: [parent],
    }))).toThrowError(expect.objectContaining({ code: "row_mount_disagreement" }));
  });
});
