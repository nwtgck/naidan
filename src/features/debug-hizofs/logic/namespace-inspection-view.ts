import type {
  HizoFSHomeRecordInspectionRequest,
  HizoFSNamespacePathInspection,
} from "@/00-storage/service/hizofs/inspection";
import { exactObject } from "@/utils/exact-object";

/**
 * Namespace navigation is a convenience overlay on the persisted Inspector.
 * Preserve every namespace inspection field explicitly so the overlay cannot
 * hide newly added inode, paging, truncation, or authority evidence.
 */

export type HizoFSNamespaceInspectionEntryRow = Readonly<{
  kind: string;
  name: string;
  path: string;
  pathComponents: readonly string[];
  target: string;
}>;

export type HizoFSNamespacePageNavigationTarget = Readonly<{
  label: string;
  request: HizoFSHomeRecordInspectionRequest;
  role: HizoFSNamespacePathInspection["pageReads"][number]["role"];
}>;

export type HizoFSNamespaceInspectionView = Readonly<{
  authorityMode: HizoFSNamespacePathInspection["authorityMode"];
  authoritySummary: string;
  commitSequence: string;
  createdAt: string | undefined;
  directoryEntries: readonly HizoFSNamespaceInspectionEntryRow[];
  directorySummary: string | undefined;
  fileSize: string | undefined;
  inodeKind: HizoFSNamespacePathInspection["inode"]["inodeKind"];
  inodeNumber: string;
  inodeRevision: string;
  inodeSummary: string;
  modifiedAt: string | undefined;
  pageNavigationSummary: string | undefined;
  pageNavigationTargets: readonly HizoFSNamespacePageNavigationTarget[];
  pageReadsTruncated: boolean;
  pagesRead: number;
  parentPath: string | undefined;
  parentPathComponents: readonly string[] | undefined;
  path: string;
  pathComponents: readonly string[];
  resourceSummary: string;
  symlinkTarget: string | undefined;
}>;

function formatPath({ pathComponents }: { pathComponents: readonly string[] }): string {
  return pathComponents.length === 0 ? "/" : `/${pathComponents.join("/")}`;
}

function pageNavigationLabel({ index, role }: {
  index: number;
  role: HizoFSNamespacePathInspection["pageReads"][number]["role"];
}): string {
  switch (role) {
  case "directory": return `Directory page ${index + 1}`;
  case "inode_table": return `Inode Table page ${index + 1}`;
  default: return role satisfies never;
  }
}

function entryRow({ entry, parentPathComponents }: {
  entry: NonNullable<HizoFSNamespacePathInspection["directory"]>["entries"][number];
  parentPathComponents: readonly string[];
}): HizoFSNamespaceInspectionEntryRow {
  const pathComponents = [...parentPathComponents, entry.name];
  switch (entry.targetType) {
  case "inode": {
    const { inodeKind, inodeNumber, name, targetType: _targetType, ...unhandledEntry } = entry;
    unhandledEntry satisfies Record<PropertyKey, never>;
    return exactObject<HizoFSNamespaceInspectionEntryRow>()({
      kind: inodeKind,
      name,
      path: formatPath({ pathComponents }),
      pathComponents,
      target: `inode ${inodeNumber}`,
    });
  }
  case "subvolume": {
    const { name, subvolumeId, targetType: _targetType, ...unhandledEntry } = entry;
    unhandledEntry satisfies Record<PropertyKey, never>;
    return exactObject<HizoFSNamespaceInspectionEntryRow>()({
      kind: "subvolume",
      name,
      path: formatPath({ pathComponents }),
      pathComponents,
      target: `Subvolume ${subvolumeId}`,
    });
  }
  default: return entry satisfies never;
  }
}

function pageNavigationTarget({ index, pageRead }: {
  index: number;
  pageRead: HizoFSNamespacePathInspection["pageReads"][number];
}): HizoFSNamespacePageNavigationTarget {
  const { request, role, ...unhandledPageRead } = pageRead;
  unhandledPageRead satisfies Record<PropertyKey, never>;
  const {
    frameLength,
    homeOffset,
    homeSegmentId,
    pageIsRoot,
    recordKind,
    ...unhandledRequest
  } = request;
  unhandledRequest satisfies Record<PropertyKey, never>;
  return exactObject<HizoFSNamespacePageNavigationTarget>()({
    label: pageNavigationLabel({ index, role }),
    request: exactObject<HizoFSHomeRecordInspectionRequest>()({
      frameLength,
      homeOffset,
      homeSegmentId,
      pageIsRoot,
      recordKind,
    }),
    role,
  });
}

export function createHizoFSNamespaceInspectionView({ inspection }: {
  inspection: HizoFSNamespacePathInspection;
}): HizoFSNamespaceInspectionView {
  const {
    authorityMode,
    commitSequence,
    directory,
    inode,
    pageReads,
    pageReadsTruncated,
    pagesRead,
    pathComponents: inspectedPathComponents,
    ...unhandledInspection
  } = inspection;
  unhandledInspection satisfies Record<PropertyKey, never>;
  const {
    createdAt,
    fileSize,
    inodeKind,
    inodeNumber,
    inodeRevision,
    modifiedAt,
    symlinkTarget,
    ...unhandledInode
  } = inode;
  unhandledInode satisfies Record<PropertyKey, never>;
  if (directory !== undefined) {
    const { entries: _entries, truncated: _truncated, ...unhandledDirectory } = directory;
    unhandledDirectory satisfies Record<PropertyKey, never>;
  }

  const pathComponents = [...inspectedPathComponents];
  const parentPathComponents = pathComponents.length === 0
    ? undefined
    : pathComponents.slice(0, -1);
  return exactObject<HizoFSNamespaceInspectionView>()({
    authorityMode,
    authoritySummary: `${authorityMode}, Commit ${commitSequence}`,
    commitSequence,
    createdAt,
    directoryEntries: directory?.entries.map(entry => entryRow({
      entry,
      parentPathComponents: pathComponents,
    })) ?? [],
    directorySummary: directory === undefined
      ? undefined
      : `${directory.entries.length} entries${directory.truncated ? " (truncated)" : ""}`,
    fileSize,
    inodeKind,
    inodeNumber,
    inodeRevision,
    inodeSummary: `${inodeKind} inode ${inodeNumber}, revision ${inodeRevision}`,
    modifiedAt,
    pageNavigationSummary: pageReads.length === 0
      ? undefined
      : `${pageReads.length} page references${pageReadsTruncated ? " (truncated)" : ""}`,
    pageNavigationTargets: pageReads.map((pageRead, index) => pageNavigationTarget({ index, pageRead })),
    pageReadsTruncated,
    pagesRead,
    parentPath: parentPathComponents === undefined
      ? undefined
      : formatPath({ pathComponents: parentPathComponents }),
    parentPathComponents,
    path: formatPath({ pathComponents }),
    pathComponents,
    resourceSummary: `${pagesRead} authenticated pages read`,
    symlinkTarget,
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
