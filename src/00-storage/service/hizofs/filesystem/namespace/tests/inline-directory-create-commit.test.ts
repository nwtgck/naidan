import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createCommitSequence,
  createFileSystemCommitPayload,
  createHomeRecordReference,
  createInodeNumber,
  createInodeRevision,
  createSubvolumeId,
  createTimestampMilliseconds,
  createUInt64,
  parseMutationId,
  parseSegmentId,
  type DirectoryInodeEntry,
  type HomeRecordReference,
  type InodeLeafEntry,
  type InodeNumber,
} from "@/00-storage/service/hizofs/00-format";
import { prepareInlineDirectoryCreateCommit } from "@/00-storage/service/hizofs/filesystem/namespace/inline-directory-create-commit";
import type { RootInodeTablePageStore } from "@/00-storage/service/hizofs/filesystem/mutation/root-inode-table-mutation";
import type { ImmutableBTreePage } from "@/00-storage/service/hizofs/indexes/immutable-btree-reader";
import { describe, expect, it } from "vitest";

type Page = ImmutableBTreePage<InodeNumber, InodeLeafEntry, HomeRecordReference>;

function reference({ offset }: { offset: bigint }): HomeRecordReference {
  return createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: offset }),
    frameLength: 128,
    recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
    segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(Number(offset % 251n) + 1) }),
  } });
}

class MemoryPageStore implements RootInodeTablePageStore {
  readonly pages = new Map<HomeRecordReference, Page>();
  private nextOffset = 512n;

  async readPage({ reference: pageReference }: { isRoot: boolean; reference: HomeRecordReference }): Promise<Page> {
    const page = this.pages.get(pageReference);
    if (page === undefined) throw new Error("missing page");
    return page;
  }

  async writePage({ page }: { isRoot: boolean; page: Page }): Promise<HomeRecordReference> {
    const pageReference = reference({ offset: this.nextOffset });
    this.nextOffset += 128n;
    this.pages.set(pageReference, page);
    return pageReference;
  }
}

function fixture() {
  const rootReference = reference({ offset: 64n });
  const parent: DirectoryInodeEntry = {
    content: { entries: [], type: "inline" },
    inodeKind: "directory",
    inodeNumber: createInodeNumber({ value: 1n }),
    inodeRevision: createInodeRevision({ value: 1n }),
    timestamps: { createdAt: null, modifiedAt: null },
  };
  const pageStore = new MemoryPageStore();
  pageStore.pages.set(rootReference, { entries: [parent], level: 0, type: "leaf" });
  return {
    baseCommit: createFileSystemCommitPayload({ payload: {
      commitSequence: createCommitSequence({ value: 1n }),
      mutationId: parseMutationId({ bytes: new Uint8Array(16).fill(3) }),
      nestedSubvolumeTableRootHomeRef: null,
      nextInodeNumber: createInodeNumber({ value: 2n }),
      nextSubvolumeId: createSubvolumeId({ value: 2n }),
      rootDirectoryInodeNumber: createInodeNumber({ value: 1n }),
      rootInodeTableRootHomeRef: rootReference,
    } }),
    pageStore,
    parent,
  };
}

describe("prepareInlineDirectoryCreateCommit", () => {
  it("prepares the canonical Inode Table root and advances the inode allocator", async () => {
    const { baseCommit, pageStore, parent } = fixture();
    const result = await prepareInlineDirectoryCreateCommit({
      baseCommit,
      maximumKnownInodeNumber: parent.inodeNumber,
      mutationId: parseMutationId({ bytes: new Uint8Array(16).fill(7) }),
      operationTimestamp: createTimestampMilliseconds({ value: 1_700_000_000_000n }),
      pageStore,
      parent,
      request: { type: "file" },
      target: {
        destinationExists: false,
        entryName: "file",
        parentAccess: "read_write",
        parentDirectoryInodeNumber: parent.inodeNumber,
        parentSubvolumeId: createSubvolumeId({ value: 1n }),
      },
    });

    expect(result.commitPayload.commitSequence).toBe(2n);
    expect(result.commitPayload.nextInodeNumber).toBe(3n);
    expect(result.commitPayload.mutationId).toEqual(new Uint8Array(16).fill(7));
    expect(result.commitPayload.rootInodeTableRootHomeRef).not.toBe(baseCommit.rootInodeTableRootHomeRef);
    expect(result.plan.directoryEntry.name).toBe("file");
    const writtenRoot = pageStore.pages.get(result.commitPayload.rootInodeTableRootHomeRef);
    expect(writtenRoot).toMatchObject({ level: 0, type: "leaf" });
    if (writtenRoot?.type !== "leaf") throw new Error("expected written root Inode Table leaf");
    expect(writtenRoot.entries).toMatchObject([
      { inodeKind: "directory", inodeNumber: 1n, inodeRevision: 2n },
      { inodeKind: "file", inodeNumber: 2n, inodeRevision: 1n },
    ]);
  });
});
