import { describe, expect, it } from "vitest";
import {
  createInodeNumber,
  createSubvolumeId,
  type DirectoryLeafEntry,
  type InodeNumber,
} from "@/00-storage/service/hizofs/00-format";
import {
  prepareOrdinaryEntryRemovalTarget,
  streamOrdinaryEntryRemovalInodeBatches,
  type OpenOrdinaryRemovalDirectory,
} from "@/00-storage/service/hizofs/filesystem/namespace/ordinary-entry-removal-plan";

const parentDirectoryInodeNumber = createInodeNumber({ value: 1n });
const parentSubvolumeId = createSubvolumeId({ value: 1n });

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

function directoryReader({ byDirectory, reads }: {
  byDirectory: ReadonlyMap<InodeNumber, readonly DirectoryLeafEntry[]>;
  reads?: Array<readonly [InodeNumber, string | undefined, number]>;
}): OpenOrdinaryRemovalDirectory {
  return async ({ directoryEntry }) => ({
    readPage: async ({ afterName, maximumEntries }) => {
      reads?.push([directoryEntry.inodeNumber, afterName, maximumEntries]);
      const entries = byDirectory.get(directoryEntry.inodeNumber) ?? [];
      const start = afterName === undefined
        ? 0
        : entries.findIndex(candidate => candidate.name === afterName) + 1;
      const page = entries.slice(start, start + maximumEntries);
      return { entries: page, truncated: start + page.length < entries.length };
    },
  });
}

async function collectBatches({
  deleteBatchSize,
  openDirectory,
  recursive,
  source,
}: Parameters<typeof streamOrdinaryEntryRemovalInodeBatches>[0]): Promise<readonly (readonly InodeNumber[])[]> {
  const batches: Array<readonly InodeNumber[]> = [];
  for await (const batch of streamOrdinaryEntryRemovalInodeBatches({
    deleteBatchSize,
    openDirectory,
    recursive,
    source,
  })) batches.push(batch);
  return batches;
}

describe("ordinary entry removal planning", () => {
  it("rejects invalid target admission before traversal", () => {
    const source = entry({ inodeKind: "file", inodeNumber: 2n, name: "source" });
    expect(() => prepareOrdinaryEntryRemovalTarget({
      deleteBatchSize: 2,
      parentAccess: "read_write",
      parentDirectoryInodeNumber,
      parentSubvolumeId,
      sourceEntry: null,
    })).toThrowError(expect.objectContaining({ code: "source_missing" }));
    expect(() => prepareOrdinaryEntryRemovalTarget({
      deleteBatchSize: 2,
      parentAccess: "read",
      parentDirectoryInodeNumber,
      parentSubvolumeId,
      sourceEntry: source,
    })).toThrowError(expect.objectContaining({ code: "read_only_parent" }));
    expect(() => prepareOrdinaryEntryRemovalTarget({
      deleteBatchSize: 0,
      parentAccess: "read_write",
      parentDirectoryInodeNumber,
      parentSubvolumeId,
      sourceEntry: source,
    })).toThrowError(expect.objectContaining({ code: "invalid_limits" }));
    expect(() => prepareOrdinaryEntryRemovalTarget({
      deleteBatchSize: 2,
      parentAccess: "read_write",
      parentDirectoryInodeNumber,
      parentSubvolumeId,
      sourceEntry: {
        name: "mounted",
        subvolumeId: createSubvolumeId({ value: 2n }),
        targetType: "subvolume",
      },
    })).toThrowError(expect.objectContaining({ code: "mounted_subvolume" }));
  });

  it("streams files and symlinks as one bounded deletion batch", async () => {
    for (const source of [
      entry({ inodeKind: "file", inodeNumber: 2n, name: "file" }),
      entry({ inodeKind: "symlink", inodeNumber: 3n, name: "link" }),
    ]) {
      expect(await collectBatches({
        deleteBatchSize: 2,
        openDirectory: async () => {
          throw new Error("non-directory traversal must not open a directory");
        },
        recursive: true,
        source,
      })).toEqual([[source.inodeNumber]]);
    }
  });

  it("allows only empty directories without recursive mode", async () => {
    const root = entry({ inodeKind: "directory", inodeNumber: 10n, name: "dir" });
    expect(await collectBatches({
      deleteBatchSize: 2,
      openDirectory: directoryReader({ byDirectory: new Map([[root.inodeNumber, []]]) }),
      recursive: false,
      source: root,
    })).toEqual([[root.inodeNumber]]);

    await expect(collectBatches({
      deleteBatchSize: 2,
      openDirectory: directoryReader({ byDirectory: new Map([[
        root.inodeNumber,
        [entry({ inodeKind: "file", inodeNumber: 11n, name: "child" })],
      ]]) }),
      recursive: false,
      source: root,
    })).rejects.toMatchObject({ code: "directory_not_empty" });
  });

  it("streams recursive removal through bounded pages and delete-key batches", async () => {
    const root = entry({ inodeKind: "directory", inodeNumber: 10n, name: "root" });
    const first = entry({ inodeKind: "file", inodeNumber: 11n, name: "a" });
    const second = entry({ inodeKind: "file", inodeNumber: 12n, name: "b" });
    const nested = entry({ inodeKind: "directory", inodeNumber: 13n, name: "nested" });
    const last = entry({ inodeKind: "file", inodeNumber: 14n, name: "z" });
    const nestedFile = entry({ inodeKind: "file", inodeNumber: 15n, name: "nested-file" });
    const byDirectory = new Map<InodeNumber, readonly DirectoryLeafEntry[]>([
      [root.inodeNumber, [first, second, nested, last]],
      [nested.inodeNumber, [nestedFile]],
    ]);
    const reads: Array<readonly [InodeNumber, string | undefined, number]> = [];

    const batches = await collectBatches({
      deleteBatchSize: 2,
      openDirectory: directoryReader({ byDirectory, reads }),
      recursive: true,
      source: root,
    });

    expect(batches).toEqual([
      [root.inodeNumber, first.inodeNumber],
      [second.inodeNumber, nested.inodeNumber],
      [nestedFile.inodeNumber, last.inodeNumber],
    ]);
    expect(batches.every(batch => batch.length <= 2)).toBe(true);
    expect(reads).toEqual([
      [root.inodeNumber, undefined, 2],
      [root.inodeNumber, "b", 2],
      [nested.inodeNumber, undefined, 2],
    ]);
  });

  it("rejects mounted Subvolumes discovered on later recursive pages", async () => {
    const root = entry({ inodeKind: "directory", inodeNumber: 10n, name: "root" });
    const first = entry({ inodeKind: "file", inodeNumber: 11n, name: "a" });
    const mount: DirectoryLeafEntry = {
      name: "mounted",
      subvolumeId: createSubvolumeId({ value: 2n }),
      targetType: "subvolume",
    };
    await expect(collectBatches({
      deleteBatchSize: 1,
      openDirectory: async () => ({
        readPage: async ({ afterName }) => afterName === undefined
          ? { entries: [first], truncated: true }
          : { entries: [mount], truncated: false },
      }),
      recursive: true,
      source: root,
    })).rejects.toMatchObject({ code: "mounted_subvolume" });
  });

  it("fails closed when a truncated page cannot advance", async () => {
    const root = entry({ inodeKind: "directory", inodeNumber: 10n, name: "root" });
    await expect(collectBatches({
      deleteBatchSize: 1,
      openDirectory: async () => ({
        readPage: async () => ({ entries: [], truncated: true }),
      }),
      recursive: true,
      source: root,
    })).rejects.toMatchObject({ code: "directory_state_missing" });
  });
});
