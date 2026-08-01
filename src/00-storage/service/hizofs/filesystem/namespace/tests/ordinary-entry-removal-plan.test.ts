import { describe, expect, it } from "vitest";
import {
  createInodeNumber,
  createSubvolumeId,
  type DirectoryLeafEntry,
  type InodeNumber,
} from "@/00-storage/service/hizofs/00-format";
import { prepareOrdinaryEntryRemovalPlan } from "@/00-storage/service/hizofs/filesystem/namespace/ordinary-entry-removal-plan";

const parentDirectoryInodeNumber = createInodeNumber({ value: 1n });

function entry({ inodeKind, inodeNumber, name }: {
  inodeKind: "directory" | "file" | "symlink";
  inodeNumber: bigint;
  name: string;
}): Extract<DirectoryLeafEntry, { targetType: "inode" }> {
  return {
    inodeKind,
    inodeNumber: createInodeNumber({ value: inodeNumber }),
    name,
    targetType: "inode",
  };
}

function directories(entries: readonly [InodeNumber, readonly DirectoryLeafEntry[]][]): ReadonlyMap<InodeNumber, readonly DirectoryLeafEntry[]> {
  return new Map(entries);
}

function request({
  directoryEntries = directories([]),
  recursive = false,
  sourceEntry = entry({ inodeKind: "file", inodeNumber: 2n, name: "source" }),
}: {
  directoryEntries?: ReadonlyMap<InodeNumber, readonly DirectoryLeafEntry[]>;
  recursive?: boolean;
  sourceEntry?: DirectoryLeafEntry | null;
} = {}): Parameters<typeof prepareOrdinaryEntryRemovalPlan>[0] {
  return {
    directoryEntries,
    limits: { deleteBatchSize: 2, maxVisitedInodes: 8 },
    parentAccess: "read_write",
    parentDirectoryInodeNumber,
    parentSubvolumeId: createSubvolumeId({ value: 1n }),
    recursive,
    sourceEntry,
  };
}

describe("ordinary entry removal planning", () => {
  it("rejects missing entries and read-only parents", () => {
    expect(() => prepareOrdinaryEntryRemovalPlan(request({ sourceEntry: null })))
      .toThrowError(expect.objectContaining({ code: "source_missing" }));
    expect(() => prepareOrdinaryEntryRemovalPlan({
      ...request(),
      parentAccess: "read",
    })).toThrowError(expect.objectContaining({ code: "read_only_parent" }));
  });

  it("removes files and symlinks without following their targets", () => {
    const symlink = entry({ inodeKind: "symlink", inodeNumber: 3n, name: "link" });
    expect(prepareOrdinaryEntryRemovalPlan(request({ recursive: true, sourceEntry: symlink }))).toEqual({
      deleteBatches: [[symlink.inodeNumber]],
      parentDirectoryInodeNumber,
      parentRemovalName: "link",
      removedInodeNumbersPostOrder: [symlink.inodeNumber],
      subvolumeId: createSubvolumeId({ value: 1n }),
    });
  });

  it("allows only empty directories without recursive mode", () => {
    const root = entry({ inodeKind: "directory", inodeNumber: 10n, name: "dir" });
    expect(prepareOrdinaryEntryRemovalPlan(request({
      directoryEntries: directories([[root.inodeNumber, []]]),
      sourceEntry: root,
    })).removedInodeNumbersPostOrder).toEqual([root.inodeNumber]);
    expect(() => prepareOrdinaryEntryRemovalPlan(request({
      directoryEntries: directories([[
        root.inodeNumber,
        [entry({ inodeKind: "file", inodeNumber: 11n, name: "child" })],
      ]]),
      sourceEntry: root,
    }))).toThrowError(expect.objectContaining({ code: "directory_not_empty" }));
  });

  it("builds deterministic descendant-first batches and does not follow symlinks", () => {
    const root = entry({ inodeKind: "directory", inodeNumber: 10n, name: "root" });
    const nested = entry({ inodeKind: "directory", inodeNumber: 11n, name: "nested" });
    const file = entry({ inodeKind: "file", inodeNumber: 12n, name: "file" });
    const link = entry({ inodeKind: "symlink", inodeNumber: 13n, name: "link" });
    const result = prepareOrdinaryEntryRemovalPlan(request({
      directoryEntries: directories([
        [root.inodeNumber, [nested, link]],
        [nested.inodeNumber, [file]],
      ]),
      recursive: true,
      sourceEntry: root,
    }));
    expect(result.removedInodeNumbersPostOrder).toEqual([
      file.inodeNumber,
      nested.inodeNumber,
      link.inodeNumber,
      root.inodeNumber,
    ]);
    expect(result.deleteBatches).toEqual([
      [file.inodeNumber, nested.inodeNumber],
      [link.inodeNumber, root.inodeNumber],
    ]);
  });

  it("rejects mounted Subvolumes anywhere in the subtree", () => {
    const root = entry({ inodeKind: "directory", inodeNumber: 10n, name: "root" });
    const mount: DirectoryLeafEntry = {
      name: "mounted",
      subvolumeId: createSubvolumeId({ value: 2n }),
      targetType: "subvolume",
    };
    expect(() => prepareOrdinaryEntryRemovalPlan(request({
      directoryEntries: directories([[root.inodeNumber, [mount]]]),
      recursive: true,
      sourceEntry: root,
    }))).toThrowError(expect.objectContaining({ code: "mounted_subvolume" }));
    expect(() => prepareOrdinaryEntryRemovalPlan(request({ sourceEntry: mount })))
      .toThrowError(expect.objectContaining({ code: "mounted_subvolume" }));
  });

  it("fails closed on missing directory state, duplicate inode identity, and cycles", () => {
    const root = entry({ inodeKind: "directory", inodeNumber: 10n, name: "root" });
    const nested = entry({ inodeKind: "directory", inodeNumber: 11n, name: "nested" });
    expect(() => prepareOrdinaryEntryRemovalPlan(request({ recursive: true, sourceEntry: root })))
      .toThrowError(expect.objectContaining({ code: "directory_state_missing" }));
    expect(() => prepareOrdinaryEntryRemovalPlan(request({
      directoryEntries: directories([
        [root.inodeNumber, [nested]],
        [nested.inodeNumber, [root]],
      ]),
      recursive: true,
      sourceEntry: root,
    }))).toThrowError(expect.objectContaining({ code: "invalid_directory_graph" }));
    const duplicate = entry({ inodeKind: "file", inodeNumber: 12n, name: "duplicate" });
    expect(() => prepareOrdinaryEntryRemovalPlan(request({
      directoryEntries: directories([[root.inodeNumber, [duplicate, { ...duplicate, name: "again" }]]]),
      recursive: true,
      sourceEntry: root,
    }))).toThrowError(expect.objectContaining({ code: "invalid_directory_graph" }));
  });

  it("enforces explicit traversal and delete-batch bounds", () => {
    const root = entry({ inodeKind: "directory", inodeNumber: 10n, name: "root" });
    const first = entry({ inodeKind: "file", inodeNumber: 11n, name: "a" });
    const second = entry({ inodeKind: "file", inodeNumber: 12n, name: "b" });
    expect(() => prepareOrdinaryEntryRemovalPlan({
      ...request({
        directoryEntries: directories([[root.inodeNumber, [first, second]]]),
        recursive: true,
        sourceEntry: root,
      }),
      limits: { deleteBatchSize: 1, maxVisitedInodes: 2 },
    })).toThrowError(expect.objectContaining({ code: "traversal_limit_exceeded" }));
    expect(() => prepareOrdinaryEntryRemovalPlan({
      ...request(),
      limits: { deleteBatchSize: 0, maxVisitedInodes: 2 },
    })).toThrowError(expect.objectContaining({ code: "invalid_limits" }));
  });
});
