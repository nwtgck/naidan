import { describe, expect, it, vi, type Mock } from "vitest";
import {
  createFileOffset,
  createHomeRecordReference,
  createInodeNumber,
  createInodeRevision,
  createTimestampMilliseconds,
  createUInt64,
  HIZOFS_V1_FORMAT_CONSTANTS,
  parseSegmentId,
  type DirectoryPage,
  type HomeRecordReference,
  type InodeBranchPage,
  type InodeLeafEntry,
} from "@/00-storage/service/hizofs/00-format";
import {
  createReadOnlyNamespace,
  createReadOnlyNamespaceResolver,
  type ReadOnlyNamespacePageSource,
} from "@/00-storage/service/hizofs/filesystem/read-only-namespace";
import { ReadOnlyNamespaceValidationCache } from "@/00-storage/service/hizofs/filesystem/namespace-validation-cache";

const KINDS = HIZOFS_V1_FORMAT_CONSTANTS.recordKinds;

function reference({ kind, offset }: { kind: number; offset: bigint }): HomeRecordReference {
  return createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: offset }),
    frameLength: 128,
    segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(Number(offset % 251n) + 1) }),
    recordKind: kind,
  } });
}

const inodeRoot = reference({ kind: KINDS.inode_table_page, offset: 64n });
const inodeLeafA = reference({ kind: KINDS.inode_table_page, offset: 192n });
const inodeLeafB = reference({ kind: KINDS.inode_table_page, offset: 320n });
const directoryRoot = reference({ kind: KINDS.directory_page, offset: 448n });
const fileExtentRoot = reference({ kind: KINDS.file_extent_page, offset: 576n });

const timestamps = {
  createdAt: createTimestampMilliseconds({ value: -8_640_000_000_000_000n }),
  modifiedAt: createTimestampMilliseconds({ value: 8_640_000_000_000_000n }),
};

type InodeFixtureEntry<Entry extends InodeLeafEntry = InodeLeafEntry> = Entry extends InodeLeafEntry
  ? Omit<Entry, "inodeRevision" | "timestamps"> & Partial<Pick<Entry, "inodeRevision" | "timestamps">>
  : never;

function inode(entry: InodeFixtureEntry): InodeLeafEntry {
  return {
    ...entry,
    inodeRevision: entry.inodeRevision ?? createInodeRevision({ value: 1n }),
    timestamps: entry.timestamps ?? { createdAt: null, modifiedAt: null },
  } as InodeLeafEntry;
}

function standaloneTreeDirectoryInodePage({ root }: { root: HomeRecordReference }): Readonly<{
  entries: readonly InodeLeafEntry[];
  level: 0;
  type: "leaf";
}> {
  return {
    entries: [
      inode({
        content: { bytes: new Uint8Array(), type: "inline" },
        fileSize: createFileOffset({ value: 0n }),
        inodeKind: "file",
        inodeNumber: createInodeNumber({ value: 2n }),
      }),
      inode({
        content: { directoryTreeRootHomeRef: root, type: "tree" },
        inodeKind: "directory",
        inodeNumber: createInodeNumber({ value: 7n }),
      }),
    ],
    level: 0,
    type: "leaf",
  };
}

function fixture(): Readonly<{
  directoryPages: Map<HomeRecordReference, DirectoryPage>;
  inodePages: Map<HomeRecordReference, Readonly<{ entries: readonly InodeLeafEntry[]; level: 0; type: "leaf" }> | InodeBranchPage>;
  namespace: ReturnType<typeof createReadOnlyNamespace>;
  pointReads: Mock<NonNullable<ReadOnlyNamespacePageSource["readInodePointPage"]>>;
  readDirectoryPage: Mock<ReadOnlyNamespacePageSource["readDirectoryPage"]>;
  readExtentFile: Mock<ReadOnlyNamespacePageSource["readExtentFile"]>;
  readInodePage: Mock<ReadOnlyNamespacePageSource["readInodePage"]>;
  resolver: ReturnType<typeof createReadOnlyNamespaceResolver>;
}> {
  const entries = new Map<bigint, InodeLeafEntry>([
    [1n, inode({
      content: { entries: [
        { inodeKind: "file", inodeNumber: createInodeNumber({ value: 2n }), name: "inline.txt", targetType: "inode" },
        { inodeKind: "symlink", inodeNumber: createInodeNumber({ value: 3n }), name: "link", targetType: "inode" },
        { inodeKind: "directory", inodeNumber: createInodeNumber({ value: 4n }), name: "tree", targetType: "inode" },
      ], type: "inline" },
      inodeKind: "directory",
      inodeNumber: createInodeNumber({ value: 1n }),
    })],
    [2n, inode({
      content: { bytes: new TextEncoder().encode("hello"), type: "inline" },
      fileSize: createFileOffset({ value: 5n }),
      inodeKind: "file",
      inodeNumber: createInodeNumber({ value: 2n }),
      inodeRevision: createInodeRevision({ value: 9_007_199_254_740_995n }),
      timestamps,
    })],
    [3n, inode({
      inodeKind: "symlink",
      inodeNumber: createInodeNumber({ value: 3n }),
      target: "../raw/target",
    })],
    [4n, inode({
      content: { directoryTreeRootHomeRef: directoryRoot, type: "tree" },
      inodeKind: "directory",
      inodeNumber: createInodeNumber({ value: 4n }),
    })],
    [5n, inode({
      content: { extentTreeRootHomeRef: fileExtentRoot, type: "tree" },
      fileSize: createFileOffset({ value: 9_007_199_254_741_777n }),
      inodeKind: "file",
      inodeNumber: createInodeNumber({ value: 5n }),
    })],
  ]);
  const inodePages = new Map<HomeRecordReference, Readonly<{ entries: readonly InodeLeafEntry[]; level: 0; type: "leaf" }> | InodeBranchPage>([
    [inodeRoot, { entries: [
      { childPageHomeRef: inodeLeafA, upperBound: createInodeNumber({ value: 3n }) },
      { childPageHomeRef: inodeLeafB, upperBound: createInodeNumber({ value: 5n }) },
    ], level: 1 }],
    [inodeLeafA, { entries: [...entries.values()].filter(value => value.inodeNumber <= 3n), level: 0, type: "leaf" }],
    [inodeLeafB, { entries: [...entries.values()].filter(value => value.inodeNumber >= 4n), level: 0, type: "leaf" }],
  ]);
  const directoryPages = new Map<HomeRecordReference, DirectoryPage>([
    [directoryRoot, { entries: [
      { inodeKind: "file", inodeNumber: createInodeNumber({ value: 5n }), name: "huge.bin", targetType: "inode" },
    ], level: 0, type: "leaf" }],
  ]);
  const readExtentFile = vi.fn<ReadOnlyNamespacePageSource["readExtentFile"]>(async () => new Uint8Array([7, 8, 9]));
  const pointReads = vi.fn<NonNullable<ReadOnlyNamespacePageSource["readInodePointPage"]>>(
    async ({ inodeNumber, reference: value }) => {
      const page = inodePages.get(value);
      if (page === undefined) throw new Error("missing inode point page");
      if ("type" in page) {
        return {
          entry: page.entries.find(entry => entry.inodeNumber === inodeNumber),
          type: "leaf" as const,
        };
      }
      return { page, type: "branch" as const };
    });
  const readInodePage = vi.fn<ReadOnlyNamespacePageSource["readInodePage"]>(async ({ reference: value }) => {
    const page = inodePages.get(value);
    if (page === undefined) throw new Error("missing inode page");
    return page;
  });
  const readDirectoryPage = vi.fn<ReadOnlyNamespacePageSource["readDirectoryPage"]>(async ({ reference: value }) => {
    const page = directoryPages.get(value);
    if (page === undefined) throw new Error("missing directory page");
    return page;
  });
  const source: ReadOnlyNamespacePageSource = {
    readDirectoryPage,
    readExtentFile,
    readInodePointPage: pointReads,
    readInodePage,
  };
  return {
    directoryPages,
    inodePages,
    namespace: createReadOnlyNamespace({
      inodeTableRootHomeRef: inodeRoot,
      rootDirectoryInodeNumber: createInodeNumber({ value: 1n }),
      source,
    }),
    pointReads,
    readDirectoryPage,
    readExtentFile,
    readInodePage,
    resolver: createReadOnlyNamespaceResolver({
      inodeTableRootHomeRef: inodeRoot,
      rootDirectoryInodeNumber: createInodeNumber({ value: 1n }),
      source,
    }),
  };
}

describe("read-only HizoFS namespace", () => {
  it("builds the global namespace proof without nested validation-cache admission", async () => {
    const { pointReads, readDirectoryPage, readExtentFile, readInodePage } = fixture();
    const resolver = createReadOnlyNamespaceResolver({
      inodeTableRootHomeRef: inodeRoot,
      rootDirectoryInodeNumber: createInodeNumber({ value: 1n }),
      source: {
        readDirectoryPage: async args => await readDirectoryPage(args),
        readExtentFile: async args => await readExtentFile(args),
        readInodePointPage: async args => await pointReads(args),
        readInodePage: async args => await readInodePage(args),
      },
      validationCache: new ReadOnlyNamespaceValidationCache({ maximumEntries: 1 }),
    });

    await expect(resolver.resolveInode({ pathComponents: [] })).resolves.toMatchObject({
      inodeKind: "directory",
      inodeNumber: createInodeNumber({ value: 1n }),
    });
    expect(readInodePage).toHaveBeenCalledTimes(3);
    await expect(resolver.maximumKnownInodeNumber()).resolves.toBe(createInodeNumber({ value: 5n }));
    expect(readInodePage).toHaveBeenCalledTimes(5);
  }, 1_000);

  it("validates the complete Directory tree before using a selective point reader", async () => {
    const root = reference({ kind: KINDS.directory_page, offset: 704n });
    const first = reference({ kind: KINDS.directory_page, offset: 832n });
    const corruptSibling = reference({ kind: KINDS.directory_page, offset: 960n });
    const pointReads = vi.fn(async () => ({
      entry: { inodeKind: "file" as const, inodeNumber: createInodeNumber({ value: 2n }), name: "alpha", targetType: "inode" as const },
      type: "leaf" as const,
    }));
    const pages = new Map<HomeRecordReference, DirectoryPage>([
      [root, {
        entries: [
          { childPageHomeRef: first, upperBoundName: "m" },
          { childPageHomeRef: corruptSibling, upperBoundName: "z" },
        ],
        level: 1,
        type: "branch",
      }],
      [first, {
        entries: [{ inodeKind: "file", inodeNumber: createInodeNumber({ value: 2n }), name: "alpha", targetType: "inode" }],
        level: 0,
        type: "leaf",
      }],
      // A non-root immutable leaf may not be empty. The lookup key routes to
      // the other child, so only complete-tree validation can detect this.
      [corruptSibling, { entries: [], level: 0, type: "leaf" }],
    ]);
    const resolver = createReadOnlyNamespaceResolver({
      inodeTableRootHomeRef: inodeRoot,
      rootDirectoryInodeNumber: createInodeNumber({ value: 7n }),
      source: {
        readDirectoryPage: async ({ reference: value }) => {
          const page = pages.get(value);
          if (page === undefined) throw new Error("missing Directory page fixture");
          return page;
        },
        readDirectoryPointPage: pointReads,
        readExtentFile: async () => new Uint8Array(),
        readInodePage: async () => standaloneTreeDirectoryInodePage({ root }),
      },
    });
    const directory = inode({
      content: { directoryTreeRootHomeRef: root, type: "tree" },
      inodeKind: "directory",
      inodeNumber: createInodeNumber({ value: 7n }),
    });
    if (directory.inodeKind !== "directory") throw new Error("expected Directory fixture");

    await expect(resolver.lookupDirectoryEntry({ directory, name: "alpha" })).rejects.toBeInstanceOf(TypeError);
    expect(pointReads).not.toHaveBeenCalled();
  });

  it("treats a selective branch point above the maximum upper bound as absent", async () => {
    const root = reference({ kind: KINDS.directory_page, offset: 1088n });
    const leaf = reference({ kind: KINDS.directory_page, offset: 1216n });
    const pages = new Map<HomeRecordReference, DirectoryPage>([
      [root, {
        entries: [{ childPageHomeRef: leaf, upperBoundName: "m" }],
        level: 1,
        type: "branch",
      }],
      [leaf, {
        entries: [{ inodeKind: "file", inodeNumber: createInodeNumber({ value: 2n }), name: "m", targetType: "inode" }],
        level: 0,
        type: "leaf",
      }],
    ]);
    const pointReads = vi.fn(async () => ({ level: 1, type: "absent" as const }));
    const resolver = createReadOnlyNamespaceResolver({
      inodeTableRootHomeRef: inodeRoot,
      rootDirectoryInodeNumber: createInodeNumber({ value: 7n }),
      source: {
        readDirectoryPage: async ({ reference: value }) => {
          const page = pages.get(value);
          if (page === undefined) throw new Error("missing Directory page fixture");
          return page;
        },
        readDirectoryPointPage: pointReads,
        readExtentFile: async () => new Uint8Array(),
        readInodePage: async () => standaloneTreeDirectoryInodePage({ root }),
      },
    });
    const directory = inode({
      content: { directoryTreeRootHomeRef: root, type: "tree" },
      inodeKind: "directory",
      inodeNumber: createInodeNumber({ value: 7n }),
    });
    if (directory.inodeKind !== "directory") throw new Error("expected Directory fixture");

    await expect(resolver.lookupDirectoryEntry({ directory, name: "zz" })).resolves.toBeUndefined();
    expect(pointReads).toHaveBeenCalledTimes(1);
  });

  it("looks up inline and tree directories through the immutable B-tree reader", async () => {
    const { namespace, pointReads } = fixture();
    expect((await namespace.stat({ pathComponents: [] })).kind).toBe("directory");
    expect((await namespace.stat({ pathComponents: ["inline.txt"] })).kind).toBe("file");
    expect((await namespace.stat({ pathComponents: ["tree", "huge.bin"] })).kind).toBe("file");
    await expect(namespace.stat({ pathComponents: ["missing"] })).rejects.toMatchObject({ code: "not_found" });
    expect(pointReads).toHaveBeenCalledWith(expect.objectContaining({ isRoot: true, reference: inodeRoot }));
    expect(pointReads).toHaveBeenCalledWith(expect.objectContaining({ isRoot: false, reference: inodeLeafA }));
    expect(pointReads).toHaveBeenCalledWith(expect.objectContaining({ isRoot: false, reference: inodeLeafB }));
  });

  it("exposes a bounded allocator high-water lookup without re-enumerating the validated inode tree", async () => {
    const { readInodePage, resolver } = fixture();
    expect(await resolver.maximumKnownInodeNumber()).toBe(5n);
    readInodePage.mockClear();
    expect(await resolver.maximumKnownInodeNumber()).toBe(5n);
    expect(readInodePage).not.toHaveBeenCalled();
    const root = await resolver.resolveInode({ pathComponents: [] });
    if (root.inodeKind !== "directory") throw new Error("expected root directory");
    expect(await resolver.lookupDirectoryEntry({ directory: root, name: "inline.txt" })).toEqual({
      inodeKind: "file",
      inodeNumber: 2n,
      name: "inline.txt",
      targetType: "inode",
    });
    const tree = await resolver.resolveInode({ pathComponents: ["tree"] });
    if (tree.inodeKind !== "directory") throw new Error("expected tree directory");
    expect(await resolver.listDirectoryEntries({ inode: tree })).toEqual([{
      inodeKind: "file",
      inodeNumber: 5n,
      name: "huge.bin",
      targetType: "inode",
    }]);
  });

  it("lists inline and tree directories in persisted UTF-8 order", async () => {
    const { namespace } = fixture();
    expect((await namespace.list({ pathComponents: [] })).map(entry => entry.name)).toEqual(["inline.txt", "link", "tree"]);
    expect(await namespace.list({ pathComponents: ["tree"] })).toEqual([
      { inodeKind: "file", inodeNumber: 5n, name: "huge.bin", targetType: "inode" },
    ]);
  });

  it("returns a bounded directory prefix without hiding truncation", async () => {
    const { namespace } = fixture();
    await expect(namespace.listBounded({ maximumEntries: -1, pathComponents: [] }))
      .rejects.toThrow("maximumEntries");
    expect(await namespace.listBounded({ maximumEntries: 2, pathComponents: [] })).toEqual({
      entries: [
        { inodeKind: "file", inodeNumber: 2n, name: "inline.txt", targetType: "inode" },
        { inodeKind: "symlink", inodeNumber: 3n, name: "link", targetType: "inode" },
      ],
      truncated: true,
    });
    expect(await namespace.listBounded({ maximumEntries: 1, pathComponents: ["tree"] })).toEqual({
      entries: [
        { inodeKind: "file", inodeNumber: 5n, name: "huge.bin", targetType: "inode" },
      ],
      truncated: false,
    });
  });



  it("reuses the resolved directory inode across adjacent bounded listing pages", async () => {
    const { pointReads, resolver } = fixture();
    if (resolver.listAfterBounded === undefined) throw new Error("expected paged listing capability");
    const first = await resolver.listAfterBounded({
      afterName: undefined,
      maximumEntries: 1,
      pathComponents: [],
    });
    expect(first.entries.map(entry => entry.name)).toEqual(["inline.txt"]);
    expect(first.truncated).toBe(true);
    const pointReadsAfterFirstPage = pointReads.mock.calls.length;
    const second = await resolver.listAfterBounded({
      afterName: "inline.txt",
      maximumEntries: 1,
      pathComponents: [],
    });
    expect(second.entries.map(entry => entry.name)).toEqual(["link"]);
    expect(second.truncated).toBe(true);
    expect(pointReads.mock.calls.length).toBe(pointReadsAfterFirstPage);
  });

  it("continues adjacent tree-directory pages without restarting the immutable B-tree scan", async () => {
    const { directoryPages, inodePages, readDirectoryPage, resolver } = fixture();
    const inodeRootPage = inodePages.get(inodeRoot);
    const inodeLeafBPage = inodePages.get(inodeLeafB);
    if (inodeRootPage === undefined || "type" in inodeRootPage) throw new Error("expected Inode root branch");
    if (inodeLeafBPage === undefined || !("type" in inodeLeafBPage)) throw new Error("expected Inode leaf B");
    const addedFiles = [6n, 7n, 8n].map(value => inode({
      content: { bytes: new Uint8Array(), type: "inline" },
      fileSize: createFileOffset({ value: 0n }),
      inodeKind: "file",
      inodeNumber: createInodeNumber({ value }),
    }));
    inodePages.set(inodeRoot, {
      entries: [
        inodeRootPage.entries[0]!,
        { childPageHomeRef: inodeLeafB, upperBound: createInodeNumber({ value: 8n }) },
      ],
      level: 1,
    });
    inodePages.set(inodeLeafB, {
      entries: [...inodeLeafBPage.entries, ...addedFiles],
      level: 0,
      type: "leaf",
    });
    directoryPages.set(directoryRoot, {
      entries: [
        { inodeKind: "file", inodeNumber: createInodeNumber({ value: 5n }), name: "a.bin", targetType: "inode" },
        { inodeKind: "file", inodeNumber: createInodeNumber({ value: 6n }), name: "b.bin", targetType: "inode" },
        { inodeKind: "file", inodeNumber: createInodeNumber({ value: 7n }), name: "c.bin", targetType: "inode" },
        { inodeKind: "file", inodeNumber: createInodeNumber({ value: 8n }), name: "d.bin", targetType: "inode" },
      ],
      level: 0,
      type: "leaf",
    });
    if (resolver.listAfterBounded === undefined) throw new Error("expected paged listing capability");

    const first = await resolver.listAfterBounded({
      afterName: undefined,
      maximumEntries: 1,
      pathComponents: ["tree"],
    });
    expect(first.entries.map(entry => entry.name)).toEqual(["a.bin"]);
    expect(first.truncated).toBe(true);
    const readsAfterFirstPage = readDirectoryPage.mock.calls.length;

    const second = await resolver.listAfterBounded({
      afterName: "a.bin",
      maximumEntries: 1,
      pathComponents: ["tree"],
    });
    expect(second.entries.map(entry => entry.name)).toEqual(["b.bin"]);
    expect(second.truncated).toBe(true);
    expect(readDirectoryPage.mock.calls.length).toBe(readsAfterFirstPage);
  });

  it("keeps a validated paged cursor authoritative after the shared validation proof is evicted", async () => {
    const { directoryPages, inodePages, pointReads, readDirectoryPage, readExtentFile, readInodePage } = fixture();
    const inodeRootPage = inodePages.get(inodeRoot);
    const inodeLeafBPage = inodePages.get(inodeLeafB);
    if (inodeRootPage === undefined || "type" in inodeRootPage) throw new Error("expected Inode root branch");
    if (inodeLeafBPage === undefined || !("type" in inodeLeafBPage)) throw new Error("expected Inode leaf B");
    const added = inode({
      content: { bytes: new Uint8Array(), type: "inline" },
      fileSize: createFileOffset({ value: 0n }),
      inodeKind: "file",
      inodeNumber: createInodeNumber({ value: 6n }),
    });
    inodePages.set(inodeRoot, {
      entries: [
        inodeRootPage.entries[0]!,
        { childPageHomeRef: inodeLeafB, upperBound: createInodeNumber({ value: 6n }) },
      ],
      level: 1,
    });
    inodePages.set(inodeLeafB, { entries: [...inodeLeafBPage.entries, added], level: 0, type: "leaf" });
    directoryPages.set(directoryRoot, {
      entries: [
        { inodeKind: "file", inodeNumber: createInodeNumber({ value: 5n }), name: "a.bin", targetType: "inode" },
        { inodeKind: "file", inodeNumber: createInodeNumber({ value: 6n }), name: "b.bin", targetType: "inode" },
      ],
      level: 0,
      type: "leaf",
    });
    const validationCache = new ReadOnlyNamespaceValidationCache({ maximumEntries: 1_024 });
    const resolver = createReadOnlyNamespaceResolver({
      inodeTableRootHomeRef: inodeRoot,
      rootDirectoryInodeNumber: createInodeNumber({ value: 1n }),
      source: {
        readDirectoryPage: async args => await readDirectoryPage(args),
        readExtentFile: async args => await readExtentFile(args),
        readInodePointPage: async args => await pointReads(args),
        readInodePage: async args => await readInodePage(args),
      },
      validationCache,
    });
    if (resolver.listAfterBounded === undefined) throw new Error("expected paged listing capability");

    const first = await resolver.listAfterBounded({
      afterName: undefined,
      maximumEntries: 1,
      pathComponents: ["tree"],
    });
    expect(first.entries.map(entry => entry.name)).toEqual(["a.bin"]);
    expect(first.truncated).toBe(true);
    validationCache.clear();
    const readsAfterEviction = readDirectoryPage.mock.calls.length;

    const second = await resolver.listAfterBounded({
      afterName: "a.bin",
      maximumEntries: 1,
      pathComponents: ["tree"],
    });
    expect(second.entries.map(entry => entry.name)).toEqual(["b.bin"]);
    expect(readDirectoryPage.mock.calls.length).toBe(readsAfterEviction);
  });

  it("projects lossless bigint stat fields without reading file content", async () => {
    const { namespace, readExtentFile } = fixture();
    const stat = await namespace.stat({ pathComponents: ["tree", "huge.bin"] });
    expect(stat).toEqual({
      createdAt: null,
      fileSize: 9_007_199_254_741_777n,
      inodeNumber: 5n,
      inodeRevision: 1n,
      kind: "file",
      modifiedAt: null,
    });
    expect(readExtentFile).not.toHaveBeenCalled();
    const inline = await namespace.stat({ pathComponents: ["inline.txt"] });
    expect(inline.inodeRevision).toBe(9_007_199_254_740_995n);
    expect(inline.createdAt).toBe(-8_640_000_000_000_000n);
    expect(inline.modifiedAt).toBe(8_640_000_000_000_000n);
  });

  it("reads inline files locally and delegates tree files without narrowing bigint offsets", async () => {
    const { namespace, readExtentFile } = fixture();
    expect(new TextDecoder().decode(await namespace.readFile({ pathComponents: ["inline.txt"] }))).toBe("hello");
    expect(await namespace.readFile({ pathComponents: ["tree", "huge.bin"], offset: 8_640_000_000_000_000n, length: 3n })).toEqual(new Uint8Array([7, 8, 9]));
    expect(readExtentFile).toHaveBeenCalledWith(expect.objectContaining({
      length: 3n,
      offset: 8_640_000_000_000_000n,
    }));
  });

  it("returns raw symlink targets without following the final component", async () => {
    const { namespace } = fixture();
    expect(await namespace.readlink({ pathComponents: ["link"] })).toBe("../raw/target");
    await expect(namespace.readlink({ pathComponents: ["inline.txt"] })).rejects.toMatchObject({ code: "not_symlink" });
  });

  it("rejects persisted inode-kind mismatches and nested Subvolume crossings", async () => {
    const { namespace } = fixture();
    await expect(namespace.stat({ pathComponents: ["link", "child"] })).rejects.toMatchObject({ code: "not_directory" });
  });

  it("validates the complete immutable inode graph before returning a point lookup", async () => {
    const { inodePages, namespace } = fixture();
    inodePages.set(inodeRoot, {
      entries: [
        { childPageHomeRef: inodeLeafA, upperBound: createInodeNumber({ value: 3n }) },
        { childPageHomeRef: inodeLeafB, upperBound: createInodeNumber({ value: 6n }) },
      ],
      level: 1,
    });

    await expect(namespace.stat({ pathComponents: ["inline.txt"] })).rejects.toThrow("upper bound");
  });

  it("rejects an ordinary inode that is reachable from more than one directory entry", async () => {
    const { directoryPages, namespace } = fixture();
    directoryPages.set(directoryRoot, {
      entries: [
        { inodeKind: "file", inodeNumber: createInodeNumber({ value: 2n }), name: "duplicate.txt", targetType: "inode" },
        { inodeKind: "file", inodeNumber: createInodeNumber({ value: 5n }), name: "huge.bin", targetType: "inode" },
      ],
      level: 0,
      type: "leaf",
    });

    await expect(namespace.stat({ pathComponents: ["inline.txt"] }))
      .rejects.toMatchObject({ code: "corrupt_namespace" });
  });

  it("rejects an unrelated dangling ordinary-inode target", async () => {
    const { directoryPages, namespace } = fixture();
    directoryPages.set(directoryRoot, {
      entries: [
        { inodeKind: "file", inodeNumber: createInodeNumber({ value: 6n }), name: "dangling.bin", targetType: "inode" },
        { inodeKind: "file", inodeNumber: createInodeNumber({ value: 5n }), name: "huge.bin", targetType: "inode" },
      ],
      level: 0,
      type: "leaf",
    });

    await expect(namespace.stat({ pathComponents: ["inline.txt"] }))
      .rejects.toMatchObject({ code: "corrupt_namespace" });
  });

  it("rejects an unrelated ordinary-directory cycle", async () => {
    const { directoryPages, namespace } = fixture();
    directoryPages.set(directoryRoot, {
      entries: [
        { inodeKind: "directory", inodeNumber: createInodeNumber({ value: 1n }), name: "cycle", targetType: "inode" },
        { inodeKind: "file", inodeNumber: createInodeNumber({ value: 5n }), name: "huge.bin", targetType: "inode" },
      ],
      level: 0,
      type: "leaf",
    });

    await expect(namespace.stat({ pathComponents: ["inline.txt"] }))
      .rejects.toMatchObject({ code: "corrupt_namespace" });
  });

  it("rejects an orphan inode even when the requested path does not reference it", async () => {
    const { inodePages, namespace } = fixture();
    const firstLeaf = inodePages.get(inodeLeafA);
    if (firstLeaf === undefined || !("type" in firstLeaf)) throw new Error("expected first Inode leaf fixture");
    const root = firstLeaf.entries.find(entry => entry.inodeNumber === 1n);
    if (root?.inodeKind !== "directory" || root.content.type !== "inline") throw new Error("expected inline root Directory fixture");
    const rootContent = root.content;
    inodePages.set(inodeLeafA, {
      entries: firstLeaf.entries.map(entry => entry.inodeNumber === 1n
        ? { ...root, content: { ...rootContent, entries: rootContent.entries.filter(entry => entry.targetType !== "inode" || entry.inodeNumber !== 2n) } }
        : entry),
      level: 0,
      type: "leaf",
    });

    await expect(namespace.stat({ pathComponents: ["tree", "huge.bin"] }))
      .rejects.toMatchObject({ code: "corrupt_namespace" });
  });
});
