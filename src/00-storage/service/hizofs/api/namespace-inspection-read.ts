import type {
  DirectoryLeafEntry,
  HomeRecordReference,
  InodeLeafEntry,
  InodeNumber,
} from "@/00-storage/service/hizofs/00-format";
import {
  createReadOnlyNamespaceResolver,
  type ReadOnlyNamespacePageSource,
} from "@/00-storage/service/hizofs/filesystem/read-only-namespace";

export type HizoFSNamespaceInspectionPageSource = ReadOnlyNamespacePageSource;

export type HizoFSNamespacePathRead = Readonly<{
  directory: Readonly<{
    entries: readonly DirectoryLeafEntry[];
    truncated: boolean;
  }> | undefined;
  inode: InodeLeafEntry;
  symlinkTarget: string | undefined;
}>;

/**
 * Keeps filesystem traversal in the public API owner. Inspector code supplies
 * authenticated page reads but cannot reach filesystem internals directly.
 */
export async function readHizoFSNamespacePathForInspection({
  inodeTableRootHomeRef,
  maximumDirectoryEntries,
  pathComponents,
  rootDirectoryInodeNumber,
  source,
}: {
  inodeTableRootHomeRef: HomeRecordReference;
  maximumDirectoryEntries: number;
  pathComponents: readonly string[];
  rootDirectoryInodeNumber: InodeNumber;
  source: HizoFSNamespaceInspectionPageSource;
}): Promise<HizoFSNamespacePathRead> {
  const namespace = createReadOnlyNamespaceResolver({
    inodeTableRootHomeRef,
    rootDirectoryInodeNumber,
    source,
  });
  const inode = await namespace.resolveInode({ pathComponents });
  switch (inode.inodeKind) {
  case "directory":
    return {
      directory: await namespace.listDirectoryEntriesBounded({
        inode,
        maximumEntries: maximumDirectoryEntries,
      }),
      inode,
      symlinkTarget: undefined,
    };
  case "file":
    return { directory: undefined, inode, symlinkTarget: undefined };
  case "symlink":
    return {
      directory: undefined,
      inode,
      symlinkTarget: inode.target,
    };
  default: return inode satisfies never;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
