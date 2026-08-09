import {
  createFileOffset,
  createInodeNumber,
  createInodeRevision,
  assertDirectoryLeafEntryFitsMetadataPage,
  assertInodeLeafEntryFitsMetadataPage,
  UINT64_MAXIMUM,
  type DirectoryLeafEntry,
  type InodeLeafEntry,
  type InodeNumber,
  type SubvolumeAccess,
  type SubvolumeId,
  type TimestampMilliseconds,
} from "@/00-storage/service/hizofs/00-format";

export type OrdinaryEntryCreatePlanErrorCode =
  | "allocator_exhausted"
  | "allocator_regression"
  | "destination_exists"
  | "parent_read_only";

export class OrdinaryEntryCreatePlanError extends Error {
  readonly code: OrdinaryEntryCreatePlanErrorCode;

  constructor({ code, message }: { code: OrdinaryEntryCreatePlanErrorCode; message: string }) {
    super(message);
    this.name = "OrdinaryEntryCreatePlanError";
    this.code = code;
  }
}

export type OrdinaryEntryCreateRequest =
  | Readonly<{ type: "directory" }>
  | Readonly<{ type: "file" }>
  | Readonly<{ target: string; type: "symlink" }>;

export type OrdinaryEntryCreateTargetDescriptor = Readonly<{
  entryName: string;
  parentAccess: SubvolumeAccess;
  parentDirectoryInodeNumber: InodeNumber;
  parentSubvolumeId: SubvolumeId;
}>;

export type OrdinaryEntryCreateTarget = Readonly<
  OrdinaryEntryCreateTargetDescriptor & { destinationExists: boolean }
>;

export type OrdinaryEntryCreatePlan = Readonly<{
  directoryEntry: Extract<DirectoryLeafEntry, { targetType: "inode" }>;
  inode: InodeLeafEntry;
  nextInodeNumber: InodeNumber;
  parentDirectoryInodeNumber: InodeNumber;
  subvolumeId: SubvolumeId;
}>;

function assertMutable({ access }: { access: SubvolumeAccess }): void {
  switch (access) {
  case "read_write": return;
  case "read":
    throw new OrdinaryEntryCreatePlanError({
      code: "parent_read_only",
      message: "ordinary entry creation requires a mutable parent Subvolume",
    });
  default: access satisfies never;
  }
}

function createInode({
  inodeNumber,
  operationTimestamp,
  request,
}: {
  inodeNumber: InodeNumber;
  operationTimestamp: TimestampMilliseconds;
  request: OrdinaryEntryCreateRequest;
}): InodeLeafEntry {
  const common = {
    inodeNumber,
    inodeRevision: createInodeRevision({ value: 1n }),
    timestamps: {
      createdAt: operationTimestamp,
      modifiedAt: operationTimestamp,
    },
  } as const;
  switch (request.type) {
  case "directory": return {
    ...common,
    content: { entries: [], type: "inline" },
    inodeKind: "directory",
  };
  case "file": return {
    ...common,
    content: { bytes: new Uint8Array(), type: "inline" },
    fileSize: createFileOffset({ value: 0n }),
    inodeKind: "file",
  };
  case "symlink": return {
    ...common,
    inodeKind: "symlink",
    target: request.target,
  };
  default: return request satisfies never;
  }
}

export function prepareOrdinaryEntryCreatePlan({
  maximumKnownInodeNumber,
  nextInodeNumber,
  operationTimestamp,
  request,
  target,
}: Readonly<{
  maximumKnownInodeNumber: InodeNumber | undefined;
  nextInodeNumber: InodeNumber;
  operationTimestamp: TimestampMilliseconds;
  request: OrdinaryEntryCreateRequest;
  target: OrdinaryEntryCreateTarget;
}>): OrdinaryEntryCreatePlan {
  assertMutable({ access: target.parentAccess });
  if (target.destinationExists) {
    throw new OrdinaryEntryCreatePlanError({
      code: "destination_exists",
      message: "ordinary entry creation destination already exists",
    });
  }
  if (nextInodeNumber === UINT64_MAXIMUM) {
    throw new OrdinaryEntryCreatePlanError({
      code: "allocator_exhausted",
      message: "ordinary entry creation Inode Number allocator is exhausted",
    });
  }
  if (
    nextInodeNumber <= target.parentDirectoryInodeNumber
    || (maximumKnownInodeNumber !== undefined && nextInodeNumber <= maximumKnownInodeNumber)
  ) {
    throw new OrdinaryEntryCreatePlanError({
      code: "allocator_regression",
      message: "ordinary entry creation allocator high-water mark does not exceed captured inode identities",
    });
  }

  const inode = createInode({
    inodeNumber: nextInodeNumber,
    operationTimestamp,
    request,
  });
  const directoryEntry = {
    inodeKind: inode.inodeKind,
    inodeNumber: inode.inodeNumber,
    name: target.entryName,
    targetType: "inode",
  } as const;

  // Reuse the authoritative codecs as validators. This planner must not
  // duplicate filename, symlink-target, inline-content, or inode constraints.
  assertDirectoryLeafEntryFitsMetadataPage({ entry: directoryEntry });
  assertInodeLeafEntryFitsMetadataPage({ entry: inode });

  return {
    directoryEntry,
    inode,
    nextInodeNumber: createInodeNumber({ value: nextInodeNumber + 1n }),
    parentDirectoryInodeNumber: target.parentDirectoryInodeNumber,
    subvolumeId: target.parentSubvolumeId,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
