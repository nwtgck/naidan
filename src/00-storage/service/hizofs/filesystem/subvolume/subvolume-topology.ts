import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  type DirectoryLeafEntry,
  type InodeNumber,
  type NestedSubvolumeLeafEntry,
  type SubvolumeId,
} from "@/00-storage/service/hizofs/00-format";

export type SubvolumeTopologyMount = Readonly<{
  entry: Extract<DirectoryLeafEntry, { targetType: "subvolume" }>;
  parentDirectoryInodeNumber: InodeNumber;
  parentSubvolumeId: SubvolumeId;
}>;

export type SubvolumeTopologyErrorCode =
  | "duplicate_mount_identity"
  | "duplicate_mount_location"
  | "duplicate_subvolume_identity"
  | "invalid_inode_table_root"
  | "invalid_topology_limit"
  | "missing_mount"
  | "orphan_mount"
  | "orphan_parent"
  | "root_mount_present"
  | "root_row_present"
  | "row_mount_disagreement"
  | "topology_cycle"
  | "topology_limit_exceeded";

export class SubvolumeTopologyError extends Error {
  readonly code: SubvolumeTopologyErrorCode;

  constructor({ code, message }: { code: SubvolumeTopologyErrorCode; message: string }) {
    super(message);
    this.name = "SubvolumeTopologyError";
    this.code = code;
  }
}

export type ValidatedSubvolumeTopology = Readonly<{
  childrenOf: ({ parentSubvolumeId }: { parentSubvolumeId: SubvolumeId }) => readonly NestedSubvolumeLeafEntry[];
  mountFor: ({ subvolumeId }: { subvolumeId: SubvolumeId }) => SubvolumeTopologyMount | undefined;
  mounts: readonly SubvolumeTopologyMount[];
  rowFor: ({ subvolumeId }: { subvolumeId: SubvolumeId }) => NestedSubvolumeLeafEntry | undefined;
  rows: readonly NestedSubvolumeLeafEntry[];
}>;

function mountLocationIdentity({ mount }: { mount: SubvolumeTopologyMount }): string {
  return `${mount.parentSubvolumeId}:${mount.parentDirectoryInodeNumber}:${mount.entry.name.length}:${mount.entry.name}`;
}

function rowsAgreeWithMount({ mount, row }: {
  mount: SubvolumeTopologyMount;
  row: NestedSubvolumeLeafEntry;
}): boolean {
  return mount.entry.name === row.entryName
    && mount.entry.subvolumeId === row.subvolumeId
    && mount.parentDirectoryInodeNumber === row.parentDirectoryInodeNumber
    && mount.parentSubvolumeId === row.parentSubvolumeId;
}

function cloneRow({ row }: { row: NestedSubvolumeLeafEntry }): NestedSubvolumeLeafEntry {
  return { ...row };
}

function cloneMount({ mount }: { mount: SubvolumeTopologyMount }): SubvolumeTopologyMount {
  return { ...mount, entry: { ...mount.entry } };
}

export function validateSubvolumeTopology({ maxTopologyEntries, mounts, rootSubvolumeId, rows }: {
  maxTopologyEntries: number;
  mounts: readonly SubvolumeTopologyMount[];
  rootSubvolumeId: SubvolumeId;
  rows: readonly NestedSubvolumeLeafEntry[];
}): ValidatedSubvolumeTopology {
  if (!Number.isSafeInteger(maxTopologyEntries) || maxTopologyEntries < 1) {
    throw new SubvolumeTopologyError({
      code: "invalid_topology_limit",
      message: "Subvolume topology validation requires a positive safe entry limit",
    });
  }
  if (rows.length > maxTopologyEntries || mounts.length > maxTopologyEntries) {
    throw new SubvolumeTopologyError({
      code: "topology_limit_exceeded",
      message: "Subvolume topology exceeds the explicit row or mount memory bound",
    });
  }

  const stableRows = rows.map(row => cloneRow({ row }));
  const stableMounts = mounts.map(mount => cloneMount({ mount }));
  const rowById = new Map<SubvolumeId, NestedSubvolumeLeafEntry>();
  const mountById = new Map<SubvolumeId, SubvolumeTopologyMount>();
  const mountLocations = new Set<string>();
  const childrenByParentId = new Map<SubvolumeId, NestedSubvolumeLeafEntry[]>();

  for (const row of stableRows) {
    if (row.subvolumeId === rootSubvolumeId) {
      throw new SubvolumeTopologyError({
        code: "root_row_present",
        message: "The implicit root Subvolume must not appear in the Nested Subvolume Table",
      });
    }
    if (row.inodeTableRootHomeRef.recordKind !== HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page) {
      throw new SubvolumeTopologyError({
        code: "invalid_inode_table_root",
        message: "Nested Subvolume row must reference an Inode Table page root",
      });
    }
    if (rowById.has(row.subvolumeId)) {
      throw new SubvolumeTopologyError({
        code: "duplicate_subvolume_identity",
        message: "Nested Subvolume Table contains a duplicate Subvolume identity",
      });
    }
    rowById.set(row.subvolumeId, row);
    const children = childrenByParentId.get(row.parentSubvolumeId) ?? [];
    children.push(row);
    childrenByParentId.set(row.parentSubvolumeId, children);
  }

  for (const mount of stableMounts) {
    if (mount.entry.subvolumeId === rootSubvolumeId) {
      throw new SubvolumeTopologyError({
        code: "root_mount_present",
        message: "The implicit root Subvolume must not have a parent mount entry",
      });
    }
    if (mountById.has(mount.entry.subvolumeId)) {
      throw new SubvolumeTopologyError({
        code: "duplicate_mount_identity",
        message: "Subvolume topology contains more than one mount for one Subvolume identity",
      });
    }
    const location = mountLocationIdentity({ mount });
    if (mountLocations.has(location)) {
      throw new SubvolumeTopologyError({
        code: "duplicate_mount_location",
        message: "Subvolume topology contains more than one mount at one directory location",
      });
    }
    mountLocations.add(location);
    mountById.set(mount.entry.subvolumeId, mount);
  }

  for (const row of stableRows) {
    const mount = mountById.get(row.subvolumeId);
    if (mount === undefined) {
      throw new SubvolumeTopologyError({
        code: "missing_mount",
        message: "Nested Subvolume row has no matching parent Directory Entry",
      });
    }
    if (!rowsAgreeWithMount({ mount, row })) {
      throw new SubvolumeTopologyError({
        code: "row_mount_disagreement",
        message: "Nested Subvolume row disagrees with its parent Directory Entry",
      });
    }
    if (row.parentSubvolumeId !== rootSubvolumeId && !rowById.has(row.parentSubvolumeId)) {
      throw new SubvolumeTopologyError({
        code: "orphan_parent",
        message: "Nested Subvolume row references a missing parent Subvolume",
      });
    }
  }
  for (const mount of stableMounts) {
    if (!rowById.has(mount.entry.subvolumeId)) {
      throw new SubvolumeTopologyError({
        code: "orphan_mount",
        message: "Subvolume parent Directory Entry has no matching Nested Subvolume row",
      });
    }
  }

  const reached = new Set<SubvolumeId>();
  const queue = [...(childrenByParentId.get(rootSubvolumeId) ?? [])];
  for (let index = 0; index < queue.length; index += 1) {
    const row = queue[index];
    if (row === undefined) throw new Error("Subvolume topology traversal queue became inconsistent");
    if (reached.has(row.subvolumeId)) {
      throw new SubvolumeTopologyError({
        code: "topology_cycle",
        message: "Subvolume topology contains a cycle or duplicate parent reachability",
      });
    }
    reached.add(row.subvolumeId);
    queue.push(...(childrenByParentId.get(row.subvolumeId) ?? []));
  }
  if (reached.size !== stableRows.length) {
    throw new SubvolumeTopologyError({
      code: "topology_cycle",
      message: "Subvolume topology contains a cycle disconnected from the implicit root",
    });
  }

  for (const children of childrenByParentId.values()) {
    children.sort((left, right) => left.subvolumeId < right.subvolumeId ? -1 : left.subvolumeId > right.subvolumeId ? 1 : 0);
  }

  return {
    childrenOf: ({ parentSubvolumeId }) => childrenByParentId.get(parentSubvolumeId) ?? [],
    mountFor: ({ subvolumeId }) => mountById.get(subvolumeId),
    mounts: stableMounts,
    rowFor: ({ subvolumeId }) => rowById.get(subvolumeId),
    rows: stableRows,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
