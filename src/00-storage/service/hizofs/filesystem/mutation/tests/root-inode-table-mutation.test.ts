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
  createUInt64,
  parseMutationId,
  parseSegmentId,
  type HomeRecordReference,
  type InodeLeafEntry,
  type InodeNumber,
} from "@/00-storage/service/hizofs/00-format";
import {
  prepareRootInodeTableMutation,
  type RootInodeTablePageStore,
} from "@/00-storage/service/hizofs/filesystem/mutation/root-inode-table-mutation";
import type { ImmutableBTreePage } from "@/00-storage/service/hizofs/indexes/immutable-btree-reader";

function reference({ offset }: { offset: bigint }): HomeRecordReference {
  return createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: offset }),
    frameLength: 128,
    recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
    segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(Number(offset % 251n) + 1) }),
  } });
}

function directoryInode({ inodeNumber }: { inodeNumber: bigint }): InodeLeafEntry {
  return {
    content: { entries: [], type: "inline" },
    inodeKind: "directory",
    inodeNumber: createInodeNumber({ value: inodeNumber }),
    inodeRevision: createInodeRevision({ value: 1n }),
    timestamps: { createdAt: null, modifiedAt: null },
  };
}

function fileInode({ inodeNumber }: { inodeNumber: bigint }): InodeLeafEntry {
  return {
    content: { bytes: new TextEncoder().encode("hello"), type: "inline" },
    fileSize: createFileOffset({ value: 5n }),
    inodeKind: "file",
    inodeNumber: createInodeNumber({ value: inodeNumber }),
    inodeRevision: createInodeRevision({ value: 1n }),
    timestamps: { createdAt: null, modifiedAt: null },
  };
}

type Page = ImmutableBTreePage<InodeNumber, InodeLeafEntry, HomeRecordReference>;

class MemoryInodePageStore implements RootInodeTablePageStore {
  readonly pages = new Map<HomeRecordReference, Page>();
  readonly writes: Readonly<{ isRoot: boolean; page: Page; reference: HomeRecordReference }>[] = [];
  private nextOffset = 512n;

  async readPage({ isRoot: _isRoot, reference: pageReference }: {
    isRoot: boolean;
    reference: HomeRecordReference;
  }): Promise<Page> {
    const page = this.pages.get(pageReference);
    if (page === undefined) throw new Error("missing inode page");
    return page;
  }

  async writePage({ isRoot, page }: { isRoot: boolean; page: Page }): Promise<HomeRecordReference> {
    const pageReference = reference({ offset: this.nextOffset });
    this.nextOffset += 128n;
    this.pages.set(pageReference, page);
    this.writes.push({ isRoot, page, reference: pageReference });
    return pageReference;
  }
}

function fixture() {
  const rootReference = reference({ offset: 64n });
  const rootEntry = directoryInode({ inodeNumber: 1n });
  const store = new MemoryInodePageStore();
  store.pages.set(rootReference, { entries: [rootEntry], level: 0, type: "leaf" });
  const baseCommit = createFileSystemCommitPayload({ payload: {
    commitSequence: createCommitSequence({ value: 1n }),
    mutationId: parseMutationId({ bytes: new Uint8Array(16).fill(3) }),
    nestedSubvolumeTableRootHomeRef: null,
    nextInodeNumber: createInodeNumber({ value: 2n }),
    nextSubvolumeId: createSubvolumeId({ value: 2n }),
    rootDirectoryInodeNumber: createInodeNumber({ value: 1n }),
    rootInodeTableRootHomeRef: rootReference,
  } });
  return { baseCommit, rootEntry, store };
}

describe("root Inode Table mutation preparation", () => {
  it("writes a new canonical root and prepares the next Commit", async () => {
    const { baseCommit, store } = fixture();
    const nextEntry = fileInode({ inodeNumber: 2n });
    const result = await prepareRootInodeTableMutation({
      baseCommit,
      changes: [{ entry: nextEntry, type: "set" }],
      mutationId: parseMutationId({ bytes: new Uint8Array(16).fill(7) }),
      pageStore: store,
    });

    expect(result.type).toBe("prepared");
    if (result.type !== "prepared") throw new Error("expected prepared mutation");
    expect(result.commitPayload.commitSequence).toBe(2n);
    expect(result.commitPayload.rootInodeTableRootHomeRef).not.toBe(baseCommit.rootInodeTableRootHomeRef);
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0]).toMatchObject({ isRoot: true, page: { type: "leaf" } });
  });

  it("splits the root Inode Table at the 32-entry runtime packing limit", async () => {
    const { baseCommit, store } = fixture();
    store.pages.set(baseCommit.rootInodeTableRootHomeRef, {
      entries: Array.from({ length: 32 }, (_, index) => directoryInode({ inodeNumber: BigInt(index + 1) })),
      level: 0,
      type: "leaf",
    });
    const result = await prepareRootInodeTableMutation({
      baseCommit,
      changes: [{ entry: fileInode({ inodeNumber: 33n }), type: "set" }],
      mutationId: parseMutationId({ bytes: new Uint8Array(16).fill(7) }),
      pageStore: store,
    });

    expect(result.type).toBe("prepared");
    if (result.type !== "prepared") throw new Error("expected prepared mutation");
    const root = store.pages.get(result.commitPayload.rootInodeTableRootHomeRef);
    expect(root).toMatchObject({ level: 1, type: "branch" });
    if (root?.type !== "branch") throw new Error("expected split Inode Table branch root");
    expect(root.children).toHaveLength(2);
    for (const child of root.children) {
      const childPage = store.pages.get(child.childPageReference);
      expect(childPage?.type).toBe("leaf");
      if (childPage?.type !== "leaf") throw new Error("expected Inode Table leaf child");
      expect(childPage.entries.length).toBeLessThanOrEqual(32);
    }
  });

  it("does not prepare a Commit for a byte-identical inode set", async () => {
    const { baseCommit, rootEntry, store } = fixture();
    const result = await prepareRootInodeTableMutation({
      baseCommit,
      changes: [{ entry: rootEntry, type: "set" }],
      mutationId: parseMutationId({ bytes: new Uint8Array(16).fill(7) }),
      pageStore: store,
    });
    expect(result).toEqual({ type: "unchanged" });
    expect(store.writes).toEqual([]);
  });

  it("rejects reuse of the base Mutation ID before reading pages", async () => {
    const { baseCommit, store } = fixture();
    await expect(prepareRootInodeTableMutation({
      baseCommit,
      changes: [{ entry: fileInode({ inodeNumber: 2n }), type: "set" }],
      mutationId: baseCommit.mutationId,
      pageStore: store,
    })).rejects.toThrow("fresh Mutation ID");
    expect(store.writes).toEqual([]);
  });
});
