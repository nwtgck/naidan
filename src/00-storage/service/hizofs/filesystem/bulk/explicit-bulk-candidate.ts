import {
  compareFilenameComponentsByUtf8,
  createFileOffset,
  createInodeNumber,
  createInodeRevision,
  encodeFilenameComponent,
  encodeSymlinkTarget,
  HIZOFS_V1_FORMAT_CONSTANTS,
  UINT64_MAXIMUM,
  type DirectoryLeafEntry,
  type FileInodeEntry,
  type FileOffset,
  type InodeNumber,
  type InodeRevision,
  type InodeTimestamps,
  type SymlinkInodeEntry,
  type TimestampMilliseconds,
} from "@/00-storage/service/hizofs/00-format";

export type ExplicitBulkCandidateErrorCode =
  | "allocator_exhausted"
  | "allocator_regression"
  | "candidate_sealed"
  | "duplicate_entry"
  | "entry_limit_exceeded"
  | "inline_byte_limit_exceeded"
  | "inline_file_size_mismatch"
  | "inline_file_too_large"
  | "invalid_limits"
  | "invalid_parent_directory";

export class ExplicitBulkCandidateError extends Error {
  readonly code: ExplicitBulkCandidateErrorCode;

  constructor({ code, message }: { code: ExplicitBulkCandidateErrorCode; message: string }) {
    super(message);
    this.name = "ExplicitBulkCandidateError";
    this.code = code;
  }
}

export type ExplicitBulkDirectoryCandidate = Readonly<{
  entries: readonly DirectoryLeafEntry[];
  inodeNumber: InodeNumber;
  inodeRevision: InodeRevision;
  timestamps: InodeTimestamps;
}>;

export type SealedExplicitBulkCandidate = Readonly<{
  directories: readonly ExplicitBulkDirectoryCandidate[];
  files: readonly FileInodeEntry[];
  nextInodeNumber: InodeNumber;
  symlinks: readonly SymlinkInodeEntry[];
  targetDirectoryInodeNumber: InodeNumber;
  totalInlineFileBytes: number;
}>;

type MutableDirectoryCandidate = {
  entries: DirectoryLeafEntry[];
  entryNames: Set<string>;
  inodeNumber: InodeNumber;
  inodeRevision: InodeRevision;
  timestamps: InodeTimestamps;
};

function compareDirectoryEntries({ left, right }: {
  left: DirectoryLeafEntry;
  right: DirectoryLeafEntry;
}): number {
  return compareFilenameComponentsByUtf8({ left: left.name, right: right.name });
}

function cloneFile({ file }: { file: FileInodeEntry }): FileInodeEntry {
  switch (file.content.type) {
  case "inline": return {
    ...file,
    content: { bytes: new Uint8Array(file.content.bytes), type: "inline" },
  };
  case "tree": return file;
  default: return file.content satisfies never;
  }
}

function cloneSymlink({ symlink }: { symlink: SymlinkInodeEntry }): SymlinkInodeEntry {
  return { ...symlink, timestamps: { ...symlink.timestamps } };
}

export class ExplicitBulkCandidate {
  private readonly directories = new Map<InodeNumber, MutableDirectoryCandidate>();
  private readonly files: FileInodeEntry[] = [];
  private readonly limits: Readonly<{ maxEntries: number; maxInlineFileBytesTotal: number }>;
  private readonly symlinks: SymlinkInodeEntry[] = [];
  private readonly targetDirectoryInodeNumber: InodeNumber;
  private entryCount = 0;
  private nextInodeNumber: InodeNumber;
  private sealed = false;
  private totalInlineFileBytes = 0;

  constructor({ limits, nextInodeNumber, rootDirectory }: {
    limits: Readonly<{ maxEntries: number; maxInlineFileBytesTotal: number }>;
    nextInodeNumber: InodeNumber;
    rootDirectory: Readonly<{
      inodeNumber: InodeNumber;
      inodeRevision: InodeRevision;
      timestamps: InodeTimestamps;
    }>;
  }) {
    if (
      !Number.isSafeInteger(limits.maxEntries)
      || limits.maxEntries < 1
      || !Number.isSafeInteger(limits.maxInlineFileBytesTotal)
      || limits.maxInlineFileBytesTotal < 0
    ) {
      throw new ExplicitBulkCandidateError({
        code: "invalid_limits",
        message: "explicit bulk candidate limits must be bounded safe integers",
      });
    }
    if (nextInodeNumber <= rootDirectory.inodeNumber) {
      throw new ExplicitBulkCandidateError({
        code: "allocator_regression",
        message: "explicit bulk Inode Number allocator must exceed the root directory identity",
      });
    }
    this.limits = limits;
    this.nextInodeNumber = nextInodeNumber;
    this.targetDirectoryInodeNumber = rootDirectory.inodeNumber;
    this.directories.set(rootDirectory.inodeNumber, {
      entries: [],
      entryNames: new Set(),
      inodeNumber: rootDirectory.inodeNumber,
      inodeRevision: rootDirectory.inodeRevision,
      timestamps: { ...rootDirectory.timestamps },
    });
  }

  private assertActive(): void {
    if (this.sealed) {
      throw new ExplicitBulkCandidateError({
        code: "candidate_sealed",
        message: "explicit bulk candidate is sealed for publication",
      });
    }
  }

  private prepareParent({ name, parentDirectoryInodeNumber }: {
    name: string;
    parentDirectoryInodeNumber: InodeNumber;
  }): MutableDirectoryCandidate {
    this.assertActive();
    encodeFilenameComponent({ value: name });
    const parent = this.directories.get(parentDirectoryInodeNumber);
    if (parent === undefined) {
      throw new ExplicitBulkCandidateError({
        code: "invalid_parent_directory",
        message: "explicit bulk parent is not a candidate-owned directory",
      });
    }
    if (parent.entryNames.has(name)) {
      throw new ExplicitBulkCandidateError({
        code: "duplicate_entry",
        message: "explicit bulk directory entry already exists",
      });
    }
    if (this.entryCount >= this.limits.maxEntries) {
      throw new ExplicitBulkCandidateError({
        code: "entry_limit_exceeded",
        message: "explicit bulk candidate entry budget is exhausted",
      });
    }
    if (this.nextInodeNumber === UINT64_MAXIMUM) {
      throw new ExplicitBulkCandidateError({
        code: "allocator_exhausted",
        message: "explicit bulk Inode Number allocator is exhausted",
      });
    }
    return parent;
  }

  private allocateInodeNumber(): InodeNumber {
    const allocated = this.nextInodeNumber;
    this.nextInodeNumber = createInodeNumber({ value: allocated + 1n });
    return allocated;
  }

  createDirectory({ name, parentDirectoryInodeNumber, timestamp }: {
    name: string;
    parentDirectoryInodeNumber: InodeNumber;
    timestamp: TimestampMilliseconds;
  }): InodeNumber {
    const parent = this.prepareParent({ name, parentDirectoryInodeNumber });
    const inodeNumber = this.allocateInodeNumber();
    const entry = {
      inodeKind: "directory",
      inodeNumber,
      name,
      targetType: "inode",
    } as const;
    parent.entries.push(entry);
    parent.entryNames.add(name);
    parent.timestamps = { createdAt: parent.timestamps.createdAt, modifiedAt: timestamp };
    this.directories.set(inodeNumber, {
      entries: [],
      entryNames: new Set(),
      inodeNumber,
      inodeRevision: createInodeRevision({ value: 1n }),
      timestamps: { createdAt: timestamp, modifiedAt: timestamp },
    });
    this.entryCount += 1;
    return inodeNumber;
  }

  createDirectoryWithTimestamps({ name, parentDirectoryInodeNumber, timestamps }: {
    name: string;
    parentDirectoryInodeNumber: InodeNumber;
    timestamps: InodeTimestamps;
  }): InodeNumber {
    const parent = this.prepareParent({ name, parentDirectoryInodeNumber });
    const inodeNumber = this.allocateInodeNumber();
    parent.entries.push({
      inodeKind: "directory",
      inodeNumber,
      name,
      targetType: "inode",
    });
    parent.entryNames.add(name);
    this.directories.set(inodeNumber, {
      entries: [],
      entryNames: new Set(),
      inodeNumber,
      inodeRevision: createInodeRevision({ value: 1n }),
      timestamps: { ...timestamps },
    });
    this.entryCount += 1;
    return inodeNumber;
  }

  createEmptyFile({ name, parentDirectoryInodeNumber, timestamp }: {
    name: string;
    parentDirectoryInodeNumber: InodeNumber;
    timestamp: TimestampMilliseconds;
  }): InodeNumber {
    return this.createInlineFile({
      bytes: new Uint8Array(),
      name,
      parentDirectoryInodeNumber,
      timestamp,
    });
  }

  createInlineFile({ bytes, name, parentDirectoryInodeNumber, timestamp }: {
    bytes: Uint8Array;
    name: string;
    parentDirectoryInodeNumber: InodeNumber;
    timestamp: TimestampMilliseconds;
  }): InodeNumber {
    const parent = this.prepareParent({ name, parentDirectoryInodeNumber });
    if (bytes.byteLength > HIZOFS_V1_FORMAT_CONSTANTS.limits.inlineFileBytes) {
      throw new ExplicitBulkCandidateError({
        code: "inline_file_too_large",
        message: "explicit bulk inline file exceeds the V1 inline file limit",
      });
    }
    if (this.totalInlineFileBytes + bytes.byteLength > this.limits.maxInlineFileBytesTotal) {
      throw new ExplicitBulkCandidateError({
        code: "inline_byte_limit_exceeded",
        message: "explicit bulk inline byte budget is exhausted",
      });
    }
    const inodeNumber = this.allocateInodeNumber();
    const ownedBytes = new Uint8Array(bytes);
    const file: FileInodeEntry = {
      content: { bytes: ownedBytes, type: "inline" },
      fileSize: createFileOffset({ value: BigInt(ownedBytes.byteLength) }),
      inodeKind: "file",
      inodeNumber,
      inodeRevision: createInodeRevision({ value: 1n }),
      timestamps: { createdAt: timestamp, modifiedAt: timestamp },
    };
    parent.entries.push({ inodeKind: "file", inodeNumber, name, targetType: "inode" });
    parent.entryNames.add(name);
    parent.timestamps = { createdAt: parent.timestamps.createdAt, modifiedAt: timestamp };
    this.files.push(file);
    this.entryCount += 1;
    this.totalInlineFileBytes += ownedBytes.byteLength;
    return inodeNumber;
  }

  createFile({ content, fileSize, name, parentDirectoryInodeNumber, timestamps }: {
    content: FileInodeEntry["content"];
    fileSize: FileOffset;
    name: string;
    parentDirectoryInodeNumber: InodeNumber;
    timestamps: InodeTimestamps;
  }): InodeNumber {
    const parent = this.prepareParent({ name, parentDirectoryInodeNumber });
    const normalizedFileSize = createFileOffset({ value: fileSize });
    let ownedContent: FileInodeEntry["content"];
    switch (content.type) {
    case "inline": {
      if (content.bytes.byteLength > HIZOFS_V1_FORMAT_CONSTANTS.limits.inlineFileBytes) {
        throw new ExplicitBulkCandidateError({
          code: "inline_file_too_large",
          message: "explicit bulk inline file exceeds the V1 inline file limit",
        });
      }
      if (BigInt(content.bytes.byteLength) !== normalizedFileSize) {
        throw new ExplicitBulkCandidateError({
          code: "inline_file_size_mismatch",
          message: "explicit bulk inline file bytes must equal its logical file size",
        });
      }
      if (this.totalInlineFileBytes + content.bytes.byteLength > this.limits.maxInlineFileBytesTotal) {
        throw new ExplicitBulkCandidateError({
          code: "inline_byte_limit_exceeded",
          message: "explicit bulk inline byte budget is exhausted",
        });
      }
      ownedContent = { bytes: new Uint8Array(content.bytes), type: "inline" };
      break;
    }
    case "tree": ownedContent = content; break;
    default: return content satisfies never;
    }
    const inodeNumber = this.allocateInodeNumber();
    this.files.push({
      content: ownedContent,
      fileSize: normalizedFileSize,
      inodeKind: "file",
      inodeNumber,
      inodeRevision: createInodeRevision({ value: 1n }),
      timestamps: { ...timestamps },
    });
    parent.entries.push({ inodeKind: "file", inodeNumber, name, targetType: "inode" });
    parent.entryNames.add(name);
    this.entryCount += 1;
    switch (ownedContent.type) {
    case "inline": this.totalInlineFileBytes += ownedContent.bytes.byteLength; break;
    case "tree": break;
    default: return ownedContent satisfies never;
    }
    return inodeNumber;
  }

  createSymlink({ name, parentDirectoryInodeNumber, target, timestamps }: {
    name: string;
    parentDirectoryInodeNumber: InodeNumber;
    target: string;
    timestamps: InodeTimestamps;
  }): InodeNumber {
    const parent = this.prepareParent({ name, parentDirectoryInodeNumber });
    encodeSymlinkTarget({ value: target });
    const inodeNumber = this.allocateInodeNumber();
    const symlink: SymlinkInodeEntry = {
      inodeKind: "symlink",
      inodeNumber,
      inodeRevision: createInodeRevision({ value: 1n }),
      target,
      timestamps: { ...timestamps },
    };
    parent.entries.push({ inodeKind: "symlink", inodeNumber, name, targetType: "inode" });
    parent.entryNames.add(name);
    this.symlinks.push(symlink);
    this.entryCount += 1;
    return inodeNumber;
  }

  seal(): SealedExplicitBulkCandidate {
    this.sealed = true;
    return {
      directories: [...this.directories.values()]
        .sort((left, right) => left.inodeNumber < right.inodeNumber ? -1 : left.inodeNumber > right.inodeNumber ? 1 : 0)
        .map(directory => ({
          entries: [...directory.entries].sort((left, right) => compareDirectoryEntries({ left, right })),
          inodeNumber: directory.inodeNumber,
          inodeRevision: directory.inodeRevision,
          timestamps: { ...directory.timestamps },
        })),
      files: [...this.files]
        .sort((left, right) => left.inodeNumber < right.inodeNumber ? -1 : left.inodeNumber > right.inodeNumber ? 1 : 0)
        .map(file => cloneFile({ file })),
      nextInodeNumber: this.nextInodeNumber,
      symlinks: [...this.symlinks]
        .sort((left, right) => left.inodeNumber < right.inodeNumber ? -1 : left.inodeNumber > right.inodeNumber ? 1 : 0)
        .map(symlink => cloneSymlink({ symlink })),
      targetDirectoryInodeNumber: this.targetDirectoryInodeNumber,
      totalInlineFileBytes: this.totalInlineFileBytes,
    };
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
