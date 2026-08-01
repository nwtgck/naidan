import {
  createSubvolumeId,
  UINT64_MAXIMUM,
  type DirectoryLeafEntry,
  type HomeRecordReference,
  type InodeNumber,
  type NestedSubvolumeLeafEntry,
  type SubvolumeAccess,
  type SubvolumeId,
} from "@/00-storage/service/hizofs/00-format";
import {
  isSameContainerCoordinationKey,
  type ContainerCoordinationKey,
} from "@/00-storage/service/hizofs/filesystem/container-coordination-key";
import {
  validateSubvolumeTopology,
  type SubvolumeTopologyMount,
} from "@/00-storage/service/hizofs/filesystem/subvolume/subvolume-topology";

export type SubvolumeSnapshotPlanErrorCode =
  | "allocator_exhausted"
  | "allocator_regression"
  | "cross_device"
  | "destination_parent_missing"
  | "destination_exists"
  | "parent_read_only"
  | "recursive_snapshot_required"
  | "source_not_mounted";

export class SubvolumeSnapshotPlanError extends Error {
  readonly code: SubvolumeSnapshotPlanErrorCode;

  constructor({ code, message }: { code: SubvolumeSnapshotPlanErrorCode; message: string }) {
    super(message);
    this.name = "SubvolumeSnapshotPlanError";
    this.code = code;
  }
}

export type SubvolumeSnapshotSource = Readonly<{
  access: SubvolumeAccess;
  containerCoordinationKey: ContainerCoordinationKey;
  inodeTableRootHomeRef: HomeRecordReference;
  rootDirectoryInodeNumber: InodeNumber;
  subvolumeId: SubvolumeId;
}>;

export type SubvolumeSnapshotTarget = Readonly<{
  containerCoordinationKey: ContainerCoordinationKey;
  destinationExists: boolean;
  entryName: string;
  parentAccess: SubvolumeAccess;
  parentDirectoryInodeNumber: InodeNumber;
  parentSubvolumeId: SubvolumeId;
  requestedAccess: SubvolumeAccess;
}>;

export type SubvolumeSnapshotPlan = Readonly<{
  directoryEntry: Extract<DirectoryLeafEntry, { targetType: "subvolume" }>;
  nextSubvolumeId: SubvolumeId;
  snapshot: NestedSubvolumeLeafEntry;
}>;

function referencesAreEqual({ left, right }: {
  left: HomeRecordReference;
  right: HomeRecordReference;
}): boolean {
  if (left.recordKind !== right.recordKind
    || left.byteOffset !== right.byteOffset
    || left.frameLength !== right.frameLength
    || left.segmentId.byteLength !== right.segmentId.byteLength) return false;
  for (let index = 0; index < left.segmentId.byteLength; index += 1) {
    if (left.segmentId[index] !== right.segmentId[index]) return false;
  }
  return true;
}

export function prepareSubvolumeSnapshotPlan({
  maxTopologyEntries,
  nextSubvolumeId,
  rootSubvolumeId,
  source,
  target,
  topologyMounts,
  topologyRows,
}: {
  maxTopologyEntries: number;
  nextSubvolumeId: SubvolumeId;
  rootSubvolumeId: SubvolumeId;
  source: SubvolumeSnapshotSource;
  target: SubvolumeSnapshotTarget;
  topologyMounts: readonly SubvolumeTopologyMount[];
  topologyRows: readonly NestedSubvolumeLeafEntry[];
}): SubvolumeSnapshotPlan {
  switch (source.access) {
  case "read":
  case "read_write": break;
  default: source.access satisfies never;
  }
  switch (target.requestedAccess) {
  case "read":
  case "read_write": break;
  default: target.requestedAccess satisfies never;
  }
  switch (target.parentAccess) {
  case "read_write": break;
  case "read": throw new SubvolumeSnapshotPlanError({
    code: "parent_read_only",
    message: "Subvolume snapshot requires a read-write parent",
  });
  default: target.parentAccess satisfies never;
  }
  if (!isSameContainerCoordinationKey({
    left: source.containerCoordinationKey,
    right: target.containerCoordinationKey,
  })) {
    throw new SubvolumeSnapshotPlanError({
      code: "cross_device",
      message: "Subvolume snapshot source and destination must use the same physical container",
    });
  }
  if (target.destinationExists) {
    throw new SubvolumeSnapshotPlanError({
      code: "destination_exists",
      message: "Subvolume snapshot destination already exists",
    });
  }

  const topology = validateSubvolumeTopology({
    maxTopologyEntries,
    mounts: topologyMounts,
    rootSubvolumeId,
    rows: topologyRows,
  });
  if (source.subvolumeId !== rootSubvolumeId) {
    const sourceRow = topology.rowFor({ subvolumeId: source.subvolumeId });
    if (sourceRow === undefined
      || sourceRow.rootDirectoryInodeNumber !== source.rootDirectoryInodeNumber
      || !referencesAreEqual({ left: sourceRow.inodeTableRootHomeRef, right: source.inodeTableRootHomeRef })) {
      throw new SubvolumeSnapshotPlanError({
        code: "source_not_mounted",
        message: "Subvolume snapshot source does not match the captured topology",
      });
    }
  }
  if (target.parentSubvolumeId !== rootSubvolumeId
    && topology.rowFor({ subvolumeId: target.parentSubvolumeId }) === undefined) {
    throw new SubvolumeSnapshotPlanError({
      code: "destination_parent_missing",
      message: "Subvolume snapshot destination parent is absent from the captured topology",
    });
  }
  if (topology.childrenOf({ parentSubvolumeId: source.subvolumeId }).length > 0) {
    throw new SubvolumeSnapshotPlanError({
      code: "recursive_snapshot_required",
      message: "Subvolume snapshot with nested mounts requires the recursive snapshot planner",
    });
  }
  if (nextSubvolumeId === UINT64_MAXIMUM) {
    throw new SubvolumeSnapshotPlanError({
      code: "allocator_exhausted",
      message: "Subvolume ID allocator is exhausted",
    });
  }
  let greatestKnownSubvolumeId = source.subvolumeId > target.parentSubvolumeId
    ? source.subvolumeId
    : target.parentSubvolumeId;
  for (const row of topology.rows) {
    if (row.subvolumeId > greatestKnownSubvolumeId) greatestKnownSubvolumeId = row.subvolumeId;
  }
  if (nextSubvolumeId <= greatestKnownSubvolumeId) {
    throw new SubvolumeSnapshotPlanError({
      code: "allocator_regression",
      message: "Subvolume snapshot allocator high-water mark does not exceed known Subvolume IDs",
    });
  }

  const allocatedSubvolumeId = nextSubvolumeId;
  return {
    directoryEntry: {
      name: target.entryName,
      subvolumeId: allocatedSubvolumeId,
      targetType: "subvolume",
    },
    nextSubvolumeId: createSubvolumeId({ value: allocatedSubvolumeId + 1n }),
    snapshot: {
      access: target.requestedAccess,
      entryName: target.entryName,
      inodeTableRootHomeRef: source.inodeTableRootHomeRef,
      parentDirectoryInodeNumber: target.parentDirectoryInodeNumber,
      parentSubvolumeId: target.parentSubvolumeId,
      rootDirectoryInodeNumber: source.rootDirectoryInodeNumber,
      subvolumeId: allocatedSubvolumeId,
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
