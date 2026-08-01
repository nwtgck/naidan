import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  UINT64_MAXIMUM,
  createHomeRecordReference,
  createInodeNumber,
  createInodeRevision,
  createSubvolumeId,
  createTimestampMilliseconds,
  createUInt64,
  parseSegmentId,
  type DirectoryInodeEntry,
} from "@/00-storage/service/hizofs/00-format";
import {
  InlineDirectoryCreateMutationError,
  prepareInlineDirectoryCreateMutation,
} from "@/00-storage/service/hizofs/filesystem/namespace/inline-directory-create-mutation";
import { prepareOrdinaryEntryCreatePlan } from "@/00-storage/service/hizofs/filesystem/namespace/ordinary-entry-create-plan";
import { describe, expect, it } from "vitest";

const operationTimestamp = createTimestampMilliseconds({ value: 1_700_000_000_000n });

function parent({ revision = 4n }: { revision?: bigint } = {}): DirectoryInodeEntry {
  return {
    content: {
      entries: [{
        inodeKind: "file",
        inodeNumber: createInodeNumber({ value: 2n }),
        name: "z",
        targetType: "inode",
      }],
      type: "inline",
    },
    inodeKind: "directory",
    inodeNumber: createInodeNumber({ value: 1n }),
    inodeRevision: createInodeRevision({ value: revision }),
    timestamps: { createdAt: null, modifiedAt: null },
  };
}

function plan({ entryName = "a" }: { entryName?: string } = {}) {
  return prepareOrdinaryEntryCreatePlan({
    knownInodeNumbers: [createInodeNumber({ value: 1n }), createInodeNumber({ value: 2n })],
    nextInodeNumber: createInodeNumber({ value: 3n }),
    operationTimestamp,
    request: { type: "file" },
    target: {
      destinationExists: false,
      entryName,
      parentAccess: "read_write",
      parentDirectoryInodeNumber: createInodeNumber({ value: 1n }),
      parentSubvolumeId: createSubvolumeId({ value: 1n }),
    },
  });
}

describe("prepareInlineDirectoryCreateMutation", () => {
  it("updates the parent and inserts the allocated inode as root-table changes", () => {
    const result = prepareInlineDirectoryCreateMutation({ parent: parent(), plan: plan() });
    expect(result.updatedParent.content).toEqual({
      entries: [
        { inodeKind: "file", inodeNumber: 3n, name: "a", targetType: "inode" },
        { inodeKind: "file", inodeNumber: 2n, name: "z", targetType: "inode" },
      ],
      type: "inline",
    });
    expect(result.updatedParent.inodeRevision).toBe(5n);
    expect(result.updatedParent.timestamps.modifiedAt).toBe(operationTimestamp);
    expect(result.changes).toHaveLength(2);
  });

  it("orders names by canonical UTF-8 bytes", () => {
    const result = prepareInlineDirectoryCreateMutation({ parent: parent(), plan: plan({ entryName: "ä" }) });
    if (result.updatedParent.content.type !== "inline") throw new Error("expected inline directory");
    expect(result.updatedParent.content.entries.map(entry => entry.name)).toEqual(["z", "ä"]);
  });

  it("rejects a stale duplicate destination", () => {
    const staleParent = parent();
    if (staleParent.content.type !== "inline") throw new Error("expected inline directory");
    const duplicate: DirectoryInodeEntry = {
      ...staleParent,
      content: {
        entries: [...staleParent.content.entries, {
          inodeKind: "file",
          inodeNumber: createInodeNumber({ value: 8n }),
          name: "a",
          targetType: "inode",
        }],
        type: "inline",
      },
    };
    expect(() => prepareInlineDirectoryCreateMutation({ parent: duplicate, plan: plan() }))
      .toThrowError(InlineDirectoryCreateMutationError);
  });

  it("rejects a parent identity mismatch", () => {
    expect(() => prepareInlineDirectoryCreateMutation({
      parent: { ...parent(), inodeNumber: createInodeNumber({ value: 8n }) },
      plan: plan(),
    })).toThrow("does not target");
  });

  it("rejects exhausted parent revisions", () => {
    expect(() => prepareInlineDirectoryCreateMutation({
      parent: parent({ revision: UINT64_MAXIMUM }),
      plan: plan(),
    })).toThrow("revision is exhausted");
  });

  it("fails closed for a tree-backed parent", () => {
    const treeParent: DirectoryInodeEntry = {
      ...parent(),
      content: {
        directoryTreeRootHomeRef: createHomeRecordReference({ fields: {
          byteOffset: createUInt64({ value: 64n }),
          frameLength: 128,
          recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.directory_page,
          segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(7) }),
        } }),
        type: "tree",
      },
    };
    expect(() => prepareInlineDirectoryCreateMutation({ parent: treeParent, plan: plan() }))
      .toThrow("directory-page mutation executor");
  });
});
