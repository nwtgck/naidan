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

export type HizoFSNamespaceValidationPageReadEvent = Readonly<{
  label: string;
  request: HizoFSHomeRecordInspectionRequest;
  role: HizoFSNamespacePathInspection["pageReads"][number]["role"];
}>;

export type HizoFSNamespaceValidationHomeReference = Readonly<{
  occurrenceCount: number;
  request: HizoFSHomeRecordInspectionRequest;
  roles: readonly HizoFSNamespacePathInspection["pageReads"][number]["role"][];
}>;

export type HizoFSNamespaceValidationEvidence = Readonly<{
  rawPageReadEvents: readonly HizoFSNamespaceValidationPageReadEvent[];
  recordedPageReadEventCount: number;
  repeatedPageReadEventCount: number;
  totalPageReadEventCount: number;
  traceTruncated: boolean;
  uniqueHomeRecordReferences: readonly HizoFSNamespaceValidationHomeReference[];
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
  parentPath: string | undefined;
  parentPathComponents: readonly string[] | undefined;
  path: string;
  pathComponents: readonly string[];
  symlinkTarget: string | undefined;
  validationEvidence: HizoFSNamespaceValidationEvidence;
}>;

function formatPath({ pathComponents }: { pathComponents: readonly string[] }): string {
  return pathComponents.length === 0 ? "/" : `/${pathComponents.join("/")}`;
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

function validationPageReadEvent({ index, pageRead }: {
  index: number;
  pageRead: HizoFSNamespacePathInspection["pageReads"][number];
}): HizoFSNamespaceValidationPageReadEvent {
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
  return exactObject<HizoFSNamespaceValidationPageReadEvent>()({
    label: `Page-read event ${index + 1}`,
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

function homeReferenceKey({ request }: {
  request: HizoFSHomeRecordInspectionRequest;
}): string {
  const { frameLength, homeOffset, homeSegmentId, pageIsRoot: _pageIsRoot, recordKind, ...unhandledRequest } = request;
  unhandledRequest satisfies Record<PropertyKey, never>;
  return `${homeSegmentId}:${homeOffset}:${String(frameLength)}:${String(recordKind)}`;
}

function validationEvidence({ pageReads, pageReadsTruncated, pagesRead }: {
  pageReads: HizoFSNamespacePathInspection["pageReads"];
  pageReadsTruncated: boolean;
  pagesRead: number;
}): HizoFSNamespaceValidationEvidence {
  const rawPageReadEvents = pageReads.map((pageRead, index) => validationPageReadEvent({ index, pageRead }));
  const grouped = new Map<string, {
    occurrenceCount: number;
    request: HizoFSHomeRecordInspectionRequest;
    roles: HizoFSNamespacePathInspection["pageReads"][number]["role"][];
  }>();
  for (const event of rawPageReadEvents) {
    const key = homeReferenceKey({ request: event.request });
    const existing = grouped.get(key);
    if (existing === undefined) {
      grouped.set(key, { occurrenceCount: 1, request: event.request, roles: [event.role] });
      continue;
    }
    existing.occurrenceCount += 1;
    if (!existing.roles.includes(event.role)) existing.roles.push(event.role);
  }
  const uniqueHomeRecordReferences = [...grouped.values()].map(group => exactObject<HizoFSNamespaceValidationHomeReference>()({
    occurrenceCount: group.occurrenceCount,
    request: group.request,
    roles: [...group.roles],
  }));
  return exactObject<HizoFSNamespaceValidationEvidence>()({
    rawPageReadEvents,
    recordedPageReadEventCount: rawPageReadEvents.length,
    repeatedPageReadEventCount: rawPageReadEvents.length - uniqueHomeRecordReferences.length,
    totalPageReadEventCount: pagesRead,
    traceTruncated: pageReadsTruncated,
    uniqueHomeRecordReferences,
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
    parentPath: parentPathComponents === undefined
      ? undefined
      : formatPath({ pathComponents: parentPathComponents }),
    parentPathComponents,
    path: formatPath({ pathComponents }),
    pathComponents,
    symlinkTarget,
    validationEvidence: validationEvidence({ pageReads, pageReadsTruncated, pagesRead }),
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
