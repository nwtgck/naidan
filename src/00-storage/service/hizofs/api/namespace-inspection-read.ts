import type {
  DirectoryLeafEntry,
  HomeRecordReference,
  InodeNumber,
} from "@/00-storage/service/hizofs/00-format";
import {
  createReadOnlyNamespace,
  type ReadOnlyInodeStat,
  type ReadOnlyNamespacePageSource,
} from "@/00-storage/service/hizofs/filesystem/read-only-namespace";

export type HizoFSNamespaceInspectionPageSource = ReadOnlyNamespacePageSource;

export type HizoFSNamespacePathRead = Readonly<{
  directory: Readonly<{
    entries: readonly DirectoryLeafEntry[];
    truncated: boolean;
  }> | undefined;
  stat: ReadOnlyInodeStat;
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
  const namespace = createReadOnlyNamespace({
    inodeTableRootHomeRef,
    rootDirectoryInodeNumber,
    source,
  });
  const stat = await namespace.stat({ pathComponents });
  switch (stat.kind) {
  case "directory":
    return {
      directory: await namespace.listBounded({
        maximumEntries: maximumDirectoryEntries,
        pathComponents,
      }),
      stat,
      symlinkTarget: undefined,
    };
  case "file":
    return { directory: undefined, stat, symlinkTarget: undefined };
  case "symlink":
    return {
      directory: undefined,
      stat,
      symlinkTarget: await namespace.readlink({ pathComponents }),
    };
  default: return stat.kind satisfies never;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
