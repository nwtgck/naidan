import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  UINT64_MAXIMUM,
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
import { prepareTreeBackedDirectoryCreateCommit } from "@/00-storage/service/hizofs/filesystem/namespace/tree-backed-directory-create-commit";
import {
  prepareTreeBackedDirectoryCreateMutation,
  TreeBackedDirectoryCreateMutationError,
} from "@/00-storage/service/hizofs/filesystem/namespace/tree-backed-directory-create-mutation";
import { prepareOrdinaryEntryCreatePlan } from "@/00-storage/service/hizofs/filesystem/namespace/ordinary-entry-create-plan";
import type { ImmutableBTreePage } from "@/00-storage/service/hizofs/indexes/immutable-btree-reader";
import { describe, expect, it } from "vitest";

const operationTimestamp = createTimestampMilliseconds({ value: 1_700_000_000_000n });

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
  #nextOffset = 1_024n;

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
      offset: this.#nextOffset,
    });
    this.#nextOffset += 128n;
    this.pages.set(pageReference, page);
    return pageReference;
  }
}

class MemoryInodePageStore implements RootInodeTablePageStore {
  readonly pages = new Map<HomeRecordReference, InodePage>();
  #nextOffset = 2_048n;

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
      offset: this.#nextOffset,
    });
    this.#nextOffset += 128n;
    this.pages.set(pageReference, page);
    return pageReference;
  }
}

function existingEntry({ name = "z" }: { name?: string } = {}): DirectoryLeafEntry {
  return {
    inodeKind: "file",
    inodeNumber: createInodeNumber({ value: 2n }),
    name,
    targetType: "inode",
  };
}

function fixture({ revision = 4n }: { revision?: bigint } = {}) {
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
    inodeRevision: createInodeRevision({ value: revision }),
    timestamps: { createdAt: null, modifiedAt: null },
  };
  const directoryPort = new MemoryDirectoryPagePort();
  directoryPort.pages.set(directoryRoot, { entries: [existingEntry()], level: 0, type: "leaf" });
  const inodePageStore = new MemoryInodePageStore();
  inodePageStore.pages.set(inodeRoot, { entries: [parent], level: 0, type: "leaf" });
  return {
    baseCommit: createFileSystemCommitPayload({ payload: {
      commitSequence: createCommitSequence({ value: 1n }),
      mutationId: parseMutationId({ bytes: new Uint8Array(16).fill(3) }),
      nestedSubvolumeTableRootHomeRef: null,
      nextInodeNumber: createInodeNumber({ value: 3n }),
      nextSubvolumeId: createSubvolumeId({ value: 2n }),
      rootDirectoryInodeNumber: parent.inodeNumber,
      rootInodeTableRootHomeRef: inodeRoot,
    } }),
    directoryPageStore: createDirectoryPageTreePageStore({ pagePort: directoryPort }),
    directoryPort,
    inodePageStore,
    parent,
  };
}

function plan({ entryName = "a" }: { entryName?: string } = {}) {
  return prepareOrdinaryEntryCreatePlan({
    knownInodeNumbers: [createInodeNumber({ value: 1n }), createInodeNumber({ value: 2n })],
    nextInodeNumber: createInodeNumber({ value: 3n }),
    operationTimestamp,
    request: { type: "file" },
    target: {
      destinationExists: false,
      entryName,
      parentAccess: "read_write",
      parentDirectoryInodeNumber: createInodeNumber({ value: 1n }),
      parentSubvolumeId: createSubvolumeId({ value: 1n }),
    },
  });
}

describe("tree-backed directory creation", () => {
  it("writes a canonical Directory Page and prepares both Inode Table changes", async () => {
    const { directoryPageStore, directoryPort, parent } = fixture();
    const result = await prepareTreeBackedDirectoryCreateMutation({
      pageStore: directoryPageStore,
      parent,
      plan: plan(),
    });

    expect(result.updatedParent.inodeRevision).toBe(5n);
    expect(result.updatedParent.timestamps.modifiedAt).toBe(operationTimestamp);
    expect(result.changes).toHaveLength(2);
    if (result.updatedParent.content.type !== "tree") throw new Error("expected tree-backed directory");
    expect(result.updatedParent.content.directoryTreeRootHomeRef)
      .not.toBe(parent.content.type === "tree" ? parent.content.directoryTreeRootHomeRef : undefined);
    expect(directoryPort.pages.get(result.updatedParent.content.directoryTreeRootHomeRef)).toEqual({
      entries: [
        { inodeKind: "file", inodeNumber: 3n, name: "a", targetType: "inode" },
        { inodeKind: "file", inodeNumber: 2n, name: "z", targetType: "inode" },
      ],
      level: 0,
      type: "leaf",
    });
  });

  it("reads a pre-existing branch and rewrites the canonical Directory Page tree", async () => {
    const { directoryPageStore, directoryPort, parent } = fixture();
    if (parent.content.type !== "tree") throw new Error("expected tree-backed directory");
    const childReference = reference({
      kind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.directory_page,
      offset: 96n,
    });
    directoryPort.pages.set(childReference, { entries: [existingEntry()], level: 0, type: "leaf" });
    directoryPort.pages.set(parent.content.directoryTreeRootHomeRef, {
      entries: [{ childPageHomeRef: childReference, upperBoundName: "z" }],
      level: 1,
      type: "branch",
    });

    const result = await prepareTreeBackedDirectoryCreateMutation({
      pageStore: directoryPageStore,
      parent,
      plan: plan(),
    });

    if (result.updatedParent.content.type !== "tree") throw new Error("expected tree-backed directory");
    const nextRootReference = result.updatedParent.content.directoryTreeRootHomeRef;
    expect(directoryPort.pages.get(nextRootReference)).toMatchObject({ level: 0, type: "leaf" });
    await expect(readDirectoryPageTreeEntry({
      name: "a",
      pageStore: directoryPageStore,
      rootReference: nextRootReference,
    })).resolves.toMatchObject({ inodeNumber: 3n, name: "a" });
    await expect(readDirectoryPageTreeEntry({
      name: "z",
      pageStore: directoryPageStore,
      rootReference: nextRootReference,
    })).resolves.toMatchObject({ inodeNumber: 2n, name: "z" });
  });

  it("uses canonical UTF-8 byte ordering", async () => {
    const { directoryPageStore, directoryPort, parent } = fixture();
    const result = await prepareTreeBackedDirectoryCreateMutation({
      pageStore: directoryPageStore,
      parent,
      plan: plan({ entryName: "ä" }),
    });
    if (result.updatedParent.content.type !== "tree") throw new Error("expected tree-backed directory");
    const page = directoryPort.pages.get(result.updatedParent.content.directoryTreeRootHomeRef);
    if (page?.type !== "leaf") throw new Error("expected Directory leaf page");
    expect(page.entries.map(entry => entry.name)).toEqual(["z", "ä"]);
  });

  it("rejects a stale duplicate without writing a page", async () => {
    const { directoryPageStore, directoryPort, parent } = fixture();
    await expect(prepareTreeBackedDirectoryCreateMutation({
      pageStore: directoryPageStore,
      parent,
      plan: plan({ entryName: "z" }),
    })).rejects.toBeInstanceOf(TreeBackedDirectoryCreateMutationError);
    expect(directoryPort.pages.size).toBe(1);
  });

  it("rejects an exhausted parent revision", async () => {
    const { directoryPageStore, parent } = fixture({ revision: UINT64_MAXIMUM });
    await expect(prepareTreeBackedDirectoryCreateMutation({
      pageStore: directoryPageStore,
      parent,
      plan: plan(),
    })).rejects.toThrow("revision is exhausted");
  });

  it("fails closed when called for an inline parent", async () => {
    const { directoryPageStore, parent } = fixture();
    await expect(prepareTreeBackedDirectoryCreateMutation({
      pageStore: directoryPageStore,
      parent: { ...parent, content: { entries: [], type: "inline" } },
      plan: plan(),
    })).rejects.toThrow("inline directory mutation executor");
  });

  it("prepares a new Commit root and advances the inode allocator", async () => {
    const { baseCommit, directoryPageStore, inodePageStore, parent } = fixture();
    const result = await prepareTreeBackedDirectoryCreateCommit({
      baseCommit,
      directoryPageStore,
      inodeTablePageStore: inodePageStore,
      knownInodeNumbers: [parent.inodeNumber, createInodeNumber({ value: 2n })],
      mutationId: parseMutationId({ bytes: new Uint8Array(16).fill(7) }),
      operationTimestamp,
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
});
