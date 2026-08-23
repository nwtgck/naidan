import { describe, expect, it } from "vitest";
import type { HizoFSNamespaceInspectionView } from "./namespace-inspection-view";
import type { HizoFSPhysicalRecordInspectionView } from "./physical-record-inspection-view";
import {
  appendHizoFSPhysicalInspectorRecordTraversalColumn,
  attachHizoFSPhysicalInspectorRecordFrame,
  createHizoFSPhysicalInspectorAuthorityTraversalColumn,
  createHizoFSPhysicalInspectorNamespaceTraversalColumn,
  createHizoFSPhysicalInspectorRecordTraversalColumn,
} from "./physical-inspector-record-traversal";

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

  it("projects the decrypted namespace as a traversal root with authenticated page edges", () => {
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
      pageNavigationSummary: "1 page references",
      pageNavigationTargets: [{
        label: "Inode Table page 1",
        request: {
          frameLength: 160,
          homeOffset: "128",
          homeSegmentId: "03",
          pageIsRoot: true,
          recordKind: 5,
        },
        role: "inode_table",
      }],
      pageReadsTruncated: false,
      pagesRead: 1,
      parentPath: undefined,
      parentPathComponents: undefined,
      path: "/",
      pathComponents: [],
      resourceSummary: "1 authenticated pages read",
      symlinkTarget: undefined,
    };

    expect(createHizoFSPhysicalInspectorNamespaceTraversalColumn({ view })).toEqual({
      authoritySummary: "active, Commit 4",
      inodeSummary: "directory inode 1, revision 3",
      navigationTargets: [{
        label: "Inode Table page 1",
        request: {
          frameLength: 160,
          homeOffset: "128",
          homeSegmentId: "03",
          pageIsRoot: true,
          recordKind: 5,
        },
        targetType: "home_record",
      }],
      path: "/",
      resourceSummary: "1 authenticated pages read",
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
