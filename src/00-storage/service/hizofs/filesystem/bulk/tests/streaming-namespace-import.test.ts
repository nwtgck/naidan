import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createHomeRecordReference,
  createInodeNumber,
  createTimestampMilliseconds,
  createUInt64,
  encodeHomeRecordReference,
  parseSegmentId,
  type DirectoryLeafEntry,
  type FileExtentPage,
  type HomeRecordReference,
  type InodeLeafEntry,
  type InodeNumber,
} from "@/00-storage/service/hizofs/00-format";
import {
  StreamingNamespaceImport,
  type StreamingNamespaceImportPort,
} from "@/00-storage/service/hizofs/filesystem/bulk/streaming-namespace-import";
import { ImmutableBTreeReader } from "@/00-storage/service/hizofs/indexes/immutable-btree-reader";
import type { ImmutableBTreePage } from "@/00-storage/service/hizofs/indexes/ordering";
import type { DirectoryPageTreePageStore } from "@/00-storage/service/hizofs/filesystem/mutation/directory-page-tree";
import {
  createFileExtentTreePageStore,
  fileExtentEntriesFromFloor,
} from "@/00-storage/service/hizofs/filesystem/mutation/file-extent-tree";
import type { RootInodeTablePageStore } from "@/00-storage/service/hizofs/filesystem/mutation/root-inode-table-mutation";
import { createFileOffset } from "@/00-storage/service/hizofs/00-format";
import { describe, expect, it } from "vitest";

function identity({ reference }: { reference: HomeRecordReference }): string {
  return [...encodeHomeRecordReference({ reference })]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

class MemoryImportPort {
  readonly fileData: Uint8Array[] = [];
  readonly #directoryPages = new Map<string, ImmutableBTreePage<string, DirectoryLeafEntry, HomeRecordReference>>();
  readonly #extentPages = new Map<string, FileExtentPage>();
  readonly #inodePages = new Map<string, ImmutableBTreePage<InodeNumber, InodeLeafEntry, HomeRecordReference>>();
  readonly directoryPageStore: DirectoryPageTreePageStore = {
    readPage: async ({ reference }) => {
      const page = this.#directoryPages.get(identity({ reference }));
      if (page === undefined) throw new Error("missing Directory Page");
      return page;
    },
    writePage: async ({ page }) => {
      const reference = this.#reference({ kind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.directory_page });
      this.#directoryPages.set(identity({ reference }), page);
      return reference;
    },
  };
  readonly extentPageStore = createFileExtentTreePageStore({ pagePort: {
    readPage: async ({ reference }) => {
      const page = this.#extentPages.get(identity({ reference }));
      if (page === undefined) throw new Error("missing File Extent Page");
      return page;
    },
    writePage: async ({ page }) => {
      const reference = this.#reference({ kind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_extent_page });
      this.#extentPages.set(identity({ reference }), page);
      return reference;
    },
  } });
  readonly rootInodeTablePageStore: RootInodeTablePageStore = {
    readPage: async ({ reference }) => {
      const page = this.#inodePages.get(identity({ reference }));
      if (page === undefined) throw new Error("missing Inode Table Page");
      return page;
    },
    writePage: async ({ page }) => {
      const reference = this.#reference({ kind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page });
      this.#inodePages.set(identity({ reference }), page);
      return reference;
    },
  };
  #nextOffset = 1_024n;

  #reference({ kind }: { kind: number }): HomeRecordReference {
    const offset = this.#nextOffset;
    this.#nextOffset += 128n;
    return createHomeRecordReference({ fields: {
      byteOffset: createUInt64({ value: offset }),
      frameLength: 96,
      recordKind: kind,
      segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(Number(offset % 251n) + 1) }),
    } });
  }

  async createEmptyInodeRoot(): Promise<HomeRecordReference> {
    return await this.rootInodeTablePageStore.writePage({
      isRoot: true,
      page: { entries: [], level: 0, type: "leaf" },
    });
  }

  port(): StreamingNamespaceImportPort {
    return {
      directoryPageStore: this.directoryPageStore,
      fileContentPort: {
        extentPageStore: this.extentPageStore,
        writeFileData: async ({ bytes }) => {
          this.fileData.push(new Uint8Array(bytes));
          return this.#reference({ kind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_data });
        },
      },
      rootInodeTablePageStore: this.rootInodeTablePageStore,
    };
  }

  inodeReader(): ImmutableBTreeReader<InodeNumber, InodeLeafEntry, HomeRecordReference> {
    return new ImmutableBTreeReader({
      compareKeys: ({ left, right }) => left < right ? -1 : left > right ? 1 : 0,
      getEntryKey: ({ entry }) => entry.inodeNumber,
      pageReader: this.rootInodeTablePageStore.readPage,
      referenceIdentity: identity,
    });
  }
}

const limits = {
  directory: { maximumEntryMutationsPerBatch: 2 },
  file: { maximumExtentMutationsPerBatch: 2 },
} as const;

function timestamps({ createdAt, modifiedAt }: {
  createdAt: bigint | null;
  modifiedAt: bigint | null;
}) {
  return {
    createdAt: createdAt === null ? null : createTimestampMilliseconds({ value: createdAt }),
    modifiedAt: modifiedAt === null ? null : createTimestampMilliseconds({ value: modifiedAt }),
  };
}

function inodeEntry({ entries, name }: { entries: readonly DirectoryLeafEntry[]; name: string }): DirectoryLeafEntry {
  const entry = entries.find(candidate => candidate.name === name);
  if (entry === undefined) throw new Error(`missing directory entry ${name}`);
  return entry;
}

async function getInode({ inodeNumber, port, rootReference }: {
  inodeNumber: InodeNumber;
  port: MemoryImportPort;
  rootReference: HomeRecordReference;
}): Promise<InodeLeafEntry> {
  const entry = await port.inodeReader().get({ key: inodeNumber, rootReference });
  if (entry === undefined) throw new Error("missing imported inode");
  return entry;
}

function inlineDirectoryEntries({ inode }: { inode: InodeLeafEntry }): readonly DirectoryLeafEntry[] {
  if (inode.inodeKind !== "directory" || inode.content.type !== "inline") {
    throw new Error("expected inline directory inode");
  }
  return inode.content.entries;
}

describe("Streaming namespace import", () => {
  it("resumes a bounded nested import with sparse data, symlinks, and exact timestamps", async () => {
    const memory = new MemoryImportPort();
    const rootReference = await memory.createEmptyInodeRoot();
    const rootDirectoryInodeNumber = createInodeNumber({ value: 1n });
    const first = new StreamingNamespaceImport({
      limits,
      nextInodeNumber: createInodeNumber({ value: 2n }),
      port: memory.port(),
      rootDirectory: {
        inodeNumber: rootDirectoryInodeNumber,
        timestamps: timestamps({ createdAt: null, modifiedAt: 90n }),
      },
      rootInodeTableRootHomeRef: rootReference,
    });

    await first.ensureDirectory({
      path: ["a"],
      timestamps: timestamps({ createdAt: 10n, modifiedAt: null }),
    });
    await first.writeFileChunk({ bytes: new Uint8Array(128 * 1024), offset: 0n, path: ["a", "large"] });
    const resumed = StreamingNamespaceImport.restore({
      checkpoint: await first.checkpoint(),
      limits,
      port: memory.port(),
    });
    await resumed.writeFileChunk({ bytes: Uint8Array.of(1, 2, 3), offset: 128n * 1024n, path: ["a", "large"] });
    await resumed.finalizeFile({
      path: ["a", "large"],
      size: 128n * 1024n + 3n,
      timestamps: timestamps({ createdAt: null, modifiedAt: 20n }),
    });
    await resumed.writeSymlink({
      path: ["a", "link"],
      target: "../target",
      timestamps: timestamps({ createdAt: 30n, modifiedAt: 40n }),
    });
    await resumed.ensureDirectory({
      path: ["b"],
      timestamps: timestamps({ createdAt: 50n, modifiedAt: 60n }),
    });
    const sealed = await resumed.finalize();

    expect(sealed.nextInodeNumber).toBe(6n);
    expect(memory.fileData.map(bytes => [...bytes])).toEqual([[1, 2, 3]]);

    const root = await getInode({
      inodeNumber: rootDirectoryInodeNumber,
      port: memory,
      rootReference: sealed.rootInodeTableRootHomeRef,
    });
    expect(root.timestamps).toEqual(timestamps({ createdAt: null, modifiedAt: 90n }));
    const rootEntries = inlineDirectoryEntries({ inode: root });
    expect(rootEntries.map(entry => entry.name)).toEqual(["a", "b"]);

    const aReference = inodeEntry({ entries: rootEntries, name: "a" });
    if (aReference.targetType !== "inode") throw new Error("expected inode-backed directory");
    const a = await getInode({
      inodeNumber: aReference.inodeNumber,
      port: memory,
      rootReference: sealed.rootInodeTableRootHomeRef,
    });
    expect(a.timestamps).toEqual(timestamps({ createdAt: 10n, modifiedAt: null }));
    const aEntries = inlineDirectoryEntries({ inode: a });
    expect(aEntries.map(entry => entry.name)).toEqual(["large", "link"]);

    const largeReference = inodeEntry({ entries: aEntries, name: "large" });
    if (largeReference.targetType !== "inode") throw new Error("expected inode-backed file");
    const large = await getInode({
      inodeNumber: largeReference.inodeNumber,
      port: memory,
      rootReference: sealed.rootInodeTableRootHomeRef,
    });
    if (large.inodeKind !== "file" || large.content.type !== "tree") throw new Error("expected extent-backed file");
    expect(large.fileSize).toBe(128n * 1024n + 3n);
    expect(large.timestamps).toEqual(timestamps({ createdAt: null, modifiedAt: 20n }));
    const extents = [];
    for await (const extent of fileExtentEntriesFromFloor({
      fileOffset: createFileOffset({ value: 0n }),
      pageStore: memory.extentPageStore,
      rootReference: large.content.extentTreeRootHomeRef,
    })) extents.push(extent);
    expect(extents.map(extent => ({ byteLength: extent.byteLength, fileOffset: extent.fileOffset }))).toEqual([
      { byteLength: 3, fileOffset: 128n * 1024n },
    ]);

    const linkReference = inodeEntry({ entries: aEntries, name: "link" });
    if (linkReference.targetType !== "inode") throw new Error("expected inode-backed symlink");
    const link = await getInode({
      inodeNumber: linkReference.inodeNumber,
      port: memory,
      rootReference: sealed.rootInodeTableRootHomeRef,
    });
    expect(link).toMatchObject({
      inodeKind: "symlink",
      target: "../target",
      timestamps: timestamps({ createdAt: 30n, modifiedAt: 40n }),
    });
  });

  it("imports an empty file without allocating File Data and preserves absent timestamps", async () => {
    const memory = new MemoryImportPort();
    const rootDirectoryInodeNumber = createInodeNumber({ value: 1n });
    const value = new StreamingNamespaceImport({
      limits,
      nextInodeNumber: createInodeNumber({ value: 2n }),
      port: memory.port(),
      rootDirectory: {
        inodeNumber: rootDirectoryInodeNumber,
        timestamps: timestamps({ createdAt: null, modifiedAt: null }),
      },
      rootInodeTableRootHomeRef: await memory.createEmptyInodeRoot(),
    });

    await value.finalizeFile({
      path: ["empty"],
      size: 0n,
      timestamps: timestamps({ createdAt: null, modifiedAt: null }),
    });
    const sealed = await value.finalize();
    const root = await getInode({
      inodeNumber: rootDirectoryInodeNumber,
      port: memory,
      rootReference: sealed.rootInodeTableRootHomeRef,
    });
    const emptyReference = inodeEntry({ entries: inlineDirectoryEntries({ inode: root }), name: "empty" });
    if (emptyReference.targetType !== "inode") throw new Error("expected inode-backed empty file");
    const empty = await getInode({
      inodeNumber: emptyReference.inodeNumber,
      port: memory,
      rootReference: sealed.rootInodeTableRootHomeRef,
    });

    expect(empty).toMatchObject({
      content: { bytes: new Uint8Array(), type: "inline" },
      fileSize: 0n,
      inodeKind: "file",
      timestamps: { createdAt: null, modifiedAt: null },
    });
    expect(memory.fileData).toEqual([]);
  });

  it("rejects a traversal jump outside the active depth-first stack", async () => {
    const memory = new MemoryImportPort();
    const value = new StreamingNamespaceImport({
      limits,
      nextInodeNumber: createInodeNumber({ value: 2n }),
      port: memory.port(),
      rootDirectory: {
        inodeNumber: createInodeNumber({ value: 1n }),
        timestamps: timestamps({ createdAt: null, modifiedAt: null }),
      },
      rootInodeTableRootHomeRef: await memory.createEmptyInodeRoot(),
    });
    await value.ensureDirectory({ path: ["a"], timestamps: timestamps({ createdAt: null, modifiedAt: null }) });

    await expect(value.writeSymlink({
      path: ["missing", "link"],
      target: "target",
      timestamps: timestamps({ createdAt: null, modifiedAt: null }),
    })).rejects.toMatchObject({ code: "non_depth_first_path" });
    expect(value.state()).toBe("failed");
  });

  it("does not seal a namespace with an unfinished file", async () => {
    const memory = new MemoryImportPort();
    const value = new StreamingNamespaceImport({
      limits,
      nextInodeNumber: createInodeNumber({ value: 2n }),
      port: memory.port(),
      rootDirectory: {
        inodeNumber: createInodeNumber({ value: 1n }),
        timestamps: timestamps({ createdAt: null, modifiedAt: null }),
      },
      rootInodeTableRootHomeRef: await memory.createEmptyInodeRoot(),
    });
    await value.writeFileChunk({ bytes: Uint8Array.of(1), offset: 0n, path: ["file"] });

    await expect(value.finalize()).rejects.toMatchObject({ code: "active_file_conflict" });
    expect(value.state()).toBe("failed");
  });
});

export const TEST_ONLY = {};
