import type {
  DirectoryInodeEntry,
  DirectoryLeafEntry,
  InodeLeafEntry,
} from "@/00-storage/service/hizofs/00-format";
import type {
  ReadOnlyInodeStat,
  ReadOnlyNamespaceResolver,
} from "@/00-storage/service/hizofs/filesystem/read-only-namespace";
import type {
  TransitionNamespaceEntry,
  TransitionNamespaceMetadata,
  TransitionNamespaceSourcePort,
} from "@/00-storage/service/naidan-persistence-control/transition/namespace-copy";

function metadataFromStat({ stat }: { stat: ReadOnlyInodeStat }): TransitionNamespaceMetadata {
  return {
    createdAt: stat.createdAt === null ? undefined : BigInt(stat.createdAt),
    modifiedAt: stat.modifiedAt === null ? undefined : BigInt(stat.modifiedAt),
  };
}

function metadataFromInode({ inode }: { inode: InodeLeafEntry }): TransitionNamespaceMetadata {
  return {
    createdAt: inode.timestamps.createdAt === null ? undefined : BigInt(inode.timestamps.createdAt),
    modifiedAt: inode.timestamps.modifiedAt === null ? undefined : BigInt(inode.timestamps.modifiedAt),
  };
}

function requireDirectory({ inode }: { inode: InodeLeafEntry }): DirectoryInodeEntry {
  switch (inode.inodeKind) {
  case "directory": return inode;
  case "file":
  case "symlink": throw new TypeError("HizoFS transition source path is not a directory");
  default: return inode satisfies never;
  }
}

async function projectEntry({ entry, resolver }: {
  entry: DirectoryLeafEntry;
  resolver: ReadOnlyNamespaceResolver;
}): Promise<TransitionNamespaceEntry> {
  switch (entry.targetType) {
  case "subvolume": throw new TypeError("HizoFS transition source cannot flatten a nested Subvolume boundary");
  case "inode": break;
  default: return entry satisfies never;
  }
  const inode = await resolver.resolveInodeByNumber({ inodeNumber: entry.inodeNumber });
  if (inode.inodeKind !== entry.inodeKind) {
    throw new TypeError("HizoFS transition source directory entry disagrees with its inode kind");
  }
  const metadata = metadataFromInode({ inode });
  switch (inode.inodeKind) {
  case "directory": return { kind: "directory", metadata, name: entry.name };
  case "file": return { kind: "file", metadata, name: entry.name, size: BigInt(inode.fileSize) };
  case "symlink": return { kind: "symlink", metadata, name: entry.name };
  default: return inode satisfies never;
  }
}

/**
 * Projects an authenticated private candidate into the same bounded source
 * contract used by transition verification. Pagination remains inside the
 * immutable HizoFS indexes, so verification never materializes a whole
 * directory or exposes record references outside the HizoFS owner.
 */
export function createHizoFSTransitionNamespaceSource({ resolver }: {
  resolver: ReadOnlyNamespaceResolver;
}): TransitionNamespaceSourcePort {
  return {
    readRootMetadata: async () => metadataFromStat({ stat: await resolver.stat({ pathComponents: [] }) }),
    listDirectory: async ({ afterName, maximumEntries, path }) => {
      if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1) {
        throw new TypeError("HizoFS transition source maximum entries must be a positive safe integer");
      }
      const inode = requireDirectory({ inode: await resolver.resolveInode({ pathComponents: path }) });
      const listing = await resolver.listDirectoryEntriesAfterBounded({ afterName, inode, maximumEntries });
      return {
        entries: await Promise.all(listing.entries.map(async entry => await projectEntry({ entry, resolver }))),
        state: listing.truncated ? "more" : "complete",
      };
    },
    readFileChunk: async ({ maximumBytes, offset, path }) => {
      if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
        throw new TypeError("HizoFS transition source maximum bytes must be a positive safe integer");
      }
      const stat = await resolver.stat({ pathComponents: path });
      if (stat.kind !== "file" || stat.fileSize === undefined) {
        throw new TypeError("HizoFS transition source file path is not a file");
      }
      const size = BigInt(stat.fileSize);
      if (offset < 0n || offset > size) throw new RangeError("HizoFS transition source file offset is outside the file");
      const length = size - offset < BigInt(maximumBytes) ? size - offset : BigInt(maximumBytes);
      const bytes = await resolver.readFile({ length, offset, pathComponents: path });
      if (BigInt(bytes.byteLength) !== length) {
        throw new TypeError("HizoFS transition source returned an unexpected bounded file length");
      }
      return { bytes, state: offset + length === size ? "complete" : "more" };
    },
    readSymlink: async ({ path }) => await resolver.readlink({ pathComponents: path }),
  };
}

export const TEST_ONLY = {
  metadataFromInode,
  metadataFromStat,
  projectEntry,
  requireDirectory,
};
