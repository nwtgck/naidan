import {
  encodeHomeRecordReference,
  type NestedSubvolumeLeafEntry,
  type SubvolumeAccess,
  type SubvolumeId,
} from "@/00-storage/service/hizofs/00-format";
import {
  validateSubvolumeTopology,
  type SubvolumeTopologyMount,
} from "@/00-storage/service/hizofs/filesystem/subvolume/subvolume-topology";

export type SubvolumeDeletePlanErrorCode =
  | "duplicate_subvolume_identity"
  | "invalid_topology_limit"
  | "nested_subvolumes_present"
  | "parent_read_only"
  | "root_subvolume"
  | "target_not_mounted"
  | "topology_cycle"
  | "topology_limit_exceeded";

export class SubvolumeDeletePlanError extends Error {
  readonly code: SubvolumeDeletePlanErrorCode;

  constructor({ code, message }: { code: SubvolumeDeletePlanErrorCode; message: string }) {
    super(message);
    this.name = "SubvolumeDeletePlanError";
    this.code = code;
  }
}

export type SubvolumeDeletePlan = Readonly<{
  deletedSubvolumeIds: readonly SubvolumeId[];
  mountEntriesToRemove: readonly SubvolumeTopologyMount[];
  subvolumeRowsToRemove: readonly NestedSubvolumeLeafEntry[];
}>;

function referencesAreEqual({ left, right }: {
  left: NestedSubvolumeLeafEntry["inodeTableRootHomeRef"];
  right: NestedSubvolumeLeafEntry["inodeTableRootHomeRef"];
}): boolean {
  const leftBytes = encodeHomeRecordReference({ reference: left });
  const rightBytes = encodeHomeRecordReference({ reference: right });
  if (leftBytes.byteLength !== rightBytes.byteLength) return false;
  for (let index = 0; index < leftBytes.byteLength; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return false;
  }
  return true;
}

function rowsAreEqual({ left, right }: {
  left: NestedSubvolumeLeafEntry;
  right: NestedSubvolumeLeafEntry;
}): boolean {
  return left.access === right.access
    && left.entryName === right.entryName
    && left.parentDirectoryInodeNumber === right.parentDirectoryInodeNumber
    && left.parentSubvolumeId === right.parentSubvolumeId
    && left.rootDirectoryInodeNumber === right.rootDirectoryInodeNumber
    && left.subvolumeId === right.subvolumeId
    && referencesAreEqual({ left: left.inodeTableRootHomeRef, right: right.inodeTableRootHomeRef });
}

export function prepareSubvolumeDeletePlan({
  maxTopologyEntries,
  parentAccess,
  recursiveSubvolumes,
  rootSubvolumeId,
  target,
  topologyMounts,
  topologyRows,
}: Readonly<{
  maxTopologyEntries: number;
  parentAccess: SubvolumeAccess;
  recursiveSubvolumes: boolean;
  rootSubvolumeId: SubvolumeId;
  target: NestedSubvolumeLeafEntry;
  topologyMounts: readonly SubvolumeTopologyMount[];
  topologyRows: readonly NestedSubvolumeLeafEntry[];
}>): SubvolumeDeletePlan {
  switch (parentAccess) {
  case "read_write": break;
  case "read": throw new SubvolumeDeletePlanError({
    code: "parent_read_only",
    message: "Subvolume deletion requires a read-write parent",
  });
  default: parentAccess satisfies never;
  }
  if (target.subvolumeId === rootSubvolumeId) {
    throw new SubvolumeDeletePlanError({
      code: "root_subvolume",
      message: "The root Subvolume cannot be deleted",
    });
  }

  const topology = validateSubvolumeTopology({
    maxTopologyEntries,
    mounts: topologyMounts,
    rootSubvolumeId,
    rows: topologyRows,
  });

  const authoritativeTarget = topology.rowFor({ subvolumeId: target.subvolumeId });
  if (authoritativeTarget === undefined || !rowsAreEqual({ left: authoritativeTarget, right: target })) {
    throw new SubvolumeDeletePlanError({
      code: "target_not_mounted",
      message: "Subvolume deletion target is no longer mounted at the expected location",
    });
  }

  const directChildren = topology.childrenOf({ parentSubvolumeId: target.subvolumeId });
  if (!recursiveSubvolumes && directChildren.length > 0) {
    throw new SubvolumeDeletePlanError({
      code: "nested_subvolumes_present",
      message: "Subvolume contains nested Subvolumes and requires explicit recursive deletion",
    });
  }

  const visiting = new Set<SubvolumeId>();
  const visited = new Set<SubvolumeId>();
  const rowsToRemove: NestedSubvolumeLeafEntry[] = [];
  const stack: Array<Readonly<{ entry: NestedSubvolumeLeafEntry; phase: "enter" | "exit" }>> = [
    { entry: authoritativeTarget, phase: "enter" },
  ];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) throw new Error("Subvolume deletion traversal stack became inconsistent");
    switch (frame.phase) {
    case "exit": {
      visiting.delete(frame.entry.subvolumeId);
      if (!visited.has(frame.entry.subvolumeId)) {
        visited.add(frame.entry.subvolumeId);
        rowsToRemove.push(frame.entry);
      }
      continue;
    }
    case "enter": break;
    default: frame.phase satisfies never;
    }
    if (visiting.has(frame.entry.subvolumeId)) {
      throw new SubvolumeDeletePlanError({
        code: "topology_cycle",
        message: "Subvolume deletion topology contains a reachable cycle",
      });
    }
    if (visited.has(frame.entry.subvolumeId)) continue;
    visiting.add(frame.entry.subvolumeId);
    stack.push({ entry: frame.entry, phase: "exit" });
    const children = topology.childrenOf({ parentSubvolumeId: frame.entry.subvolumeId });
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child === undefined) throw new Error("Subvolume deletion child index became inconsistent");
      stack.push({ entry: child, phase: "enter" });
    }
  }

  return {
    deletedSubvolumeIds: rowsToRemove.map(entry => entry.subvolumeId),
    mountEntriesToRemove: rowsToRemove.map((entry) => {
      const mount = topology.mountFor({ subvolumeId: entry.subvolumeId });
      if (mount === undefined) throw new Error("validated Subvolume topology lost a required mount");
      return mount;
    }),
    subvolumeRowsToRemove: rowsToRemove,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
