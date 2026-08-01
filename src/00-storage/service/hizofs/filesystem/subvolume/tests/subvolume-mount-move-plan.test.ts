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
import { prepareSubvolumeMountMovePlan } from "@/00-storage/service/hizofs/filesystem/subvolume/subvolume-mount-move-plan";
import type { SubvolumeTopologyMount } from "@/00-storage/service/hizofs/filesystem/subvolume/subvolume-topology";

const rootSubvolumeId = createSubvolumeId({ value: 1n });
const row: NestedSubvolumeLeafEntry = {
  access: "read",
  entryName: "old",
  inodeTableRootHomeRef: createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: 64n }),
    frameLength: 96,
    recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
    segmentId: parseSegmentId({ bytes: Uint8Array.from({ length: 16 }, (_, index) => index + 1) }),
  } }),
  parentDirectoryInodeNumber: createInodeNumber({ value: 10n }),
  parentSubvolumeId: rootSubvolumeId,
  rootDirectoryInodeNumber: createInodeNumber({ value: 20n }),
  subvolumeId: createSubvolumeId({ value: 2n }),
};

function mount({ source = row }: { source?: NestedSubvolumeLeafEntry } = {}): SubvolumeTopologyMount {
  return {
    entry: { name: source.entryName, subvolumeId: source.subvolumeId, targetType: "subvolume" },
    parentDirectoryInodeNumber: source.parentDirectoryInodeNumber,
    parentSubvolumeId: source.parentSubvolumeId,
  };
}

function input({
  destinationExists = false,
  destinationName = "new",
  destinationParentDirectoryInodeNumber = createInodeNumber({ value: 11n }),
  destinationParentSubvolumeId = rootSubvolumeId,
  parentAccess = "read_write",
  source = row,
  topologyMounts = [mount()],
  topologyRows = [row],
}: Readonly<{
  destinationExists?: boolean;
  destinationName?: string;
  destinationParentDirectoryInodeNumber?: ReturnType<typeof createInodeNumber>;
  destinationParentSubvolumeId?: ReturnType<typeof createSubvolumeId>;
  parentAccess?: "read" | "read_write";
  source?: NestedSubvolumeLeafEntry | null;
  topologyMounts?: readonly SubvolumeTopologyMount[];
  topologyRows?: readonly NestedSubvolumeLeafEntry[];
}> = {}) {
  return {
    destination: {
      entryName: destinationName,
      exists: destinationExists,
      parentAccess,
      parentDirectoryInodeNumber: destinationParentDirectoryInodeNumber,
      parentSubvolumeId: destinationParentSubvolumeId,
    },
    maxTopologyEntries: 100,
    rootSubvolumeId,
    source,
    topologyMounts,
    topologyRows,
  } as const;
}

describe("Subvolume mount move plan", () => {
  it("updates the validated mount entry and topology row as one candidate", () => {
    expect(prepareSubvolumeMountMovePlan(input())).toEqual({
      destinationMountEntry: { name: "new", subvolumeId: 2n, targetType: "subvolume" },
      sourceMount: {
        entry: { name: "old", subvolumeId: 2n, targetType: "subvolume" },
        parentDirectoryInodeNumber: 10n,
        parentSubvolumeId: 1n,
      },
      updatedRow: {
        ...row,
        entryName: "new",
        parentDirectoryInodeNumber: 11n,
      },
    });
  });

  it("returns no-op only after resolving an existing exact same path", () => {
    expect(prepareSubvolumeMountMovePlan(input({
      destinationName: "old",
      destinationParentDirectoryInodeNumber: row.parentDirectoryInodeNumber,
    }))).toBeNull();
    expect(() => prepareSubvolumeMountMovePlan(input({
      destinationName: "old",
      destinationParentDirectoryInodeNumber: row.parentDirectoryInodeNumber,
      source: null,
    }))).toThrowError(expect.objectContaining({ code: "source_missing" }));
  });

  it("rejects cross-Subvolume destinations", () => {
    expect(() => prepareSubvolumeMountMovePlan(input({
      destinationParentSubvolumeId: createSubvolumeId({ value: 3n }),
    }))).toThrowError(expect.objectContaining({ code: "cross_subvolume" }));
  });

  it("rejects read-only parent authority and every destination collision", () => {
    expect(() => prepareSubvolumeMountMovePlan(input({ parentAccess: "read" })))
      .toThrowError(expect.objectContaining({ code: "parent_read_only" }));
    expect(() => prepareSubvolumeMountMovePlan(input({ destinationExists: true })))
      .toThrowError(expect.objectContaining({ code: "destination_exists" }));
  });

  it("rejects a source row that does not match the captured topology", () => {
    expect(() => prepareSubvolumeMountMovePlan(input({
      source: { ...row, access: "read_write" },
    }))).toThrowError(expect.objectContaining({ code: "source_not_mounted" }));
  });

  it("rejects row and mount disagreement before planning a move", () => {
    expect(() => prepareSubvolumeMountMovePlan(input({
      topologyMounts: [{ ...mount(), entry: { ...mount().entry, name: "different" } }],
    }))).toThrowError(expect.objectContaining({ code: "row_mount_disagreement" }));
  });
});
