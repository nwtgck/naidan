import {
  createInodeNumber,
  createInodeRevision,
  createSubvolumeId,
  HIZOFS_V1_FORMAT_CONSTANTS,
  UINT64_MAXIMUM,
  type DirectoryInodeEntry,
  type DirectoryLeafEntry,
  type HomeRecordReference,
  type InodeNumber,
  type NestedSubvolumeLeafEntry,
  type SubvolumeAccess,
  type SubvolumeId,
  type TimestampMilliseconds,
} from "@/00-storage/service/hizofs/00-format";
import {
  validateSubvolumeTopology,
  type SubvolumeTopologyMount,
} from "@/00-storage/service/hizofs/filesystem/subvolume/subvolume-topology";

export type SubvolumeCreatePlanErrorCode =
  | "allocator_regression"
  | "destination_exists"
  | "destination_parent_missing"
  | "inode_allocator_exhausted"
  | "invalid_inode_table_root"
  | "parent_read_only"
  | "subvolume_allocator_exhausted";

export class SubvolumeCreatePlanError extends Error {
  readonly code: SubvolumeCreatePlanErrorCode;

  constructor({ code, message }: { code: SubvolumeCreatePlanErrorCode; message: string }) {
    super(message);
    this.name = "SubvolumeCreatePlanError";
    this.code = code;
  }
}

export type SubvolumeCreateTarget = Readonly<{
  destinationExists: boolean;
  entryName: string;
  parentAccess: SubvolumeAccess;
  parentDirectoryInodeNumber: InodeNumber;
  parentSubvolumeId: SubvolumeId;
  requestedAccess: SubvolumeAccess;
}>;

export type SubvolumeCreatePlan = Readonly<{
  directoryEntry: Extract<DirectoryLeafEntry, { targetType: "subvolume" }>;
  nextInodeNumber: InodeNumber;
  nextSubvolumeId: SubvolumeId;
  rootDirectoryInode: DirectoryInodeEntry;
  subvolume: NestedSubvolumeLeafEntry;
}>;

export function prepareSubvolumeCreatePlan({
  inodeTableRootHomeRef,
  maxTopologyEntries,
  nextInodeNumber,
  nextSubvolumeId,
  operationTimestamp,
  rootSubvolumeId,
  target,
  topologyMounts,
  topologyRows,
}: Readonly<{
  inodeTableRootHomeRef: HomeRecordReference;
  maxTopologyEntries: number;
  nextInodeNumber: InodeNumber;
  nextSubvolumeId: SubvolumeId;
  operationTimestamp: TimestampMilliseconds;
  rootSubvolumeId: SubvolumeId;
  target: SubvolumeCreateTarget;
  topologyMounts: readonly SubvolumeTopologyMount[];
  topologyRows: readonly NestedSubvolumeLeafEntry[];
}>): SubvolumeCreatePlan {
  const topology = validateSubvolumeTopology({
    maxTopologyEntries,
    mounts: topologyMounts,
    rootSubvolumeId,
    rows: topologyRows,
  });
  switch (target.requestedAccess) {
  case "read":
  case "read_write": break;
  default: target.requestedAccess satisfies never;
  }
  switch (target.parentAccess) {
  case "read_write": break;
  case "read": throw new SubvolumeCreatePlanError({
    code: "parent_read_only",
    message: "Subvolume creation requires a read-write parent",
  });
  default: target.parentAccess satisfies never;
  }
  if (
    target.parentSubvolumeId !== rootSubvolumeId
    && topology.rowFor({ subvolumeId: target.parentSubvolumeId }) === undefined
  ) {
    throw new SubvolumeCreatePlanError({
      code: "destination_parent_missing",
      message: "Subvolume creation destination parent is absent from the captured topology",
    });
  }
  if (target.destinationExists) {
    throw new SubvolumeCreatePlanError({
      code: "destination_exists",
      message: "Subvolume creation destination already exists",
    });
  }
  if (inodeTableRootHomeRef.recordKind !== HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page) {
    throw new SubvolumeCreatePlanError({
      code: "invalid_inode_table_root",
      message: "Subvolume creation requires an Inode Table root reference",
    });
  }
  if (nextSubvolumeId === UINT64_MAXIMUM) {
    throw new SubvolumeCreatePlanError({
      code: "subvolume_allocator_exhausted",
      message: "Subvolume ID allocator is exhausted",
    });
  }
  if (nextInodeNumber === UINT64_MAXIMUM) {
    throw new SubvolumeCreatePlanError({
      code: "inode_allocator_exhausted",
      message: "Inode Number allocator is exhausted",
    });
  }
  const knownSubvolumeIds = [rootSubvolumeId, ...topology.rows.map(row => row.subvolumeId)];
  const knownInodeNumbers = [
    target.parentDirectoryInodeNumber,
    ...topology.rows.flatMap(row => [row.parentDirectoryInodeNumber, row.rootDirectoryInodeNumber]),
  ];
  if (
    knownSubvolumeIds.some(subvolumeId => nextSubvolumeId <= subvolumeId)
    || knownInodeNumbers.some(inodeNumber => nextInodeNumber <= inodeNumber)
  ) {
    throw new SubvolumeCreatePlanError({
      code: "allocator_regression",
      message: "Subvolume creation allocator high-water marks do not exceed captured identities",
    });
  }

  const allocatedSubvolumeId = nextSubvolumeId;
  const allocatedRootDirectoryInodeNumber = nextInodeNumber;
  const directoryEntry = {
    name: target.entryName,
    subvolumeId: allocatedSubvolumeId,
    targetType: "subvolume",
  } as const;
  const rootDirectoryInode: DirectoryInodeEntry = {
    content: { entries: [], type: "inline" },
    inodeKind: "directory",
    inodeNumber: allocatedRootDirectoryInodeNumber,
    inodeRevision: createInodeRevision({ value: 1n }),
    timestamps: {
      createdAt: operationTimestamp,
      modifiedAt: operationTimestamp,
    },
  };

  return {
    directoryEntry,
    nextInodeNumber: createInodeNumber({ value: allocatedRootDirectoryInodeNumber + 1n }),
    nextSubvolumeId: createSubvolumeId({ value: allocatedSubvolumeId + 1n }),
    rootDirectoryInode,
    subvolume: {
      access: target.requestedAccess,
      entryName: target.entryName,
      inodeTableRootHomeRef,
      parentDirectoryInodeNumber: target.parentDirectoryInodeNumber,
      parentSubvolumeId: target.parentSubvolumeId,
      rootDirectoryInodeNumber: allocatedRootDirectoryInodeNumber,
      subvolumeId: allocatedSubvolumeId,
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
