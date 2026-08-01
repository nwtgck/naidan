import { describe, expect, it } from "vitest";
import {
  createFileOffset,
  createInodeNumber,
  createInodeRevision,
  createHomeRecordReference,
  createTimestampMilliseconds,
  createUInt64,
  HIZOFS_V1_FORMAT_CONSTANTS,
  parseSegmentId,
  UINT64_MAXIMUM,
} from "@/00-storage/service/hizofs/00-format";
import { ExplicitBulkCandidate } from "@/00-storage/service/hizofs/filesystem/bulk/explicit-bulk-candidate";

function candidate({
  maxEntries = 8,
  maxInlineFileBytesTotal = 32,
  nextInodeNumber = 10n,
}: Readonly<{
  maxEntries?: number;
  maxInlineFileBytesTotal?: number;
  nextInodeNumber?: bigint;
}> = {}) {
  return new ExplicitBulkCandidate({
    limits: { maxEntries, maxInlineFileBytesTotal },
    nextInodeNumber: createInodeNumber({ value: nextInodeNumber }),
    rootDirectory: {
      inodeNumber: createInodeNumber({ value: 1n }),
      inodeRevision: createInodeRevision({ value: 1n }),
      timestamps: {
        createdAt: createTimestampMilliseconds({ value: 1n }),
        modifiedAt: createTimestampMilliseconds({ value: 1n }),
      },
    },
  });
}

function errorCode(operation: () => unknown): string | undefined {
  try {
    operation();
    return undefined;
  } catch (error: unknown) {
    return error instanceof Error && "code" in error ? String(error.code) : undefined;
  }
}

const timestamp = createTimestampMilliseconds({ value: 5n });

const extentRoot = createHomeRecordReference({ fields: {
  byteOffset: createUInt64({ value: 128n }),
  frameLength: 96,
  recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_extent_page,
  segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(1) }),
} });

describe("Explicit bulk candidate", () => {
  it("builds empty files and directories as metadata-only entries in canonical order", () => {
    const builder = candidate();
    builder.createEmptyFile({ name: "z-file", parentDirectoryInodeNumber: createInodeNumber({ value: 1n }), timestamp });
    builder.createDirectory({ name: "a-directory", parentDirectoryInodeNumber: createInodeNumber({ value: 1n }), timestamp });

    const sealed = builder.seal();
    expect(sealed.directories[0]?.entries.map(entry => entry.name)).toEqual(["a-directory", "z-file"]);
    expect(sealed.files).toHaveLength(1);
    expect(sealed.files[0]).toMatchObject({
      content: { bytes: new Uint8Array(), type: "inline" },
      fileSize: 0n,
      inodeRevision: 1n,
    });
    expect(sealed.totalInlineFileBytes).toBe(0);
    expect(sealed.nextInodeNumber).toBe(12n);
    expect(sealed.targetDirectoryInodeNumber).toBe(1n);
  });

  it("allows nested construction only below candidate-owned directories", () => {
    const builder = candidate();
    const child = builder.createDirectory({
      name: "child",
      parentDirectoryInodeNumber: createInodeNumber({ value: 1n }),
      timestamp,
    });
    builder.createEmptyFile({ name: "value", parentDirectoryInodeNumber: child, timestamp });
    const sealed = builder.seal();
    expect(sealed.directories.find(directory => directory.inodeNumber === child)?.entries)
      .toEqual([{ inodeKind: "file", inodeNumber: 11n, name: "value", targetType: "inode" }]);
  });

  it("preserves exact timestamps, absence, symlinks, and extent-backed sparse files", () => {
    const builder = candidate();
    const directory = builder.createDirectoryWithTimestamps({
      name: "exact",
      parentDirectoryInodeNumber: createInodeNumber({ value: 1n }),
      timestamps: {
        createdAt: null,
        modifiedAt: createTimestampMilliseconds({ value: 20n }),
      },
    });
    builder.createFile({
      content: { extentTreeRootHomeRef: extentRoot, type: "tree" },
      fileSize: createFileOffset({ value: 1_000_000n }),
      name: "sparse",
      parentDirectoryInodeNumber: directory,
      timestamps: {
        createdAt: createTimestampMilliseconds({ value: 30n }),
        modifiedAt: null,
      },
    });
    builder.createSymlink({
      name: "link",
      parentDirectoryInodeNumber: directory,
      target: "../target",
      timestamps: { createdAt: null, modifiedAt: null },
    });

    const sealed = builder.seal();
    expect(sealed.directories.find(value => value.inodeNumber === 1n)?.timestamps).toEqual({
      createdAt: 1n,
      modifiedAt: 1n,
    });
    expect(sealed.directories.find(value => value.inodeNumber === directory)?.timestamps).toEqual({
      createdAt: null,
      modifiedAt: 20n,
    });
    expect(sealed.files).toEqual([expect.objectContaining({
      content: { extentTreeRootHomeRef: extentRoot, type: "tree" },
      fileSize: 1_000_000n,
      timestamps: { createdAt: 30n, modifiedAt: null },
    })]);
    expect(sealed.symlinks).toEqual([expect.objectContaining({
      target: "../target",
      timestamps: { createdAt: null, modifiedAt: null },
    })]);
    expect(sealed.totalInlineFileBytes).toBe(0);
  });

  it("validates exact inline size and symlink target contracts", () => {
    const builder = candidate();
    expect(errorCode(() => builder.createFile({
      content: { bytes: Uint8Array.of(1), type: "inline" },
      fileSize: createFileOffset({ value: 2n }),
      name: "bad-size",
      parentDirectoryInodeNumber: createInodeNumber({ value: 1n }),
      timestamps: { createdAt: null, modifiedAt: null },
    }))).toBe("inline_file_size_mismatch");
    expect(() => builder.createSymlink({
      name: "bad-link",
      parentDirectoryInodeNumber: createInodeNumber({ value: 1n }),
      target: "bad\u0000target",
      timestamps: { createdAt: null, modifiedAt: null },
    })).toThrow();
  });

  it("rejects duplicate entries and unknown parent directories", () => {
    const builder = candidate();
    builder.createEmptyFile({ name: "same", parentDirectoryInodeNumber: createInodeNumber({ value: 1n }), timestamp });
    expect(errorCode(() => builder.createDirectory({
      name: "same",
      parentDirectoryInodeNumber: createInodeNumber({ value: 1n }),
      timestamp,
    }))).toBe("duplicate_entry");
    expect(errorCode(() => builder.createEmptyFile({
      name: "orphan",
      parentDirectoryInodeNumber: createInodeNumber({ value: 99n }),
      timestamp,
    }))).toBe("invalid_parent_directory");
  });

  it("enforces an explicit entry budget before mutating the candidate", () => {
    const builder = candidate({ maxEntries: 1 });
    builder.createEmptyFile({ name: "one", parentDirectoryInodeNumber: createInodeNumber({ value: 1n }), timestamp });
    expect(errorCode(() => builder.createEmptyFile({
      name: "two",
      parentDirectoryInodeNumber: createInodeNumber({ value: 1n }),
      timestamp,
    }))).toBe("entry_limit_exceeded");
    expect(builder.seal().files).toHaveLength(1);
  });

  it("bounds copied inline data and clones caller-owned buffers", () => {
    const builder = candidate({ maxInlineFileBytesTotal: 3 });
    const bytes = Uint8Array.from([1, 2, 3]);
    builder.createInlineFile({
      bytes,
      name: "small",
      parentDirectoryInodeNumber: createInodeNumber({ value: 1n }),
      timestamp,
    });
    bytes[0] = 9;
    const sealed = builder.seal();
    expect([...sealed.files[0]?.content.type === "inline" ? sealed.files[0].content.bytes : []])
      .toEqual([1, 2, 3]);
    expect(sealed.totalInlineFileBytes).toBe(3);

    expect(errorCode(() => candidate({ maxInlineFileBytesTotal: 2 }).createInlineFile({
      bytes: Uint8Array.from([1, 2, 3]),
      name: "too-much",
      parentDirectoryInodeNumber: createInodeNumber({ value: 1n }),
      timestamp,
    }))).toBe("inline_byte_limit_exceeded");
    expect(errorCode(() => candidate({
      maxInlineFileBytesTotal: HIZOFS_V1_FORMAT_CONSTANTS.limits.inlineFileBytes + 1,
    }).createInlineFile({
      bytes: new Uint8Array(HIZOFS_V1_FORMAT_CONSTANTS.limits.inlineFileBytes + 1),
      name: "too-large",
      parentDirectoryInodeNumber: createInodeNumber({ value: 1n }),
      timestamp,
    }))).toBe("inline_file_too_large");
  });

  it("rejects allocator regression and exhaustion", () => {
    expect(() => candidate({ nextInodeNumber: 1n })).toThrowError();
    const exhausted = candidate({ nextInodeNumber: UINT64_MAXIMUM });
    expect(errorCode(() => exhausted.createEmptyFile({
      name: "never",
      parentDirectoryInodeNumber: createInodeNumber({ value: 1n }),
      timestamp,
    }))).toBe("allocator_exhausted");
  });

  it("seals the candidate against later mutation and returns detached arrays", () => {
    const builder = candidate();
    builder.createEmptyFile({ name: "one", parentDirectoryInodeNumber: createInodeNumber({ value: 1n }), timestamp });
    const first = builder.seal();
    expect(errorCode(() => builder.createEmptyFile({
      name: "two",
      parentDirectoryInodeNumber: createInodeNumber({ value: 1n }),
      timestamp,
    }))).toBe("candidate_sealed");
    expect(builder.seal()).toEqual(first);
  });
});
