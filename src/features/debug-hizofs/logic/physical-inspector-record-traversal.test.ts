import { describe, expect, it } from "vitest";
import { createFileOffset, createInodeNumber, createInodeRevision, createTimestampMilliseconds } from "@/00-storage/service/hizofs/00-format";
import type { HizoFSNamespaceInspectionView } from "./namespace-inspection-view";
import type { HizoFSPhysicalRecordInspectionView } from "./physical-record-inspection-view";
import {
  appendHizoFSPhysicalInspectorRecordTraversalColumn,
  attachHizoFSPhysicalInspectorRecordFrame,
  createHizoFSPhysicalInspectorAuthorityTraversalColumn,
  createHizoFSPhysicalInspectorNamespaceTraversalColumn,
  createHizoFSPhysicalInspectorRecordTraversalColumn,
} from "./physical-inspector-record-traversal";
import { stringifyPersistedAuditValue } from "./persisted-audit-json";

function recordView({ identitySummary, payloadSummary }: {
  identitySummary: string;
  payloadSummary: string;
}): HizoFSPhysicalRecordInspectionView {
  return {
    frameLength: 128,
    header: {} as never,
    headerFlags: 0,
    headerJson: "{}",
    homeOffset: "64",
    homeSegmentId: "01",
    identitySummary,
    navigationTargets: [],
    payload: { byteLength: 48, kind: "file_data", state: "decoded" },
    payloadDocumentLabel: "Bounded File Data inspection",
    payloadJson: "{}",
    payloadSummary,
    physicalOffset: "96",
    physicalSegmentId: "02",
    plaintextByteLength: 48,
    plaintextPreviewBase64Url: "",
    plaintextPreviewByteLength: 48,
    plaintextPreviewTruncated: false,
    plaintextSummary: "48/48 bytes previewed",
    recordKind: 2,
    recordKindName: "file_data",
    sealedLength: 64,
  };
}

describe("HizoFS physical Inspector record traversal", () => {

  it("projects the decrypted namespace without treating validation reads as structural edges", () => {
    const view: HizoFSNamespaceInspectionView = {
      authorityMode: "active",
      authoritySummary: "active, Commit 4",
      commitSequence: "4",
      createdAt: "10",
      directoryEntries: [],
      directorySummary: "0 entries",
      fileSize: undefined,
      inodeKind: "directory",
      inodeNumber: "1",
      inodeRevision: "3",
      inodeSummary: "directory inode 1, revision 3",
      modifiedAt: "20",
      nestedSubvolumeTableRoot: undefined,
      parentPath: undefined,
      parentPathComponents: undefined,
      path: "/",
      pathComponents: [],
      selectedInodeEvidence: {
        containingInodeTablePage: {
          frameLength: 160,
          homeOffset: "128",
          homeSegmentId: "03",
          pageIsRoot: true,
          recordKind: 5,
        },
        contentSummary: "content.type inline · 0 Directory entries",
        entry: {
          content: { entries: [], type: "inline" },
          inodeKind: "directory",
          inodeNumber: createInodeNumber({ value: 1n }),
          inodeRevision: createInodeRevision({ value: 3n }),
          timestamps: {
            createdAt: createTimestampMilliseconds({ value: 10n }),
            modifiedAt: createTimestampMilliseconds({ value: 20n }),
          },
        },
        entryJson: "{}",
        navigationTargets: [],
      },
      symlinkTarget: undefined,
      validationEvidence: {
        rawPageReadEvents: [{
          label: "Page-read event 1",
          request: {
            frameLength: 160,
            homeOffset: "128",
            homeSegmentId: "03",
            pageIsRoot: true,
            recordKind: 5,
          },
          role: "inode_table",
        }],
        recordedPageReadEventCount: 1,
        repeatedPageReadEventCount: 0,
        totalPageReadEventCount: 1,
        traceTruncated: false,
        uniqueHomeRecordReferences: [{
          occurrenceCount: 1,
          request: {
            frameLength: 160,
            homeOffset: "128",
            homeSegmentId: "03",
            pageIsRoot: true,
            recordKind: 5,
          },
          roles: ["inode_table"],
        }],
      },
    };

    expect(createHizoFSPhysicalInspectorNamespaceTraversalColumn({ view })).toEqual({
      authoritySummary: "active, Commit 4",
      inodeSummary: "directory inode 1, revision 3",
      path: "/",
      title: "Decrypted namespace",
    });
  });

  it("projects the complete authority view into the first navigation column", () => {
    const column = createHizoFSPhysicalInspectorAuthorityTraversalColumn({
      view: {
        authorityNavigationTargets: [{
          label: "Relocation Index",
          request: {
            frameLength: 176,
            pageIsRoot: true,
            physicalOffset: "640",
            physicalSegmentId: "41",
            recordKind: 48,
          },
        }],
        copyRows: [],
        displayedFrameCount: 0,
        frameRowsTruncated: false,
        physicalAnomalies: [],
        recoveryNavigationTargets: [{
          label: "Fallback Commit candidate",
          request: { frameLength: 128, homeOffset: "32", homeSegmentId: "09", recordKind: 3 },
        }],
        rootDirectorySummary: "active, Commit 4",
        rootRecoveryReason: undefined,
        rootNavigationTargets: [{
          label: "Active Commit",
          request: { frameLength: 128, homeOffset: "64", homeSegmentId: "01", recordKind: 3 },
        }],
        segmentRows: [],
        superblockSelectionSummary: "copy 0, sequence 12, converged",
        totalFrameCount: 0,
        unlockSelectionSummary: "copy 1, sequence 9, converged",
      },
    });

    expect(column.navigationTargets.map(target => target.targetType)).toEqual([
      "physical_record",
      "home_record",
      "home_record",
    ]);
    expect(column.navigationTargets.map(target => target.label)).toEqual([
      "Relocation Index",
      "Fallback Commit candidate",
      "Active Commit",
    ]);
    expect(column.rootDirectorySummary).toBe("active, Commit 4");
  });
  it("preserves namespace observation evidence across framed-binary enrichment", () => {
    const column = createHizoFSPhysicalInspectorRecordTraversalColumn({
      namespaceObservation: {
        authorityMode: "active",
        commitSequence: "4",
        path: "/docs",
        pathComponents: ["docs"],
      },
      title: "Directory page 1",
      view: recordView({ identitySummary: "page", payloadSummary: "directory page" }),
    });

    const expectedObservation = {
      authorityMode: "active",
      commitSequence: "4",
      path: "/docs",
      pathComponents: ["docs"],
    };
    expect(column.namespaceObservation).toEqual(expectedObservation);
    expect(attachHizoFSPhysicalInspectorRecordFrame({
      column,
      framedBinary: {
        frameBase64Url: "AQID",
        frameByteLength: 3,
        physicalOffset: "96",
        physicalSegmentId: "02",
      },
    }).namespaceObservation).toEqual(expectedObservation);
  });

  it("preserves Commit-wide validation context without claiming target lineage", () => {
    const column = createHizoFSPhysicalInspectorRecordTraversalColumn({
      namespaceObservation: {
        authorityMode: "active",
        commitSequence: "4",
        path: "/naidan-storage/migration-state.json",
        pathComponents: ["naidan-storage", "migration-state.json"],
      },
      title: "Validation Home Record 03:128",
      validationObservation: {
        commitSequence: "4",
        occurrenceCount: 3,
        path: "/naidan-storage/migration-state.json",
        roles: ["inode_table"],
      },
      view: recordView({ identitySummary: "page", payloadSummary: "inode_table page" }),
    });

    const expectedObservation = {
      commitSequence: "4",
      occurrenceCount: 3,
      path: "/naidan-storage/migration-state.json",
      roles: ["inode_table"],
    };
    expect(column.validationObservation).toEqual(expectedObservation);
    expect(attachHizoFSPhysicalInspectorRecordFrame({
      column,
      framedBinary: {
        frameBase64Url: "AQID",
        frameByteLength: 3,
        physicalOffset: "96",
        physicalSegmentId: "02",
      },
    }).validationObservation).toEqual(expectedObservation);
  });

  it("focuses the exact selected Inode entry without filtering the containing page", () => {
    const rootEntry = {
      content: { entries: [], type: "inline" as const },
      inodeKind: "directory" as const,
      inodeNumber: createInodeNumber({ value: 1n }),
      inodeRevision: createInodeRevision({ value: 1n }),
      timestamps: { createdAt: null, modifiedAt: null },
    };
    const selectedEntry = {
      content: { bytes: Uint8Array.from([1, 2, 3]), type: "inline" as const },
      fileSize: createFileOffset({ value: 3n }),
      inodeKind: "file" as const,
      inodeNumber: createInodeNumber({ value: 7n }),
      inodeRevision: createInodeRevision({ value: 2n }),
      timestamps: { createdAt: null, modifiedAt: null },
    };
    const view: HizoFSPhysicalRecordInspectionView = {
      ...recordView({ identitySummary: "inode page", payloadSummary: "inode_table leaf" }),
      payload: {
        decodedPayload: { entries: [rootEntry, selectedEntry], level: 0, type: "leaf" },
        family: "inode_table",
        isRoot: true,
        itemCount: 2,
        level: 0,
        navigationReferences: [],
        pageType: "leaf",
        state: "decoded",
      },
      recordKind: 5,
      recordKindName: "inode_table_page",
    };
    const entryJson = stringifyPersistedAuditValue({ value: selectedEntry });
    const column = createHizoFSPhysicalInspectorRecordTraversalColumn({
      selectedInodeObservation: {
        commitSequence: "4",
        entryJson,
        inodeNumber: "7",
        path: "/docs/report.bin",
        relationship: "containing_inode_table_page",
      },
      title: "Containing Inode Table Page",
      view,
    });

    expect(column.selectedInodeEntryIndex).toBe(1);
    expect(column.view.payload).toBe(view.payload);
    expect(() => createHizoFSPhysicalInspectorRecordTraversalColumn({
      selectedInodeObservation: {
        commitSequence: "4",
        entryJson: "{}",
        inodeNumber: "7",
        path: "/docs/report.bin",
        relationship: "containing_inode_table_page",
      },
      title: "Stale containing page",
      view,
    })).toThrow("no longer matches");
  });

  it("keeps the reference chain as columns and replaces descendants when branching from an earlier column", () => {
    const root = createHizoFSPhysicalInspectorRecordTraversalColumn({
      title: "Active Commit",
      view: recordView({ identitySummary: "root", payloadSummary: "Commit" }),
    });
    const firstChild = createHizoFSPhysicalInspectorRecordTraversalColumn({
      title: "Root Inode Table",
      view: recordView({ identitySummary: "first", payloadSummary: "first child" }),
    });
    const replacementChild = createHizoFSPhysicalInspectorRecordTraversalColumn({
      title: "Directory tree root",
      view: recordView({ identitySummary: "replacement", payloadSummary: "replacement child" }),
    });

    const initial = appendHizoFSPhysicalInspectorRecordTraversalColumn({
      column: root,
      columns: [],
      sourceColumnIndex: undefined,
    });
    const followed = appendHizoFSPhysicalInspectorRecordTraversalColumn({
      column: firstChild,
      columns: initial,
      sourceColumnIndex: 0,
    });
    const branched = appendHizoFSPhysicalInspectorRecordTraversalColumn({
      column: replacementChild,
      columns: followed,
      sourceColumnIndex: 0,
    });

    expect(followed.map(column => column.title)).toEqual(["Active Commit", "Root Inode Table"]);
    expect(branched.map(column => column.title)).toEqual(["Active Commit", "Directory tree root"]);
  });
});
