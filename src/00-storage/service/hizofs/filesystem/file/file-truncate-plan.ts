import {
  createInodeRevision,
  HIZOFS_V1_FORMAT_CONSTANTS,
  UINT64_MAXIMUM,
  type FileInodeEntry,
  type FileOffset,
  type HomeRecordReference,
  type InodeNumber,
  type InodeRevision,
  type InodeTimestamps,
  type TimestampMilliseconds,
} from "@/00-storage/service/hizofs/00-format";

export type FileTruncatePlanErrorCode =
  | "invalid_inline_state"
  | "revision_exhausted";

export class FileTruncatePlanError extends Error {
  readonly code: FileTruncatePlanErrorCode;

  constructor({ code, message }: { code: FileTruncatePlanErrorCode; message: string }) {
    super(message);
    this.name = "FileTruncatePlanError";
    this.code = code;
  }
}

type FileTruncatePlanCommon = Readonly<{
  inodeNumber: InodeNumber;
  nextInodeRevision: InodeRevision;
  targetFileSize: FileOffset;
  timestamps: InodeTimestamps;
}>;

export type FileTruncatePlan = Readonly<
  | (FileTruncatePlanCommon & {
      action: "write_inline";
      bytes: Uint8Array;
    })
  | (FileTruncatePlanCommon & {
      action: "promote_inline_to_extent";
      inlinePrefixBytes: Uint8Array;
    })
  | (FileTruncatePlanCommon & {
      action: "reuse_extent_tree";
      sourceExtentTreeRootHomeRef: HomeRecordReference;
    })
  | (FileTruncatePlanCommon & {
      action: "trim_extent_tree";
      sourceExtentTreeRootHomeRef: HomeRecordReference;
    })
>;

function validateInlineState({ source }: { source: FileInodeEntry }): void {
  switch (source.content.type) {
  case "tree": return;
  case "inline": {
    const inlineLimit = HIZOFS_V1_FORMAT_CONSTANTS.limits.inlineFileBytes;
    if (
      source.content.bytes.byteLength > inlineLimit
      || BigInt(source.content.bytes.byteLength) !== source.fileSize
    ) {
      throw new FileTruncatePlanError({
        code: "invalid_inline_state",
        message: "inline file bytes must exactly represent the logical file size within the inline limit",
      });
    }
    return;
  }
  default: return source.content satisfies never;
  }
}

function commonPlan({ operationTimestamp, source, targetFileSize }: {
  operationTimestamp: TimestampMilliseconds;
  source: FileInodeEntry;
  targetFileSize: FileOffset;
}): FileTruncatePlanCommon {
  if (source.inodeRevision === UINT64_MAXIMUM) {
    throw new FileTruncatePlanError({
      code: "revision_exhausted",
      message: "Inode Revision allocator is exhausted",
    });
  }
  return {
    inodeNumber: source.inodeNumber,
    nextInodeRevision: createInodeRevision({ value: source.inodeRevision + 1n }),
    targetFileSize,
    timestamps: {
      createdAt: source.timestamps.createdAt,
      modifiedAt: operationTimestamp,
    },
  };
}

export function prepareFileTruncatePlan({ operationTimestamp, source, targetFileSize }: {
  operationTimestamp: TimestampMilliseconds;
  source: FileInodeEntry;
  targetFileSize: FileOffset;
}): FileTruncatePlan | null {
  validateInlineState({ source });
  if (source.fileSize === targetFileSize) return null;

  const common = commonPlan({ operationTimestamp, source, targetFileSize });
  switch (source.content.type) {
  case "inline": {
    const inlineLimit = BigInt(HIZOFS_V1_FORMAT_CONSTANTS.limits.inlineFileBytes);
    if (targetFileSize <= inlineLimit) {
      const bytes = new Uint8Array(Number(targetFileSize));
      bytes.set(source.content.bytes.subarray(0, bytes.byteLength));
      return { ...common, action: "write_inline", bytes };
    }
    return {
      ...common,
      action: "promote_inline_to_extent",
      inlinePrefixBytes: new Uint8Array(source.content.bytes),
    };
  }
  case "tree":
    if (targetFileSize > source.fileSize) {
      return {
        ...common,
        action: "reuse_extent_tree",
        sourceExtentTreeRootHomeRef: source.content.extentTreeRootHomeRef,
      };
    }
    return {
      ...common,
      action: "trim_extent_tree",
      sourceExtentTreeRootHomeRef: source.content.extentTreeRootHomeRef,
    };
  default: return source.content satisfies never;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
