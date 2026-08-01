import { describe, expect, it } from "vitest";
import {
  createFileOffset,
  createHomeRecordReference,
  createInodeNumber,
  createInodeRevision,
  createTimestampMilliseconds,
  createUInt64,
  HIZOFS_V1_FORMAT_CONSTANTS,
  parseSegmentId,
  UINT64_MAXIMUM,
  type FileInodeEntry,
} from "@/00-storage/service/hizofs/00-format";
import { prepareFileTruncatePlan } from "@/00-storage/service/hizofs/filesystem/file/file-truncate-plan";

const extentRoot = createHomeRecordReference({ fields: {
  byteOffset: createUInt64({ value: 256n }),
  frameLength: 96,
  recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_extent_page,
  segmentId: parseSegmentId({ bytes: Uint8Array.from({ length: 16 }, (_, index) => index + 70) }),
} });

function inlineFile({
  bytes = Uint8Array.of(1, 2, 3),
  fileSize = BigInt(bytes.byteLength),
  revision = 5n,
}: Readonly<{
  bytes?: Uint8Array;
  fileSize?: bigint;
  revision?: bigint;
}> = {}): FileInodeEntry {
  return {
    content: { bytes, type: "inline" },
    fileSize: createFileOffset({ value: fileSize }),
    inodeKind: "file",
    inodeNumber: createInodeNumber({ value: 9n }),
    inodeRevision: createInodeRevision({ value: revision }),
    timestamps: {
      createdAt: createTimestampMilliseconds({ value: 10n }),
      modifiedAt: createTimestampMilliseconds({ value: 20n }),
    },
  };
}

function extentFile({ fileSize = 8_000n, revision = 2n }: Readonly<{
  fileSize?: bigint;
  revision?: bigint;
}> = {}): FileInodeEntry {
  return {
    content: { extentTreeRootHomeRef: extentRoot, type: "tree" },
    fileSize: createFileOffset({ value: fileSize }),
    inodeKind: "file",
    inodeNumber: createInodeNumber({ value: 10n }),
    inodeRevision: createInodeRevision({ value: revision }),
    timestamps: { createdAt: null, modifiedAt: null },
  };
}

const operationTimestamp = createTimestampMilliseconds({ value: 100n });

describe("file truncate plan", () => {
  it("does not publish a timestamp-only mutation for an unchanged size", () => {
    expect(prepareFileTruncatePlan({
      operationTimestamp,
      source: inlineFile(),
      targetFileSize: createFileOffset({ value: 3n }),
    })).toBeNull();
  });

  it("shrinks inline content and advances only this branch revision", () => {
    const plan = prepareFileTruncatePlan({
      operationTimestamp,
      source: inlineFile(),
      targetFileSize: createFileOffset({ value: 2n }),
    });
    expect(plan).toMatchObject({
      action: "write_inline",
      inodeNumber: 9n,
      nextInodeRevision: 6n,
      targetFileSize: 2n,
      timestamps: { createdAt: 10n, modifiedAt: 100n },
    });
    if (plan?.action !== "write_inline") throw new Error("expected inline truncate plan");
    expect(plan.bytes).toEqual(Uint8Array.of(1, 2));
  });

  it("materializes only a bounded inline zero extension", () => {
    const plan = prepareFileTruncatePlan({
      operationTimestamp,
      source: inlineFile(),
      targetFileSize: createFileOffset({ value: 5n }),
    });
    if (plan?.action !== "write_inline") throw new Error("expected inline extension plan");
    expect(plan.bytes).toEqual(Uint8Array.of(1, 2, 3, 0, 0));
  });

  it("promotes an oversized inline extension without materializing its sparse tail", () => {
    const targetFileSize = BigInt(HIZOFS_V1_FORMAT_CONSTANTS.limits.inlineFileBytes + 1);
    const source = inlineFile();
    const plan = prepareFileTruncatePlan({
      operationTimestamp,
      source,
      targetFileSize: createFileOffset({ value: targetFileSize }),
    });
    expect(plan).toMatchObject({
      action: "promote_inline_to_extent",
      targetFileSize,
    });
    if (plan?.action !== "promote_inline_to_extent" || source.content.type !== "inline") {
      throw new Error("expected inline promotion plan");
    }
    expect(plan.inlinePrefixBytes).toEqual(source.content.bytes);
    expect(plan.inlinePrefixBytes).not.toBe(source.content.bytes);
    expect(plan.inlinePrefixBytes.byteLength).toBe(3);
  });

  it("extends an extent-backed file by reusing the root and leaving an implicit hole", () => {
    const plan = prepareFileTruncatePlan({
      operationTimestamp,
      source: extentFile(),
      targetFileSize: createFileOffset({ value: 9_000n }),
    });
    expect(plan).toMatchObject({
      action: "reuse_extent_tree",
      sourceExtentTreeRootHomeRef: extentRoot,
      targetFileSize: 9_000n,
    });
  });

  it("requires extent trimming on shrink and never auto-demotes small tree files", () => {
    const smallPlan = prepareFileTruncatePlan({
      operationTimestamp,
      source: extentFile(),
      targetFileSize: createFileOffset({ value: 10n }),
    });
    expect(smallPlan).toMatchObject({ action: "trim_extent_tree", targetFileSize: 10n });

    const zeroPlan = prepareFileTruncatePlan({
      operationTimestamp,
      source: extentFile(),
      targetFileSize: createFileOffset({ value: 0n }),
    });
    expect(zeroPlan).toMatchObject({ action: "trim_extent_tree", targetFileSize: 0n });
  });

  it("rejects malformed inline state even when the requested size is unchanged", () => {
    expect(() => prepareFileTruncatePlan({
      operationTimestamp,
      source: inlineFile({ fileSize: 4n }),
      targetFileSize: createFileOffset({ value: 4n }),
    })).toThrowError(expect.objectContaining({ code: "invalid_inline_state" }));
  });

  it("rejects inode revision exhaustion before preparing candidate work", () => {
    expect(() => prepareFileTruncatePlan({
      operationTimestamp,
      source: inlineFile({ revision: UINT64_MAXIMUM }),
      targetFileSize: createFileOffset({ value: 2n }),
    })).toThrowError(expect.objectContaining({ code: "revision_exhausted" }));
  });
});
