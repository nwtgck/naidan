import type {
  DirectoryLeafEntry,
  HomeRecordReference,
  InodeNumber,
  NestedSubvolumeLeafEntry,
  SubvolumeAccess,
  SubvolumeId,
} from "@/00-storage/service/hizofs/00-format";
import {
  validateSubvolumeTopology,
  type SubvolumeTopologyMount,
} from "@/00-storage/service/hizofs/filesystem/subvolume/subvolume-topology";

export type SubvolumeMountMovePlanErrorCode =
  | "cross_subvolume"
  | "destination_exists"
  | "parent_read_only"
  | "source_missing"
  | "source_not_mounted";

export class SubvolumeMountMovePlanError extends Error {
  readonly code: SubvolumeMountMovePlanErrorCode;

  constructor({ code, message }: { code: SubvolumeMountMovePlanErrorCode; message: string }) {
    super(message);
    this.name = "SubvolumeMountMovePlanError";
    this.code = code;
  }
}

export type SubvolumeMountMoveDestination = Readonly<{
  entryName: string;
  exists: boolean;
  parentAccess: SubvolumeAccess;
  parentDirectoryInodeNumber: InodeNumber;
  parentSubvolumeId: SubvolumeId;
}>;

export type SubvolumeMountMovePlan = Readonly<{
  destinationMountEntry: Extract<DirectoryLeafEntry, { targetType: "subvolume" }>;
  sourceMount: SubvolumeTopologyMount;
  updatedRow: NestedSubvolumeLeafEntry;
}>;

function bytesAreEqual({ left, right }: { left: Uint8Array; right: Uint8Array }): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function referencesAreEqual({ left, right }: {
  left: HomeRecordReference;
  right: HomeRecordReference;
}): boolean {
  return left.byteOffset === right.byteOffset
    && left.frameLength === right.frameLength
    && left.recordKind === right.recordKind
    && bytesAreEqual({ left: left.segmentId, right: right.segmentId });
}

function rowsAreEqual({ left, right }: {
  left: NestedSubvolumeLeafEntry;
  right: NestedSubvolumeLeafEntry;
}): boolean {
  return left.access === right.access
    && left.entryName === right.entryName
    && referencesAreEqual({ left: left.inodeTableRootHomeRef, right: right.inodeTableRootHomeRef })
    && left.parentDirectoryInodeNumber === right.parentDirectoryInodeNumber
    && left.parentSubvolumeId === right.parentSubvolumeId
    && left.rootDirectoryInodeNumber === right.rootDirectoryInodeNumber
    && left.subvolumeId === right.subvolumeId;
}

export function prepareSubvolumeMountMovePlan({
  destination,
  maxTopologyEntries,
  rootSubvolumeId,
  source,
  topologyMounts,
  topologyRows,
}: {
  destination: SubvolumeMountMoveDestination;
  maxTopologyEntries: number;
  rootSubvolumeId: SubvolumeId;
  source: NestedSubvolumeLeafEntry | null;
  topologyMounts: readonly SubvolumeTopologyMount[];
  topologyRows: readonly NestedSubvolumeLeafEntry[];
}): SubvolumeMountMovePlan | null {
  if (source === null) {
    throw new SubvolumeMountMovePlanError({
      code: "source_missing",
      message: "Subvolume mount move source does not exist",
    });
  }
  const topology = validateSubvolumeTopology({
    maxTopologyEntries,
    mounts: topologyMounts,
    rootSubvolumeId,
    rows: topologyRows,
  });
  const capturedSource = topology.rowFor({ subvolumeId: source.subvolumeId });
  const sourceMount = topology.mountFor({ subvolumeId: source.subvolumeId });
  if (capturedSource === undefined || sourceMount === undefined || !rowsAreEqual({ left: capturedSource, right: source })) {
    throw new SubvolumeMountMovePlanError({
      code: "source_not_mounted",
      message: "Subvolume mount move source does not match the captured topology",
    });
  }
  switch (destination.parentAccess) {
  case "read_write": break;
  case "read": throw new SubvolumeMountMovePlanError({
    code: "parent_read_only",
    message: "Subvolume mount move requires a read-write parent",
  });
  default: destination.parentAccess satisfies never;
  }
  if (capturedSource.parentSubvolumeId !== destination.parentSubvolumeId) {
    throw new SubvolumeMountMovePlanError({
      code: "cross_subvolume",
      message: "Subvolume mount move cannot cross a parent Subvolume boundary",
    });
  }
  if (
    sourceMount.parentDirectoryInodeNumber === destination.parentDirectoryInodeNumber
    && sourceMount.entry.name === destination.entryName
  ) {
    return null;
  }
  if (destination.exists) {
    throw new SubvolumeMountMovePlanError({
      code: "destination_exists",
      message: "Subvolume mount move does not replace an existing destination",
    });
  }

  return {
    destinationMountEntry: {
      name: destination.entryName,
      subvolumeId: capturedSource.subvolumeId,
      targetType: "subvolume",
    },
    sourceMount,
    updatedRow: {
      ...capturedSource,
      entryName: destination.entryName,
      parentDirectoryInodeNumber: destination.parentDirectoryInodeNumber,
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
