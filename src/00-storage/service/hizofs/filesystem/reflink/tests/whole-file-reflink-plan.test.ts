import { describe, expect, it } from "vitest";
import {
  createFileOffset,
  createHomeRecordReference,
  createInodeNumber,
  createInodeRevision,
  createSubvolumeId,
  createTimestampMilliseconds,
  createUInt64,
  HIZOFS_V1_FORMAT_CONSTANTS,
  parseSegmentId,
  UINT64_MAXIMUM,
  type FileInodeEntry,
  type InodeLeafEntry,
} from "@/00-storage/service/hizofs/00-format";
import type { ContainerCoordinationKey } from "@/00-storage/service/hizofs/filesystem/container-coordination-key";
import { prepareWholeFileReflinkPlan } from "@/00-storage/service/hizofs/filesystem/reflink/whole-file-reflink-plan";

function coordinationKey(): ContainerCoordinationKey {
  return Object.freeze({}) as ContainerCoordinationKey;
}

const extentRoot = createHomeRecordReference({ fields: {
  byteOffset: createUInt64({ value: 128n }),
  frameLength: 96,
  recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_extent_page,
  segmentId: parseSegmentId({ bytes: Uint8Array.from({ length: 16 }, (_, index) => 32 - index) }),
} });

function inlineSource(): FileInodeEntry {
  return {
    content: { bytes: Uint8Array.of(1, 2, 3), type: "inline" },
    fileSize: createFileOffset({ value: 3n }),
    inodeKind: "file",
    inodeNumber: createInodeNumber({ value: 4n }),
    inodeRevision: createInodeRevision({ value: 7n }),
    timestamps: {
      createdAt: createTimestampMilliseconds({ value: 10n }),
      modifiedAt: createTimestampMilliseconds({ value: 20n }),
    },
  };
}

function treeSource(): FileInodeEntry {
  return {
    content: { extentTreeRootHomeRef: extentRoot, type: "tree" },
    fileSize: createFileOffset({ value: 9_000n }),
    inodeKind: "file",
    inodeNumber: createInodeNumber({ value: 5n }),
    inodeRevision: createInodeRevision({ value: 2n }),
    timestamps: { createdAt: null, modifiedAt: null },
  };
}

function planInput({
  container = coordinationKey(),
  destinationEntry = null,
  destinationIsSource = false,
  maximumKnownInodeNumber = 7n,
  nextInodeNumber = 8n,
  parentAccess = "read_write",
  parentDirectoryInodeNumber = 1n,
  replace = true,
  sourceContainer = container,
  sourceInode = inlineSource() as InodeLeafEntry,
  sourceReachable = true,
}: Readonly<{
  container?: ContainerCoordinationKey;
  destinationEntry?: Parameters<typeof prepareWholeFileReflinkPlan>[0]["target"]["existingEntry"];
  destinationIsSource?: boolean;
  maximumKnownInodeNumber?: bigint;
  nextInodeNumber?: bigint;
  parentAccess?: "read" | "read_write";
  parentDirectoryInodeNumber?: bigint;
  replace?: boolean;
  sourceContainer?: ContainerCoordinationKey;
  sourceInode?: InodeLeafEntry | null;
  sourceReachable?: boolean;
}> = {}) {
  return {
    maximumKnownInodeNumber: createInodeNumber({ value: maximumKnownInodeNumber }),
    nextInodeNumber: createInodeNumber({ value: nextInodeNumber }),
    operationTimestamp: createTimestampMilliseconds({ value: 100n }),
    source: {
      containerCoordinationKey: sourceContainer,
      inode: sourceInode,
      reachable: sourceReachable,
    },
    target: {
      containerCoordinationKey: container,
      destinationIsSource,
      entryName: "clone.bin",
      existingEntry: destinationEntry,
      parentAccess,
      parentDirectoryInodeNumber: createInodeNumber({ value: parentDirectoryInodeNumber }),
      replace,
    },
  } as const;
}

function errorCode(input: Parameters<typeof prepareWholeFileReflinkPlan>[0]): string | undefined {
  try {
    prepareWholeFileReflinkPlan(input);
    return undefined;
  } catch (error: unknown) {
    return error instanceof Error && "code" in error ? String(error.code) : undefined;
  }
}

describe("whole-file reflink plan", () => {
  it("copies inline bytes into a fresh inode identity", () => {
    const source = inlineSource();
    const plan = prepareWholeFileReflinkPlan(planInput({ sourceInode: source }));
    expect(plan.directoryEntry).toEqual({
      inodeKind: "file",
      inodeNumber: 8n,
      name: "clone.bin",
      targetType: "inode",
    });
    expect(plan.inode).toMatchObject({
      fileSize: 3n,
      inodeKind: "file",
      inodeNumber: 8n,
      inodeRevision: 1n,
      timestamps: { createdAt: 100n, modifiedAt: 100n },
    });
    expect(plan.inode.content.type).toBe("inline");
    if (plan.inode.content.type !== "inline" || source.content.type !== "inline") throw new Error("expected inline content");
    expect(plan.inode.content.bytes).toEqual(source.content.bytes);
    expect(plan.inode.content.bytes).not.toBe(source.content.bytes);
    expect(plan.destinationParentDirectoryInodeNumber).toBe(1n);
    expect(plan.nextInodeNumber).toBe(9n);
  });

  it("shares an immutable extent graph without copying source timestamps", () => {
    const source = treeSource();
    const plan = prepareWholeFileReflinkPlan(planInput({ nextInodeNumber: 9n, sourceInode: source }));
    expect(plan.inode.content).toEqual({ extentTreeRootHomeRef: extentRoot, type: "tree" });
    expect(plan.inode.timestamps).toEqual({ createdAt: 100n, modifiedAt: 100n });
    expect(plan.inode.inodeNumber).toBe(9n);
  });

  it("requires explicit replacement and allows replacing a regular file or symlink", () => {
    expect(errorCode(planInput({
      destinationEntry: {
        inodeKind: "file",
        inodeNumber: createInodeNumber({ value: 6n }),
        name: "clone.bin",
        targetType: "inode",
      },
      replace: false,
    }))).toBe("destination_exists");

    const fileReplacement = prepareWholeFileReflinkPlan(planInput({
      destinationEntry: {
        inodeKind: "file",
        inodeNumber: createInodeNumber({ value: 6n }),
        name: "clone.bin",
        targetType: "inode",
      },
    }));
    expect(fileReplacement.replacedInodeNumber).toBe(6n);
    expect(fileReplacement.expectedDestinationEntry).toMatchObject({ inodeKind: "file", inodeNumber: 6n });

    const symlinkReplacement = prepareWholeFileReflinkPlan(planInput({
      destinationEntry: {
        inodeKind: "symlink",
        inodeNumber: createInodeNumber({ value: 7n }),
        name: "clone.bin",
        targetType: "inode",
      },
    }));
    expect(symlinkReplacement.replacedInodeNumber).toBe(7n);
  });

  it("rejects a destination binding whose captured name does not match the request", () => {
    expect(errorCode(planInput({
      destinationEntry: {
        inodeKind: "file",
        inodeNumber: createInodeNumber({ value: 6n }),
        name: "different.bin",
        targetType: "inode",
      },
    }))).toBe("destination_binding_mismatch");
  });

  it("rejects a missing or non-regular source", () => {
    expect(errorCode(planInput({ sourceReachable: false }))).toBe("source_not_found");
    expect(errorCode(planInput({ sourceInode: {
      content: { entries: [], type: "inline" },
      inodeKind: "directory",
      inodeNumber: createInodeNumber({ value: 4n }),
      inodeRevision: createInodeRevision({ value: 1n }),
      timestamps: { createdAt: null, modifiedAt: null },
    } }))).toBe("source_not_regular_file");
  });

  it("rejects cross-container and read-only destination operations", () => {
    expect(errorCode(planInput({ sourceContainer: coordinationKey() }))).toBe("cross_device");
    expect(errorCode(planInput({ parentAccess: "read" }))).toBe("parent_read_only");
  });

  it("rejects directory, subvolume, and destructive self replacement", () => {
    expect(errorCode(planInput({
      destinationEntry: {
        inodeKind: "directory",
        inodeNumber: createInodeNumber({ value: 6n }),
        name: "clone.bin",
        targetType: "inode",
      },
    }))).toBe("destination_type_mismatch");
    expect(errorCode(planInput({
      destinationEntry: {
        name: "clone.bin",
        subvolumeId: createSubvolumeId({ value: 6n }),
        targetType: "subvolume",
      },
    }))).toBe("destination_type_mismatch");
    expect(errorCode(planInput({ destinationIsSource: true }))).toBe("destructive_self_replace");
  });

  it("rejects allocator exhaustion and a regressed high-water mark", () => {
    expect(errorCode(planInput({ nextInodeNumber: UINT64_MAXIMUM }))).toBe("allocator_exhausted");
    expect(errorCode(planInput({ nextInodeNumber: 4n }))).toBe("allocator_regression");
    expect(errorCode(planInput({ maximumKnownInodeNumber: 12n, nextInodeNumber: 8n })))
      .toBe("allocator_regression");
    expect(errorCode(planInput({
      destinationEntry: {
        inodeKind: "file",
        inodeNumber: createInodeNumber({ value: 9n }),
        name: "clone.bin",
        targetType: "inode",
      },
      nextInodeNumber: 8n,
    }))).toBe("allocator_regression");
  });
});
