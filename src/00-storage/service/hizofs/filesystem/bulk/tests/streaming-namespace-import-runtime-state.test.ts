import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createFileOffset,
  createHomeRecordReference,
  createInodeNumber,
  createInodeRevision,
  createTimestampMilliseconds,
  createUInt64,
  parseSegmentId,
  type HomeRecordReference,
} from "@/00-storage/service/hizofs/00-format";
import {
  type SealedStreamingNamespaceImport,
  type StreamingNamespaceImportCheckpoint,
  validateSealedStreamingNamespaceImport,
  validateStreamingNamespaceImportCheckpoint,
} from "@/00-storage/service/hizofs/filesystem/bulk/streaming-namespace-import";
import { describe, expect, it } from "vitest";

function reference({ kind, offset }: { kind: number; offset: bigint }): HomeRecordReference {
  return createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: offset }),
    frameLength: 96,
    recordKind: kind,
    segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(Number(offset % 251n) + 1) }),
  } });
}

function activeCheckpoint(): StreamingNamespaceImportCheckpoint {
  return {
    activeFile: {
      file: {
        extentRoot: reference({ kind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_extent_page, offset: 384n }),
        nextOffset: createFileOffset({ value: 131_075n }),
      },
      inodeNumber: createInodeNumber({ value: 3n }),
      path: ["日本語", "large.bin"],
    },
    directories: [
      {
        directory: {
          content: {
            entries: [{
              inodeKind: "directory",
              inodeNumber: createInodeNumber({ value: 2n }),
              name: "日本語",
              targetType: "inode",
            }],
            type: "inline",
          },
          inodeNumber: createInodeNumber({ value: 1n }),
          inodeRevision: createInodeRevision({ value: 1n }),
          previousName: "日本語",
          timestamps: {
            createdAt: null,
            modifiedAt: createTimestampMilliseconds({ value: -5n }),
          },
        },
        path: [],
      },
      {
        directory: {
          content: {
            directoryTreeRootHomeRef: reference({
              kind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.directory_page,
              offset: 512n,
            }),
            type: "tree",
          },
          inodeNumber: createInodeNumber({ value: 2n }),
          inodeRevision: createInodeRevision({ value: 1n }),
          previousName: "large.bin",
          timestamps: {
            createdAt: createTimestampMilliseconds({ value: 10n }),
            modifiedAt: null,
          },
        },
        path: ["日本語"],
      },
    ],
    nextInodeNumber: createInodeNumber({ value: 4n }),
    rootDirectoryInodeNumber: createInodeNumber({ value: 1n }),
    rootInodeTableRootHomeRef: reference({
      kind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
      offset: 128n,
    }),
  };
}

function sealedCandidate(): SealedStreamingNamespaceImport {
  return {
    nextInodeNumber: createInodeNumber({ value: 8n }),
    rootDirectoryInodeNumber: createInodeNumber({ value: 1n }),
    rootInodeTableRootHomeRef: reference({
      kind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
      offset: 640n,
    }),
  };
}

describe("streaming namespace import runtime state validation", () => {
  it("accepts a bounded active checkpoint with Unicode paths and exact metadata", () => {
    const checkpoint = activeCheckpoint();
    expect(() => validateStreamingNamespaceImportCheckpoint({ checkpoint })).not.toThrow();
    expect(checkpoint.activeFile?.file.nextOffset).toBe(131_075n);
    expect(checkpoint.directories[0]?.directory.timestamps)
      .toEqual({ createdAt: null, modifiedAt: -5n });
  });

  it("accepts a sealed private root without turning it into a persistent format", () => {
    const sealed = sealedCandidate();
    expect(() => validateSealedStreamingNamespaceImport({ sealed })).not.toThrow();
    expect(sealed.nextInodeNumber).toBe(8n);
  });

  it("rejects wrong physical reference kinds", () => {
    const sealed = sealedCandidate();
    expect(() => validateSealedStreamingNamespaceImport({ sealed: {
      ...sealed,
      rootInodeTableRootHomeRef: reference({
        kind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.directory_page,
        offset: 768n,
      }),
    } })).toThrow("wrong physical record kind");
  });

  it("rejects an active file outside the active depth-first directory stack", () => {
    const checkpoint = activeCheckpoint();
    expect(() => validateStreamingNamespaceImportCheckpoint({ checkpoint: {
      ...checkpoint,
      activeFile: checkpoint.activeFile === undefined
        ? undefined
        : { ...checkpoint.activeFile, path: ["different", "large.bin"] },
    } })).toThrow("not owned by the current directory");
  });

  it("rejects paths beyond the runtime bound and non-canonical inline entries", () => {
    const checkpoint = activeCheckpoint();
    expect(() => validateStreamingNamespaceImportCheckpoint({ checkpoint: {
      ...checkpoint,
      activeFile: checkpoint.activeFile === undefined
        ? undefined
        : { ...checkpoint.activeFile, path: Array.from({ length: 1_025 }, () => "x") },
    } })).toThrow("component bound");

    const root = checkpoint.directories[0];
    if (root === undefined) throw new Error("expected root frame");
    expect(() => validateStreamingNamespaceImportCheckpoint({ checkpoint: {
      ...checkpoint,
      directories: [{
        ...root,
        directory: {
          ...root.directory,
          content: {
            entries: [
              { inodeKind: "file", inodeNumber: createInodeNumber({ value: 3n }), name: "z", targetType: "inode" },
              { inodeKind: "directory", inodeNumber: createInodeNumber({ value: 2n }), name: "a", targetType: "inode" },
            ],
            type: "inline",
          },
          previousName: "a",
        },
      }, ...checkpoint.directories.slice(1)],
    } })).toThrow("not canonically ordered");
  });

  it("rejects inode identities outside the allocator range", () => {
    const checkpoint = activeCheckpoint();
    expect(() => validateStreamingNamespaceImportCheckpoint({ checkpoint: {
      ...checkpoint,
      activeFile: checkpoint.activeFile === undefined
        ? undefined
        : { ...checkpoint.activeFile, inodeNumber: checkpoint.nextInodeNumber },
    } })).toThrow("outside the allocated range");
  });
});
