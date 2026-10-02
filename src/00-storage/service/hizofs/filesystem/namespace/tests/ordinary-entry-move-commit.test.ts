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
import { prepareOrdinaryEntryMoveCommit } from "@/00-storage/service/hizofs/filesystem/namespace/ordinary-entry-move-commit";
import { prepareOrdinaryEntryMovePlan } from "@/00-storage/service/hizofs/filesystem/namespace/ordinary-entry-move-plan";
import type { ImmutableBTreePage } from "@/00-storage/service/hizofs/indexes/immutable-btree-reader";
import { describe, expect, it, vi } from "vitest";

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
  private reading = false;

  async readPage({ reference: pageReference }: {
    isRoot: boolean;
    reference: HomeRecordReference;
  }): Promise<DirectoryPage> {
    if (this.reading) throw new Error("Directory page authority is not reentrant");
    this.reading = true;
    try {
      await Promise.resolve();
      const page = this.pages.get(pageReference);
      if (page === undefined) throw new Error("missing Directory page");
      return page;
    } finally {
      this.reading = false;
    }
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

function binding({ inodeKind, inodeNumber, name }: {
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

function directoryInode({ entries, inodeNumber, revision = 1n }: {
  entries: readonly DirectoryLeafEntry[];
  inodeNumber: bigint;
  revision?: bigint;
}): DirectoryInodeEntry {
  return {
    content: { entries, type: "inline" },
    inodeKind: "directory",
    inodeNumber: createInodeNumber({ value: inodeNumber }),
    inodeRevision: createInodeRevision({ value: revision }),
    timestamps: { createdAt: null, modifiedAt: null },
  };
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

function fixture({ inodes, rootDirectoryInodeNumber }: {
  inodes: readonly InodeLeafEntry[];
  rootDirectoryInodeNumber: InodeNumber;
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
      rootDirectoryInodeNumber,
      rootInodeTableRootHomeRef: inodeRoot,
    } }),
    directoryPageStore: createDirectoryPageTreePageStore({ pagePort: directoryPort }),
    directoryPort,
    inodePageStore,
  };
}

function rootEntries({ root, store }: {
  root: HomeRecordReference;
  store: MemoryInodePageStore;
}): readonly InodeLeafEntry[] {
  const page = store.pages.get(root);
  if (page?.type !== "leaf") throw new Error("expected root Inode Table leaf");
  return page.entries;
}

const operationTimestamp = createTimestampMilliseconds({ value: 1_700_000_000_000n });
const subvolumeId = createSubvolumeId({ value: 1n });

function inlineBoundaryFixture() {
  const source = binding({ inodeKind: "file", inodeNumber: 17n, name: "s" });
  const entries = [
    ...Array.from({ length: 15 }, (_, index) => binding({
      inodeKind: "file",
      inodeNumber: BigInt(index + 2),
      name: `${index.toString().padStart(3, "0")}${"x".repeat(247)}`,
    })),
    source,
  ];
  const parent = directoryInode({ entries, inodeNumber: 1n });
  return {
    parent,
    source,
    state: fixture({
      inodes: [parent, ...entries.map(entry => fileInode({ inodeNumber: entry.inodeNumber }))],
      rootDirectoryInodeNumber: parent.inodeNumber,
    }),
  };
}

async function prepare({
  destinationEntry,
  destinationName,
  destinationParent,
  fixture: state,
  replace,
  sourceEntry,
  sourceParent,
}: {
  destinationEntry: DirectoryLeafEntry | null;
  destinationName: string;
  destinationParent: DirectoryInodeEntry;
  fixture: ReturnType<typeof fixture>;
  replace: boolean;
  sourceEntry: DirectoryLeafEntry;
  sourceParent: DirectoryInodeEntry;
}) {
  const plan = prepareOrdinaryEntryMovePlan({
    destination: {
      ancestorDirectoryInodeNumbers: [destinationParent.inodeNumber],
      directoryContainsSubvolumeMount: false,
      directoryEmpty: true,
      entry: destinationEntry,
      parentAccess: "read_write",
      parentDirectoryInodeNumber: destinationParent.inodeNumber,
      parentSubvolumeId: subvolumeId,
    },
    destinationName,
    replace,
    source: {
      entry: sourceEntry,
      parentAccess: "read_write",
      parentDirectoryInodeNumber: sourceParent.inodeNumber,
      parentSubvolumeId: subvolumeId,
    },
  });
  if (plan === null) throw new Error("test expected a concrete move plan");
  return await prepareOrdinaryEntryMoveCommit({
    baseCommit: state.baseCommit,
    destinationParent,
    directoryPageStore: state.directoryPageStore,
    inodeTablePageStore: state.inodePageStore,
    mutationId: parseMutationId({ bytes: new Uint8Array(16).fill(9) }),
    operationTimestamp,
    plan,
    sourceParent,
  });
}

describe("ordinary entry move Commit", () => {
  it.each([
    { destinationName: "z".repeat(122), expectedBytes: 4096, expectedType: "inline" },
    { destinationName: "z".repeat(123), expectedBytes: 4097, expectedType: "tree" },
    { destinationName: "\u754c".repeat(41), expectedBytes: 4097, expectedType: "tree" },
  ] as const)("selects $expectedType for a rename requiring $expectedBytes UTF-8 bytes", async ({ destinationName, expectedBytes, expectedType }) => {
    const { parent, source, state } = inlineBoundaryFixture();
    if (parent.content.type !== "inline") throw new Error("expected inline input");
    expect(parent.content.entries.reduce((total, entry) => total + encodeDirectoryEntry({ entry: entry === source
      ? { ...entry, name: destinationName }
      : entry }).byteLength, 0)).toBe(expectedBytes);
    const result = await prepare({
      destinationEntry: null,
      destinationName,
      destinationParent: parent,
      fixture: state,
      replace: false,
      sourceEntry: source,
      sourceParent: parent,
    });
    const content = result.mutation.updatedSourceParent.content;
    expect(content.type).toBe(expectedType);
    expect(result.mutation.updatedSourceParent.inodeRevision).toBe(2n);
    expect(state.directoryPort.pages.size).toBe(expectedType === "inline" ? 0 : 1);
    if (content.type === "tree") {
      await expect(readDirectoryPageTreeEntry({ name: destinationName, pageStore: state.directoryPageStore, rootReference: content.directoryTreeRootHomeRef }))
        .resolves.toEqual({ ...source, name: destinationName });
    }
    expect(parent.content.entries.at(-1)).toBe(source);
  });

  it("leaves the captured parent and Inode Table unchanged when promotion fails", async () => {
    const { parent, source, state } = inlineBoundaryFixture();
    const failure = new Error("Directory Page write failed");
    vi.spyOn(state.directoryPort, "writePage").mockRejectedValueOnce(failure);
    await expect(prepare({
      destinationEntry: null,
      destinationName: "z".repeat(250),
      destinationParent: parent,
      fixture: state,
      replace: false,
      sourceEntry: source,
      sourceParent: parent,
    })).rejects.toBe(failure);
    expect(parent.content).toMatchObject({ entries: expect.arrayContaining([source]), type: "inline" });
    expect(parent.inodeRevision).toBe(1n);
    expect(state.directoryPort.pages.size).toBe(0);
    expect(state.inodePageStore.pages.size).toBe(1);
  });

  it("renames an inline entry within one parent and increments the parent once", async () => {
    const source = binding({ inodeKind: "file", inodeNumber: 2n, name: "z-source" });
    const keep = binding({ inodeKind: "file", inodeNumber: 3n, name: "keep" });
    const parent = directoryInode({ entries: [keep, source], inodeNumber: 1n });
    const state = fixture({
      inodes: [parent, fileInode({ inodeNumber: 2n }), fileInode({ inodeNumber: 3n })],
      rootDirectoryInodeNumber: parent.inodeNumber,
    });

    const result = await prepare({
      destinationEntry: null,
      destinationName: "a-destination",
      destinationParent: parent,
      fixture: state,
      replace: false,
      sourceEntry: source,
      sourceParent: parent,
    });

    expect(result.commitPayload.commitSequence).toBe(2n);
    expect(result.mutation.updatedSourceParent).toBe(result.mutation.updatedDestinationParent);
    expect(result.mutation.updatedSourceParent.inodeRevision).toBe(2n);
    expect(result.mutation.updatedSourceParent.timestamps.modifiedAt).toBe(operationTimestamp);
    if (result.mutation.updatedSourceParent.content.type !== "inline") throw new Error("expected inline parent");
    expect(result.mutation.updatedSourceParent.content.entries.map(entry => entry.name))
      .toEqual(["a-destination", "keep"]);
    expect(rootEntries({
      root: result.commitPayload.rootInodeTableRootHomeRef,
      store: state.inodePageStore,
    }).map(entry => entry.inodeNumber)).toEqual([1n, 2n, 3n]);
  });

  it("moves across parents and removes a replaced inode in the same Commit", async () => {
    const source = binding({ inodeKind: "file", inodeNumber: 3n, name: "source" });
    const replaced = binding({ inodeKind: "file", inodeNumber: 4n, name: "destination" });
    const sourceParent = directoryInode({ entries: [source], inodeNumber: 1n });
    const destinationParent = directoryInode({ entries: [replaced], inodeNumber: 2n });
    const state = fixture({
      inodes: [
        sourceParent,
        destinationParent,
        fileInode({ inodeNumber: 3n }),
        fileInode({ inodeNumber: 4n }),
      ],
      rootDirectoryInodeNumber: sourceParent.inodeNumber,
    });

    const result = await prepare({
      destinationEntry: replaced,
      destinationName: "destination",
      destinationParent,
      fixture: state,
      replace: true,
      sourceEntry: source,
      sourceParent,
    });

    if (result.mutation.updatedSourceParent.content.type !== "inline") throw new Error("expected inline source parent");
    if (result.mutation.updatedDestinationParent.content.type !== "inline") throw new Error("expected inline destination parent");
    expect(result.mutation.updatedSourceParent.content.entries).toEqual([]);
    expect(result.mutation.updatedDestinationParent.content.entries).toEqual([
      { ...source, name: "destination" },
    ]);
    expect(result.mutation.updatedSourceParent.inodeRevision).toBe(2n);
    expect(result.mutation.updatedDestinationParent.inodeRevision).toBe(2n);
    expect(rootEntries({
      root: result.commitPayload.rootInodeTableRootHomeRef,
      store: state.inodePageStore,
    }).map(entry => entry.inodeNumber)).toEqual([1n, 2n, 3n]);
  });

  it.each(["leaf", "branch"] as const)("rewrites a tree-backed same-parent rename through a serialized %s page writer", async rootType => {
    const source = binding({ inodeKind: "file", inodeNumber: 2n, name: "source" });
    const parentBase = directoryInode({ entries: [], inodeNumber: 1n });
    const directoryRoot = reference({
      kind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.directory_page,
      offset: 256n,
    });
    const parent: DirectoryInodeEntry = {
      ...parentBase,
      content: { directoryTreeRootHomeRef: directoryRoot, type: "tree" },
    };
    const state = fixture({
      inodes: [parent, fileInode({ inodeNumber: 2n })],
      rootDirectoryInodeNumber: parent.inodeNumber,
    });
    if (rootType === "leaf") {
      state.directoryPort.pages.set(directoryRoot, { entries: [source], level: 0, type: "leaf" });
    } else {
      const child = reference({ kind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.directory_page, offset: 384n });
      state.directoryPort.pages.set(directoryRoot, {
        entries: [{ childPageHomeRef: child, upperBoundName: source.name }], level: 1, type: "branch",
      });
      state.directoryPort.pages.set(child, { entries: [source], level: 0, type: "leaf" });
    }

    const result = await prepare({
      destinationEntry: null,
      destinationName: "moved",
      destinationParent: parent,
      fixture: state,
      replace: false,
      sourceEntry: source,
      sourceParent: parent,
    });

    if (result.mutation.updatedSourceParent.content.type !== "tree") throw new Error("expected tree parent");
    await expect(readDirectoryPageTreeEntry({
      name: "moved", pageStore: state.directoryPageStore,
      rootReference: result.mutation.updatedSourceParent.content.directoryTreeRootHomeRef,
    })).resolves.toEqual({ ...source, name: "moved" });
  });
});
