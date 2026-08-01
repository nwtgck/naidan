import { describe, expect, it } from "vitest";
import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createCommitSequence,
  createFileOffset,
  createFileSystemCommitPayload,
  createHomeRecordReference,
  createInodeNumber,
  createInodeRevision,
  createSubvolumeId,
  createUInt64,
  encodeFileDataPayload,
  encodeFileExtentPage,
  encodeHomeRecordReference,
  encodeInodeLeafPage,
  parseMutationId,
  parseSegmentId,
  type HomeRecordReference,
} from "@/00-storage/service/hizofs/00-format";
import {
  type AuthenticatedNamespaceRecordSource,
} from "@/00-storage/service/hizofs/authenticated-store/namespace-record-source";
import { createAuthenticatedReadOnlyNamespace } from "@/00-storage/service/hizofs/filesystem/authenticated-read-only-namespace";

const KINDS = HIZOFS_V1_FORMAT_CONSTANTS.recordKinds;

function reference({ kind, offset }: { kind: number; offset: bigint }): HomeRecordReference {
  return createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: offset }),
    frameLength: 256,
    recordKind: kind,
    segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(Number(offset % 251n) + 1) }),
  } });
}

function referenceIdentity({ reference: value }: { reference: HomeRecordReference }): string {
  return [...encodeHomeRecordReference({ reference: value })]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

describe("authenticated read-only HizoFS namespace", () => {
  it("reads an authenticated extent range across File Data payload offsets", async () => {
    const inodeRoot = reference({ kind: KINDS.inode_table_page, offset: 64n });
    const extentRoot = reference({ kind: KINDS.file_extent_page, offset: 320n });
    const dataA = reference({ kind: KINDS.file_data, offset: 576n });
    const dataB = reference({ kind: KINDS.file_data, offset: 832n });
    const fileNumber = createInodeNumber({ value: 2n });
    const inodeBytes = encodeInodeLeafPage({
      isRoot: true,
      entries: [
        {
          content: {
            entries: [{
              inodeKind: "file",
              inodeNumber: fileNumber,
              name: "data.bin",
              targetType: "inode",
            }],
            type: "inline",
          },
          inodeKind: "directory",
          inodeNumber: createInodeNumber({ value: 1n }),
          inodeRevision: createInodeRevision({ value: 1n }),
          timestamps: { createdAt: null, modifiedAt: null },
        },
        {
          content: { extentTreeRootHomeRef: extentRoot, type: "tree" },
          fileSize: createFileOffset({ value: 8n }),
          inodeKind: "file",
          inodeNumber: fileNumber,
          inodeRevision: createInodeRevision({ value: 1n }),
          timestamps: { createdAt: null, modifiedAt: null },
        },
      ],
    });
    const extentBytes = encodeFileExtentPage({
      isRoot: true,
      page: {
        entries: [
          {
            byteLength: 4,
            dataOffset: 1,
            fileDataHomeRef: dataA,
            fileOffset: createFileOffset({ value: 0n }),
          },
          {
            byteLength: 4,
            dataOffset: 2,
            fileDataHomeRef: dataB,
            fileOffset: createFileOffset({ value: 4n }),
          },
        ],
        level: 0,
        type: "leaf",
      },
    });
    const records = new Map<string, Readonly<{ plaintext: Uint8Array; recordKind: number }>>([
      [referenceIdentity({ reference: inodeRoot }), { plaintext: inodeBytes, recordKind: KINDS.inode_table_page }],
      [referenceIdentity({ reference: extentRoot }), { plaintext: extentBytes, recordKind: KINDS.file_extent_page }],
      [referenceIdentity({ reference: dataA }), {
        plaintext: encodeFileDataPayload({ payload: { bytes: new Uint8Array([90, 1, 2, 3, 4, 91]) } }),
        recordKind: KINDS.file_data,
      }],
      [referenceIdentity({ reference: dataB }), {
        plaintext: encodeFileDataPayload({ payload: { bytes: new Uint8Array([80, 81, 5, 6, 7, 8, 82]) } }),
        recordKind: KINDS.file_data,
      }],
    ]);
    const recordSource: AuthenticatedNamespaceRecordSource = {
      decodeRecordPayload: ({ decode }) => decode(),
      readHomeRecord: async ({ reference: value }) => {
        const record = records.get(referenceIdentity({ reference: value }));
        if (record === undefined) throw new Error("missing record fixture");
        return { plaintext: Uint8Array.from(record.plaintext), recordKind: record.recordKind };
      },
    };
    const namespace = createAuthenticatedReadOnlyNamespace({
      commit: createFileSystemCommitPayload({ payload: {
        commitSequence: createCommitSequence({ value: 1n }),
        mutationId: parseMutationId({ bytes: new Uint8Array(16).fill(7) }),
        nestedSubvolumeTableRootHomeRef: null,
        nextInodeNumber: createInodeNumber({ value: 3n }),
        nextSubvolumeId: createSubvolumeId({ value: 2n }),
        rootDirectoryInodeNumber: createInodeNumber({ value: 1n }),
        rootInodeTableRootHomeRef: inodeRoot,
      } }),
      recordSource,
    });

    expect(await namespace.readFile({
      length: 6n,
      offset: 1n,
      pathComponents: ["data.bin"],
    })).toEqual(new Uint8Array([2, 3, 4, 5, 6, 7]));
  });

  it("reads leading and trailing sparse holes as zero-filled bytes", async () => {
    const inodeRoot = reference({ kind: KINDS.inode_table_page, offset: 64n });
    const extentRoot = reference({ kind: KINDS.file_extent_page, offset: 320n });
    const data = reference({ kind: KINDS.file_data, offset: 576n });
    const fileNumber = createInodeNumber({ value: 2n });
    const records = new Map<string, Readonly<{ plaintext: Uint8Array; recordKind: number }>>([
      [referenceIdentity({ reference: inodeRoot }), {
        plaintext: encodeInodeLeafPage({ isRoot: true,
          entries: [
            {
              content: { entries: [{ inodeKind: "file", inodeNumber: fileNumber, name: "hole.bin", targetType: "inode" }], type: "inline" },
              inodeKind: "directory",
              inodeNumber: createInodeNumber({ value: 1n }),
              inodeRevision: createInodeRevision({ value: 1n }),
              timestamps: { createdAt: null, modifiedAt: null },
            },
            {
              content: { extentTreeRootHomeRef: extentRoot, type: "tree" },
              fileSize: createFileOffset({ value: 10n }),
              inodeKind: "file",
              inodeNumber: fileNumber,
              inodeRevision: createInodeRevision({ value: 1n }),
              timestamps: { createdAt: null, modifiedAt: null },
            },
          ],
        }),
        recordKind: KINDS.inode_table_page,
      }],
      [referenceIdentity({ reference: extentRoot }), {
        plaintext: encodeFileExtentPage({ isRoot: true, page: {
          entries: [{ byteLength: 4, dataOffset: 0, fileDataHomeRef: data, fileOffset: createFileOffset({ value: 4n }) }],
          level: 0,
          type: "leaf",
        } }),
        recordKind: KINDS.file_extent_page,
      }],
      [referenceIdentity({ reference: data }), {
        plaintext: encodeFileDataPayload({ payload: { bytes: new Uint8Array([4, 5, 6, 7]) } }),
        recordKind: KINDS.file_data,
      }],
    ]);
    const namespace = createAuthenticatedReadOnlyNamespace({
      commit: createFileSystemCommitPayload({ payload: {
        commitSequence: createCommitSequence({ value: 1n }),
        mutationId: parseMutationId({ bytes: new Uint8Array(16).fill(8) }),
        nestedSubvolumeTableRootHomeRef: null,
        nextInodeNumber: createInodeNumber({ value: 3n }),
        nextSubvolumeId: createSubvolumeId({ value: 2n }),
        rootDirectoryInodeNumber: createInodeNumber({ value: 1n }),
        rootInodeTableRootHomeRef: inodeRoot,
      } }),
      recordSource: {
        decodeRecordPayload: ({ decode }) => decode(),
        readHomeRecord: async ({ reference: value }) => {
          const record = records.get(referenceIdentity({ reference: value }));
          if (record === undefined) throw new Error("missing record fixture");
          return { plaintext: Uint8Array.from(record.plaintext), recordKind: record.recordKind };
        },
      },
    });

    expect(await namespace.readFile({ length: 10n, offset: 0n, pathComponents: ["hole.bin"] }))
      .toEqual(new Uint8Array([0, 0, 0, 0, 4, 5, 6, 7, 0, 0]));
    expect(await namespace.readFile({ length: 7n, offset: 3n, pathComponents: ["hole.bin"] }))
      .toEqual(new Uint8Array([0, 4, 5, 6, 7, 0, 0]));
  });
});

export const TEST_ONLY = {};
