import { describe, expect, it } from "vitest";
import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createCommitSequence,
  createFileOffset,
  createFileSystemCommitPayload,
  createHomeRecordReference,
  createInodeNumber,
  createPhysicalRecordReference,
  createSubvolumeId,
  createUInt64,
  encodeDirectoryPage,
  encodeFileExtentPage,
  encodeFileSystemCommitPayload,
  encodeInodeBranchPage,
  encodeNestedSubvolumeBranchPage,
  encodeRelocationIndexPage,
  parseMutationId,
  parseSegmentId,
} from "@/00-storage/service/hizofs/00-format";
import { projectMaintenanceRecordChildren } from "@/00-storage/service/hizofs/maintenance/maintenance-record-child-projection";
import {
  createLogicalMaintenanceTraversalItem,
  createPhysicalRelocationMaintenanceTraversalItem,
} from "@/00-storage/service/hizofs/maintenance/maintenance-traversal-item";

const KINDS = HIZOFS_V1_FORMAT_CONSTANTS.recordKinds;

function segmentId({ seed }: { seed: number }) {
  return parseSegmentId({ bytes: Uint8Array.from({ length: 16 }, (_, index) => (seed + index) & 0xff) });
}

function homeReference({ kind, offset = 64n, seed = 1 }: {
  kind: number;
  offset?: bigint;
  seed?: number;
}) {
  return createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: offset }),
    frameLength: 96,
    recordKind: kind,
    segmentId: segmentId({ seed }),
  } });
}

function physicalReference({ kind, offset = 64n, seed = 1 }: {
  kind: number;
  offset?: bigint;
  seed?: number;
}) {
  return createPhysicalRecordReference({ fields: {
    byteOffset: createUInt64({ value: offset }),
    frameLength: 96,
    recordKind: kind,
    segmentId: segmentId({ seed }),
  } });
}

describe("maintenance record child projection", () => {
  it("projects Commit authority into logical root pages", () => {
    const inodeRoot = homeReference({ kind: KINDS.inode_table_page, seed: 2 });
    const nestedRoot = homeReference({ kind: KINDS.nested_subvolume_table_page, offset: 160n, seed: 3 });
    const commit = homeReference({ kind: KINDS.file_system_commit, seed: 1 });
    const plaintext = encodeFileSystemCommitPayload({ payload: createFileSystemCommitPayload({ payload: {
      commitSequence: createCommitSequence({ value: 1n }),
      mutationId: parseMutationId({ bytes: new Uint8Array(16).fill(7) }),
      nestedSubvolumeTableRootHomeRef: nestedRoot,
      nextInodeNumber: createInodeNumber({ value: 2n }),
      nextSubvolumeId: createSubvolumeId({ value: 2n }),
      rootDirectoryInodeNumber: createInodeNumber({ value: 1n }),
      rootInodeTableRootHomeRef: inodeRoot,
    } }) });

    expect(projectMaintenanceRecordChildren({
      item: createLogicalMaintenanceTraversalItem({ pageRole: "not_page", reference: commit }),
      plaintext,
    })).toEqual([
      expect.objectContaining({ kind: "logical_home", pageRole: "root", reference: inodeRoot }),
      expect.objectContaining({ kind: "logical_home", pageRole: "root", reference: nestedRoot }),
    ]);
  });

  it("assigns non-root roles to logical branch children", () => {
    const cases = [
      {
        child: homeReference({ kind: KINDS.inode_table_page, seed: 4 }),
        encode: (child: ReturnType<typeof homeReference>) => encodeInodeBranchPage({
          isRoot: true,
          page: { entries: [{ childPageHomeRef: child, upperBound: createInodeNumber({ value: 1n }) }], level: 1 },
        }),
        kind: KINDS.inode_table_page,
      },
      {
        child: homeReference({ kind: KINDS.nested_subvolume_table_page, seed: 5 }),
        encode: (child: ReturnType<typeof homeReference>) => encodeNestedSubvolumeBranchPage({
          isRoot: true,
          page: { entries: [{ childPageHomeRef: child, upperBound: createSubvolumeId({ value: 1n }) }], level: 1 },
        }),
        kind: KINDS.nested_subvolume_table_page,
      },
      {
        child: homeReference({ kind: KINDS.directory_page, seed: 6 }),
        encode: (child: ReturnType<typeof homeReference>) => encodeDirectoryPage({
          isRoot: true,
          page: { entries: [{ childPageHomeRef: child, upperBoundName: "z" }], level: 1, type: "branch" },
        }),
        kind: KINDS.directory_page,
      },
      {
        child: homeReference({ kind: KINDS.file_extent_page, seed: 7 }),
        encode: (child: ReturnType<typeof homeReference>) => encodeFileExtentPage({
          isRoot: true,
          page: {
            entries: [{ childPageHomeRef: child, upperBound: createFileOffset({ value: 1n }) }],
            level: 1,
            type: "branch",
          },
        }),
        kind: KINDS.file_extent_page,
      },
    ];

    for (const value of cases) {
      const root = homeReference({ kind: value.kind, seed: value.kind });
      expect(projectMaintenanceRecordChildren({
        item: createLogicalMaintenanceTraversalItem({ pageRole: "root", reference: root }),
        plaintext: value.encode(value.child),
      })).toEqual([expect.objectContaining({
        kind: "logical_home",
        pageRole: "non_root",
        reference: value.child,
      })]);
    }
  });

  it("projects File Extent leaf data as logical non-page records", () => {
    const data = homeReference({ kind: KINDS.file_data, seed: 8 });
    const extentRoot = homeReference({ kind: KINDS.file_extent_page, seed: 9 });
    const plaintext = encodeFileExtentPage({
      isRoot: true,
      page: {
        entries: [{
          byteLength: 1,
          dataOffset: 0,
          fileDataHomeRef: data,
          fileOffset: createFileOffset({ value: 0n }),
        }],
        level: 0,
        type: "leaf",
      },
    });
    expect(projectMaintenanceRecordChildren({
      item: createLogicalMaintenanceTraversalItem({ pageRole: "root", reference: extentRoot }),
      plaintext,
    })).toEqual([expect.objectContaining({ kind: "logical_home", pageRole: "not_page", reference: data })]);
  });

  it("traverses physical relocation branches but does not retain leaf mappings", () => {
    const root = physicalReference({ kind: KINDS.relocation_index_page, seed: 10 });
    const child = physicalReference({ kind: KINDS.relocation_index_page, seed: 11 });
    const branch = encodeRelocationIndexPage({
      isRoot: true,
      page: {
        entries: [{
          childPagePhysicalRef: child,
          upperBound: { homeOffset: createUInt64({ value: 64n }), homeSegmentId: segmentId({ seed: 12 }) },
        }],
        level: 1,
        type: "branch",
      },
    });
    expect(projectMaintenanceRecordChildren({
      item: createPhysicalRelocationMaintenanceTraversalItem({ pageRole: "root", reference: root }),
      plaintext: branch,
    })).toEqual([expect.objectContaining({
      kind: "physical_relocation_page",
      pageRole: "non_root",
      reference: child,
    })]);

    const mapped = physicalReference({ kind: KINDS.file_data, seed: 13 });
    const leaf = encodeRelocationIndexPage({
      isRoot: true,
      page: {
        entries: [{
          currentPhysicalRecordRef: mapped,
          homeOffset: createUInt64({ value: 64n }),
          homeSegmentId: segmentId({ seed: 14 }),
        }],
        level: 0,
        type: "leaf",
      },
    });
    expect(projectMaintenanceRecordChildren({
      item: createPhysicalRelocationMaintenanceTraversalItem({ pageRole: "root", reference: root }),
      plaintext: leaf,
    })).toEqual([]);
  });

  it("rejects page-role and physical-authority mismatches", () => {
    const extentRoot = homeReference({ kind: KINDS.file_extent_page, seed: 15 });
    const emptyExtent = encodeFileExtentPage({ isRoot: true, page: { entries: [], level: 0, type: "leaf" } });
    expect(() => projectMaintenanceRecordChildren({
      item: createLogicalMaintenanceTraversalItem({ pageRole: "not_page", reference: extentRoot }),
      plaintext: emptyExtent,
    })).toThrow("explicit root or non-root role");

    const relocation = homeReference({ kind: KINDS.relocation_index_page, seed: 16 });
    const emptyRelocation = encodeRelocationIndexPage({ isRoot: true, page: { entries: [], level: 0, type: "leaf" } });
    expect(() => projectMaintenanceRecordChildren({
      item: createLogicalMaintenanceTraversalItem({ pageRole: "root", reference: relocation }),
      plaintext: emptyRelocation,
    })).toThrow("physical page item");
  });
});
