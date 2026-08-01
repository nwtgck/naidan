import { describe, expect, it } from "vitest";
import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createCommitSequence,
  createFileOffset,
  createHomeRecordReference,
  createInodeNumber,
  createInodeRevision,
  createPhysicalRecordReference,
  createSubvolumeId,
  createUInt64,
  encodeDirectoryPage,
  encodeFileExtentPage,
  encodeFileSystemCommitPayload,
  encodeInodeLeafPage,
  encodeNestedSubvolumeLeafPage,
  encodeRelocationIndexPage,
  parseMutationId,
  parseSegmentIdLowercaseHex,
} from "@/00-storage/service/hizofs/00-format";
import { TEST_ONLY } from "@/00-storage/service/hizofs/inspection/physical-record-inspection";

function homeReference({ frameLength, offset, segmentId, recordKind }: {
  frameLength: number;
  offset: bigint;
  segmentId: string;
  recordKind: number;
}) {
  return createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: offset }),
    frameLength,
    recordKind,
    segmentId: parseSegmentIdLowercaseHex({ value: segmentId }),
  } });
}

function physicalReference({ frameLength, offset, segmentId, recordKind }: {
  frameLength: number;
  offset: bigint;
  segmentId: string;
  recordKind: number;
}) {
  return createPhysicalRecordReference({ fields: {
    byteOffset: createUInt64({ value: offset }),
    frameLength,
    recordKind,
    segmentId: parseSegmentIdLowercaseHex({ value: segmentId }),
  } });
}

describe("HizoFS physical record inspection", () => {
  it("projects authoritative Commit home references for interactive inspection", () => {
    const kinds = HIZOFS_V1_FORMAT_CONSTANTS.recordKinds;
    const payload = {
      commitSequence: createCommitSequence({ value: 9n }),
      mutationId: parseMutationId({ bytes: new Uint8Array(16).fill(1) }),
      nestedSubvolumeTableRootHomeRef: homeReference({
        frameLength: 160,
        offset: 256n,
        recordKind: kinds.nested_subvolume_table_page,
        segmentId: "00000000000000000000000000000022",
      }),
      nextInodeNumber: createInodeNumber({ value: 10n }),
      nextSubvolumeId: createSubvolumeId({ value: 8n }),
      rootDirectoryInodeNumber: createInodeNumber({ value: 1n }),
      rootInodeTableRootHomeRef: homeReference({
        frameLength: 128,
        offset: 128n,
        recordKind: kinds.inode_table_page,
        segmentId: "00000000000000000000000000000011",
      }),
    };
    const bytes = encodeFileSystemCommitPayload({ payload });

    expect(TEST_ONLY.inspectPayload({
      bytes,
      pageIsRoot: undefined,
      recordKind: kinds.file_system_commit,
    })).toEqual({
      commitSequence: "9",
      decodedPayload: payload,
      navigationReferences: [
        {
          frameLength: 128,
          homeOffset: "128",
          homeSegmentId: "00000000000000000000000000000011",
          pageIsRoot: true,
          recordKind: kinds.inode_table_page,
          role: "root_inode_table_root",
          targetType: "home_record",
        },
        {
          frameLength: 160,
          homeOffset: "256",
          homeSegmentId: "00000000000000000000000000000022",
          pageIsRoot: true,
          recordKind: kinds.nested_subvolume_table_page,
          role: "nested_subvolume_table_root",
          targetType: "home_record",
        },
      ],
      kind: "file_system_commit",
      nextInodeNumber: "10",
      nextSubvolumeId: "8",
      rootDirectoryInodeNumber: "1",
      state: "decoded",
    });
  });

  it("projects directory branch and File Data references without inventing page roles", () => {
    const kinds = HIZOFS_V1_FORMAT_CONSTANTS.recordKinds;
    const directoryChild = homeReference({
      frameLength: 144,
      offset: 384n,
      recordKind: kinds.directory_page,
      segmentId: "00000000000000000000000000000031",
    });
    const directoryBytes = encodeDirectoryPage({
      isRoot: true,
      page: {
        entries: [{ childPageHomeRef: directoryChild, upperBoundName: "z" }],
        level: 1,
        type: "branch",
      },
    });
    const directoryInspection = TEST_ONLY.inspectPayload({
      bytes: directoryBytes,
      pageIsRoot: true,
      recordKind: kinds.directory_page,
    });
    expect(directoryInspection).toMatchObject({
      navigationReferences: [{
        frameLength: 144,
        homeOffset: "384",
        homeSegmentId: "00000000000000000000000000000031",
        pageIsRoot: false,
        recordKind: kinds.directory_page,
        role: "directory_child_page",
        targetType: "home_record",
      }],
    });
    expect(directoryInspection).toMatchObject({
      decodedPayload: {
        entries: [{ childPageHomeRef: directoryChild, upperBoundName: "z" }],
        level: 1,
        type: "branch",
      },
    });

    const fileData = homeReference({
      frameLength: 192,
      offset: 512n,
      recordKind: kinds.file_data,
      segmentId: "00000000000000000000000000000032",
    });
    const extentBytes = encodeFileExtentPage({
      isRoot: true,
      page: {
        entries: [{
          byteLength: 32,
          dataOffset: 4,
          fileDataHomeRef: fileData,
          fileOffset: createFileOffset({ value: 0n }),
        }],
        level: 0,
        type: "leaf",
      },
    });
    const extentInspection = TEST_ONLY.inspectPayload({
      bytes: extentBytes,
      pageIsRoot: true,
      recordKind: kinds.file_extent_page,
    });
    expect(extentInspection).toMatchObject({
      navigationReferences: [{
        frameLength: 192,
        homeOffset: "512",
        homeSegmentId: "00000000000000000000000000000032",
        recordKind: kinds.file_data,
        role: "file_data",
        targetType: "home_record",
      }],
    });
    expect(extentInspection).toMatchObject({
      decodedPayload: {
        entries: [{
          byteLength: 32,
          dataOffset: 4,
          fileDataHomeRef: fileData,
          fileOffset: createFileOffset({ value: 0n }),
        }],
        level: 0,
        type: "leaf",
      },
    });
  });

  it("projects relocation child and mapped physical references", () => {
    const kinds = HIZOFS_V1_FORMAT_CONSTANTS.recordKinds;
    const child = physicalReference({
      frameLength: 176,
      offset: 640n,
      recordKind: kinds.relocation_index_page,
      segmentId: "00000000000000000000000000000041",
    });
    const branchBytes = encodeRelocationIndexPage({
      isRoot: true,
      page: {
        entries: [{
          childPagePhysicalRef: child,
          upperBound: {
            homeOffset: createUInt64({ value: 1024n }),
            homeSegmentId: parseSegmentIdLowercaseHex({ value: "00000000000000000000000000000042" }),
          },
        }],
        level: 1,
        type: "branch",
      },
    });
    const branchInspection = TEST_ONLY.inspectPayload({
      bytes: branchBytes,
      pageIsRoot: true,
      recordKind: kinds.relocation_index_page,
    });
    expect(branchInspection).toMatchObject({
      navigationReferences: [{
        frameLength: 176,
        pageIsRoot: false,
        physicalOffset: "640",
        physicalSegmentId: "00000000000000000000000000000041",
        recordKind: kinds.relocation_index_page,
        role: "relocation_child_page",
        targetType: "physical_record",
      }],
    });
    expect(branchInspection).toMatchObject({
      decodedPayload: {
        entries: [{
          childPagePhysicalRef: child,
          upperBound: {
            homeOffset: createUInt64({ value: 1024n }),
            homeSegmentId: parseSegmentIdLowercaseHex({ value: "00000000000000000000000000000042" }),
          },
        }],
        level: 1,
        type: "branch",
      },
    });

    const mapped = physicalReference({
      frameLength: 208,
      offset: 768n,
      recordKind: kinds.file_data,
      segmentId: "00000000000000000000000000000043",
    });
    const leafBytes = encodeRelocationIndexPage({
      isRoot: true,
      page: {
        entries: [{
          currentPhysicalRecordRef: mapped,
          homeOffset: createUInt64({ value: 896n }),
          homeSegmentId: parseSegmentIdLowercaseHex({ value: "00000000000000000000000000000044" }),
        }],
        level: 0,
        type: "leaf",
      },
    });
    const leafInspection = TEST_ONLY.inspectPayload({
      bytes: leafBytes,
      pageIsRoot: true,
      recordKind: kinds.relocation_index_page,
    });
    expect(leafInspection).toMatchObject({
      navigationReferences: [{
        frameLength: 208,
        homeOffset: "896",
        homeSegmentId: "00000000000000000000000000000044",
        physicalOffset: "768",
        physicalSegmentId: "00000000000000000000000000000043",
        recordKind: kinds.file_data,
        role: "relocated_record",
        targetType: "physical_record",
      }],
    });
    expect(leafInspection).toMatchObject({
      decodedPayload: {
        entries: [{
          currentPhysicalRecordRef: mapped,
          homeOffset: createUInt64({ value: 896n }),
          homeSegmentId: parseSegmentIdLowercaseHex({ value: "00000000000000000000000000000044" }),
        }],
        level: 0,
        type: "leaf",
      },
    });
  });

  it("projects tree roots embedded in Inode and nested Subvolume leaf entries", () => {
    const kinds = HIZOFS_V1_FORMAT_CONSTANTS.recordKinds;
    const directoryTreeRoot = homeReference({
      frameLength: 224,
      offset: 1152n,
      recordKind: kinds.directory_page,
      segmentId: "00000000000000000000000000000051",
    });
    const extentTreeRoot = homeReference({
      frameLength: 240,
      offset: 1280n,
      recordKind: kinds.file_extent_page,
      segmentId: "00000000000000000000000000000052",
    });
    const inodeBytes = encodeInodeLeafPage({
      entries: [
        {
          content: { directoryTreeRootHomeRef: directoryTreeRoot, type: "tree" },
          inodeKind: "directory",
          inodeNumber: createInodeNumber({ value: 2n }),
          inodeRevision: createInodeRevision({ value: 1n }),
          timestamps: { createdAt: null, modifiedAt: null },
        },
        {
          content: { extentTreeRootHomeRef: extentTreeRoot, type: "tree" },
          fileSize: createFileOffset({ value: 64n }),
          inodeKind: "file",
          inodeNumber: createInodeNumber({ value: 3n }),
          inodeRevision: createInodeRevision({ value: 1n }),
          timestamps: { createdAt: null, modifiedAt: null },
        },
      ],
      isRoot: true,
    });
    const inodeInspection = TEST_ONLY.inspectPayload({
      bytes: inodeBytes,
      pageIsRoot: true,
      recordKind: kinds.inode_table_page,
    });
    expect(inodeInspection).toMatchObject({
      navigationReferences: [
        {
          frameLength: 224,
          homeOffset: "1152",
          homeSegmentId: "00000000000000000000000000000051",
          pageIsRoot: true,
          recordKind: kinds.directory_page,
          role: "directory_tree_root",
          targetType: "home_record",
        },
        {
          frameLength: 240,
          homeOffset: "1280",
          homeSegmentId: "00000000000000000000000000000052",
          pageIsRoot: true,
          recordKind: kinds.file_extent_page,
          role: "file_extent_tree_root",
          targetType: "home_record",
        },
      ],
    });
    expect(inodeInspection).toMatchObject({
      decodedPayload: {
        entries: [
          {
            content: { directoryTreeRootHomeRef: directoryTreeRoot, type: "tree" },
            inodeKind: "directory",
            inodeNumber: createInodeNumber({ value: 2n }),
            inodeRevision: createInodeRevision({ value: 1n }),
            timestamps: { createdAt: null, modifiedAt: null },
          },
          {
            content: { extentTreeRootHomeRef: extentTreeRoot, type: "tree" },
            fileSize: createFileOffset({ value: 64n }),
            inodeKind: "file",
            inodeNumber: createInodeNumber({ value: 3n }),
            inodeRevision: createInodeRevision({ value: 1n }),
            timestamps: { createdAt: null, modifiedAt: null },
          },
        ],
        level: 0,
        type: "leaf",
      },
    });

    const subvolumeInodeTable = homeReference({
      frameLength: 256,
      offset: 1408n,
      recordKind: kinds.inode_table_page,
      segmentId: "00000000000000000000000000000053",
    });
    const subvolumeBytes = encodeNestedSubvolumeLeafPage({
      entries: [{
        access: "read",
        entryName: "archive",
        inodeTableRootHomeRef: subvolumeInodeTable,
        parentDirectoryInodeNumber: createInodeNumber({ value: 1n }),
        parentSubvolumeId: createSubvolumeId({ value: 1n }),
        rootDirectoryInodeNumber: createInodeNumber({ value: 4n }),
        subvolumeId: createSubvolumeId({ value: 2n }),
      }],
      isRoot: true,
    });
    const subvolumeInspection = TEST_ONLY.inspectPayload({
      bytes: subvolumeBytes,
      pageIsRoot: true,
      recordKind: kinds.nested_subvolume_table_page,
    });
    expect(subvolumeInspection).toMatchObject({
      navigationReferences: [{
        frameLength: 256,
        homeOffset: "1408",
        homeSegmentId: "00000000000000000000000000000053",
        pageIsRoot: true,
        recordKind: kinds.inode_table_page,
        role: "subvolume_inode_table_root",
        targetType: "home_record",
      }],
    });
    expect(subvolumeInspection).toMatchObject({
      decodedPayload: {
        entries: [{
          access: "read",
          entryName: "archive",
          inodeTableRootHomeRef: subvolumeInodeTable,
          parentDirectoryInodeNumber: createInodeNumber({ value: 1n }),
          parentSubvolumeId: createSubvolumeId({ value: 1n }),
          rootDirectoryInodeNumber: createInodeNumber({ value: 4n }),
          subvolumeId: createSubvolumeId({ value: 2n }),
        }],
        level: 0,
        type: "leaf",
      },
    });
  });

  it("keeps File Data content bounded instead of retaining the full payload DTO", () => {
    const kinds = HIZOFS_V1_FORMAT_CONSTANTS.recordKinds;
    const inspection = TEST_ONLY.inspectPayload({
      bytes: Uint8Array.of(1, 2, 3, 4),
      pageIsRoot: undefined,
      recordKind: kinds.file_data,
    });

    expect(inspection).toEqual({
      byteLength: 4,
      kind: "file_data",
      state: "decoded",
    });
    expect("decodedPayload" in inspection).toBe(false);
  });
});
