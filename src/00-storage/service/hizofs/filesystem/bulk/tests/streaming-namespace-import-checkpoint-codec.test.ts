import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createFileOffset,
  createHomeRecordReference,
  createInodeNumber,
  createInodeRevision,
  createTimestampMilliseconds,
  createUInt64,
  encodeHomeRecordReference,
  parseSegmentId,
  type HomeRecordReference,
} from "@/00-storage/service/hizofs/00-format";
import {
  decodeStreamingNamespaceImportJournalCandidate,
  encodeStreamingNamespaceImportJournalCandidate,
  STREAMING_NAMESPACE_IMPORT_CHECKPOINT_CODEC,
} from "@/00-storage/service/hizofs/filesystem/bulk/streaming-namespace-import-checkpoint-codec";
import type { StreamingNamespaceImportJournalCandidate } from "@/00-storage/service/hizofs/filesystem/bulk/streaming-namespace-import-journal";
import { describe, expect, it } from "vitest";

function reference({ kind, offset }: { kind: number; offset: bigint }): HomeRecordReference {
  return createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: offset }),
    frameLength: 96,
    recordKind: kind,
    segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(Number(offset % 251n) + 1) }),
  } });
}

function activeCandidate(): StreamingNamespaceImportJournalCandidate {
  return {
    checkpoint: {
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
    },
    type: "active",
  };
}

function sealedCandidate(): StreamingNamespaceImportJournalCandidate {
  return {
    sealed: {
      nextInodeNumber: createInodeNumber({ value: 8n }),
      rootDirectoryInodeNumber: createInodeNumber({ value: 1n }),
      rootInodeTableRootHomeRef: reference({
        kind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
        offset: 640n,
      }),
    },
    type: "sealed",
  };
}

function referenceBytes({ reference: value }: { reference: HomeRecordReference }): readonly number[] {
  return [...encodeHomeRecordReference({ reference: value })];
}

describe("streaming namespace import checkpoint codec", () => {
  it("round-trips an active bounded candidate with Unicode paths and exact absence", () => {
    const source = activeCandidate();
    const bytes = encodeStreamingNamespaceImportJournalCandidate({ candidate: source });
    const decoded = decodeStreamingNamespaceImportJournalCandidate({ bytes });

    expect(decoded.type).toBe("active");
    if (decoded.type !== "active" || source.type !== "active") throw new Error("expected active candidates");
    expect(decoded.checkpoint.activeFile?.path).toEqual(["日本語", "large.bin"]);
    expect(decoded.checkpoint.activeFile?.file.nextOffset).toBe(131_075n);
    expect(decoded.checkpoint.directories[0]?.directory.timestamps).toEqual({ createdAt: null, modifiedAt: -5n });
    expect(decoded.checkpoint.directories[1]?.directory.timestamps).toEqual({ createdAt: 10n, modifiedAt: null });
    expect(referenceBytes({ reference: decoded.checkpoint.rootInodeTableRootHomeRef }))
      .toEqual(referenceBytes({ reference: source.checkpoint.rootInodeTableRootHomeRef }));
    expect(encodeStreamingNamespaceImportJournalCandidate({ candidate: decoded })).toEqual(bytes);
  });

  it("round-trips a sealed private root without publishing it", () => {
    const source = sealedCandidate();
    const bytes = encodeStreamingNamespaceImportJournalCandidate({ candidate: source });
    const decoded = decodeStreamingNamespaceImportJournalCandidate({ bytes });

    expect(decoded.type).toBe("sealed");
    if (decoded.type !== "sealed" || source.type !== "sealed") throw new Error("expected sealed candidates");
    expect(decoded.sealed.nextInodeNumber).toBe(8n);
    expect(referenceBytes({ reference: decoded.sealed.rootInodeTableRootHomeRef }))
      .toEqual(referenceBytes({ reference: source.sealed.rootInodeTableRootHomeRef }));
  });

  it("rejects non-canonical bytes and wrong reference kinds", () => {
    const canonical = new TextDecoder().decode(encodeStreamingNamespaceImportJournalCandidate({ candidate: sealedCandidate() }));
    expect(() => decodeStreamingNamespaceImportJournalCandidate({
      bytes: new TextEncoder().encode(canonical.replace("\n", "\n\n")),
    })).toThrow("exactly one LF");

    const wrongReference = reference({ kind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.directory_page, offset: 768n });
    const source = sealedCandidate();
    if (source.type !== "sealed") throw new Error("expected sealed candidate");
    expect(() => encodeStreamingNamespaceImportJournalCandidate({ candidate: {
      sealed: { ...source.sealed, rootInodeTableRootHomeRef: wrongReference },
      type: "sealed",
    } })).not.toThrow();
    const wrongBytes = encodeStreamingNamespaceImportJournalCandidate({ candidate: {
      sealed: { ...source.sealed, rootInodeTableRootHomeRef: wrongReference },
      type: "sealed",
    } });
    expect(() => decodeStreamingNamespaceImportJournalCandidate({ bytes: wrongBytes })).toThrow("wrong record kind");
  });

  it("rejects an active file outside the active directory stack", () => {
    const source = activeCandidate();
    if (source.type !== "active") throw new Error("expected active candidate");
    expect(() => encodeStreamingNamespaceImportJournalCandidate({ candidate: {
      checkpoint: {
        ...source.checkpoint,
        activeFile: source.checkpoint.activeFile === undefined
          ? undefined
          : { ...source.checkpoint.activeFile, path: ["different", "large.bin"] },
      },
      type: "active",
    } })).toThrow("not owned by the current directory frame");
  });

  it("publishes explicit bounded codec constants", () => {
    expect(STREAMING_NAMESPACE_IMPORT_CHECKPOINT_CODEC).toMatchObject({
      format: "hizofs-streaming-namespace-import",
      formatVersion: 1,
      limits: { bytes: 6 * 1024 * 1024, jsonDepth: 32 },
    });
  });
});
