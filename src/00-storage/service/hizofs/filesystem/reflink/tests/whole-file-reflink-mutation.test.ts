import { describe, expect, it } from "vitest";
import {
  UINT64_MAXIMUM,
  createFileOffset,
  createInodeNumber,
  createInodeRevision,
  createTimestampMilliseconds,
  type DirectoryInodeEntry,
  type DirectoryLeafEntry,
  type FileInodeEntry,
} from "@/00-storage/service/hizofs/00-format";
import type { ContainerCoordinationKey } from "@/00-storage/service/hizofs/filesystem/container-coordination-key";
import type { DirectoryPageTreePageStore } from "@/00-storage/service/hizofs/filesystem/mutation/directory-page-tree";
import { prepareWholeFileReflinkMutation } from "@/00-storage/service/hizofs/filesystem/reflink/whole-file-reflink-mutation";
import { prepareWholeFileReflinkPlan } from "@/00-storage/service/hizofs/filesystem/reflink/whole-file-reflink-plan";

function coordinationKey(): ContainerCoordinationKey {
  return Object.freeze({}) as ContainerCoordinationKey;
}

function sourceFile(): FileInodeEntry {
  return {
    content: { bytes: Uint8Array.of(1, 2, 3), type: "inline" },
    fileSize: createFileOffset({ value: 3n }),
    inodeKind: "file",
    inodeNumber: createInodeNumber({ value: 4n }),
    inodeRevision: createInodeRevision({ value: 2n }),
    timestamps: { createdAt: null, modifiedAt: null },
  };
}

function parent({ entries, inodeNumber = 1n, inodeRevision = 3n }: {
  entries: readonly DirectoryLeafEntry[];
  inodeNumber?: bigint;
  inodeRevision?: bigint;
}): DirectoryInodeEntry {
  return {
    content: { entries, type: "inline" },
    inodeKind: "directory",
    inodeNumber: createInodeNumber({ value: inodeNumber }),
    inodeRevision: createInodeRevision({ value: inodeRevision }),
    timestamps: { createdAt: null, modifiedAt: null },
  };
}

function pageStore(): DirectoryPageTreePageStore {
  return {
    readPage: async () => {
      throw new Error("inline reflink must not read Directory Pages");
    },
    writePage: async () => {
      throw new Error("inline reflink must not write Directory Pages");
    },
  };
}

function plan({ existingEntry = null, replace = true }: {
  existingEntry?: DirectoryLeafEntry | null;
  replace?: boolean;
} = {}) {
  const key = coordinationKey();
  return prepareWholeFileReflinkPlan({
    knownInodeNumbers: [
      createInodeNumber({ value: 1n }),
      createInodeNumber({ value: 4n }),
      ...(existingEntry?.targetType === "inode" ? [existingEntry.inodeNumber] : []),
    ],
    nextInodeNumber: createInodeNumber({ value: 8n }),
    operationTimestamp: createTimestampMilliseconds({ value: 100n }),
    source: {
      containerCoordinationKey: key,
      inode: sourceFile(),
      reachable: true,
    },
    target: {
      containerCoordinationKey: key,
      destinationIsSource: false,
      entryName: "clone.bin",
      existingEntry,
      parentAccess: "read_write",
      parentDirectoryInodeNumber: createInodeNumber({ value: 1n }),
      replace,
    },
  });
}

describe("whole-file reflink mutation", () => {
  it("updates the parent, inserts the fresh inode, and deletes a replacement atomically", async () => {
    const replacement: DirectoryLeafEntry = {
      inodeKind: "file",
      inodeNumber: createInodeNumber({ value: 6n }),
      name: "clone.bin",
      targetType: "inode",
    };
    const preparedPlan = plan({ existingEntry: replacement });
    const mutation = await prepareWholeFileReflinkMutation({
      destinationParent: parent({ entries: [replacement] }),
      directoryPageStore: pageStore(),
      operationTimestamp: createTimestampMilliseconds({ value: 100n }),
      plan: preparedPlan,
    });

    expect(mutation.updatedDestinationParent).toMatchObject({
      inodeNumber: 1n,
      inodeRevision: 4n,
      timestamps: { modifiedAt: 100n },
    });
    if (mutation.updatedDestinationParent.content.type !== "inline") throw new Error("expected inline parent");
    expect(mutation.updatedDestinationParent.content.entries).toEqual([preparedPlan.directoryEntry]);
    expect(mutation.rootInodeTableChanges).toEqual([
      { entry: mutation.updatedDestinationParent, type: "set" },
      { entry: preparedPlan.inode, type: "set" },
      { key: 6n, type: "delete" },
    ]);
  });

  it("rejects a stale replacement binding even when its inode number is unchanged", async () => {
    const replacement: DirectoryLeafEntry = {
      inodeKind: "file",
      inodeNumber: createInodeNumber({ value: 6n }),
      name: "clone.bin",
      targetType: "inode",
    };
    const preparedPlan = plan({ existingEntry: replacement });
    const stale: DirectoryLeafEntry = { ...replacement, inodeKind: "symlink" };
    await expect(prepareWholeFileReflinkMutation({
      destinationParent: parent({ entries: [stale] }),
      directoryPageStore: pageStore(),
      operationTimestamp: createTimestampMilliseconds({ value: 100n }),
      plan: preparedPlan,
    })).rejects.toMatchObject({ code: "destination_changed" });
  });

  it("rejects parent identity mismatch and revision exhaustion", async () => {
    const preparedPlan = plan();
    await expect(prepareWholeFileReflinkMutation({
      destinationParent: parent({ entries: [], inodeNumber: 2n }),
      directoryPageStore: pageStore(),
      operationTimestamp: createTimestampMilliseconds({ value: 100n }),
      plan: preparedPlan,
    })).rejects.toMatchObject({ code: "destination_parent_identity_mismatch" });

    await expect(prepareWholeFileReflinkMutation({
      destinationParent: parent({ entries: [], inodeRevision: UINT64_MAXIMUM }),
      directoryPageStore: pageStore(),
      operationTimestamp: createTimestampMilliseconds({ value: 100n }),
      plan: preparedPlan,
    })).rejects.toMatchObject({ code: "parent_revision_exhausted" });
  });
});
