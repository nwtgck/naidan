import type {
  HizoFSHomeRecordInspectionRequest,
  HizoFSNamespacePathInspection,
} from "@/00-storage/service/hizofs/inspection";
import { segmentIdToLowercaseHex, type HomeRecordReference } from "@/00-storage/service/hizofs/00-format";
import { exactObject } from "@/utils/exact-object";
import { stringifyPersistedAuditValue } from "./persisted-audit-json";
import type { HizoFSPhysicalRecordNavigationTarget } from "./physical-record-inspection-view";

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

export type HizoFSSelectedInodeEvidenceView = Readonly<{
  containingInodeTablePage: HizoFSHomeRecordInspectionRequest;
  contentSummary: string;
  entry: HizoFSNamespacePathInspection["selectedInodeEvidence"]["entry"];
  entryJson: string;
  navigationTargets: readonly (HizoFSPhysicalRecordNavigationTarget & Readonly<{
    relationship: "containing_inode_table_page" | "inode_content_reference";
  }>)[];
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
  nestedSubvolumeTableRoot: HizoFSPhysicalRecordNavigationTarget | undefined;
  parentPath: string | undefined;
  parentPathComponents: readonly string[] | undefined;
  path: string;
  pathComponents: readonly string[];
  selectedInodeEvidence: HizoFSSelectedInodeEvidenceView;
  symlinkTarget: string | undefined;
  validationEvidence: HizoFSNamespaceValidationEvidence;
}>;

function homeRecordRequest({ pageIsRoot, reference }: {
  pageIsRoot: boolean;
  reference: HomeRecordReference;
}): HizoFSHomeRecordInspectionRequest {
  return exactObject<HizoFSHomeRecordInspectionRequest>()({
    frameLength: reference.frameLength,
    homeOffset: String(reference.byteOffset),
    homeSegmentId: segmentIdToLowercaseHex({ id: reference.segmentId }),
    pageIsRoot,
    recordKind: reference.recordKind,
  });
}

function selectedInodeEvidenceView({ evidence }: {
  evidence: HizoFSNamespacePathInspection["selectedInodeEvidence"];
}): HizoFSSelectedInodeEvidenceView {
  const { containingInodeTablePage, entry, ...unhandledEvidence } = evidence;
  unhandledEvidence satisfies Record<PropertyKey, never>;
  const navigationTargets: (HizoFSPhysicalRecordNavigationTarget & Readonly<{
    relationship: "containing_inode_table_page" | "inode_content_reference";
  }>)[] = [{
    label: "Containing Inode Table Page",
    relationship: "containing_inode_table_page",
    request: containingInodeTablePage,
    targetType: "home_record",
  }];
  const contentSummary = (() => {
    switch (entry.inodeKind) {
    case "directory":
      switch (entry.content.type) {
      case "inline": return `content.type inline · ${String(entry.content.entries.length)} Directory entries`;
      case "tree":
        navigationTargets.push({
          label: "directoryTreeRootHomeRef",
          relationship: "inode_content_reference",
          request: homeRecordRequest({ pageIsRoot: true, reference: entry.content.directoryTreeRootHomeRef }),
          targetType: "home_record",
        });
        return "content.type tree · directoryTreeRootHomeRef";
      default: throw new Error(`Unhandled Directory content: ${((entry.content satisfies never) as { readonly type: string }).type}`);
      }
    case "file":
      switch (entry.content.type) {
      case "inline": return `content.type inline · fileSize ${String(entry.fileSize)} · bytes.byteLength ${String(entry.content.bytes.byteLength)}`;
      case "tree":
        navigationTargets.push({
          label: "extentTreeRootHomeRef",
          relationship: "inode_content_reference",
          request: homeRecordRequest({ pageIsRoot: true, reference: entry.content.extentTreeRootHomeRef }),
          targetType: "home_record",
        });
        return `content.type tree · fileSize ${String(entry.fileSize)} · extentTreeRootHomeRef`;
      default: throw new Error(`Unhandled File content: ${((entry.content satisfies never) as { readonly type: string }).type}`);
      }
    case "symlink": return `target ${entry.target}`;
    default: throw new Error(`Unhandled Inode kind: ${((entry satisfies never) as { readonly inodeKind: string }).inodeKind}`);
    }
  })();
  return exactObject<HizoFSSelectedInodeEvidenceView>()({
    containingInodeTablePage,
    contentSummary,
    entry,
    entryJson: stringifyPersistedAuditValue({ value: entry }),
    navigationTargets,
  });
}

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
    nestedSubvolumeTableRoot,
    pageReads,
    pageReadsTruncated,
    pagesRead,
    pathComponents: inspectedPathComponents,
    selectedInodeEvidence,
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
  const selectedEntry = selectedInodeEvidence.entry;
  const selectedKindFields = (() => {
    switch (selectedEntry.inodeKind) {
    case "directory": return { fileSize: undefined, symlinkTarget: undefined };
    case "file": return { fileSize: String(selectedEntry.fileSize), symlinkTarget: undefined };
    case "symlink": return { fileSize: undefined, symlinkTarget: selectedEntry.target };
    default: return selectedEntry satisfies never;
    }
  })();
  if (
    selectedEntry.inodeKind !== inodeKind
    || String(selectedEntry.inodeNumber) !== inodeNumber
    || String(selectedEntry.inodeRevision) !== inodeRevision
    || (selectedEntry.timestamps.createdAt === null ? undefined : String(selectedEntry.timestamps.createdAt)) !== createdAt
    || (selectedEntry.timestamps.modifiedAt === null ? undefined : String(selectedEntry.timestamps.modifiedAt)) !== modifiedAt
    || selectedKindFields.fileSize !== fileSize
    || selectedKindFields.symlinkTarget !== symlinkTarget
  ) {
    throw new Error("selected Inode structural evidence disagrees with the logical target observation");
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
    nestedSubvolumeTableRoot: nestedSubvolumeTableRoot === undefined
      ? undefined
      : {
        label: "nestedSubvolumeTableRootHomeRef",
        request: nestedSubvolumeTableRoot,
        targetType: "home_record",
      },
    parentPath: parentPathComponents === undefined
      ? undefined
      : formatPath({ pathComponents: parentPathComponents }),
    parentPathComponents,
    path: formatPath({ pathComponents }),
    pathComponents,
    selectedInodeEvidence: selectedInodeEvidenceView({ evidence: selectedInodeEvidence }),
    symlinkTarget,
    validationEvidence: validationEvidence({ pageReads, pageReadsTruncated, pagesRead }),
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
