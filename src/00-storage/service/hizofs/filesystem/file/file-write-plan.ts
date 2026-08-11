import {
  createFileOffset,
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
import type { CapturedFileWriteBytes } from "@/00-storage/service/hizofs/filesystem/file/file-write-input";

export type FileWritePlanErrorCode =
  | "file_size_overflow"
  | "invalid_inline_state"
  | "revision_exhausted";

export class FileWritePlanError extends Error {
  readonly code: FileWritePlanErrorCode;

  constructor({ code, message }: { code: FileWritePlanErrorCode; message: string }) {
    super(message);
    this.name = "FileWritePlanError";
    this.code = code;
  }
}

type FileWritePlanCommon = Readonly<{
  inodeNumber: InodeNumber;
  nextInodeRevision: InodeRevision;
  targetFileSize: FileOffset;
  timestamps: InodeTimestamps;
  writeBytes: Uint8Array;
  writeOffset: FileOffset;
}>;

export type FileWritePlan = Readonly<
  | (FileWritePlanCommon & {
      action: "write_inline";
      bytes: Uint8Array;
    })
  | (FileWritePlanCommon & {
      action: "promote_inline_to_extent";
      sourceInlineBytes: Uint8Array;
    })
  | (FileWritePlanCommon & {
      action: "copy_on_write_extent_range";
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
      throw new FileWritePlanError({
        code: "invalid_inline_state",
        message: "inline file bytes must exactly represent the logical file size within the inline limit",
      });
    }
    return;
  }
  default: return source.content satisfies never;
  }
}

function prepareFileWritePlanWithInput({ bytes, copyWriteBytes, operationTimestamp, position, source }: {
  bytes: Uint8Array;
  copyWriteBytes: boolean;
  operationTimestamp: TimestampMilliseconds;
  position: FileOffset | "append";
  source: FileInodeEntry;
}): FileWritePlan | null {
  validateInlineState({ source });
  if (bytes.byteLength === 0) return null;
  if (source.inodeRevision === UINT64_MAXIMUM) {
    throw new FileWritePlanError({
      code: "revision_exhausted",
      message: "Inode Revision allocator is exhausted",
    });
  }

  const writeOffset = position === "append" ? source.fileSize : position;
  const writeEnd = writeOffset + BigInt(bytes.byteLength);
  if (writeEnd > UINT64_MAXIMUM) {
    throw new FileWritePlanError({
      code: "file_size_overflow",
      message: "file write exceeds the maximum V1 file offset",
    });
  }
  const targetFileSize = createFileOffset({
    value: writeEnd > source.fileSize ? writeEnd : source.fileSize,
  });
  const writeBytes = copyWriteBytes ? new Uint8Array(bytes) : bytes;
  const common: FileWritePlanCommon = {
    inodeNumber: source.inodeNumber,
    nextInodeRevision: createInodeRevision({ value: source.inodeRevision + 1n }),
    targetFileSize,
    timestamps: {
      createdAt: source.timestamps.createdAt,
      modifiedAt: operationTimestamp,
    },
    writeBytes,
    writeOffset,
  };

  switch (source.content.type) {
  case "inline": {
    const inlineLimit = BigInt(HIZOFS_V1_FORMAT_CONSTANTS.limits.inlineFileBytes);
    if (targetFileSize <= inlineLimit) {
      const resultBytes = new Uint8Array(Number(targetFileSize));
      resultBytes.set(source.content.bytes);
      resultBytes.set(writeBytes, Number(writeOffset));
      return {
        ...common,
        action: "write_inline",
        bytes: resultBytes,
      };
    }
    return {
      ...common,
      action: "promote_inline_to_extent",
      sourceInlineBytes: new Uint8Array(source.content.bytes),
    };
  }
  case "tree":
    return {
      ...common,
      action: "copy_on_write_extent_range",
      sourceExtentTreeRootHomeRef: source.content.extentTreeRootHomeRef,
    };
  default: return source.content satisfies never;
  }
}

export function prepareFileWritePlan({ bytes, operationTimestamp, position, source }: {
  bytes: Uint8Array;
  operationTimestamp: TimestampMilliseconds;
  position: FileOffset | "append";
  source: FileInodeEntry;
}): FileWritePlan | null {
  return prepareFileWritePlanWithInput({
    bytes,
    copyWriteBytes: true,
    operationTimestamp,
    position,
    source,
  });
}

export function prepareCapturedFileWritePlan({ bytes, operationTimestamp, position, source }: {
  bytes: CapturedFileWriteBytes;
  operationTimestamp: TimestampMilliseconds;
  position: FileOffset | "append";
  source: FileInodeEntry;
}): FileWritePlan | null {
  return prepareFileWritePlanWithInput({
    bytes,
    copyWriteBytes: false,
    operationTimestamp,
    position,
    source,
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
