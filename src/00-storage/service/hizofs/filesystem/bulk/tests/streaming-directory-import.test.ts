import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createHomeRecordReference,
  createInodeNumber,
  createInodeRevision,
  createTimestampMilliseconds,
  createUInt64,
  encodeHomeRecordReference,
  parseSegmentId,
  type DirectoryPage,
  type HomeRecordReference,
} from "@/00-storage/service/hizofs/00-format";
import { StreamingDirectoryImport } from "@/00-storage/service/hizofs/filesystem/bulk/streaming-directory-import";
import {
  createDirectoryPageTreePageStore,
  readDirectoryPageTreeEntry,
} from "@/00-storage/service/hizofs/filesystem/mutation/directory-page-tree";
import { describe, expect, it } from "vitest";

function reference({ offset }: { offset: bigint }): HomeRecordReference {
  return createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: offset }),
    frameLength: 96,
    recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.directory_page,
    segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(Number(offset % 251n) + 1) }),
  } });
}

function identity({ value }: { value: HomeRecordReference }): string {
  return [...encodeHomeRecordReference({ reference: value })]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

class MemoryDirectoryPagePort {
  readonly pages = new Map<string, DirectoryPage>();
  private nextOffset = 1_024n;

  async readPage({ reference: value }: {
    isRoot: boolean;
    reference: HomeRecordReference;
  }): Promise<DirectoryPage> {
    const page = this.pages.get(identity({ value }));
    if (page === undefined) throw new Error("missing Directory Page");
    return page;
  }

  async writePage({ page }: {
    isRoot: boolean;
    page: DirectoryPage;
  }): Promise<HomeRecordReference> {
    const value = reference({ offset: this.nextOffset });
    this.nextOffset += 128n;
    this.pages.set(identity({ value }), page);
    return value;
  }
}

function directory({ port }: { port: MemoryDirectoryPagePort }): StreamingDirectoryImport {
  return new StreamingDirectoryImport({
    inodeNumber: createInodeNumber({ value: 8n }),
    inodeRevision: createInodeRevision({ value: 1n }),
    limits: { maximumEntryMutationsPerBatch: 3 },
    pageStore: createDirectoryPageTreePageStore({ pagePort: port }),
    timestamps: {
      createdAt: null,
      modifiedAt: createTimestampMilliseconds({ value: 20n }),
    },
  });
}

function entry({ index, name }: { index: number; name: string }) {
  return {
    inodeKind: "file" as const,
    inodeNumber: createInodeNumber({ value: BigInt(index + 100) }),
    name,
    targetType: "inode" as const,
  };
}

describe("Streaming directory import", () => {
  it("keeps a bounded small directory inline with exact timestamps", async () => {
    const port = new MemoryDirectoryPagePort();
    const value = directory({ port });
    await value.addEntry({ entry: entry({ index: 0, name: "a" }) });
    await value.addEntry({ entry: entry({ index: 1, name: "b" }) });

    await expect(value.finalize()).resolves.toEqual({
      content: {
        entries: [entry({ index: 0, name: "a" }), entry({ index: 1, name: "b" })],
        type: "inline",
      },
      inodeKind: "directory",
      inodeNumber: 8n,
      inodeRevision: 1n,
      timestamps: { createdAt: null, modifiedAt: 20n },
    });
    expect(port.pages.size).toBe(0);
  });

  it("promotes an oversized directory into a private canonical page tree", async () => {
    const port = new MemoryDirectoryPagePort();
    const pageStore = createDirectoryPageTreePageStore({ pagePort: port });
    const value = new StreamingDirectoryImport({
      inodeNumber: createInodeNumber({ value: 8n }),
      inodeRevision: createInodeRevision({ value: 1n }),
      limits: { maximumEntryMutationsPerBatch: 2 },
      pageStore,
      timestamps: { createdAt: null, modifiedAt: null },
    });
    const names = Array.from({ length: 40 }, (_, index) => (
      `${index.toString().padStart(4, "0")}-${"x".repeat(180)}`
    ));
    for (const [index, name] of names.entries()) {
      await value.addEntry({ entry: entry({ index, name }) });
    }

    const inode = await value.finalize();
    if (inode.content.type !== "tree") throw new Error("expected tree-backed directory");
    expect(port.pages.size).toBeGreaterThan(0);
    await expect(readDirectoryPageTreeEntry({
      name: names.at(-1) ?? "",
      pageStore,
      rootReference: inode.content.directoryTreeRootHomeRef,
    })).resolves.toEqual(entry({ index: names.length - 1, name: names.at(-1) ?? "" }));
  });

  it("resumes an inline or tree-backed private directory checkpoint", async () => {
    const inlinePort = new MemoryDirectoryPagePort();
    const inline = directory({ port: inlinePort });
    await inline.addEntry({ entry: entry({ index: 0, name: "a" }) });
    const resumedInline = StreamingDirectoryImport.restore({
      checkpoint: await inline.checkpoint(),
      limits: { maximumEntryMutationsPerBatch: 3 },
      pageStore: createDirectoryPageTreePageStore({ pagePort: inlinePort }),
    });
    await resumedInline.addEntry({ entry: entry({ index: 1, name: "b" }) });
    await expect(resumedInline.finalize()).resolves.toMatchObject({
      content: { entries: [{ name: "a" }, { name: "b" }], type: "inline" },
    });

    const treePort = new MemoryDirectoryPagePort();
    const pageStore = createDirectoryPageTreePageStore({ pagePort: treePort });
    const tree = new StreamingDirectoryImport({
      inodeNumber: createInodeNumber({ value: 8n }),
      inodeRevision: createInodeRevision({ value: 1n }),
      limits: { maximumEntryMutationsPerBatch: 2 },
      pageStore,
      timestamps: { createdAt: null, modifiedAt: null },
    });
    const names = Array.from({ length: 30 }, (_, index) => (
      `${index.toString().padStart(4, "0")}-${"y".repeat(180)}`
    ));
    for (const [index, name] of names.slice(0, 20).entries()) {
      await tree.addEntry({ entry: entry({ index, name }) });
    }
    const resumedTree = StreamingDirectoryImport.restore({
      checkpoint: await tree.checkpoint(),
      limits: { maximumEntryMutationsPerBatch: 2 },
      pageStore,
    });
    for (const [relativeIndex, name] of names.slice(20).entries()) {
      await resumedTree.addEntry({ entry: entry({ index: relativeIndex + 20, name }) });
    }
    const inode = await resumedTree.finalize();
    if (inode.content.type !== "tree") throw new Error("expected resumed tree-backed directory");
    await expect(readDirectoryPageTreeEntry({
      name: names.at(-1) ?? "",
      pageStore,
      rootReference: inode.content.directoryTreeRootHomeRef,
    })).resolves.toEqual(entry({ index: 29, name: names.at(-1) ?? "" }));
  });

  it("rejects duplicate or descending canonical names and becomes terminal", async () => {
    const value = directory({ port: new MemoryDirectoryPagePort() });
    await value.addEntry({ entry: entry({ index: 0, name: "b" }) });
    await expect(value.addEntry({ entry: entry({ index: 1, name: "a" }) }))
      .rejects.toMatchObject({ code: "non_canonical_entry_order" });
    await expect(value.finalize()).rejects.toMatchObject({ code: "import_failed" });
  });
});

export const TEST_ONLY = {};
