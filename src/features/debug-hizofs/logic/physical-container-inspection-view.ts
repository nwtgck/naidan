import type {
  HizoFSAuthoritySelectionInspection,
  HizoFSHomeRecordInspectionRequest,
  HizoFSPhysicalContainerInspection,
  HizoFSPhysicalRecordInspectionRequest,
  HizoFSRecordReferenceInspection,
  HizoFSSegmentFrameInspection,
  HizoFSSegmentInspection,
  HizoFSSuperblockCopyInspection,
  HizoFSUnlockEnvelopeCopyInspection,
} from "@/00-storage/service/hizofs/inspection";
import { exactObject } from "@/utils/exact-object";
import { stringifyPersistedAuditValue } from "./persisted-audit-json";

/**
 * This projection serves an implementation audit surface, not a user-friendly
 * storage summary. Keep every persisted/inspection DTO field explicit so a
 * future format field cannot disappear from the Inspector unnoticed.
 */

export type HizoFSPhysicalAuthorityNavigationTarget = Readonly<{
  label: "Relocation Index";
  request: HizoFSPhysicalRecordInspectionRequest;
}>;

export type HizoFSPhysicalRootNavigationTarget = Readonly<{
  label: "Active Commit" | "Fallback Commit" | "Nested Subvolume Table" | "Root Inode Table";
  request: HizoFSHomeRecordInspectionRequest;
}>;

export type HizoFSUnlockEnvelopeCopyInspectionRow = Readonly<{
  copy: 0 | 1;
  credentialSlotCount: number | undefined;
  envelope: HizoFSUnlockEnvelopeCopyInspection["envelope"];
  envelopeJson: string;
  fileSystemId: string | undefined;
  kind: "unlock_envelope";
  path: string;
  reason: string | undefined;
  selected: boolean;
  sequence: string | undefined;
  state: HizoFSUnlockEnvelopeCopyInspection["state"];
}>;

export type HizoFSSuperblockCopyInspectionRow = Readonly<{
  activeCommit: HizoFSRecordReferenceInspection | undefined;
  activeCommitSequence: string | undefined;
  copy: 0 | 1;
  header: HizoFSSuperblockCopyInspection["header"];
  headerJson: string;
  kind: "superblock";
  minimumUnlockSequence: string | undefined;
  path: string;
  plaintext: HizoFSSuperblockCopyInspection["plaintext"];
  plaintextJson: string;
  publicationSequence: string | undefined;
  relocationIndexRoot: HizoFSRecordReferenceInspection | undefined;
  reason: string | undefined;
  requiredFeatureBits: string | undefined;
  selected: boolean;
  state: HizoFSSuperblockCopyInspection["state"];
}>;

export type HizoFSPhysicalCopyInspectionRow =
  | HizoFSSuperblockCopyInspectionRow
  | HizoFSUnlockEnvelopeCopyInspectionRow;

export type HizoFSPhysicalFrameInspectionRow = Readonly<{
  frameLength: number;
  homeOffset: string;
  homeSegmentId: string;
  physicalOffset: string;
  physicalSegmentId: string;
  plaintextLength: number;
  recordKind: number;
}>;

export type HizoFSPhysicalSegmentInspectionRow = Readonly<{
  fileSize: string | undefined;
  frames: readonly HizoFSPhysicalFrameInspectionRow[];
  frameCount: number;
  frameRowsTruncated: boolean;
  path: string;
  physicalSegmentId: string | undefined;
  reason: string | undefined;
  segmentClass: HizoFSSegmentInspection["segmentClass"];
  state: HizoFSSegmentInspection["state"];
}>;

export type HizoFSPhysicalContainerInspectionView = Readonly<{
  authorityNavigationTargets: readonly HizoFSPhysicalAuthorityNavigationTarget[];
  copyRows: readonly HizoFSPhysicalCopyInspectionRow[];
  displayedFrameCount: number;
  frameRowsTruncated: boolean;
  physicalAnomalies: readonly string[];
  rootDirectorySummary: string;
  rootNavigationTargets: readonly HizoFSPhysicalRootNavigationTarget[];
  segmentRows: readonly HizoFSPhysicalSegmentInspectionRow[];
  totalFrameCount: number;
  superblockSelectionSummary: string;
  unlockSelectionSummary: string;
}>;

function selectionSummary({ selection }: {
  selection: HizoFSAuthoritySelectionInspection | undefined;
}): string {
  if (selection === undefined) return "not evaluated";
  switch (selection.state) {
  case "selected": {
    const { copy, redundancy, sequence, state: _state, ...unhandledSelection } = selection;
    unhandledSelection satisfies Record<PropertyKey, never>;
    return `copy ${copy}, sequence ${sequence}, ${redundancy}`;
  }
  case "rejected": {
    const { code, message, state: _state, ...unhandledSelection } = selection;
    unhandledSelection satisfies Record<PropertyKey, never>;
    return `${code}: ${message}`;
  }
  default: return selection satisfies never;
  }
}

function unlockCopyRow({ copy }: {
  copy: HizoFSUnlockEnvelopeCopyInspection;
}): HizoFSUnlockEnvelopeCopyInspectionRow {
  const {
    copy: copyNumber,
    credentialSlotCount,
    envelope,
    fileSystemId,
    path,
    reason,
    selected,
    sequence,
    state,
    ...unhandledCopy
  } = copy;
  unhandledCopy satisfies Record<PropertyKey, never>;
  return exactObject<HizoFSUnlockEnvelopeCopyInspectionRow>()({
    copy: copyNumber,
    credentialSlotCount,
    envelope,
    envelopeJson: stringifyPersistedAuditValue({ value: envelope }),
    fileSystemId,
    kind: "unlock_envelope",
    path,
    reason,
    selected,
    sequence,
    state,
  });
}

function superblockCopyRow({ copy }: {
  copy: HizoFSSuperblockCopyInspection;
}): HizoFSSuperblockCopyInspectionRow {
  const {
    activeCommit,
    activeCommitSequence,
    copy: copyNumber,
    header,
    minimumUnlockSequence,
    path,
    plaintext,
    publicationSequence,
    relocationIndexRoot,
    reason,
    requiredFeatureBits,
    selected,
    state,
    ...unhandledCopy
  } = copy;
  unhandledCopy satisfies Record<PropertyKey, never>;
  return exactObject<HizoFSSuperblockCopyInspectionRow>()({
    activeCommit,
    activeCommitSequence,
    copy: copyNumber,
    header,
    headerJson: stringifyPersistedAuditValue({ value: header }),
    kind: "superblock",
    minimumUnlockSequence,
    path,
    plaintext,
    plaintextJson: stringifyPersistedAuditValue({ value: plaintext }),
    publicationSequence,
    relocationIndexRoot,
    reason,
    requiredFeatureBits,
    selected,
    state,
  });
}

function authorityNavigationTargets({ superblockCopies }: {
  superblockCopies: HizoFSPhysicalContainerInspection["superblockCopies"];
}): readonly HizoFSPhysicalAuthorityNavigationTarget[] {
  const selectedCopy = superblockCopies.find(copy => copy.selected);
  const reference = selectedCopy?.relocationIndexRoot;
  if (reference === undefined) return [];
  const { byteOffset, frameLength, recordKind, segmentId, ...unhandledReference } = reference;
  unhandledReference satisfies Record<PropertyKey, never>;
  return [exactObject<HizoFSPhysicalAuthorityNavigationTarget>()({
    label: "Relocation Index",
    request: {
      frameLength,
      pageIsRoot: true,
      physicalOffset: byteOffset,
      physicalSegmentId: segmentId,
      recordKind,
    },
  })];
}

function rootDirectorySummary({ shortcut }: {
  shortcut: HizoFSPhysicalContainerInspection["rootDirectoryShortcut"];
}): string {
  if (shortcut === undefined) return "not evaluated";
  switch (shortcut.state) {
  case "available": {
    const {
      activeCommit: _activeCommit,
      commitSequence,
      mode,
      nestedSubvolumeTableRoot: _nestedSubvolumeTableRoot,
      rootDirectoryInodeNumber,
      rootInodeTableRoot: _rootInodeTableRoot,
      state: _state,
      ...unhandledShortcut
    } = shortcut;
    unhandledShortcut satisfies Record<PropertyKey, never>;
    return `${mode}, commit ${commitSequence}, root inode ${rootDirectoryInodeNumber}`;
  }
  case "unavailable": {
    const { reason, state: _state, ...unhandledShortcut } = shortcut;
    unhandledShortcut satisfies Record<PropertyKey, never>;
    return `unavailable: ${reason}`;
  }
  default: return shortcut satisfies never;
  }
}

function rootNavigationTarget({ label, pageIsRoot, reference }: {
  label: HizoFSPhysicalRootNavigationTarget["label"];
  pageIsRoot: boolean | undefined;
  reference: HizoFSRecordReferenceInspection;
}): HizoFSPhysicalRootNavigationTarget {
  const { byteOffset, frameLength, recordKind, segmentId, ...unhandledReference } = reference;
  unhandledReference satisfies Record<PropertyKey, never>;
  return exactObject<HizoFSPhysicalRootNavigationTarget>()({
    label,
    request: {
      frameLength,
      homeOffset: byteOffset,
      homeSegmentId: segmentId,
      ...(pageIsRoot === undefined ? {} : { pageIsRoot }),
      recordKind,
    },
  });
}

function selectedCommitLabel({ mode }: {
  mode: Extract<HizoFSPhysicalContainerInspection["rootDirectoryShortcut"], { state: "available" }>["mode"];
}): "Active Commit" | "Fallback Commit" {
  switch (mode) {
  case "active": return "Active Commit";
  case "fallback_read_only": return "Fallback Commit";
  default: return mode satisfies never;
  }
}

function rootNavigationTargets({ shortcut }: {
  shortcut: HizoFSPhysicalContainerInspection["rootDirectoryShortcut"];
}): readonly HizoFSPhysicalRootNavigationTarget[] {
  if (shortcut === undefined) return [];
  switch (shortcut.state) {
  case "unavailable": {
    const { reason: _reason, state: _state, ...unhandledShortcut } = shortcut;
    unhandledShortcut satisfies Record<PropertyKey, never>;
    return [];
  }
  case "available": {
    const {
      activeCommit,
      commitSequence: _commitSequence,
      mode,
      nestedSubvolumeTableRoot,
      rootDirectoryInodeNumber: _rootDirectoryInodeNumber,
      rootInodeTableRoot,
      state: _state,
      ...unhandledShortcut
    } = shortcut;
    unhandledShortcut satisfies Record<PropertyKey, never>;
    return [
      rootNavigationTarget({
        label: selectedCommitLabel({ mode }),
        pageIsRoot: undefined,
        reference: activeCommit,
      }),
      rootNavigationTarget({
        label: "Root Inode Table",
        pageIsRoot: true,
        reference: rootInodeTableRoot,
      }),
      ...(nestedSubvolumeTableRoot === undefined
        ? []
        : [rootNavigationTarget({
          label: "Nested Subvolume Table",
          pageIsRoot: true,
          reference: nestedSubvolumeTableRoot,
        })]),
    ];
  }
  default: return shortcut satisfies never;
  }
}

function frameRow({ frame, physicalSegmentId }: {
  frame: HizoFSSegmentFrameInspection;
  physicalSegmentId: string;
}): HizoFSPhysicalFrameInspectionRow {
  const {
    frameLength,
    homeOffset,
    homeSegmentId,
    physicalOffset,
    plaintextLength,
    recordKind,
    ...unhandledFrame
  } = frame;
  unhandledFrame satisfies Record<PropertyKey, never>;
  return exactObject<HizoFSPhysicalFrameInspectionRow>()({
    frameLength,
    homeOffset,
    homeSegmentId,
    physicalOffset,
    physicalSegmentId,
    plaintextLength,
    recordKind,
  });
}

function segmentRow({ maximumFrameRows, segment }: {
  maximumFrameRows: number;
  segment: HizoFSSegmentInspection;
}): HizoFSPhysicalSegmentInspectionRow {
  const {
    fileSize,
    frames,
    path,
    physicalSegmentId,
    reason,
    segmentClass,
    state,
    ...unhandledSegment
  } = segment;
  unhandledSegment satisfies Record<PropertyKey, never>;
  const displayedFrames = physicalSegmentId === undefined
    ? []
    : frames
      .slice(0, maximumFrameRows)
      .map(frame => frameRow({ frame, physicalSegmentId }));
  return exactObject<HizoFSPhysicalSegmentInspectionRow>()({
    fileSize,
    frameCount: frames.length,
    frameRowsTruncated: displayedFrames.length < frames.length,
    frames: displayedFrames,
    path,
    physicalSegmentId,
    reason,
    segmentClass,
    state,
  });
}

export function createHizoFSPhysicalContainerInspectionView({
  inspection,
  maximumFrameRows = 512,
}: {
  inspection: HizoFSPhysicalContainerInspection;
  maximumFrameRows?: number;
}): HizoFSPhysicalContainerInspectionView {
  if (!Number.isSafeInteger(maximumFrameRows) || maximumFrameRows < 1 || maximumFrameRows > 4_096) {
    throw new RangeError("maximumFrameRows must be a safe integer between 1 and 4096");
  }
  const {
    physicalAnomalies,
    rootDirectoryShortcut,
    segments,
    superblockCopies,
    superblockSelection,
    unlockEnvelopeCopies,
    unlockSelection,
    ...unhandledInspection
  } = inspection;
  unhandledInspection satisfies Record<PropertyKey, never>;

  let remainingFrameRows = maximumFrameRows;
  const segmentRows = segments.map(segment => {
    const rowsForSegment = Math.min(segment.frames.length, remainingFrameRows);
    remainingFrameRows -= rowsForSegment;
    return segmentRow({ maximumFrameRows: rowsForSegment, segment });
  });
  const totalFrameCount = segments.reduce((sum, segment) => sum + segment.frames.length, 0);
  const displayedFrameCount = segmentRows.reduce((sum, segment) => sum + segment.frames.length, 0);
  return exactObject<HizoFSPhysicalContainerInspectionView>()({
    authorityNavigationTargets: authorityNavigationTargets({ superblockCopies }),
    copyRows: [
      ...unlockEnvelopeCopies.map(copy => unlockCopyRow({ copy })),
      ...superblockCopies.map(copy => superblockCopyRow({ copy })),
    ],
    displayedFrameCount,
    frameRowsTruncated: displayedFrameCount < totalFrameCount,
    physicalAnomalies: [...physicalAnomalies],
    rootDirectorySummary: rootDirectorySummary({ shortcut: rootDirectoryShortcut }),
    rootNavigationTargets: rootNavigationTargets({ shortcut: rootDirectoryShortcut }),
    segmentRows,
    totalFrameCount,
    superblockSelectionSummary: selectionSummary({ selection: superblockSelection }),
    unlockSelectionSummary: selectionSummary({ selection: unlockSelection }),
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
