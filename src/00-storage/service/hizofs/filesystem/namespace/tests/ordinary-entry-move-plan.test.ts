import { describe, expect, it } from "vitest";
import {
  createInodeNumber,
  createSubvolumeId,
  type DirectoryLeafEntry,
} from "@/00-storage/service/hizofs/00-format";
import { prepareOrdinaryEntryMovePlan } from "@/00-storage/service/hizofs/filesystem/namespace/ordinary-entry-move-plan";

const subvolume1 = createSubvolumeId({ value: 1n });
const subvolume2 = createSubvolumeId({ value: 2n });
const directory1 = createInodeNumber({ value: 10n });
const directory2 = createInodeNumber({ value: 11n });

type InodeDirectoryLeafEntry = Extract<DirectoryLeafEntry, { targetType: "inode" }>;
type MoveRequest = Parameters<typeof prepareOrdinaryEntryMovePlan>[0];
type MoveRequestOptions = Readonly<{
  destinationEntry?: DirectoryLeafEntry | null;
  destinationParentDirectoryInodeNumber?: MoveRequest["destination"]["parentDirectoryInodeNumber"];
  destinationParentSubvolumeId?: MoveRequest["destination"]["parentSubvolumeId"];
  sourceEntry?: DirectoryLeafEntry | null;
  sourceParentDirectoryInodeNumber?: MoveRequest["source"]["parentDirectoryInodeNumber"];
  sourceParentSubvolumeId?: MoveRequest["source"]["parentSubvolumeId"];
}>;

function inodeEntry({ inodeKind, inodeNumber = 20n, name }: {
  inodeKind: "directory" | "file" | "symlink";
  inodeNumber?: bigint;
  name: string;
}): InodeDirectoryLeafEntry {
  return {
    inodeKind,
    inodeNumber: createInodeNumber({ value: inodeNumber }),
    name,
    targetType: "inode",
  };
}

function request({
  destinationEntry = null,
  destinationParentDirectoryInodeNumber = directory2,
  destinationParentSubvolumeId = subvolume1,
  sourceEntry = inodeEntry({ inodeKind: "file", name: "source" }),
  sourceParentDirectoryInodeNumber = directory1,
  sourceParentSubvolumeId = subvolume1,
}: MoveRequestOptions = {}): MoveRequest {
  return {
    destination: {
      directoryContainsSubvolumeMount: false,
      directoryEmpty: true,
      entry: destinationEntry,
      parentAccess: "read_write",
      parentDirectoryInodeNumber: destinationParentDirectoryInodeNumber,
      parentSubvolumeId: destinationParentSubvolumeId,
    },
    destinationName: "destination",
    replace: true,
    source: {
      directoryDescendantInodeNumbers: [],
      entry: sourceEntry,
      parentAccess: "read_write",
      parentDirectoryInodeNumber: sourceParentDirectoryInodeNumber,
      parentSubvolumeId: sourceParentSubvolumeId,
    },
  };
}

describe("ordinary entry move planning", () => {
  it("rejects a missing source before considering same-path no-op", () => {
    expect(() => prepareOrdinaryEntryMovePlan({
      ...request(),
      destinationName: "source",
      source: {
        ...request().source,
        entry: null,
        parentDirectoryInodeNumber: directory1,
      },
    })).toThrowError(expect.objectContaining({ code: "source_missing" }));
  });

  it("returns no-op only after resolving an existing exact same path", () => {
    const sourceEntry = inodeEntry({ inodeKind: "file", name: "same" });
    expect(prepareOrdinaryEntryMovePlan({
      ...request({ sourceEntry, sourceParentDirectoryInodeNumber: directory1 }),
      destination: {
        ...request().destination,
        entry: sourceEntry,
        parentDirectoryInodeNumber: directory1,
      },
      destinationName: "same",
    })).toBeNull();
  });

  it("rejects cross-Subvolume moves and read-only parents", () => {
    expect(() => prepareOrdinaryEntryMovePlan(request({ destinationParentSubvolumeId: subvolume2 })))
      .toThrowError(expect.objectContaining({ code: "cross_subvolume" }));
    expect(() => prepareOrdinaryEntryMovePlan({
      ...request(),
      destination: { ...request().destination, parentAccess: "read" },
    })).toThrowError(expect.objectContaining({ code: "read_only_parent" }));
  });

  it("rejects an existing destination when replacement was not requested", () => {
    expect(() => prepareOrdinaryEntryMovePlan({
      ...request({ destinationEntry: inodeEntry({ inodeKind: "file", inodeNumber: 21n, name: "destination" }) }),
      replace: false,
    })).toThrowError(expect.objectContaining({ code: "destination_exists" }));
  });

  it("rejects mounted Subvolume entries on either side", () => {
    const mount: DirectoryLeafEntry = {
      name: "mount",
      subvolumeId: subvolume2,
      targetType: "subvolume",
    };
    expect(() => prepareOrdinaryEntryMovePlan(request({ sourceEntry: mount })))
      .toThrowError(expect.objectContaining({ code: "mounted_subvolume" }));
    expect(() => prepareOrdinaryEntryMovePlan(request({ destinationEntry: mount })))
      .toThrowError(expect.objectContaining({ code: "mounted_subvolume" }));
  });

  it("allows file and symlink replacement while preserving fresh destination binding", () => {
    const sourceEntry = inodeEntry({ inodeKind: "file", inodeNumber: 21n, name: "source" });
    const destinationEntry = inodeEntry({ inodeKind: "symlink", inodeNumber: 22n, name: "destination" });
    expect(prepareOrdinaryEntryMovePlan(request({ destinationEntry, sourceEntry }))).toEqual({
      destinationBinding: { ...sourceEntry, name: "destination" },
      destinationParentDirectoryInodeNumber: directory2,
      replacedInodeNumber: destinationEntry.inodeNumber,
      sourceParentDirectoryInodeNumber: directory1,
      sourceRemovalName: "source",
      subvolumeId: subvolume1,
      type: "move",
    });
  });

  it("enforces the directory replacement matrix", () => {
    const directorySource = inodeEntry({ inodeKind: "directory", inodeNumber: 30n, name: "source" });
    const directoryDestination = inodeEntry({ inodeKind: "directory", inodeNumber: 31n, name: "destination" });
    expect(() => prepareOrdinaryEntryMovePlan(request({
      destinationEntry: directoryDestination,
      sourceEntry: inodeEntry({ inodeKind: "file", name: "source" }),
    }))).toThrowError(expect.objectContaining({ code: "type_mismatch" }));
    expect(() => prepareOrdinaryEntryMovePlan(request({
      destinationEntry: inodeEntry({ inodeKind: "file", name: "destination" }),
      sourceEntry: directorySource,
    }))).toThrowError(expect.objectContaining({ code: "type_mismatch" }));
    expect(() => prepareOrdinaryEntryMovePlan({
      ...request({ destinationEntry: directoryDestination, sourceEntry: directorySource }),
      destination: { ...request().destination, directoryEmpty: false, entry: directoryDestination },
    })).toThrowError(expect.objectContaining({ code: "destination_directory_not_empty" }));
    expect(() => prepareOrdinaryEntryMovePlan({
      ...request({ destinationEntry: directoryDestination, sourceEntry: directorySource }),
      destination: { ...request().destination, directoryContainsSubvolumeMount: true, entry: directoryDestination },
    })).toThrowError(expect.objectContaining({ code: "destination_directory_has_subvolume" }));
  });

  it("rejects moving a directory into itself or a descendant", () => {
    const sourceEntry = inodeEntry({ inodeKind: "directory", inodeNumber: 30n, name: "source" });
    expect(() => prepareOrdinaryEntryMovePlan(request({
      destinationParentDirectoryInodeNumber: sourceEntry.inodeNumber,
      sourceEntry,
    }))).toThrowError(expect.objectContaining({ code: "directory_cycle" }));
    expect(() => prepareOrdinaryEntryMovePlan({
      ...request({ sourceEntry }),
      destination: { ...request().destination, parentDirectoryInodeNumber: createInodeNumber({ value: 40n }) },
      source: {
        ...request().source,
        directoryDescendantInodeNumbers: [createInodeNumber({ value: 40n })],
        entry: sourceEntry,
      },
    })).toThrowError(expect.objectContaining({ code: "directory_cycle" }));
  });
});
