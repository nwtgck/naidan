import type {
  DirectoryLeafEntry,
  InodeNumber,
  SubvolumeAccess,
  SubvolumeId,
} from "@/00-storage/service/hizofs/00-format";

export type OrdinaryEntryRemovalPlanErrorCode =
  | "directory_not_empty"
  | "directory_state_missing"
  | "invalid_directory_graph"
  | "invalid_limits"
  | "mounted_subvolume"
  | "read_only_parent"
  | "source_missing"
  | "traversal_limit_exceeded";

export class OrdinaryEntryRemovalPlanError extends Error {
  readonly code: OrdinaryEntryRemovalPlanErrorCode;

  constructor({ code, message }: { code: OrdinaryEntryRemovalPlanErrorCode; message: string }) {
    super(message);
    this.name = "OrdinaryEntryRemovalPlanError";
    this.code = code;
  }
}

export type OrdinaryEntryRemovalPlan = Readonly<{
  deleteBatches: readonly (readonly InodeNumber[])[];
  parentDirectoryInodeNumber: InodeNumber;
  parentRemovalName: string;
  removedInodeNumbersPostOrder: readonly InodeNumber[];
  subvolumeId: SubvolumeId;
}>;

type OrdinaryInodeEntry = Extract<DirectoryLeafEntry, { targetType: "inode" }>;

type TraversalFrame = Readonly<{
  entry: OrdinaryInodeEntry;
  expanded: boolean;
}>;

function validateLimits({ deleteBatchSize, maxVisitedInodes }: {
  deleteBatchSize: number;
  maxVisitedInodes: number;
}): void {
  if (
    !Number.isSafeInteger(deleteBatchSize)
    || deleteBatchSize < 1
    || !Number.isSafeInteger(maxVisitedInodes)
    || maxVisitedInodes < 1
  ) {
    throw new OrdinaryEntryRemovalPlanError({
      code: "invalid_limits",
      message: "ordinary removal requires positive safe-integer traversal limits",
    });
  }
}

function assertMutable({ access }: { access: SubvolumeAccess }): void {
  switch (access) {
  case "read_write": return;
  case "read":
    throw new OrdinaryEntryRemovalPlanError({
      code: "read_only_parent",
      message: "ordinary entry removal requires a mutable parent Subvolume",
    });
  default: access satisfies never;
  }
}

function asOrdinaryEntry({ entry }: { entry: DirectoryLeafEntry }): OrdinaryInodeEntry {
  switch (entry.targetType) {
  case "inode": return entry;
  case "subvolume":
    throw new OrdinaryEntryRemovalPlanError({
      code: "mounted_subvolume",
      message: "ordinary entry removal cannot remove a mounted Subvolume",
    });
  default: return entry satisfies never;
  }
}

function directoryEntriesFor({ directoryEntries, inodeNumber }: {
  directoryEntries: ReadonlyMap<InodeNumber, readonly DirectoryLeafEntry[]>;
  inodeNumber: InodeNumber;
}): readonly DirectoryLeafEntry[] {
  const entries = directoryEntries.get(inodeNumber);
  if (entries === undefined) {
    throw new OrdinaryEntryRemovalPlanError({
      code: "directory_state_missing",
      message: "ordinary removal cannot resolve an authoritative directory state",
    });
  }
  return entries;
}

function createDeleteBatches({ batchSize, inodeNumbers }: {
  batchSize: number;
  inodeNumbers: readonly InodeNumber[];
}): readonly (readonly InodeNumber[])[] {
  const batches: InodeNumber[][] = [];
  for (let offset = 0; offset < inodeNumbers.length; offset += batchSize) {
    batches.push(inodeNumbers.slice(offset, offset + batchSize));
  }
  return batches;
}

export function prepareOrdinaryEntryRemovalPlan({
  directoryEntries,
  limits,
  parentAccess,
  parentDirectoryInodeNumber,
  parentSubvolumeId,
  recursive,
  sourceEntry,
}: {
  directoryEntries: ReadonlyMap<InodeNumber, readonly DirectoryLeafEntry[]>;
  limits: Readonly<{ deleteBatchSize: number; maxVisitedInodes: number }>;
  parentAccess: SubvolumeAccess;
  parentDirectoryInodeNumber: InodeNumber;
  parentSubvolumeId: SubvolumeId;
  recursive: boolean;
  sourceEntry: DirectoryLeafEntry | null;
}): OrdinaryEntryRemovalPlan {
  validateLimits(limits);
  assertMutable({ access: parentAccess });
  if (sourceEntry === null) {
    throw new OrdinaryEntryRemovalPlanError({
      code: "source_missing",
      message: "ordinary entry removal source does not exist",
    });
  }
  const source = asOrdinaryEntry({ entry: sourceEntry });

  switch (source.inodeKind) {
  case "file":
  case "symlink": {
    const removedInodeNumbersPostOrder = [source.inodeNumber];
    return {
      deleteBatches: createDeleteBatches({ batchSize: limits.deleteBatchSize, inodeNumbers: removedInodeNumbersPostOrder }),
      parentDirectoryInodeNumber,
      parentRemovalName: source.name,
      removedInodeNumbersPostOrder,
      subvolumeId: parentSubvolumeId,
    };
  }
  case "directory": break;
  default: source.inodeKind satisfies never;
  }

  const sourceDirectoryEntries = directoryEntriesFor({
    directoryEntries,
    inodeNumber: source.inodeNumber,
  });
  if (!recursive) {
    for (const entry of sourceDirectoryEntries) asOrdinaryEntry({ entry });
    if (sourceDirectoryEntries.length > 0) {
      throw new OrdinaryEntryRemovalPlanError({
        code: "directory_not_empty",
        message: "ordinary non-recursive removal requires an empty directory",
      });
    }
    const removedInodeNumbersPostOrder = [source.inodeNumber];
    return {
      deleteBatches: createDeleteBatches({ batchSize: limits.deleteBatchSize, inodeNumbers: removedInodeNumbersPostOrder }),
      parentDirectoryInodeNumber,
      parentRemovalName: source.name,
      removedInodeNumbersPostOrder,
      subvolumeId: parentSubvolumeId,
    };
  }

  const visited = new Set<InodeNumber>();
  const removedInodeNumbersPostOrder: InodeNumber[] = [];
  const stack: TraversalFrame[] = [{ entry: source, expanded: false }];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) throw new Error("ordinary removal traversal stack became inconsistent");
    if (frame.expanded) {
      removedInodeNumbersPostOrder.push(frame.entry.inodeNumber);
      continue;
    }
    if (visited.has(frame.entry.inodeNumber)) {
      throw new OrdinaryEntryRemovalPlanError({
        code: "invalid_directory_graph",
        message: "ordinary removal found a cycle or reused inode identity",
      });
    }
    if (visited.size >= limits.maxVisitedInodes) {
      throw new OrdinaryEntryRemovalPlanError({
        code: "traversal_limit_exceeded",
        message: "ordinary removal traversal exceeded its explicit inode budget",
      });
    }
    visited.add(frame.entry.inodeNumber);
    stack.push({ entry: frame.entry, expanded: true });

    switch (frame.entry.inodeKind) {
    case "file":
    case "symlink": break;
    case "directory": {
      const children = directoryEntriesFor({
        directoryEntries,
        inodeNumber: frame.entry.inodeNumber,
      });
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (child === undefined) throw new Error("ordinary removal directory index became inconsistent");
        stack.push({ entry: asOrdinaryEntry({ entry: child }), expanded: false });
      }
      break;
    }
    default: frame.entry.inodeKind satisfies never;
    }
  }

  return {
    deleteBatches: createDeleteBatches({ batchSize: limits.deleteBatchSize, inodeNumbers: removedInodeNumbersPostOrder }),
    parentDirectoryInodeNumber,
    parentRemovalName: source.name,
    removedInodeNumbersPostOrder,
    subvolumeId: parentSubvolumeId,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
