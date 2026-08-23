import type { HizoFSPhysicalRecordFrameInspection } from "@/00-storage/service/hizofs/inspection";
import { exactObject } from "@/utils/exact-object";
import type { HizoFSNamespaceInspectionView } from "./namespace-inspection-view";
import type { HizoFSPhysicalContainerInspectionView } from "./physical-container-inspection-view";
import type {
  HizoFSPhysicalRecordInspectionView,
  HizoFSPhysicalRecordNavigationTarget,
} from "./physical-record-inspection-view";

export type HizoFSPhysicalInspectorAuthorityTraversalColumn = Readonly<{
  navigationTargets: readonly HizoFSPhysicalRecordNavigationTarget[];
  rootDirectorySummary: string;
  superblockSelectionSummary: string;
  title: "Physical authority";
  unlockSelectionSummary: string;
}>;

export type HizoFSPhysicalInspectorNamespaceTraversalColumn = Readonly<{
  authoritySummary: string;
  inodeSummary: string;
  path: string;
  title: "Decrypted namespace";
}>;

/**
 * Projects the complete decrypted namespace observation into a traversal root.
 * The deliberately undisplayed descriptive fields remain explicitly consumed
 * here so a new namespace-inspection field cannot silently bypass typecheck.
 */
export function createHizoFSPhysicalInspectorNamespaceTraversalColumn({ view }: {
  view: HizoFSNamespaceInspectionView;
}): HizoFSPhysicalInspectorNamespaceTraversalColumn {
  const {
    authorityMode: _authorityMode,
    authoritySummary,
    commitSequence: _commitSequence,
    createdAt: _createdAt,
    directoryEntries: _directoryEntries,
    directorySummary: _directorySummary,
    fileSize: _fileSize,
    inodeKind: _inodeKind,
    inodeNumber: _inodeNumber,
    inodeRevision: _inodeRevision,
    inodeSummary,
    modifiedAt: _modifiedAt,
    parentPath: _parentPath,
    parentPathComponents: _parentPathComponents,
    path,
    pathComponents: _pathComponents,
    symlinkTarget: _symlinkTarget,
    validationEvidence: _validationEvidence,
    ...unhandledView
  } = view;
  unhandledView satisfies Record<PropertyKey, never>;

  return exactObject<HizoFSPhysicalInspectorNamespaceTraversalColumn>()({
    authoritySummary,
    inodeSummary,
    path,
    title: "Decrypted namespace",
  });
}

export function createHizoFSPhysicalInspectorAuthorityTraversalColumn({ view }: {
  view: HizoFSPhysicalContainerInspectionView;
}): HizoFSPhysicalInspectorAuthorityTraversalColumn {
  const {
    authorityNavigationTargets,
    copyRows: _copyRows,
    displayedFrameCount: _displayedFrameCount,
    frameRowsTruncated: _frameRowsTruncated,
    physicalAnomalies: _physicalAnomalies,
    recoveryNavigationTargets,
    rootDirectorySummary,
    rootRecoveryReason: _rootRecoveryReason,
    rootNavigationTargets,
    segmentRows: _segmentRows,
    superblockSelectionSummary,
    totalFrameCount: _totalFrameCount,
    unlockSelectionSummary,
    ...unhandledView
  } = view;
  unhandledView satisfies Record<PropertyKey, never>;

  const navigationTargets: HizoFSPhysicalRecordNavigationTarget[] = [];
  for (const target of authorityNavigationTargets) {
    const { label, request, ...unhandledTarget } = target;
    unhandledTarget satisfies Record<PropertyKey, never>;
    navigationTargets.push({ label, request, targetType: "physical_record" });
  }
  for (const target of recoveryNavigationTargets) {
    const { label, request, ...unhandledTarget } = target;
    unhandledTarget satisfies Record<PropertyKey, never>;
    navigationTargets.push({ label, request, targetType: "home_record" });
  }
  for (const target of rootNavigationTargets) {
    const { label, request, ...unhandledTarget } = target;
    unhandledTarget satisfies Record<PropertyKey, never>;
    navigationTargets.push({ label, request, targetType: "home_record" });
  }

  return exactObject<HizoFSPhysicalInspectorAuthorityTraversalColumn>()({
    navigationTargets,
    rootDirectorySummary,
    superblockSelectionSummary,
    title: "Physical authority",
    unlockSelectionSummary,
  });
}

export type HizoFSPhysicalInspectorNamespaceObservation = Readonly<{
  authorityMode: HizoFSNamespaceInspectionView["authorityMode"];
  commitSequence: string;
  path: string;
  pathComponents: readonly string[];
}>;

export type HizoFSPhysicalInspectorValidationObservation = Readonly<{
  commitSequence: string;
  occurrenceCount: number;
  path: string;
  roles: HizoFSNamespaceInspectionView["validationEvidence"]["uniqueHomeRecordReferences"][number]["roles"];
}>;

export type HizoFSPhysicalInspectorTraversalBreadcrumb =
  | Readonly<{ kind: "authority"; label: "Physical authority" }>
  | Readonly<{ kind: "frame"; label: "Physical frame" }>
  | Readonly<{ kind: "namespace"; label: "Decrypted namespace" }>
  | Readonly<{ columnIndex: number; kind: "record"; label: string }>;

export type HizoFSPhysicalInspectorRecordTraversalColumn = Readonly<{
  framedBinary?: HizoFSPhysicalRecordFrameInspection;
  namespaceObservation?: HizoFSPhysicalInspectorNamespaceObservation;
  title: string;
  validationObservation?: HizoFSPhysicalInspectorValidationObservation;
  view: HizoFSPhysicalRecordInspectionView;
}>;

/**
 * Retains the complete authoritative record view inside each horizontal
 * traversal column. The explicit destructuring below is intentionally
 * exhaustive: when HizoFS record inspection gains a field, typecheck must
 * force the Workbench projection to acknowledge it instead of silently
 * rendering an older subset.
 */
export function createHizoFSPhysicalInspectorRecordTraversalColumn({ namespaceObservation, title, validationObservation, view }: {
  namespaceObservation?: HizoFSPhysicalInspectorNamespaceObservation;
  title: string;
  validationObservation?: HizoFSPhysicalInspectorValidationObservation;
  view: HizoFSPhysicalRecordInspectionView;
}): HizoFSPhysicalInspectorRecordTraversalColumn {
  const {
    frameLength: _frameLength,
    header: _header,
    headerFlags: _headerFlags,
    headerJson: _headerJson,
    homeOffset: _homeOffset,
    homeSegmentId: _homeSegmentId,
    identitySummary: _identitySummary,
    navigationTargets: _navigationTargets,
    payload: _payload,
    payloadDocumentLabel: _payloadDocumentLabel,
    payloadJson: _payloadJson,
    payloadSummary: _payloadSummary,
    physicalOffset: _physicalOffset,
    physicalSegmentId: _physicalSegmentId,
    plaintextByteLength: _plaintextByteLength,
    plaintextPreviewBase64Url: _plaintextPreviewBase64Url,
    plaintextPreviewByteLength: _plaintextPreviewByteLength,
    plaintextPreviewTruncated: _plaintextPreviewTruncated,
    plaintextSummary: _plaintextSummary,
    recordKind: _recordKind,
    recordKindName: _recordKindName,
    sealedLength: _sealedLength,
    ...unhandledView
  } = view;
  unhandledView satisfies Record<PropertyKey, never>;

  return exactObject<HizoFSPhysicalInspectorRecordTraversalColumn>()({
    framedBinary: undefined,
    ...(namespaceObservation === undefined
      ? {}
      : {
        namespaceObservation: exactObject<HizoFSPhysicalInspectorNamespaceObservation>()({
          authorityMode: namespaceObservation.authorityMode,
          commitSequence: namespaceObservation.commitSequence,
          path: namespaceObservation.path,
          pathComponents: [...namespaceObservation.pathComponents],
        }),
      }),
    ...(validationObservation === undefined
      ? {}
      : {
        validationObservation: exactObject<HizoFSPhysicalInspectorValidationObservation>()({
          commitSequence: validationObservation.commitSequence,
          occurrenceCount: validationObservation.occurrenceCount,
          path: validationObservation.path,
          roles: [...validationObservation.roles],
        }),
      }),
    title,
    view,
  });
}

export function attachHizoFSPhysicalInspectorRecordFrame({ column, framedBinary }: {
  column: HizoFSPhysicalInspectorRecordTraversalColumn;
  framedBinary: HizoFSPhysicalRecordFrameInspection;
}): HizoFSPhysicalInspectorRecordTraversalColumn {
  const { framedBinary: _previousFramedBinary, namespaceObservation, title, validationObservation, view, ...unhandledColumn } = column;
  unhandledColumn satisfies Record<PropertyKey, never>;
  const {
    frameBase64Url,
    frameByteLength,
    physicalOffset,
    physicalSegmentId,
    ...unhandledFramedBinary
  } = framedBinary;
  unhandledFramedBinary satisfies Record<PropertyKey, never>;
  return exactObject<HizoFSPhysicalInspectorRecordTraversalColumn>()({
    framedBinary: exactObject<HizoFSPhysicalRecordFrameInspection>()({
      frameBase64Url,
      frameByteLength,
      physicalOffset,
      physicalSegmentId,
    }),
    ...(namespaceObservation === undefined ? {} : { namespaceObservation }),
    title,
    ...(validationObservation === undefined ? {} : { validationObservation }),
    view,
  });
}

export function appendHizoFSPhysicalInspectorRecordTraversalColumn({
  column,
  columns,
  sourceColumnIndex,
}: {
  column: HizoFSPhysicalInspectorRecordTraversalColumn;
  columns: readonly HizoFSPhysicalInspectorRecordTraversalColumn[];
  sourceColumnIndex: number | undefined;
}): readonly HizoFSPhysicalInspectorRecordTraversalColumn[] {
  if (sourceColumnIndex === undefined) return [column];
  const boundedSourceIndex = Math.min(Math.max(sourceColumnIndex, 0), columns.length - 1);
  return [...columns.slice(0, boundedSourceIndex + 1), column];
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
