import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createCommitSequence,
  createFileSystemCommitPayload,
  createHomeRecordReference,
  createInodeNumber,
  createInodeRevision,
  createSubvolumeId,
  createTimestampMilliseconds,
  createFileOffset,
  createUInt64,
  parseMutationId,
  parseSegmentId,
  type DirectoryInodeEntry,
  type DirectoryLeafEntry,
  type DirectoryPage,
  type HomeRecordReference,
  type InodeLeafEntry,
  type InodeNumber,
} from "@/00-storage/service/hizofs/00-format";
import {
  createDirectoryPageTreePageStore,
  type DirectoryPagePort,
} from "@/00-storage/service/hizofs/filesystem/mutation/directory-page-tree";
import type { RootInodeTablePageStore } from "@/00-storage/service/hizofs/filesystem/mutation/root-inode-table-mutation";
import { prepareOrdinaryEntryRemovalCommit } from "@/00-storage/service/hizofs/filesystem/namespace/ordinary-entry-removal-commit";
import { prepareOrdinaryEntryRemovalPlan } from "@/00-storage/service/hizofs/filesystem/namespace/ordinary-entry-removal-plan";
import type { ImmutableBTreePage } from "@/00-storage/service/hizofs/indexes/immutable-btree-reader";
import { describe, expect, it } from "vitest";

type InodePage = ImmutableBTreePage<InodeNumber, InodeLeafEntry, HomeRecordReference>;

function reference({ kind, offset }: { kind: number; offset: bigint }): HomeRecordReference {
  return createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: offset }),
    frameLength: 128,
    recordKind: kind,
    segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(Number(offset % 251n) + 1) }),
  } });
}

class MemoryDirectoryPagePort implements DirectoryPagePort {
  readonly pages = new Map<HomeRecordReference, DirectoryPage>();
  private nextOffset = 1_024n;

  async readPage({ reference: pageReference }: {
    isRoot: boolean;
    reference: HomeRecordReference;
  }): Promise<DirectoryPage> {
    const page = this.pages.get(pageReference);
    if (page === undefined) throw new Error("missing Directory page");
    return page;
  }

  async writePage({ page }: { isRoot: boolean; page: DirectoryPage }): Promise<HomeRecordReference> {
    const pageReference = reference({
      kind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.directory_page,
      offset: this.nextOffset,
    });
    this.nextOffset += 128n;
    this.pages.set(pageReference, page);
    return pageReference;
  }
}

class MemoryInodePageStore implements RootInodeTablePageStore {
  readonly pages = new Map<HomeRecordReference, InodePage>();
  private nextOffset = 2_048n;

  async readPage({ reference: pageReference }: {
    isRoot: boolean;
    reference: HomeRecordReference;
  }): Promise<InodePage> {
    const page = this.pages.get(pageReference);
    if (page === undefined) throw new Error("missing Inode Table page");
    return page;
  }

  async writePage({ page }: { isRoot: boolean; page: InodePage }): Promise<HomeRecordReference> {
    const pageReference = reference({
      kind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
      offset: this.nextOffset,
    });
    this.nextOffset += 128n;
    this.pages.set(pageReference, page);
    return pageReference;
  }
}

function fileInode({ inodeNumber }: { inodeNumber: bigint }): InodeLeafEntry {
  return {
    content: { bytes: new Uint8Array(), type: "inline" },
    fileSize: createFileOffset({ value: 0n }),
    inodeKind: "file",
    inodeNumber: createInodeNumber({ value: inodeNumber }),
    inodeRevision: createInodeRevision({ value: 1n }),
    timestamps: { createdAt: null, modifiedAt: null },
  };
}

function directoryInode({ entries, inodeNumber }: {
  entries: readonly DirectoryLeafEntry[];
  inodeNumber: bigint;
}): DirectoryInodeEntry {
  return {
    content: { entries, type: "inline" },
    inodeKind: "directory",
    inodeNumber: createInodeNumber({ value: inodeNumber }),
    inodeRevision: createInodeRevision({ value: 1n }),
    timestamps: { createdAt: null, modifiedAt: null },
  };
}

function binding({ inodeKind, inodeNumber, name }: {
  inodeKind: "directory" | "file";
  inodeNumber: bigint;
  name: string;
}): DirectoryLeafEntry {
  return {
    inodeKind,
    inodeNumber: createInodeNumber({ value: inodeNumber }),
    name,
    targetType: "inode",
  };
}

function baseFixture({ inodes, parent }: {
  inodes: readonly InodeLeafEntry[];
  parent: DirectoryInodeEntry;
}) {
  const inodeRoot = reference({
    kind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
    offset: 64n,
  });
  const inodePageStore = new MemoryInodePageStore();
  inodePageStore.pages.set(inodeRoot, { entries: inodes, level: 0, type: "leaf" });
  const directoryPort = new MemoryDirectoryPagePort();
  return {
    baseCommit: createFileSystemCommitPayload({ payload: {
      commitSequence: createCommitSequence({ value: 1n }),
      mutationId: parseMutationId({ bytes: new Uint8Array(16).fill(3) }),
      nestedSubvolumeTableRootHomeRef: null,
      nextInodeNumber: createInodeNumber({ value: 20n }),
      nextSubvolumeId: createSubvolumeId({ value: 2n }),
      rootDirectoryInodeNumber: parent.inodeNumber,
      rootInodeTableRootHomeRef: inodeRoot,
    } }),
    directoryPageStore: createDirectoryPageTreePageStore({ pagePort: directoryPort }),
    directoryPort,
    inodePageStore,
  };
}

function writtenRootEntries({ commitRoot, pageStore }: {
  commitRoot: HomeRecordReference;
  pageStore: MemoryInodePageStore;
}): readonly InodeLeafEntry[] {
  const page = pageStore.pages.get(commitRoot);
  if (page?.type !== "leaf") throw new Error("expected one written root Inode Table leaf");
  return page.entries;
}

const operationTimestamp = createTimestampMilliseconds({ value: 1_700_000_000_000n });

async function prepare({ directoryEntries, parent, recursive, sourceEntry, fixture }: {
  directoryEntries: ReadonlyMap<InodeNumber, readonly DirectoryLeafEntry[]>;
  fixture: ReturnType<typeof baseFixture>;
  parent: DirectoryInodeEntry;
  recursive: boolean;
  sourceEntry: DirectoryLeafEntry;
}) {
  const plan = prepareOrdinaryEntryRemovalPlan({
    directoryEntries,
    limits: { deleteBatchSize: 2, maxVisitedInodes: 16 },
    parentAccess: "read_write",
    parentDirectoryInodeNumber: parent.inodeNumber,
    parentSubvolumeId: createSubvolumeId({ value: 1n }),
    recursive,
    sourceEntry,
  });
  return await prepareOrdinaryEntryRemovalCommit({
    baseCommit: fixture.baseCommit,
    directoryPageStore: fixture.directoryPageStore,
    inodeTablePageStore: fixture.inodePageStore,
    mutationId: parseMutationId({ bytes: new Uint8Array(16).fill(9) }),
    operationTimestamp,
    parent,
    plan,
  });
}

describe("ordinary entry removal Commit", () => {
  it("removes an inline file binding and its inode in one Commit", async () => {
    const source = binding({ inodeKind: "file", inodeNumber: 2n, name: "remove" });
    const keep = binding({ inodeKind: "file", inodeNumber: 3n, name: "keep" });
    const parent = directoryInode({ entries: [keep, source], inodeNumber: 1n });
    const fixture = baseFixture({
      inodes: [parent, fileInode({ inodeNumber: 2n }), fileInode({ inodeNumber: 3n })],
      parent,
    });
    const result = await prepare({
      directoryEntries: new Map(),
      fixture,
      parent,
      recursive: false,
      sourceEntry: source,
    });

    expect(result.commitPayload.commitSequence).toBe(2n);
    expect(result.commitPayload.nextInodeNumber).toBe(20n);
    expect(result.mutation.updatedParent).toMatchObject({ inodeRevision: 2n });
    expect(result.mutation.updatedParent.timestamps.modifiedAt).toBe(operationTimestamp);
    if (result.mutation.updatedParent.content.type !== "inline") throw new Error("expected inline parent");
    expect(result.mutation.updatedParent.content.entries.map(entry => entry.name)).toEqual(["keep"]);
    expect(writtenRootEntries({
      commitRoot: result.commitPayload.rootInodeTableRootHomeRef,
      pageStore: fixture.inodePageStore,
    }).map(entry => entry.inodeNumber)).toEqual([1n, 3n]);
  });

  it("rewrites a tree-backed parent through the authoritative Directory Page writer", async () => {
    const source = binding({ inodeKind: "file", inodeNumber: 2n, name: "remove" });
    const keep = binding({ inodeKind: "file", inodeNumber: 3n, name: "keep" });
    const parent = directoryInode({ entries: [], inodeNumber: 1n });
    const directoryRoot = reference({
      kind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.directory_page,
      offset: 256n,
    });
    const treeParent: DirectoryInodeEntry = {
      ...parent,
      content: { directoryTreeRootHomeRef: directoryRoot, type: "tree" },
    };
    const fixture = baseFixture({
      inodes: [treeParent, fileInode({ inodeNumber: 2n }), fileInode({ inodeNumber: 3n })],
      parent: treeParent,
    });
    fixture.directoryPort.pages.set(directoryRoot, { entries: [keep, source], level: 0, type: "leaf" });
    const result = await prepare({
      directoryEntries: new Map(),
      fixture,
      parent: treeParent,
      recursive: false,
      sourceEntry: source,
    });

    if (result.mutation.updatedParent.content.type !== "tree") throw new Error("expected tree-backed parent");
    expect(fixture.directoryPort.pages.get(result.mutation.updatedParent.content.directoryTreeRootHomeRef))
      .toMatchObject({ entries: [keep], type: "leaf" });
    expect(writtenRootEntries({
      commitRoot: result.commitPayload.rootInodeTableRootHomeRef,
      pageStore: fixture.inodePageStore,
    }).map(entry => entry.inodeNumber)).toEqual([1n, 3n]);
  });

  it("applies recursive inode deletion in bounded unpublished batches", async () => {
    const source = binding({ inodeKind: "directory", inodeNumber: 2n, name: "tree" });
    const childFile = binding({ inodeKind: "file", inodeNumber: 3n, name: "a" });
    const childDirectory = binding({ inodeKind: "directory", inodeNumber: 4n, name: "b" });
    const nestedFile = binding({ inodeKind: "file", inodeNumber: 5n, name: "c" });
    const parent = directoryInode({ entries: [source], inodeNumber: 1n });
    const sourceDirectory = directoryInode({ entries: [childFile, childDirectory], inodeNumber: 2n });
    const nestedDirectory = directoryInode({ entries: [nestedFile], inodeNumber: 4n });
    const fixture = baseFixture({
      inodes: [
        parent,
        sourceDirectory,
        fileInode({ inodeNumber: 3n }),
        nestedDirectory,
        fileInode({ inodeNumber: 5n }),
      ],
      parent,
    });
    const result = await prepare({
      directoryEntries: new Map([
        [sourceDirectory.inodeNumber, sourceDirectory.content.type === "inline" ? sourceDirectory.content.entries : []],
        [nestedDirectory.inodeNumber, nestedDirectory.content.type === "inline" ? nestedDirectory.content.entries : []],
      ]),
      fixture,
      parent,
      recursive: true,
      sourceEntry: source,
    });

    expect(result.plan.deleteBatches.map(batch => [...batch])).toEqual([[3n, 5n], [4n, 2n]]);
    expect(writtenRootEntries({
      commitRoot: result.commitPayload.rootInodeTableRootHomeRef,
      pageStore: fixture.inodePageStore,
    }).map(entry => entry.inodeNumber)).toEqual([1n]);
  });
});

export const TEST_ONLY = {};
