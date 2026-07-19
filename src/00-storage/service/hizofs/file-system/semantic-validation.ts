import type {
  HizoFSDirectoryEntryDto,
  HizoFSDirectoryInodeDto,
  HizoFSFileChunkDto,
  HizoFSFileInodeDto,
  HizoFSSymlinkInodeDto,
} from "@/00-storage/00-dto/hizofs.dto";
import { validateHizoFSStableId } from "@/00-storage/service/hizofs/id";
import { validateHizoFSObjectId } from "@/00-storage/service/hizofs/object-store/object-id";
import { compareHizoFSStrings } from "./ordering";

const MAX_ENTRY_NAME_UTF8_BYTE_LENGTH = 4 * 1024;
const MAX_SYMLINK_TARGET_UTF8_BYTE_LENGTH = 64 * 1024;
const UTF8 = new TextEncoder();

function assertWellFormedUnicode({
  value,
  fieldName,
}: {
  value: string;
  fieldName: string;
}): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error(
          `${fieldName} must not contain an unpaired UTF-16 surrogate`,
        );
      }
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new Error(
        `${fieldName} must not contain an unpaired UTF-16 surrogate`,
      );
    }
  }
}

export function assertHizoFSNonNegativeSafeInteger({
  value,
  fieldName,
}: {
  value: number;
  fieldName: string;
}): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative safe integer`);
  }
}

export function assertHizoFSPositiveSafeInteger({
  value,
  fieldName,
}: {
  value: number;
  fieldName: string;
}): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${fieldName} must be a positive safe integer`);
  }
}

export function assertHizoFSObjectId({
  value,
  fieldName,
}: {
  value: string;
  fieldName: string;
}): void {
  try {
    validateHizoFSObjectId({ objectId: value });
  } catch (error) {
    throw new Error(`${fieldName} is not a valid HizoFS object ID`, {
      cause: error,
    });
  }
}

export function assertHizoFSEntryName({ name }: { name: string }): void {
  assertWellFormedUnicode({
    value: name,
    fieldName: "HizoFS directory entry name",
  });
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\0") ||
    UTF8.encode(name).byteLength > MAX_ENTRY_NAME_UTF8_BYTE_LENGTH
  ) {
    throw new Error(`Invalid HizoFS directory entry name: ${name}`);
  }
}

export function assertHizoFSDirectoryEntries({
  entries,
}: {
  entries: readonly HizoFSDirectoryEntryDto[];
}): void {
  let previousName: string | undefined;
  for (const entry of entries) {
    assertHizoFSEntryName({ name: entry.name });
    validateHizoFSStableId({
      value: entry.nodeId,
      fieldName: "HizoFS directory entry nodeId",
    });
    if (
      previousName !== undefined &&
      compareHizoFSStrings({ left: previousName, right: entry.name }) >= 0
    ) {
      throw new Error(
        "HizoFS directory entries must be strictly sorted and unique",
      );
    }
    previousName = entry.name;
  }
}

function assertTimestamp({
  value,
  fieldName,
}: {
  value: number | null;
  fieldName: string;
}): void {
  if (value !== null) {
    assertHizoFSNonNegativeSafeInteger({ value, fieldName });
  }
}

export function assertHizoFSFileInode({
  inode,
  binaryPayload,
}: {
  inode: HizoFSFileInodeDto;
  binaryPayload: Uint8Array;
}): void {
  validateHizoFSStableId({
    value: inode.nodeId,
    fieldName: "HizoFS file nodeId",
  });
  assertHizoFSNonNegativeSafeInteger({
    value: inode.revision,
    fieldName: "File revision",
  });
  assertTimestamp({ value: inode.createdAt, fieldName: "File createdAt" });
  assertTimestamp({ value: inode.modifiedAt, fieldName: "File modifiedAt" });
  assertHizoFSNonNegativeSafeInteger({
    value: inode.size,
    fieldName: "File size",
  });

  switch (inode.storage.type) {
  case "inline":
    if (binaryPayload.byteLength !== inode.size) {
      throw new Error(
        "HizoFS inline file payload length does not match its size",
      );
    }
    break;
  case "extents":
    if (binaryPayload.byteLength !== 0) {
      throw new Error(
        "HizoFS extent-backed file inode must not contain inline bytes",
      );
    }
    assertHizoFSPositiveSafeInteger({
      value: inode.storage.chunkSize,
      fieldName: "File chunkSize",
    });
    assertHizoFSObjectId({
      value: inode.storage.extentIndexRootObjectId,
      fieldName: "File extentIndexRootObjectId",
    });
    break;
  default: {
    const _ex: never = inode.storage;
    throw new Error(`Unhandled HizoFS file storage: ${String(_ex)}`);
  }
  }
}

export function assertHizoFSDirectoryInode({
  inode,
}: {
  inode: HizoFSDirectoryInodeDto;
}): void {
  validateHizoFSStableId({
    value: inode.nodeId,
    fieldName: "HizoFS directory nodeId",
  });
  assertHizoFSNonNegativeSafeInteger({
    value: inode.revision,
    fieldName: "Directory revision",
  });
  assertTimestamp({ value: inode.createdAt, fieldName: "Directory createdAt" });
  assertTimestamp({
    value: inode.modifiedAt,
    fieldName: "Directory modifiedAt",
  });
  switch (inode.storage.type) {
  case "inline":
    assertHizoFSDirectoryEntries({ entries: inode.storage.entries });
    break;
  case "indexed":
    assertHizoFSObjectId({
      value: inode.storage.directoryIndexRootObjectId,
      fieldName: "Directory index root object ID",
    });
    break;
  default: {
    const _ex: never = inode.storage;
    throw new Error(`Unhandled HizoFS directory storage: ${String(_ex)}`);
  }
  }
}

export function assertHizoFSSymlinkInode({
  inode,
}: {
  inode: HizoFSSymlinkInodeDto;
}): void {
  validateHizoFSStableId({
    value: inode.nodeId,
    fieldName: "HizoFS symlink nodeId",
  });
  assertHizoFSNonNegativeSafeInteger({
    value: inode.revision,
    fieldName: "Symlink revision",
  });
  assertTimestamp({ value: inode.createdAt, fieldName: "Symlink createdAt" });
  assertTimestamp({ value: inode.modifiedAt, fieldName: "Symlink modifiedAt" });
  assertWellFormedUnicode({
    value: inode.target,
    fieldName: "HizoFS symlink target",
  });
  if (
    inode.target.includes("\0") ||
    UTF8.encode(inode.target).byteLength > MAX_SYMLINK_TARGET_UTF8_BYTE_LENGTH
  ) {
    throw new Error("HizoFS symlink target is invalid");
  }
}

export function assertHizoFSFileChunk({
  chunk,
  binaryPayload,
  chunkSize,
}: {
  chunk: HizoFSFileChunkDto;
  binaryPayload: Uint8Array;
  chunkSize: number;
}): void {
  assertHizoFSFileChunkByteLength({
    chunk,
    binaryPayloadByteLength: binaryPayload.byteLength,
    chunkSize,
  });
}

export function assertHizoFSFileChunkByteLength({
  chunk,
  binaryPayloadByteLength,
  chunkSize,
}: {
  chunk: HizoFSFileChunkDto;
  binaryPayloadByteLength: number;
  chunkSize: number;
}): void {
  const { ...unhandledChunk } = chunk;
  unhandledChunk satisfies Record<PropertyKey, never>;
  if (
    !Number.isSafeInteger(binaryPayloadByteLength)
    || binaryPayloadByteLength <= 0
    || binaryPayloadByteLength > chunkSize
  ) {
    throw new Error("HizoFS file chunk payload length is invalid");
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
