import {
  createInodeNumber,
  createInodeRevision,
  encodeDirectoryPage,
  encodeInodeLeafPage,
  UINT64_MAXIMUM,
  type DirectoryLeafEntry,
  type FileInodeEntry,
  type InodeLeafEntry,
  type InodeNumber,
  type SubvolumeAccess,
  type TimestampMilliseconds,
} from "@/00-storage/service/hizofs/00-format";
import {
  isSameContainerCoordinationKey,
  type ContainerCoordinationKey,
} from "@/00-storage/service/hizofs/filesystem/container-coordination-key";

export type WholeFileReflinkPlanErrorCode =
  | "allocator_exhausted"
  | "allocator_regression"
  | "cross_device"
  | "destination_binding_mismatch"
  | "destination_exists"
  | "destination_type_mismatch"
  | "destructive_self_replace"
  | "parent_read_only"
  | "source_not_found"
  | "source_not_regular_file";

export class WholeFileReflinkPlanError extends Error {
  readonly code: WholeFileReflinkPlanErrorCode;

  constructor({ code, message }: { code: WholeFileReflinkPlanErrorCode; message: string }) {
    super(message);
    this.name = "WholeFileReflinkPlanError";
    this.code = code;
  }
}

export type WholeFileReflinkSource = Readonly<{
  containerCoordinationKey: ContainerCoordinationKey;
  inode: InodeLeafEntry | null;
  reachable: boolean;
}>;

export type WholeFileReflinkTarget = Readonly<{
  containerCoordinationKey: ContainerCoordinationKey;
  destinationIsSource: boolean;
  entryName: string;
  existingEntry: DirectoryLeafEntry | null;
  parentAccess: SubvolumeAccess;
  parentDirectoryInodeNumber: InodeNumber;
  replace: boolean;
}>;

export type WholeFileReflinkPlan = Readonly<{
  destinationParentDirectoryInodeNumber: InodeNumber;
  directoryEntry: Extract<DirectoryLeafEntry, { targetType: "inode" }>;
  expectedDestinationEntry: DirectoryLeafEntry | null;
  inode: FileInodeEntry;
  nextInodeNumber: InodeNumber;
  replacedInodeNumber: InodeNumber | null;
}>;

function cloneFileContent({ source }: { source: FileInodeEntry }): FileInodeEntry["content"] {
  switch (source.content.type) {
  case "inline":
    return { bytes: new Uint8Array(source.content.bytes), type: "inline" };
  case "tree":
    return { extentTreeRootHomeRef: source.content.extentTreeRootHomeRef, type: "tree" };
  default: return source.content satisfies never;
  }
}

function validateReplacement({ source, target }: {
  source: FileInodeEntry;
  target: WholeFileReflinkTarget;
}): InodeNumber | null {
  if (target.destinationIsSource) {
    throw new WholeFileReflinkPlanError({
      code: "destructive_self_replace",
      message: "whole-file reflink cannot replace its own source path",
    });
  }
  const existing = target.existingEntry;
  if (existing === null) return null;
  if (existing.name !== target.entryName) {
    throw new WholeFileReflinkPlanError({
      code: "destination_binding_mismatch",
      message: "whole-file reflink destination binding name does not match the requested target",
    });
  }
  if (!target.replace) {
    throw new WholeFileReflinkPlanError({
      code: "destination_exists",
      message: "whole-file reflink destination already exists and replace is false",
    });
  }
  switch (existing.targetType) {
  case "subvolume":
    throw new WholeFileReflinkPlanError({
      code: "destination_type_mismatch",
      message: "whole-file reflink cannot replace a mounted Subvolume",
    });
  case "inode":
    switch (existing.inodeKind) {
    case "file":
    case "symlink":
      if (existing.inodeNumber === source.inodeNumber) {
        throw new WholeFileReflinkPlanError({
          code: "destructive_self_replace",
          message: "whole-file reflink cannot replace the source inode",
        });
      }
      return existing.inodeNumber;
    case "directory":
      throw new WholeFileReflinkPlanError({
        code: "destination_type_mismatch",
        message: "whole-file reflink cannot replace a directory",
      });
    default: return existing.inodeKind satisfies never;
    }
  default: return existing satisfies never;
  }
}

export function prepareWholeFileReflinkPlan({
  knownInodeNumbers,
  nextInodeNumber,
  operationTimestamp,
  source,
  target,
}: {
  knownInodeNumbers: readonly InodeNumber[];
  nextInodeNumber: InodeNumber;
  operationTimestamp: TimestampMilliseconds;
  source: WholeFileReflinkSource;
  target: WholeFileReflinkTarget;
}): WholeFileReflinkPlan {
  switch (target.parentAccess) {
  case "read_write": break;
  case "read": throw new WholeFileReflinkPlanError({
    code: "parent_read_only",
    message: "whole-file reflink requires a read-write destination parent",
  });
  default: target.parentAccess satisfies never;
  }
  if (!isSameContainerCoordinationKey({
    left: source.containerCoordinationKey,
    right: target.containerCoordinationKey,
  })) {
    throw new WholeFileReflinkPlanError({
      code: "cross_device",
      message: "whole-file reflink source and destination must use the same physical container",
    });
  }
  if (!source.reachable) {
    throw new WholeFileReflinkPlanError({
      code: "source_not_found",
      message: "whole-file reflink source is not reachable from the source session",
    });
  }
  const sourceFile = (() => {
    if (source.inode === null) {
      throw new WholeFileReflinkPlanError({
        code: "source_not_regular_file",
        message: "whole-file reflink source must be a regular file",
      });
    }
    switch (source.inode.inodeKind) {
    case "file": return source.inode;
    case "directory":
    case "symlink": throw new WholeFileReflinkPlanError({
      code: "source_not_regular_file",
      message: "whole-file reflink source must be a regular file",
    });
    default: return source.inode satisfies never;
    }
  })();

  const replacedInodeNumber = validateReplacement({ source: sourceFile, target });
  if (nextInodeNumber === UINT64_MAXIMUM) {
    throw new WholeFileReflinkPlanError({
      code: "allocator_exhausted",
      message: "Inode Number allocator is exhausted",
    });
  }
  if (
    nextInodeNumber <= target.parentDirectoryInodeNumber
    || nextInodeNumber <= sourceFile.inodeNumber
    || knownInodeNumbers.some(inodeNumber => nextInodeNumber <= inodeNumber)
    || (replacedInodeNumber !== null && nextInodeNumber <= replacedInodeNumber)
  ) {
    throw new WholeFileReflinkPlanError({
      code: "allocator_regression",
      message: "Inode Number allocator high-water mark does not exceed known inode identities",
    });
  }

  const allocatedInodeNumber = nextInodeNumber;
  const inode: FileInodeEntry = {
    content: cloneFileContent({ source: sourceFile }),
    fileSize: sourceFile.fileSize,
    inodeKind: "file",
    inodeNumber: allocatedInodeNumber,
    inodeRevision: createInodeRevision({ value: 1n }),
    timestamps: {
      createdAt: operationTimestamp,
      modifiedAt: operationTimestamp,
    },
  };
  // Reuse authoritative codecs so filename, inline-byte, and inode constraints
  // cannot drift into a reflink-specific validator.
  encodeDirectoryPage({ isRoot: false, page: { entries: [{
    inodeKind: "file",
    inodeNumber: allocatedInodeNumber,
    name: target.entryName,
    targetType: "inode",
  }], level: 0, type: "leaf" } });
  encodeInodeLeafPage({ entries: [inode], isRoot: false });

  return {
    destinationParentDirectoryInodeNumber: target.parentDirectoryInodeNumber,
    directoryEntry: {
      inodeKind: "file",
      inodeNumber: allocatedInodeNumber,
      name: target.entryName,
      targetType: "inode",
    },
    expectedDestinationEntry: target.existingEntry,
    inode,
    nextInodeNumber: createInodeNumber({ value: allocatedInodeNumber + 1n }),
    replacedInodeNumber,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
