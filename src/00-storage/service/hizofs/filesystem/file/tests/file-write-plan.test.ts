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
import { prepareFileWritePlan } from "@/00-storage/service/hizofs/filesystem/file/file-write-plan";

const extentRoot = createHomeRecordReference({ fields: {
  byteOffset: createUInt64({ value: 64n }),
  frameLength: 96,
  recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_extent_page,
  segmentId: parseSegmentId({ bytes: Uint8Array.from({ length: 16 }, (_, index) => index + 1) }),
} });

function inlineFile({
  bytes = [1, 2, 3, 4],
  fileSize = BigInt(bytes.length),
  revision = 7n,
}: Readonly<{
  bytes?: readonly number[];
  fileSize?: bigint;
  revision?: bigint;
}> = {}): FileInodeEntry {
  return {
    content: { bytes: Uint8Array.from(bytes), type: "inline" },
    fileSize: createFileOffset({ value: fileSize }),
    inodeKind: "file",
    inodeNumber: createInodeNumber({ value: 11n }),
    inodeRevision: createInodeRevision({ value: revision }),
    timestamps: {
      createdAt: createTimestampMilliseconds({ value: 10n }),
      modifiedAt: createTimestampMilliseconds({ value: 20n }),
    },
  };
}

function extentFile({ fileSize = 100n, revision = 7n }: {
  fileSize?: bigint;
  revision?: bigint;
} = {}): FileInodeEntry {
  return {
    content: { extentTreeRootHomeRef: extentRoot, type: "tree" },
    fileSize: createFileOffset({ value: fileSize }),
    inodeKind: "file",
    inodeNumber: createInodeNumber({ value: 11n }),
    inodeRevision: createInodeRevision({ value: revision }),
    timestamps: inlineFile().timestamps,
  };
}

function errorCode(parameters: Parameters<typeof prepareFileWritePlan>[0]): string | undefined {
  try {
    prepareFileWritePlan(parameters);
    return undefined;
  } catch (error: unknown) {
    return error instanceof Error && "code" in error ? String(error.code) : undefined;
  }
}

const operationTimestamp = createTimestampMilliseconds({ value: 30n });

describe("File write plan", () => {
  it("overwrites an inline range without changing the source buffer", () => {
    const source = inlineFile();
    const plan = prepareFileWritePlan({
      bytes: Uint8Array.from([9, 8]),
      operationTimestamp,
      position: createFileOffset({ value: 1n }),
      source,
    });
    expect(plan).toMatchObject({ action: "write_inline", nextInodeRevision: 8n, targetFileSize: 4n });
    if (plan?.action !== "write_inline") throw new Error("Expected inline write plan");
    expect([...plan.bytes]).toEqual([1, 9, 8, 4]);
    expect([...source.content.type === "inline" ? source.content.bytes : []]).toEqual([1, 2, 3, 4]);
    expect(plan.timestamps).toEqual({ createdAt: 10n, modifiedAt: 30n });
  });

  it("appends and materializes a bounded inline sparse hole as zeros", () => {
    const appended = prepareFileWritePlan({
      bytes: Uint8Array.from([5, 6]),
      operationTimestamp,
      position: "append",
      source: inlineFile(),
    });
    expect(appended?.action).toBe("write_inline");
    if (appended?.action !== "write_inline") throw new Error("Expected inline append plan");
    expect([...appended.bytes]).toEqual([1, 2, 3, 4, 5, 6]);

    const sparse = prepareFileWritePlan({
      bytes: Uint8Array.from([7]),
      operationTimestamp,
      position: createFileOffset({ value: 7n }),
      source: inlineFile(),
    });
    if (sparse?.action !== "write_inline") throw new Error("Expected bounded inline sparse plan");
    expect([...sparse.bytes]).toEqual([1, 2, 3, 4, 0, 0, 0, 7]);
  });

  it("promotes an oversized inline result without allocating the sparse target size", () => {
    const writeBytes = Uint8Array.from([9, 8]);
    const position = createFileOffset({
      value: BigInt(HIZOFS_V1_FORMAT_CONSTANTS.limits.inlineFileBytes) + 100n,
    });
    const plan = prepareFileWritePlan({ bytes: writeBytes, operationTimestamp, position, source: inlineFile() });
    expect(plan).toMatchObject({
      action: "promote_inline_to_extent",
      targetFileSize: position + 2n,
      writeOffset: position,
    });
    if (plan?.action !== "promote_inline_to_extent") throw new Error("Expected promotion plan");
    expect([...plan.sourceInlineBytes]).toEqual([1, 2, 3, 4]);
    expect([...plan.writeBytes]).toEqual([9, 8]);
    expect(plan.writeBytes).not.toBe(writeBytes);
  });

  it("plans extent writes as Copy-on-Write and never shrinks on overwrite", () => {
    const plan = prepareFileWritePlan({
      bytes: Uint8Array.from([1, 2, 3]),
      operationTimestamp,
      position: createFileOffset({ value: 10n }),
      source: extentFile({ fileSize: 100n }),
    });
    expect(plan).toMatchObject({
      action: "copy_on_write_extent_range",
      sourceExtentTreeRootHomeRef: extentRoot,
      targetFileSize: 100n,
      writeOffset: 10n,
    });
  });

  it("extends an extent file sparsely without materializing the hole", () => {
    const plan = prepareFileWritePlan({
      bytes: Uint8Array.from([4]),
      operationTimestamp,
      position: createFileOffset({ value: 1_000n }),
      source: extentFile({ fileSize: 100n }),
    });
    expect(plan).toMatchObject({
      action: "copy_on_write_extent_range",
      targetFileSize: 1_001n,
      writeOffset: 1_000n,
    });
  });

  it("treats an empty write as a no-op", () => {
    expect(prepareFileWritePlan({
      bytes: new Uint8Array(),
      operationTimestamp,
      position: "append",
      source: inlineFile(),
    })).toBeNull();
  });

  it("rejects file-size overflow and exhausted inode revisions", () => {
    expect(errorCode({
      bytes: Uint8Array.from([1, 2]),
      operationTimestamp,
      position: createFileOffset({ value: UINT64_MAXIMUM }),
      source: extentFile(),
    })).toBe("file_size_overflow");
    expect(errorCode({
      bytes: Uint8Array.from([1]),
      operationTimestamp,
      position: "append",
      source: inlineFile({ revision: UINT64_MAXIMUM }),
    })).toBe("revision_exhausted");
  });

  it("rejects an inconsistent inline inode instead of normalizing it silently", () => {
    expect(errorCode({
      bytes: Uint8Array.from([1]),
      operationTimestamp,
      position: "append",
      source: inlineFile({ bytes: [1, 2], fileSize: 3n }),
    })).toBe("invalid_inline_state");
  });
});
