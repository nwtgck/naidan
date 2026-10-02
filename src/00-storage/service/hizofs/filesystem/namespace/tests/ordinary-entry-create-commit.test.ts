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
  encodeDirectoryEntry,
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
  readDirectoryPageTreeEntry,
  type DirectoryPagePort,
} from "@/00-storage/service/hizofs/filesystem/mutation/directory-page-tree";
import type { RootInodeTablePageStore } from "@/00-storage/service/hizofs/filesystem/mutation/root-inode-table-mutation";
import { prepareOrdinaryEntryCreateCommit } from "@/00-storage/service/hizofs/filesystem/namespace/ordinary-entry-create-commit";
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
  private nextOffset = 4_096n;

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
  private nextOffset = 8_192n;

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

async function readInodeFromPageStore({ inodeNumber, rootReference, store }: {
  inodeNumber: InodeNumber;
  rootReference: HomeRecordReference;
  store: MemoryInodePageStore;
}): Promise<InodeLeafEntry | undefined> {
  let referenceToRead = rootReference;
  let isRoot = true;
  for (;;) {
    const page = await store.readPage({ isRoot, reference: referenceToRead });
    switch (page.type) {
    case "leaf": return page.entries.find(entry => entry.inodeNumber === inodeNumber);
    case "branch": {
      const child = page.children.find(candidate => inodeNumber <= candidate.upperBound);
      if (child === undefined) return undefined;
      referenceToRead = child.childPageReference;
      isRoot = false;
      break;
    }
    default: return page satisfies never;
    }
  }
}

function fileInode({ inodeNumber }: { inodeNumber: InodeNumber }): InodeLeafEntry {
  return {
    content: { bytes: new Uint8Array(), type: "inline" },
    fileSize: createFileOffset({ value: 0n }),
    inodeKind: "file",
    inodeNumber,
    inodeRevision: createInodeRevision({ value: 1n }),
    timestamps: { createdAt: null, modifiedAt: null },
  };
}

function inlineEntriesAtPromotionBoundary(): readonly DirectoryLeafEntry[] {
  const entries: DirectoryLeafEntry[] = [];
  let encodedBytes = 0;
  for (let index = 0; ; index += 1) {
    const entry: DirectoryLeafEntry = {
      inodeKind: "file",
      inodeNumber: createInodeNumber({ value: BigInt(index + 2) }),
      name: `existing-${index.toString().padStart(4, "0")}`,
      targetType: "inode",
    };
    const entryBytes = encodeDirectoryEntry({ entry }).byteLength;
    if (encodedBytes + entryBytes > HIZOFS_V1_FORMAT_CONSTANTS.limits.inlineDirectoryEncodedBytes) break;
    entries.push(entry);
    encodedBytes += entryBytes;
  }
  expect(entries.length).toBeGreaterThan(0);
  return entries;
}

describe("prepareOrdinaryEntryCreateCommit", () => {
  it("prepares the canonical Inode Table root and advances the inode allocator for an inline directory", async () => {
    const rootReference = reference({
      kind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
      offset: 64n,
    });
    const parent: DirectoryInodeEntry = {
      content: { entries: [], type: "inline" },
      inodeKind: "directory",
      inodeNumber: createInodeNumber({ value: 1n }),
      inodeRevision: createInodeRevision({ value: 1n }),
      timestamps: { createdAt: null, modifiedAt: null },
    };
    const pageStore = new MemoryInodePageStore();
    pageStore.pages.set(rootReference, { entries: [parent], level: 0, type: "leaf" });
    const baseCommit = createFileSystemCommitPayload({ payload: {
      commitSequence: createCommitSequence({ value: 1n }),
      mutationId: parseMutationId({ bytes: new Uint8Array(16).fill(3) }),
      nestedSubvolumeTableRootHomeRef: null,
      nextInodeNumber: createInodeNumber({ value: 2n }),
      nextSubvolumeId: createSubvolumeId({ value: 2n }),
      rootDirectoryInodeNumber: createInodeNumber({ value: 1n }),
      rootInodeTableRootHomeRef: rootReference,
    } });
    const result = await prepareOrdinaryEntryCreateCommit({
      baseCommit,
      directoryPageStore: {
        readPage: async () => {
          throw new Error("inline creation must not read Directory pages");
        },
        writePage: async () => {
          throw new Error("inline creation must not write Directory pages");
        },
      },
      inodeTablePageStore: pageStore,
      maximumKnownInodeNumber: parent.inodeNumber,
      mutationId: parseMutationId({ bytes: new Uint8Array(16).fill(7) }),
      operationTimestamp: createTimestampMilliseconds({ value: 1_700_000_000_000n }),
      parent,
      request: { type: "file" },
      target: {
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

  it("prepares a new Commit root and advances the inode allocator for a tree-backed directory", async () => {
    const directoryRoot = reference({
      kind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.directory_page,
      offset: 64n,
    });
    const inodeRoot = reference({
      kind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
      offset: 256n,
    });
    const parent: DirectoryInodeEntry = {
      content: { directoryTreeRootHomeRef: directoryRoot, type: "tree" },
      inodeKind: "directory",
      inodeNumber: createInodeNumber({ value: 1n }),
      inodeRevision: createInodeRevision({ value: 4n }),
      timestamps: { createdAt: null, modifiedAt: null },
    };
    const directoryPort = new MemoryDirectoryPagePort();
    directoryPort.pages.set(directoryRoot, {
      entries: [{ inodeKind: "file", inodeNumber: createInodeNumber({ value: 2n }), name: "z", targetType: "inode" }],
      level: 0,
      type: "leaf",
    });
    const directoryPageStore = createDirectoryPageTreePageStore({ pagePort: directoryPort });
    const inodePageStore = new MemoryInodePageStore();
    inodePageStore.pages.set(inodeRoot, { entries: [parent], level: 0, type: "leaf" });
    const baseCommit = createFileSystemCommitPayload({ payload: {
      commitSequence: createCommitSequence({ value: 1n }),
      mutationId: parseMutationId({ bytes: new Uint8Array(16).fill(3) }),
      nestedSubvolumeTableRootHomeRef: null,
      nextInodeNumber: createInodeNumber({ value: 3n }),
      nextSubvolumeId: createSubvolumeId({ value: 2n }),
      rootDirectoryInodeNumber: parent.inodeNumber,
      rootInodeTableRootHomeRef: inodeRoot,
    } });
    const operationTimestamp = createTimestampMilliseconds({ value: 1_700_000_000_000n });
    const result = await prepareOrdinaryEntryCreateCommit({
      baseCommit,
      directoryPageStore,
      inodeTablePageStore: inodePageStore,
      maximumKnownInodeNumber: createInodeNumber({ value: 2n }),
      mutationId: parseMutationId({ bytes: new Uint8Array(16).fill(7) }),
      operationTimestamp,
      parent,
      request: { type: "file" },
      target: {
        entryName: "file",
        parentAccess: "read_write",
        parentDirectoryInodeNumber: parent.inodeNumber,
        parentSubvolumeId: createSubvolumeId({ value: 1n }),
      },
    });

    expect(result.commitPayload.commitSequence).toBe(2n);
    expect(result.commitPayload.nextInodeNumber).toBe(4n);
    expect(result.commitPayload.mutationId).toEqual(new Uint8Array(16).fill(7));
    expect(result.commitPayload.rootInodeTableRootHomeRef).not.toBe(baseCommit.rootInodeTableRootHomeRef);
    const writtenRoot = inodePageStore.pages.get(result.commitPayload.rootInodeTableRootHomeRef);
    if (writtenRoot?.type !== "leaf") throw new Error("expected written root Inode Table leaf");
    expect(writtenRoot.entries).toMatchObject([
      { inodeKind: "directory", inodeNumber: 1n, inodeRevision: 5n },
      { inodeKind: "file", inodeNumber: 3n, inodeRevision: 1n },
    ]);
  });

  it("promotes a full inline directory before publishing the new child inode", async () => {
    const existingEntries = inlineEntriesAtPromotionBoundary();
    const parent: DirectoryInodeEntry = {
      content: { entries: existingEntries, type: "inline" },
      inodeKind: "directory",
      inodeNumber: createInodeNumber({ value: 1n }),
      inodeRevision: createInodeRevision({ value: 9n }),
      timestamps: { createdAt: null, modifiedAt: null },
    };
    const existingInodes = existingEntries.map(entry => {
      if (entry.targetType !== "inode") throw new Error("expected ordinary inode entry");
      return fileInode({ inodeNumber: entry.inodeNumber });
    });
    const rootReference = reference({
      kind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
      offset: 64n,
    });
    const inodePageStore = new MemoryInodePageStore();
    inodePageStore.pages.set(rootReference, {
      entries: [parent, ...existingInodes],
      level: 0,
      type: "leaf",
    });
    const directoryPort = new MemoryDirectoryPagePort();
    const directoryPageStore = createDirectoryPageTreePageStore({ pagePort: directoryPort });
    const nextInodeNumber = createInodeNumber({ value: BigInt(existingEntries.length + 2) });
    const newEntryName = "overflow-entry";
    expect(existingEntries.reduce(
      (total, entry) => total + encodeDirectoryEntry({ entry }).byteLength,
      encodeDirectoryEntry({ entry: {
        inodeKind: "file",
        inodeNumber: nextInodeNumber,
        name: newEntryName,
        targetType: "inode",
      } }).byteLength,
    )).toBeGreaterThan(HIZOFS_V1_FORMAT_CONSTANTS.limits.inlineDirectoryEncodedBytes);

    const result = await prepareOrdinaryEntryCreateCommit({
      baseCommit: createFileSystemCommitPayload({ payload: {
        commitSequence: createCommitSequence({ value: 1n }),
        mutationId: parseMutationId({ bytes: new Uint8Array(16).fill(3) }),
        nestedSubvolumeTableRootHomeRef: null,
        nextInodeNumber,
        nextSubvolumeId: createSubvolumeId({ value: 2n }),
        rootDirectoryInodeNumber: parent.inodeNumber,
        rootInodeTableRootHomeRef: rootReference,
      } }),
      directoryPageStore,
      inodeTablePageStore: inodePageStore,
      maximumKnownInodeNumber: createInodeNumber({ value: nextInodeNumber - 1n }),
      mutationId: parseMutationId({ bytes: new Uint8Array(16).fill(7) }),
      operationTimestamp: createTimestampMilliseconds({ value: 1_700_000_000_000n }),
      parent,
      request: { type: "file" },
      target: {
        entryName: newEntryName,
        parentAccess: "read_write",
        parentDirectoryInodeNumber: parent.inodeNumber,
        parentSubvolumeId: createSubvolumeId({ value: 1n }),
      },
    });

    const writtenParent = await readInodeFromPageStore({
      inodeNumber: parent.inodeNumber,
      rootReference: result.commitPayload.rootInodeTableRootHomeRef,
      store: inodePageStore,
    });
    if (writtenParent?.inodeKind !== "directory" || writtenParent.content.type !== "tree") {
      throw new Error("expected promoted directory parent");
    }
    await expect(readInodeFromPageStore({
      inodeNumber: nextInodeNumber,
      rootReference: result.commitPayload.rootInodeTableRootHomeRef,
      store: inodePageStore,
    })).resolves.toMatchObject({ inodeKind: "file", inodeNumber: nextInodeNumber });
    expect(writtenParent.inodeRevision).toBe(10n);
    await expect(readDirectoryPageTreeEntry({
      name: existingEntries[0]!.name,
      pageStore: directoryPageStore,
      rootReference: writtenParent.content.directoryTreeRootHomeRef,
    })).resolves.toMatchObject({ name: existingEntries[0]!.name });
    await expect(readDirectoryPageTreeEntry({
      name: newEntryName,
      pageStore: directoryPageStore,
      rootReference: writtenParent.content.directoryTreeRootHomeRef,
    })).resolves.toMatchObject({ inodeNumber: nextInodeNumber, name: newEntryName });
    expect(result.commitPayload.nextInodeNumber).toBe(nextInodeNumber + 1n);

    const postPromotionEntryName = "post-promotion-entry";
    const postPromotionInodeNumber = result.commitPayload.nextInodeNumber;
    const postPromotion = await prepareOrdinaryEntryCreateCommit({
      baseCommit: result.commitPayload,
      directoryPageStore,
      inodeTablePageStore: inodePageStore,
      maximumKnownInodeNumber: nextInodeNumber,
      mutationId: parseMutationId({ bytes: new Uint8Array(16).fill(8) }),
      operationTimestamp: createTimestampMilliseconds({ value: 1_700_000_000_001n }),
      parent: writtenParent,
      request: { type: "file" },
      target: {
        entryName: postPromotionEntryName,
        parentAccess: "read_write",
        parentDirectoryInodeNumber: parent.inodeNumber,
        parentSubvolumeId: createSubvolumeId({ value: 1n }),
      },
    });
    const postPromotionParent = await readInodeFromPageStore({
      inodeNumber: parent.inodeNumber,
      rootReference: postPromotion.commitPayload.rootInodeTableRootHomeRef,
      store: inodePageStore,
    });
    if (postPromotionParent?.inodeKind !== "directory" || postPromotionParent.content.type !== "tree") {
      throw new Error("expected tree-backed directory parent after post-promotion create");
    }
    await expect(readInodeFromPageStore({
      inodeNumber: postPromotionInodeNumber,
      rootReference: postPromotion.commitPayload.rootInodeTableRootHomeRef,
      store: inodePageStore,
    })).resolves.toMatchObject({ inodeKind: "file", inodeNumber: postPromotionInodeNumber });
    await expect(readDirectoryPageTreeEntry({
      name: postPromotionEntryName,
      pageStore: directoryPageStore,
      rootReference: postPromotionParent.content.directoryTreeRootHomeRef,
    })).resolves.toMatchObject({
      inodeNumber: postPromotionInodeNumber,
      name: postPromotionEntryName,
    });
    expect(postPromotion.commitPayload.nextInodeNumber).toBe(postPromotionInodeNumber + 1n);
  });
});
