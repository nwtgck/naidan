import type {
  DirectoryLeafEntry,
  InodeNumber,
  SubvolumeAccess,
  SubvolumeId,
} from "@/00-storage/service/hizofs/00-format";

export type OrdinaryEntryMovePlanErrorCode =
  | "cross_subvolume"
  | "destination_exists"
  | "destination_directory_has_subvolume"
  | "destination_directory_not_empty"
  | "directory_cycle"
  | "mounted_subvolume"
  | "read_only_parent"
  | "source_identity_reused"
  | "source_missing"
  | "type_mismatch";

export class OrdinaryEntryMovePlanError extends Error {
  readonly code: OrdinaryEntryMovePlanErrorCode;

  constructor({ code, message }: { code: OrdinaryEntryMovePlanErrorCode; message: string }) {
    super(message);
    this.name = "OrdinaryEntryMovePlanError";
    this.code = code;
  }
}

export type OrdinaryEntryMoveSource = Readonly<{
  directoryDescendantInodeNumbers: readonly InodeNumber[];
  entry: DirectoryLeafEntry | null;
  parentAccess: SubvolumeAccess;
  parentDirectoryInodeNumber: InodeNumber;
  parentSubvolumeId: SubvolumeId;
}>;

export type OrdinaryEntryMoveDestination = Readonly<{
  directoryContainsSubvolumeMount: boolean;
  directoryEmpty: boolean;
  entry: DirectoryLeafEntry | null;
  parentAccess: SubvolumeAccess;
  parentDirectoryInodeNumber: InodeNumber;
  parentSubvolumeId: SubvolumeId;
}>;

export type OrdinaryEntryMovePlan = Readonly<{
  destinationBinding: Extract<DirectoryLeafEntry, { targetType: "inode" }>;
  destinationParentDirectoryInodeNumber: InodeNumber;
  replacedInodeNumber?: InodeNumber;
  sourceParentDirectoryInodeNumber: InodeNumber;
  sourceRemovalName: string;
  subvolumeId: SubvolumeId;
  type: "move";
}>;

function assertMutable({ access }: { access: SubvolumeAccess }): void {
  switch (access) {
  case "read_write": return;
  case "read":
    throw new OrdinaryEntryMovePlanError({
      code: "read_only_parent",
      message: "ordinary entry move requires mutable source and destination parents",
    });
  default: access satisfies never;
  }
}

function isDirectoryEntry({ entry }: {
  entry: Extract<DirectoryLeafEntry, { targetType: "inode" }>;
}): boolean {
  switch (entry.inodeKind) {
  case "directory": return true;
  case "file":
  case "symlink": return false;
  default: return entry.inodeKind satisfies never;
  }
}

export function prepareOrdinaryEntryMovePlan({ destination, destinationName, replace, source }: {
  destination: OrdinaryEntryMoveDestination;
  destinationName: string;
  replace: boolean;
  source: OrdinaryEntryMoveSource;
}): OrdinaryEntryMovePlan | null {
  const sourceEntry = source.entry;
  if (sourceEntry === null) {
    throw new OrdinaryEntryMovePlanError({
      code: "source_missing",
      message: "ordinary entry move source does not exist",
    });
  }

  assertMutable({ access: source.parentAccess });
  assertMutable({ access: destination.parentAccess });
  if (source.parentSubvolumeId !== destination.parentSubvolumeId) {
    throw new OrdinaryEntryMovePlanError({
      code: "cross_subvolume",
      message: "ordinary entry move cannot cross a Subvolume boundary",
    });
  }

  if (
    source.parentDirectoryInodeNumber === destination.parentDirectoryInodeNumber
    && sourceEntry.name === destinationName
  ) {
    return null;
  }

  if (sourceEntry.targetType === "subvolume" || destination.entry?.targetType === "subvolume") {
    throw new OrdinaryEntryMovePlanError({
      code: "mounted_subvolume",
      message: "mounted Subvolume entries require the explicit topology move operation",
    });
  }

  const sourceIsDirectory = isDirectoryEntry({ entry: sourceEntry });
  if (sourceIsDirectory && (
    sourceEntry.inodeNumber === destination.parentDirectoryInodeNumber
    || source.directoryDescendantInodeNumbers.includes(destination.parentDirectoryInodeNumber)
  )) {
    throw new OrdinaryEntryMovePlanError({
      code: "directory_cycle",
      message: "ordinary directory move would create a namespace cycle",
    });
  }

  const destinationEntry = destination.entry;
  let replacedInodeNumber: InodeNumber | undefined;
  if (destinationEntry !== null) {
    if (!replace) {
      throw new OrdinaryEntryMovePlanError({
        code: "destination_exists",
        message: "ordinary entry move destination exists and replacement was not requested",
      });
    }
    if (sourceEntry.inodeNumber === destinationEntry.inodeNumber) {
      throw new OrdinaryEntryMovePlanError({
        code: "source_identity_reused",
        message: "ordinary replacement cannot destructively replace the source inode identity",
      });
    }
    const destinationIsDirectory = isDirectoryEntry({ entry: destinationEntry });
    if (sourceIsDirectory !== destinationIsDirectory) {
      throw new OrdinaryEntryMovePlanError({
        code: "type_mismatch",
        message: "ordinary entry replacement cannot cross the directory type boundary",
      });
    }
    if (destinationIsDirectory) {
      if (!destination.directoryEmpty) {
        throw new OrdinaryEntryMovePlanError({
          code: "destination_directory_not_empty",
          message: "ordinary directory replacement requires an empty destination directory",
        });
      }
      if (destination.directoryContainsSubvolumeMount) {
        throw new OrdinaryEntryMovePlanError({
          code: "destination_directory_has_subvolume",
          message: "ordinary directory replacement cannot remove a mounted Subvolume",
        });
      }
    }
    replacedInodeNumber = destinationEntry.inodeNumber;
  }

  return {
    destinationBinding: { ...sourceEntry, name: destinationName },
    destinationParentDirectoryInodeNumber: destination.parentDirectoryInodeNumber,
    ...(replacedInodeNumber === undefined ? {} : { replacedInodeNumber }),
    sourceParentDirectoryInodeNumber: source.parentDirectoryInodeNumber,
    sourceRemovalName: sourceEntry.name,
    subvolumeId: source.parentSubvolumeId,
    type: "move",
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
