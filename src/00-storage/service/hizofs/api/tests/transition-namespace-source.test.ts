import {
  createFileOffset,
  createInodeNumber,
  createInodeRevision,
  createTimestampMilliseconds,
  type DirectoryInodeEntry,
  type DirectoryLeafEntry,
  type FileInodeEntry,
  type InodeLeafEntry,
  type SymlinkInodeEntry,
} from "@/00-storage/service/hizofs/00-format";
import { createHizoFSTransitionNamespaceSource } from "@/00-storage/service/hizofs/api/transition-namespace-source";
import type {
  ReadOnlyInodeStat,
  ReadOnlyNamespaceResolver,
} from "@/00-storage/service/hizofs/filesystem/read-only-namespace";
import { describe, expect, it, vi } from "vitest";

const rootNumber = createInodeNumber({ value: 1n });
const fileNumber = createInodeNumber({ value: 2n });
const symlinkNumber = createInodeNumber({ value: 3n });
const revision = createInodeRevision({ value: 1n });

const fileEntry: DirectoryLeafEntry = {
  inodeKind: "file",
  inodeNumber: fileNumber,
  name: "data.bin",
  targetType: "inode",
};
const symlinkEntry: DirectoryLeafEntry = {
  inodeKind: "symlink",
  inodeNumber: symlinkNumber,
  name: "link",
  targetType: "inode",
};
const root: DirectoryInodeEntry = {
  content: { entries: [fileEntry, symlinkEntry], type: "inline" },
  inodeKind: "directory",
  inodeNumber: rootNumber,
  inodeRevision: revision,
  timestamps: {
    createdAt: createTimestampMilliseconds({ value: 10n }),
    modifiedAt: null,
  },
};
const file: FileInodeEntry = {
  content: { bytes: Uint8Array.of(1, 2, 3, 4), type: "inline" },
  fileSize: createFileOffset({ value: 4n }),
  inodeKind: "file",
  inodeNumber: fileNumber,
  inodeRevision: revision,
  timestamps: {
    createdAt: null,
    modifiedAt: createTimestampMilliseconds({ value: 20n }),
  },
};
const symlink: SymlinkInodeEntry = {
  inodeKind: "symlink",
  inodeNumber: symlinkNumber,
  inodeRevision: revision,
  target: "data.bin",
  timestamps: { createdAt: null, modifiedAt: null },
};

function stat({ inode }: { inode: InodeLeafEntry }): ReadOnlyInodeStat {
  const base = {
    createdAt: inode.timestamps.createdAt,
    inodeNumber: inode.inodeNumber,
    inodeRevision: inode.inodeRevision,
    kind: inode.inodeKind,
    modifiedAt: inode.timestamps.modifiedAt,
  };
  switch (inode.inodeKind) {
  case "directory":
  case "symlink": return base;
  case "file": return { ...base, fileSize: inode.fileSize };
  default: return inode satisfies never;
  }
}

function fixture(): Readonly<{
  listDirectoryEntriesAfterBounded: ReturnType<typeof vi.fn>;
  resolver: ReadOnlyNamespaceResolver;
}> {
  const byNumber = new Map([[rootNumber, root], [fileNumber, file], [symlinkNumber, symlink]] as const);
  const byPath = new Map<string, InodeLeafEntry>([
    ["", root],
    ["data.bin", file],
    ["link", symlink],
  ]);
  const resolveInode = async ({ pathComponents }: { pathComponents: readonly string[] }): Promise<InodeLeafEntry> => {
    const inode = byPath.get(pathComponents.join("/"));
    if (inode === undefined) throw new Error("missing test inode path");
    return inode;
  };
  const resolveInodeByNumber = async ({ inodeNumber }: { inodeNumber: typeof rootNumber }): Promise<InodeLeafEntry> => {
    const inode = byNumber.get(inodeNumber);
    if (inode === undefined) throw new Error("missing test inode number");
    return inode;
  };
  const listDirectoryEntriesAfterBounded = vi.fn(async () => ({
    entries: [fileEntry, symlinkEntry],
    truncated: false,
  }));
  const resolver: ReadOnlyNamespaceResolver = {
    knownInodeNumbers: async () => [...byNumber.keys()],
    list: async () => [fileEntry, symlinkEntry],
    listBounded: async () => ({ entries: [fileEntry, symlinkEntry], truncated: false }),
    listDirectoryEntries: async () => [fileEntry, symlinkEntry],
    listDirectoryEntriesAfterBounded,
    listDirectoryEntriesBounded: async () => ({ entries: [fileEntry, symlinkEntry], truncated: false }),
    lookupDirectoryEntry: async ({ name }) => [fileEntry, symlinkEntry].find(entry => entry.name === name),
    readFile: async ({ length = 4n, offset = 0n }) => file.content.bytes.slice(Number(offset), Number(offset + length)),
    readlink: async () => symlink.target,
    resolveInode,
    resolveInodeByNumber,
    stat: async ({ pathComponents }) => stat({ inode: await resolveInode({ pathComponents }) }),
  };
  return { listDirectoryEntriesAfterBounded, resolver };
}

describe("HizoFS transition namespace source", () => {
  it("projects private candidate metadata and bounded content without record references", async () => {
    const { listDirectoryEntriesAfterBounded, resolver } = fixture();
    const source = createHizoFSTransitionNamespaceSource({ resolver });

    await expect(source.readRootMetadata()).resolves.toEqual({ createdAt: 10n, modifiedAt: undefined });
    await expect(source.listDirectory({ afterName: "before", maximumEntries: 2, path: [] })).resolves.toEqual({
      entries: [
        { kind: "file", metadata: { createdAt: undefined, modifiedAt: 20n }, name: "data.bin", size: 4n },
        { kind: "symlink", metadata: { createdAt: undefined, modifiedAt: undefined }, name: "link" },
      ],
      state: "complete",
    });
    expect(listDirectoryEntriesAfterBounded).toHaveBeenCalledWith({
      afterName: "before",
      inode: root,
      maximumEntries: 2,
    });
    await expect(source.readFileChunk({ maximumBytes: 2, offset: 0n, path: ["data.bin"] })).resolves.toEqual({
      bytes: Uint8Array.of(1, 2),
      state: "more",
    });
    await expect(source.readFileChunk({ maximumBytes: 4, offset: 2n, path: ["data.bin"] })).resolves.toEqual({
      bytes: Uint8Array.of(3, 4),
      state: "complete",
    });
    await expect(source.readSymlink({ path: ["link"] })).resolves.toBe("data.bin");
  });
});
