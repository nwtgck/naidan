import { describe, expect, it } from "vitest";
import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createCommitSequence,
  createFileOffset,
  createFileSystemCommitPayload,
  createHomeRecordReference,
  createInodeNumber,
  createInodeRevision,
  createSubvolumeId,
  createTimestampMilliseconds,
  createUInt64,
  encodeHomeRecordReference,
  parseMutationId,
  parseSegmentId,
  type DirectoryLeafEntry,
  type FileSystemCommitPayload,
  type HomeRecordReference,
  type InodeLeafEntry,
  type InodeNumber,
} from "@/00-storage/service/hizofs/00-format";
import { ExplicitBulkCandidate } from "@/00-storage/service/hizofs/filesystem/bulk/explicit-bulk-candidate";
import { prepareExplicitBulkCommit } from "@/00-storage/service/hizofs/filesystem/bulk/explicit-bulk-commit";
import type { DirectoryPageTreePageStore } from "@/00-storage/service/hizofs/filesystem/mutation/directory-page-tree";
import type { RootInodeTablePageStore } from "@/00-storage/service/hizofs/filesystem/mutation/root-inode-table-mutation";
import { ImmutableBTreeReader } from "@/00-storage/service/hizofs/indexes/immutable-btree-reader";
import type { ImmutableBTreePage } from "@/00-storage/service/hizofs/indexes/ordering";

function identity({ reference }: { reference: HomeRecordReference }): string {
  return [...encodeHomeRecordReference({ reference })]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

class MemoryBulkCommitPort {
  readonly directoryPages = new Map<string, ImmutableBTreePage<string, DirectoryLeafEntry, HomeRecordReference>>();
  readonly inodePages = new Map<string, ImmutableBTreePage<InodeNumber, InodeLeafEntry, HomeRecordReference>>();
  readonly directoryPageStore: DirectoryPageTreePageStore = {
    readPage: async ({ reference }) => {
      const page = this.directoryPages.get(identity({ reference }));
      if (page === undefined) throw new Error("missing Directory Page");
      return page;
    },
    writePage: async ({ page }) => {
      const reference = this.reference({ kind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.directory_page });
      this.directoryPages.set(identity({ reference }), page);
      return reference;
    },
  };
  readonly inodeTablePageStore: RootInodeTablePageStore = {
    readPage: async ({ reference }) => {
      const page = this.inodePages.get(identity({ reference }));
      if (page === undefined) throw new Error("missing Inode Table Page");
      return page;
    },
    writePage: async ({ page }) => {
      const reference = this.reference({ kind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page });
      this.inodePages.set(identity({ reference }), page);
      return reference;
    },
  };
  private nextOffset = 1_024n;

  private reference({ kind }: { kind: number }): HomeRecordReference {
    const offset = this.nextOffset;
    this.nextOffset += 128n;
    return createHomeRecordReference({ fields: {
      byteOffset: createUInt64({ value: offset }),
      frameLength: 96,
      recordKind: kind,
      segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(Number(offset % 251n) + 1) }),
    } });
  }

  async createInodeRoot({ entries }: { entries: readonly InodeLeafEntry[] }): Promise<HomeRecordReference> {
    return await this.inodeTablePageStore.writePage({
      isRoot: true,
      page: { entries, level: 0, type: "leaf" },
    });
  }

  inodeReader(): ImmutableBTreeReader<InodeNumber, InodeLeafEntry, HomeRecordReference> {
    return new ImmutableBTreeReader({
      compareKeys: ({ left, right }) => left < right ? -1 : left > right ? 1 : 0,
      getEntryKey: ({ entry }) => entry.inodeNumber,
      pageReader: this.inodeTablePageStore.readPage,
      referenceIdentity: identity,
    });
  }
}

function directoryInode({ inodeNumber, entries = [] }: {
  inodeNumber: bigint;
  entries?: readonly DirectoryLeafEntry[];
}): InodeLeafEntry {
  return {
    content: { entries, type: "inline" },
    inodeKind: "directory",
    inodeNumber: createInodeNumber({ value: inodeNumber }),
    inodeRevision: createInodeRevision({ value: 1n }),
    timestamps: { createdAt: null, modifiedAt: null },
  };
}

function fileInode({ inodeNumber }: { inodeNumber: bigint }): InodeLeafEntry {
  return {
    content: { bytes: Uint8Array.of(7), type: "inline" },
    fileSize: createFileOffset({ value: 1n }),
    inodeKind: "file",
    inodeNumber: createInodeNumber({ value: inodeNumber }),
    inodeRevision: createInodeRevision({ value: 1n }),
    timestamps: { createdAt: null, modifiedAt: null },
  };
}

async function fixture(): Promise<Readonly<{
  baseCommit: FileSystemCommitPayload;
  memory: MemoryBulkCommitPort;
}>> {
  const memory = new MemoryBulkCommitPort();
  const rootReference = await memory.createInodeRoot({ entries: [
    directoryInode({ inodeNumber: 1n }),
    fileInode({ inodeNumber: 2n }),
    directoryInode({ inodeNumber: 3n }),
  ] });
  return {
    baseCommit: createFileSystemCommitPayload({ payload: {
      commitSequence: createCommitSequence({ value: 1n }),
      mutationId: parseMutationId({ bytes: new Uint8Array(16).fill(3) }),
      nestedSubvolumeTableRootHomeRef: null,
      nextInodeNumber: createInodeNumber({ value: 10n }),
      nextSubvolumeId: createSubvolumeId({ value: 2n }),
      rootDirectoryInodeNumber: createInodeNumber({ value: 1n }),
      rootInodeTableRootHomeRef: rootReference,
    } }),
    memory,
  };
}

function candidate(): ExplicitBulkCandidate {
  return new ExplicitBulkCandidate({
    limits: { maxEntries: 128, maxInlineFileBytesTotal: 1_024 },
    nextInodeNumber: createInodeNumber({ value: 10n }),
    rootDirectory: {
      inodeNumber: createInodeNumber({ value: 3n }),
      inodeRevision: createInodeRevision({ value: 1n }),
      timestamps: { createdAt: null, modifiedAt: null },
    },
  });
}

async function readInode({ commit, inodeNumber, memory }: {
  commit: FileSystemCommitPayload;
  inodeNumber: bigint;
  memory: MemoryBulkCommitPort;
}): Promise<InodeLeafEntry> {
  const entry = await memory.inodeReader().get({
    key: createInodeNumber({ value: inodeNumber }),
    rootReference: commit.rootInodeTableRootHomeRef,
  });
  if (entry === undefined) throw new Error(`missing Inode ${inodeNumber}`);
  return entry;
}

const timestamp = createTimestampMilliseconds({ value: 20n });
const mutationId = parseMutationId({ bytes: new Uint8Array(16).fill(9) });
const limits = { maximumEntryMutationsPerBatch: 3 } as const;

describe("Explicit bulk Commit preparation", () => {
  it("materializes nested metadata into one next Commit without changing filesystem-root identity", async () => {
    const { baseCommit, memory } = await fixture();
    const value = candidate();
    const child = value.createDirectory({
      name: "a-directory",
      parentDirectoryInodeNumber: createInodeNumber({ value: 3n }),
      timestamp,
    });
    value.createEmptyFile({
      name: "z-file",
      parentDirectoryInodeNumber: createInodeNumber({ value: 3n }),
      timestamp,
    });
    value.createSymlink({
      name: "link",
      parentDirectoryInodeNumber: child,
      target: "../z-file",
      timestamps: { createdAt: null, modifiedAt: timestamp },
    });

    const commit = await prepareExplicitBulkCommit({
      baseCommit,
      candidate: value.seal(),
      directoryImportLimits: limits,
      directoryPageStore: memory.directoryPageStore,
      inodeTablePageStore: memory.inodeTablePageStore,
      mutationId,
    });

    expect(commit.commitSequence).toBe(2n);
    expect(commit.mutationId).toEqual(mutationId);
    expect(commit.nextInodeNumber).toBe(13n);
    expect(commit.rootDirectoryInodeNumber).toBe(1n);
    expect(commit.rootInodeTableRootHomeRef).not.toBe(baseCommit.rootInodeTableRootHomeRef);
    expect(await readInode({ commit, inodeNumber: 2n, memory })).toEqual(fileInode({ inodeNumber: 2n }));

    const target = await readInode({ commit, inodeNumber: 3n, memory });
    if (target.inodeKind !== "directory" || target.content.type !== "inline") {
      throw new Error("expected inline explicit-bulk target directory");
    }
    expect(target.content.entries.map(entry => entry.name)).toEqual(["a-directory", "z-file"]);
    expect(await readInode({ commit, inodeNumber: 10n, memory })).toMatchObject({
      content: { entries: [{ name: "link" }], type: "inline" },
      inodeKind: "directory",
    });
    expect(await readInode({ commit, inodeNumber: 11n, memory })).toMatchObject({
      content: { bytes: new Uint8Array(), type: "inline" },
      fileSize: 0n,
      inodeKind: "file",
    });
    expect(await readInode({ commit, inodeNumber: 12n, memory })).toMatchObject({
      inodeKind: "symlink",
      target: "../z-file",
    });
    expect(memory.directoryPages.size).toBe(0);
  });

  it("spills an oversized target directory into private canonical pages before Commit publication", async () => {
    const { baseCommit, memory } = await fixture();
    const value = candidate();
    for (let index = 0; index < 32; index += 1) {
      value.createEmptyFile({
        name: `${index.toString().padStart(3, "0")}-${"x".repeat(180)}`,
        parentDirectoryInodeNumber: createInodeNumber({ value: 3n }),
        timestamp,
      });
    }

    const commit = await prepareExplicitBulkCommit({
      baseCommit,
      candidate: value.seal(),
      directoryImportLimits: { maximumEntryMutationsPerBatch: 2 },
      directoryPageStore: memory.directoryPageStore,
      inodeTablePageStore: memory.inodeTablePageStore,
      mutationId,
    });
    const target = await readInode({ commit, inodeNumber: 3n, memory });
    expect(target).toMatchObject({ content: { type: "tree" }, inodeKind: "directory" });
    expect(memory.directoryPages.size).toBeGreaterThan(0);
    expect(commit.nextInodeNumber).toBe(42n);
  });

  it("rejects candidate identities outside the private allocator range", async () => {
    const { baseCommit, memory } = await fixture();
    const value = candidate();
    value.createEmptyFile({
      name: "bad",
      parentDirectoryInodeNumber: createInodeNumber({ value: 3n }),
      timestamp,
    });
    const sealed = value.seal();
    const file = sealed.files[0];
    if (file === undefined) throw new Error("missing candidate file");

    await expect(prepareExplicitBulkCommit({
      baseCommit,
      candidate: {
        ...sealed,
        files: [{ ...file, inodeNumber: createInodeNumber({ value: 2n }) }],
      },
      directoryImportLimits: limits,
      directoryPageStore: memory.directoryPageStore,
      inodeTablePageStore: memory.inodeTablePageStore,
      mutationId,
    })).rejects.toMatchObject({ code: "candidate_inode_out_of_range" });
  });

  it("rejects a sealed candidate that omits its target directory", async () => {
    const { baseCommit, memory } = await fixture();
    const sealed = candidate().seal();
    await expect(prepareExplicitBulkCommit({
      baseCommit,
      candidate: { ...sealed, directories: [] },
      directoryImportLimits: limits,
      directoryPageStore: memory.directoryPageStore,
      inodeTablePageStore: memory.inodeTablePageStore,
      mutationId,
    })).rejects.toMatchObject({ code: "missing_target_directory" });
  });
});

export const TEST_ONLY = {
};
