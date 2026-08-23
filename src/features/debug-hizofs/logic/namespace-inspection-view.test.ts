import { describe, expect, it } from "vitest";
import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createFileOffset,
  createHomeRecordReference,
  createInodeNumber,
  createInodeRevision,
  createTimestampMilliseconds,
  createUInt64,
  parseSegmentId,
  type HomeRecordReference,
} from "@/00-storage/service/hizofs/00-format";
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
    nestedSubvolumeTableRoot: undefined,
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
    selectedInodeEvidence: {
      containingInodeTablePage: {
        frameLength: 160,
        homeOffset: "128",
        homeSegmentId: "00000000000000000000000000000003",
        pageIsRoot: true,
        recordKind: 5,
      },
      entry: {
        content: { entries: [], type: "inline" },
        inodeKind: "directory",
        inodeNumber: createInodeNumber({ value: 1n }),
        inodeRevision: createInodeRevision({ value: 4n }),
        timestamps: { createdAt: null, modifiedAt: createTimestampMilliseconds({ value: 10n }) },
      },
    },
  };
}

function homeReference({ offset, recordKind }: {
  offset: bigint;
  recordKind: number;
}): HomeRecordReference {
  return createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: offset }),
    frameLength: 160,
    recordKind,
    segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(7) }),
  } });
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
      nestedSubvolumeTableRoot: undefined,
      parentPath: "/",
      parentPathComponents: [],
      path: "/docs",
      pathComponents: ["docs"],
      selectedInodeEvidence: {
        containingInodeTablePage: {
          frameLength: 160,
          homeOffset: "128",
          homeSegmentId: "00000000000000000000000000000003",
          pageIsRoot: true,
          recordKind: 5,
        },
        contentSummary: "content.type inline · 0 Directory entries",
        entry: {
          content: { entries: [], type: "inline" },
          inodeKind: "directory",
          inodeNumber: 1n,
          inodeRevision: 4n,
          timestamps: { createdAt: null, modifiedAt: 10n },
        },
        entryJson: `{
  "content": {
    "entries": [],
    "type": "inline"
  },
  "inodeKind": "directory",
  "inodeNumber": "1",
  "inodeRevision": "4",
  "timestamps": {
    "createdAt": null,
    "modifiedAt": "10"
  }
}`,
        navigationTargets: [{
          label: "Containing Inode Table Page",
          relationship: "containing_inode_table_page",
          request: {
            frameLength: 160,
            homeOffset: "128",
            homeSegmentId: "00000000000000000000000000000003",
            pageIsRoot: true,
            recordKind: 5,
          },
          targetType: "home_record",
        }],
      },
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

  it("projects inline and tree File content from the exact selected Inode union", () => {
    const source = inspection();
    const inline = createHizoFSNamespaceInspectionView({
      inspection: {
        ...source,
        directory: undefined,
        inode: {
          createdAt: undefined,
          fileSize: "3",
          inodeKind: "file",
          inodeNumber: "7",
          inodeRevision: "2",
          modifiedAt: undefined,
          symlinkTarget: undefined,
        },
        selectedInodeEvidence: {
          ...source.selectedInodeEvidence,
          entry: {
            content: { bytes: Uint8Array.from([0, 16, 255]), type: "inline" },
            fileSize: createFileOffset({ value: 3n }),
            inodeKind: "file",
            inodeNumber: createInodeNumber({ value: 7n }),
            inodeRevision: createInodeRevision({ value: 2n }),
            timestamps: { createdAt: null, modifiedAt: null },
          },
        },
      },
    });
    expect(inline.selectedInodeEvidence.contentSummary).toContain("content.type inline · fileSize 3 · bytes.byteLength 3");
    expect(inline.selectedInodeEvidence.entryJson).toContain('"hex": "0010ff"');
    expect(inline.selectedInodeEvidence.navigationTargets).toHaveLength(1);

    const extentRoot = homeReference({
      offset: 512n,
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_extent_page,
    });
    const tree = createHizoFSNamespaceInspectionView({
      inspection: {
        ...source,
        directory: undefined,
        inode: {
          createdAt: undefined,
          fileSize: "3",
          inodeKind: "file",
          inodeNumber: "7",
          inodeRevision: "3",
          modifiedAt: undefined,
          symlinkTarget: undefined,
        },
        selectedInodeEvidence: {
          ...source.selectedInodeEvidence,
          entry: {
            content: { extentTreeRootHomeRef: extentRoot, type: "tree" },
            fileSize: createFileOffset({ value: 3n }),
            inodeKind: "file",
            inodeNumber: createInodeNumber({ value: 7n }),
            inodeRevision: createInodeRevision({ value: 3n }),
            timestamps: { createdAt: null, modifiedAt: null },
          },
        },
      },
    });
    expect(tree.selectedInodeEvidence.contentSummary).toContain("content.type tree · fileSize 3 · extentTreeRootHomeRef");
    expect(tree.selectedInodeEvidence.navigationTargets.map(target => target.label)).toEqual([
      "Containing Inode Table Page",
      "extentTreeRootHomeRef",
    ]);
  });

  it("projects tree Directory and Symlink structural evidence without inferred content", () => {
    const source = inspection();
    const directoryRoot = homeReference({
      offset: 768n,
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.directory_page,
    });
    const directory = createHizoFSNamespaceInspectionView({
      inspection: {
        ...source,
        directory: { entries: [], truncated: false },
        inode: {
          createdAt: undefined,
          fileSize: undefined,
          inodeKind: "directory",
          inodeNumber: "8",
          inodeRevision: "1",
          modifiedAt: undefined,
          symlinkTarget: undefined,
        },
        selectedInodeEvidence: {
          ...source.selectedInodeEvidence,
          entry: {
            content: { directoryTreeRootHomeRef: directoryRoot, type: "tree" },
            inodeKind: "directory",
            inodeNumber: createInodeNumber({ value: 8n }),
            inodeRevision: createInodeRevision({ value: 1n }),
            timestamps: { createdAt: null, modifiedAt: null },
          },
        },
      },
    });
    expect(directory.selectedInodeEvidence.navigationTargets.at(-1)?.label).toBe("directoryTreeRootHomeRef");

    const symlink = createHizoFSNamespaceInspectionView({
      inspection: {
        ...source,
        directory: undefined,
        inode: {
          createdAt: undefined,
          fileSize: undefined,
          inodeKind: "symlink",
          inodeNumber: "9",
          inodeRevision: "1",
          modifiedAt: undefined,
          symlinkTarget: "../target",
        },
        selectedInodeEvidence: {
          ...source.selectedInodeEvidence,
          entry: {
            inodeKind: "symlink",
            inodeNumber: createInodeNumber({ value: 9n }),
            inodeRevision: createInodeRevision({ value: 1n }),
            target: "../target",
            timestamps: { createdAt: null, modifiedAt: null },
          },
        },
      },
    });
    expect(symlink.selectedInodeEvidence.contentSummary).toBe("target ../target");
    expect(symlink.selectedInodeEvidence.navigationTargets).toHaveLength(1);
  });
});
