import { describe, expect, it } from "vitest";
import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createCommitSequence,
  createFileOffset,
  createHomeRecordReference,
  createInodeNumber,
  createPhysicalRecordReference,
  createSubvolumeId,
  createUInt64,
  parseMutationId,
  parseSegmentIdLowercaseHex,
  type FileSystemCommitPayload,
  type FileExtentPage,
  type RelocationIndexPage,
} from "@/00-storage/service/hizofs/00-format";
import type { HizoFSPhysicalRecordInspection } from "@/00-storage/service/hizofs/inspection";
import { createHizoFSPhysicalRecordInspectionView } from "./physical-record-inspection-view";
import { stringifyPersistedAuditValue } from "./persisted-audit-json";

function homeReference({ frameLength, offset, recordKind, segmentId }: {
  frameLength: number;
  offset: bigint;
  recordKind: number;
  segmentId: string;
}) {
  return createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: offset }),
    frameLength,
    recordKind,
    segmentId: parseSegmentIdLowercaseHex({ value: segmentId }),
  } });
}

function physicalReference({ frameLength, offset, recordKind, segmentId }: {
  frameLength: number;
  offset: bigint;
  recordKind: number;
  segmentId: string;
}) {
  return createPhysicalRecordReference({ fields: {
    byteOffset: createUInt64({ value: offset }),
    frameLength,
    recordKind,
    segmentId: parseSegmentIdLowercaseHex({ value: segmentId }),
  } });
}

function commitDecodedPayload(): FileSystemCommitPayload {
  const kinds = HIZOFS_V1_FORMAT_CONSTANTS.recordKinds;
  return {
    commitSequence: createCommitSequence({ value: 4n }),
    mutationId: parseMutationId({ bytes: Uint8Array.from({ length: 16 }, (_value, index) => index) }),
    nestedSubvolumeTableRootHomeRef: homeReference({
      frameLength: 160,
      offset: 256n,
      recordKind: kinds.nested_subvolume_table_page,
      segmentId: "00000000000000000000000000000004",
    }),
    nextInodeNumber: createInodeNumber({ value: 8n }),
    nextSubvolumeId: createSubvolumeId({ value: 3n }),
    rootDirectoryInodeNumber: createInodeNumber({ value: 1n }),
    rootInodeTableRootHomeRef: homeReference({
      frameLength: 128,
      offset: 128n,
      recordKind: kinds.inode_table_page,
      segmentId: "00000000000000000000000000000003",
    }),
  };
}

function commitInspection(): HizoFSPhysicalRecordInspection {
  const kinds = HIZOFS_V1_FORMAT_CONSTANTS.recordKinds;
  const decodedPayload = commitDecodedPayload();
  return {
    frameLength: 200,
    header: {
      flags: 0,
      frameLength: 200,
      homeOffset: createUInt64({ value: 64n }),
      homeSegmentId: parseSegmentIdLowercaseHex({ value: "00000000000000000000000000000001" }),
      nonce: new Uint8Array(12),
      plaintextLength: 112,
      recordCodecVersion: 1,
      recordKind: kinds.file_system_commit,
      sealedLength: 128,
    },
    headerFlags: 0,
    homeOffset: "64",
    homeSegmentId: "00000000000000000000000000000001",
    physicalOffset: "96",
    physicalSegmentId: "00000000000000000000000000000002",
    plaintextByteLength: 112,
    plaintextPreviewBase64Url: "",
    plaintextPreviewByteLength: 112,
    plaintextPreviewTruncated: false,
    payload: {
      commitSequence: "4",
      decodedPayload,
      navigationReferences: [
        {
          frameLength: 128,
          homeOffset: "128",
          homeSegmentId: "00000000000000000000000000000003",
          pageIsRoot: true,
          recordKind: kinds.inode_table_page,
          role: "root_inode_table_root",
          targetType: "home_record",
        },
        {
          frameLength: 160,
          homeOffset: "256",
          homeSegmentId: "00000000000000000000000000000004",
          pageIsRoot: true,
          recordKind: kinds.nested_subvolume_table_page,
          role: "nested_subvolume_table_root",
          targetType: "home_record",
        },
      ],
      kind: "file_system_commit",
      nextInodeNumber: "8",
      nextSubvolumeId: "3",
      rootDirectoryInodeNumber: "1",
      state: "decoded",
    },
    recordKind: kinds.file_system_commit,
    recordKindName: "file_system_commit",
    sealedLength: 128,
  };
}

describe("HizoFS physical record inspection view", () => {
  it("preserves Commit home references and exact decoded DTO", () => {
    const inspection = commitInspection();
    expect(createHizoFSPhysicalRecordInspectionView({ inspection })).toEqual({
      frameLength: 200,
      header: inspection.header,
      headerFlags: 0,
      headerJson: expect.stringContaining('"recordKind"'),
      homeOffset: "64",
      homeSegmentId: "00000000000000000000000000000001",
      identitySummary: "home 00000000000000000000000000000001:64; physical 00000000000000000000000000000002:96",
      navigationTargets: [
        {
          label: "Root Inode Table",
          targetType: "home_record",
          request: {
            frameLength: 128,
            homeOffset: "128",
            homeSegmentId: "00000000000000000000000000000003",
            pageIsRoot: true,
            recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
          },
        },
        {
          label: "Nested Subvolume Table",
          targetType: "home_record",
          request: {
            frameLength: 160,
            homeOffset: "256",
            homeSegmentId: "00000000000000000000000000000004",
            pageIsRoot: true,
            recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.nested_subvolume_table_page,
          },
        },
      ],
      payload: inspection.payload,
      payloadDocumentLabel: "Exact decoded structural payload DTO",
      payloadJson: stringifyPersistedAuditValue({ value: commitDecodedPayload() }),
      payloadSummary: "Commit 4, root inode 1, next inode 8, next Subvolume 3",
      physicalOffset: "96",
      physicalSegmentId: "00000000000000000000000000000002",
      plaintextByteLength: 112,
      plaintextPreviewBase64Url: "",
      plaintextPreviewByteLength: 112,
      plaintextPreviewTruncated: false,
      plaintextSummary: "112/112 bytes previewed",
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
      recordKindName: "file_system_commit",
      sealedLength: 128,
    });
  });

  it("keeps relocation navigation and exact page DTO", () => {
    const kinds = HIZOFS_V1_FORMAT_CONSTANTS.recordKinds;
    const decodedPayload: RelocationIndexPage = {
      entries: [{
        childPagePhysicalRef: physicalReference({
          frameLength: 176,
          offset: 640n,
          recordKind: kinds.relocation_index_page,
          segmentId: "00000000000000000000000000000041",
        }),
        upperBound: {
          homeOffset: createUInt64({ value: 1024n }),
          homeSegmentId: parseSegmentIdLowercaseHex({ value: "00000000000000000000000000000042" }),
        },
      }],
      level: 1,
      type: "branch",
    };
    const inspection: HizoFSPhysicalRecordInspection = {
      ...commitInspection(),
      payload: {
        decodedPayload,
        family: "relocation_index",
        isRoot: true,
        itemCount: 1,
        level: 1,
        navigationReferences: [{
          frameLength: 176,
          pageIsRoot: false,
          physicalOffset: "640",
          physicalSegmentId: "00000000000000000000000000000041",
          recordKind: kinds.relocation_index_page,
          role: "relocation_child_page",
          targetType: "physical_record",
        }],
        pageType: "branch",
        state: "decoded",
      },
      recordKind: kinds.relocation_index_page,
      recordKindName: "relocation_index_page",
    };

    const view = createHizoFSPhysicalRecordInspectionView({ inspection });
    expect(view.navigationTargets).toEqual([{
      label: "Relocation child page 1",
      request: {
        frameLength: 176,
        pageIsRoot: false,
        physicalOffset: "640",
        physicalSegmentId: "00000000000000000000000000000041",
        recordKind: kinds.relocation_index_page,
      },
      targetType: "physical_record",
    }]);
    expect(view.payloadJson).toBe(stringifyPersistedAuditValue({ value: decodedPayload }));
  });

  it("preserves sparse File Extent fields and File Data references without inferred ownership", () => {
    const kinds = HIZOFS_V1_FORMAT_CONSTANTS.recordKinds;
    const firstData = homeReference({
      frameLength: 192,
      offset: 1024n,
      recordKind: kinds.file_data,
      segmentId: "00000000000000000000000000000031",
    });
    const secondData = homeReference({
      frameLength: 208,
      offset: 2048n,
      recordKind: kinds.file_data,
      segmentId: "00000000000000000000000000000032",
    });
    const decodedPayload: FileExtentPage = {
      entries: [
        {
          byteLength: 64,
          dataOffset: 7,
          fileDataHomeRef: firstData,
          fileOffset: createFileOffset({ value: 0n }),
        },
        {
          byteLength: 32,
          dataOffset: 11,
          fileDataHomeRef: secondData,
          fileOffset: createFileOffset({ value: 4096n }),
        },
      ],
      level: 0,
      type: "leaf",
    };
    const inspection: HizoFSPhysicalRecordInspection = {
      ...commitInspection(),
      payload: {
        decodedPayload,
        family: "file_extent",
        isRoot: true,
        itemCount: 2,
        level: 0,
        navigationReferences: [firstData, secondData].map(reference => ({
          frameLength: reference.frameLength,
          homeOffset: String(reference.byteOffset),
          homeSegmentId: reference === firstData
            ? "00000000000000000000000000000031"
            : "00000000000000000000000000000032",
          recordKind: reference.recordKind,
          role: "file_data" as const,
          targetType: "home_record" as const,
        })),
        pageType: "leaf",
        state: "decoded",
      },
      recordKind: kinds.file_extent_page,
      recordKindName: "file_extent_page",
    };

    const view = createHizoFSPhysicalRecordInspectionView({ inspection });
    expect(view.payloadJson).toBe(stringifyPersistedAuditValue({ value: decodedPayload }));
    expect(view.payloadJson).toContain('"fileOffset": "4096"');
    expect(view.payloadJson).toContain('"dataOffset": 11');
    expect(view.payloadJson).toContain('"byteLength": 32');
    expect(view.navigationTargets.map(target => target.label)).toEqual(["File Data 1", "File Data 2"]);
  });
});
