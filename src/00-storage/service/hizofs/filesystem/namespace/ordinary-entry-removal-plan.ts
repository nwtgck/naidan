import type {
  DirectoryLeafEntry,
  InodeNumber,
  SubvolumeAccess,
  SubvolumeId,
} from "@/00-storage/service/hizofs/00-format";

export type OrdinaryEntryRemovalPlanErrorCode =
  | "directory_not_empty"
  | "directory_state_missing"
  | "invalid_limits"
  | "mounted_subvolume"
  | "read_only_parent"
  | "source_missing";

export class OrdinaryEntryRemovalPlanError extends Error {
  readonly code: OrdinaryEntryRemovalPlanErrorCode;

  constructor({ code, message }: { code: OrdinaryEntryRemovalPlanErrorCode; message: string }) {
    super(message);
    this.name = "OrdinaryEntryRemovalPlanError";
    this.code = code;
  }
}

export type OrdinaryEntryRemovalTarget = Readonly<{
  deleteBatchSize: number;
  parentDirectoryInodeNumber: InodeNumber;
  parentRemovalName: string;
  sourceInodeNumber: InodeNumber;
  subvolumeId: SubvolumeId;
}>;

export type OrdinaryEntryRemovalSource = Extract<DirectoryLeafEntry, { targetType: "inode" }>;

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

function asOrdinaryEntry({ entry }: { entry: DirectoryLeafEntry }): OrdinaryEntryRemovalSource {
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

export type OrdinaryRemovalDirectoryReader = Readonly<{
  readPage: ({ afterName, maximumEntries }: {
    afterName: string | undefined;
    maximumEntries: number;
  }) => Promise<Readonly<{
    entries: readonly DirectoryLeafEntry[];
    truncated: boolean;
  }>>;
}>;

export type OpenOrdinaryRemovalDirectory = ({ directoryEntry }: {
  directoryEntry: OrdinaryEntryRemovalSource;
}) => Promise<OrdinaryRemovalDirectoryReader>;

export function prepareOrdinaryEntryRemovalTarget({
  deleteBatchSize,
  parentAccess,
  parentDirectoryInodeNumber,
  parentSubvolumeId,
  sourceEntry,
}: {
  deleteBatchSize: number;
  parentAccess: SubvolumeAccess;
  parentDirectoryInodeNumber: InodeNumber;
  parentSubvolumeId: SubvolumeId;
  sourceEntry: DirectoryLeafEntry | null;
}): Readonly<{
  source: OrdinaryEntryRemovalSource;
  target: OrdinaryEntryRemovalTarget;
}> {
  if (!Number.isSafeInteger(deleteBatchSize) || deleteBatchSize < 1) {
    throw new OrdinaryEntryRemovalPlanError({
      code: "invalid_limits",
      message: "ordinary removal requires a positive safe-integer delete batch size",
    });
  }
  assertMutable({ access: parentAccess });
  if (sourceEntry === null) {
    throw new OrdinaryEntryRemovalPlanError({
      code: "source_missing",
      message: "ordinary entry removal source does not exist",
    });
  }
  const source = asOrdinaryEntry({ entry: sourceEntry });
  return {
    source,
    target: {
      deleteBatchSize,
      parentDirectoryInodeNumber,
      parentRemovalName: source.name,
      sourceInodeNumber: source.inodeNumber,
      subvolumeId: parentSubvolumeId,
    },
  };
}

type StreamingRemovalTraversalTask =
  | Readonly<{
      afterName: string | undefined;
      directoryEntry: OrdinaryEntryRemovalSource;
      reader: OrdinaryRemovalDirectoryReader | undefined;
      type: "directory_page";
    }>
  | Readonly<{
      entry: OrdinaryEntryRemovalSource;
      type: "entry";
    }>;

/**
 * Streams inode deletion keys from one already globally validated immutable
 * ordinary namespace. The caller owns that global proof; this traversal does
 * not retain another subtree-sized identity Set. Each active directory keeps
 * at most one bounded page reader on the depth-bounded traversal stack.
 */
export async function* streamOrdinaryEntryRemovalInodeBatches({
  deleteBatchSize,
  openDirectory,
  recursive,
  source,
}: {
  deleteBatchSize: number;
  openDirectory: OpenOrdinaryRemovalDirectory;
  recursive: boolean;
  source: OrdinaryEntryRemovalSource;
}): AsyncGenerator<readonly InodeNumber[]> {
  if (!Number.isSafeInteger(deleteBatchSize) || deleteBatchSize < 1) {
    throw new OrdinaryEntryRemovalPlanError({
      code: "invalid_limits",
      message: "ordinary removal requires a positive safe-integer delete batch size",
    });
  }

  const pendingBatch: InodeNumber[] = [source.inodeNumber];
  switch (source.inodeKind) {
  case "file":
  case "symlink":
    yield pendingBatch.splice(0, pendingBatch.length);
    return;
  case "directory": break;
  default: source.inodeKind satisfies never;
  }

  if (!recursive) {
    const directory = await openDirectory({ directoryEntry: source });
    const listing = await directory.readPage({
      afterName: undefined,
      maximumEntries: 1,
    });
    for (const entry of listing.entries) asOrdinaryEntry({ entry });
    if (listing.truncated || listing.entries.length > 0) {
      throw new OrdinaryEntryRemovalPlanError({
        code: "directory_not_empty",
        message: "ordinary non-recursive removal requires an empty directory",
      });
    }
    yield pendingBatch.splice(0, pendingBatch.length);
    return;
  }

  if (pendingBatch.length === deleteBatchSize) {
    yield pendingBatch.splice(0, pendingBatch.length);
  }
  const stack: StreamingRemovalTraversalTask[] = [{
    afterName: undefined,
    directoryEntry: source,
    reader: undefined,
    type: "directory_page",
  }];
  while (stack.length > 0) {
    const task = stack.pop();
    if (task === undefined) throw new Error("ordinary removal traversal stack became inconsistent");
    switch (task.type) {
    case "entry": {
      pendingBatch.push(task.entry.inodeNumber);
      if (pendingBatch.length === deleteBatchSize) {
        yield pendingBatch.splice(0, pendingBatch.length);
      }
      switch (task.entry.inodeKind) {
      case "file":
      case "symlink": break;
      case "directory":
        stack.push({
          afterName: undefined,
          directoryEntry: task.entry,
          reader: undefined,
          type: "directory_page",
        });
        break;
      default: task.entry.inodeKind satisfies never;
      }
      break;
    }
    case "directory_page": {
      const reader = task.reader ?? await openDirectory({ directoryEntry: task.directoryEntry });
      const listing = await reader.readPage({
        afterName: task.afterName,
        maximumEntries: deleteBatchSize,
      });
      const ordinaryEntries = listing.entries.map(entry => asOrdinaryEntry({ entry }));
      if (listing.truncated) {
        const lastEntry = ordinaryEntries.at(-1);
        if (lastEntry === undefined) {
          throw new OrdinaryEntryRemovalPlanError({
            code: "directory_state_missing",
            message: "bounded directory continuation cannot advance without an entry",
          });
        }
        stack.push({
          afterName: lastEntry.name,
          directoryEntry: task.directoryEntry,
          reader,
          type: "directory_page",
        });
      }
      for (let index = ordinaryEntries.length - 1; index >= 0; index -= 1) {
        const entry = ordinaryEntries[index];
        if (entry === undefined) throw new Error("ordinary removal directory index became inconsistent");
        stack.push({ entry, type: "entry" });
      }
      break;
    }
    default: task satisfies never;
    }
  }
  if (pendingBatch.length > 0) yield pendingBatch.splice(0, pendingBatch.length);
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
