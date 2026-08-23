import { describe, expect, it } from "vitest";
import type { HizoFSNamespacePathInspection } from "@/00-storage/service/hizofs/inspection";
import { createHizoFSNamespaceInspectionView } from "./namespace-inspection-view";

function inspection(): HizoFSNamespacePathInspection {
  return {
    authorityMode: "fallback_read_only",
    commitSequence: "9",
    directory: {
      entries: [
        { inodeKind: "file", inodeNumber: "2", name: "file.txt", targetType: "inode" },
        { name: "snapshot", subvolumeId: "7", targetType: "subvolume" },
      ],
      truncated: true,
    },
    inode: {
      createdAt: undefined,
      fileSize: undefined,
      inodeKind: "directory",
      inodeNumber: "1",
      inodeRevision: "4",
      modifiedAt: "10",
      symlinkTarget: undefined,
    },
    pageReads: [{
      request: {
        frameLength: 160,
        homeOffset: "128",
        homeSegmentId: "00000000000000000000000000000003",
        pageIsRoot: true,
        recordKind: 5,
      },
      role: "inode_table",
    }],
    pageReadsTruncated: true,
    pagesRead: 12,
    pathComponents: ["docs"],
  };
}

describe("HizoFS namespace inspection view", () => {
  it("preserves fallback authority, truncation, and Subvolume boundaries", () => {
    expect(createHizoFSNamespaceInspectionView({ inspection: inspection() })).toEqual({
      authorityMode: "fallback_read_only",
      authoritySummary: "fallback_read_only, Commit 9",
      commitSequence: "9",
      createdAt: undefined,
      directoryEntries: [
        {
          kind: "file",
          name: "file.txt",
          path: "/docs/file.txt",
          pathComponents: ["docs", "file.txt"],
          target: "inode 2",
        },
        {
          kind: "subvolume",
          name: "snapshot",
          path: "/docs/snapshot",
          pathComponents: ["docs", "snapshot"],
          target: "Subvolume 7",
        },
      ],
      directorySummary: "2 entries (truncated)",
      fileSize: undefined,
      inodeKind: "directory",
      inodeNumber: "1",
      inodeRevision: "4",
      inodeSummary: "directory inode 1, revision 4",
      modifiedAt: "10",
      parentPath: "/",
      parentPathComponents: [],
      path: "/docs",
      pathComponents: ["docs"],
      symlinkTarget: undefined,
      validationEvidence: {
        rawPageReadEvents: [{
          label: "Page-read event 1",
          request: {
            frameLength: 160,
            homeOffset: "128",
            homeSegmentId: "00000000000000000000000000000003",
            pageIsRoot: true,
            recordKind: 5,
          },
          role: "inode_table",
        }],
        recordedPageReadEventCount: 1,
        repeatedPageReadEventCount: 0,
        totalPageReadEventCount: 12,
        traceTruncated: true,
        uniqueHomeRecordReferences: [{
          occurrenceCount: 1,
          request: {
            frameLength: 160,
            homeOffset: "128",
            homeSegmentId: "00000000000000000000000000000003",
            pageIsRoot: true,
            recordKind: 5,
          },
          roles: ["inode_table"],
        }],
      },
    });
  });

  it("separates unique Home Record References from repeated validation events", () => {
    const source = inspection();
    const firstEvent = source.pageReads[0];
    if (firstEvent === undefined) throw new Error("expected a validation event fixture");
    const view = createHizoFSNamespaceInspectionView({
      inspection: {
        ...source,
        pageReads: [firstEvent, { ...firstEvent, role: "directory" }, firstEvent],
        pageReadsTruncated: false,
        pagesRead: 3,
      },
    });

    expect(view.validationEvidence).toMatchObject({
      recordedPageReadEventCount: 3,
      repeatedPageReadEventCount: 2,
      totalPageReadEventCount: 3,
      traceTruncated: false,
      uniqueHomeRecordReferences: [{ occurrenceCount: 3, roles: ["inode_table", "directory"] }],
    });
    expect(view.validationEvidence.rawPageReadEvents).toHaveLength(3);
  });
});
