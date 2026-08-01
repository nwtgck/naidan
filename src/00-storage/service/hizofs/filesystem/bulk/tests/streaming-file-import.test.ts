import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createFileOffset,
  createHomeRecordReference,
  createUInt64,
  encodeHomeRecordReference,
  parseSegmentId,
  type FileExtentPage,
  type HomeRecordReference,
} from "@/00-storage/service/hizofs/00-format";
import { StreamingFileImport } from "@/00-storage/service/hizofs/filesystem/bulk/streaming-file-import";
import {
  createFileExtentTreePageStore,
  fileExtentEntriesFromFloor,
} from "@/00-storage/service/hizofs/filesystem/mutation/file-extent-tree";
import { describe, expect, it } from "vitest";

function reference({ kind, offset }: { kind: number; offset: bigint }): HomeRecordReference {
  return createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: offset }),
    frameLength: 96,
    recordKind: kind,
    segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(Number(offset % 251n) + 1) }),
  } });
}

function identity({ value }: { value: HomeRecordReference }): string {
  return [...encodeHomeRecordReference({ reference: value })]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

class MemoryImportPort {
  readonly fileData: Uint8Array[] = [];
  readonly pages = new Map<string, FileExtentPage>();
  readonly extentPageStore = createFileExtentTreePageStore({ pagePort: {
    readPage: async ({ reference: value }) => {
      const page = this.pages.get(identity({ value }));
      if (page === undefined) throw new Error("missing File Extent page");
      return page;
    },
    writePage: async ({ page }) => {
      const value = reference({
        kind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_extent_page,
        offset: this.#nextPageOffset,
      });
      this.#nextPageOffset += 128n;
      this.pages.set(identity({ value }), page);
      return value;
    },
  } });
  #nextDataOffset = 1_048_576n;
  #nextPageOffset = 1_024n;

  async writeFileData({ bytes }: { bytes: Uint8Array }): Promise<HomeRecordReference> {
    this.fileData.push(new Uint8Array(bytes));
    const value = reference({
      kind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_data,
      offset: this.#nextDataOffset,
    });
    this.#nextDataOffset += 128n;
    return value;
  }
}

function importer({ port }: { port: MemoryImportPort }): StreamingFileImport {
  return new StreamingFileImport({
    limits: { maximumExtentMutationsPerBatch: 2 },
    port,
  });
}

async function extents({ content, port }: {
  content: Awaited<ReturnType<StreamingFileImport["finalize"]>>;
  port: MemoryImportPort;
}) {
  if (content.type !== "tree") throw new Error("expected extent-backed content");
  const values = [];
  for await (const entry of fileExtentEntriesFromFloor({
    fileOffset: createFileOffset({ value: 0n }),
    pageStore: port.extentPageStore,
    rootReference: content.extentTreeRootHomeRef,
  })) values.push(entry);
  return values;
}

describe("Streaming file import", () => {
  it("keeps an empty file metadata-only", async () => {
    const port = new MemoryImportPort();
    const value = importer({ port });

    await expect(value.finalize({ size: 0n })).resolves.toEqual({
      bytes: new Uint8Array(),
      type: "inline",
    });
    expect(port.fileData).toEqual([]);
    expect(port.pages.size).toBe(0);
    expect(value.state()).toBe("finalized");
  });

  it("represents a large all-zero file as a sparse extent tree without File Data", async () => {
    const port = new MemoryImportPort();
    const value = importer({ port });
    const bytes = new Uint8Array(128 * 1024);

    await value.writeChunk({ bytes, offset: 0n });
    const content = await value.finalize({ size: BigInt(bytes.byteLength) });

    expect(port.fileData).toEqual([]);
    expect(await extents({ content, port })).toEqual([]);
  });

  it("writes only non-zero runs at their exact logical offsets", async () => {
    const port = new MemoryImportPort();
    const value = importer({ port });

    await value.writeChunk({ bytes: Uint8Array.from([0, 1, 2, 0, 0, 3, 0]), offset: 0n });
    const content = await value.finalize({ size: 7n });
    const entries = await extents({ content, port });

    expect(port.fileData.map(bytes => [...bytes])).toEqual([[1, 2], [3]]);
    expect(entries.map(entry => ({ byteLength: entry.byteLength, fileOffset: entry.fileOffset }))).toEqual([
      { byteLength: 2, fileOffset: 1n },
      { byteLength: 1, fileOffset: 5n },
    ]);
  });

  it("resumes from a private candidate checkpoint without replaying prior bytes", async () => {
    const port = new MemoryImportPort();
    const first = importer({ port });
    await first.writeChunk({ bytes: Uint8Array.from([1, 0]), offset: 0n });

    const resumed = StreamingFileImport.restore({
      checkpoint: first.checkpoint(),
      limits: { maximumExtentMutationsPerBatch: 2 },
      port,
    });
    await resumed.writeChunk({ bytes: Uint8Array.from([0, 2]), offset: 2n });
    const content = await resumed.finalize({ size: 4n });
    const entries = await extents({ content, port });

    expect(port.fileData.map(bytes => [...bytes])).toEqual([[1], [2]]);
    expect(entries.map(entry => entry.fileOffset)).toEqual([0n, 3n]);
  });

  it("splits a non-zero run by the persisted File Data payload limit", async () => {
    const port = new MemoryImportPort();
    const value = importer({ port });
    const maximum = HIZOFS_V1_FORMAT_CONSTANTS.limits.fileDataPlaintextBytes;
    const bytes = new Uint8Array(maximum + 1).fill(7);

    await value.writeChunk({ bytes, offset: 0n });
    const content = await value.finalize({ size: BigInt(bytes.byteLength) });
    const entries = await extents({ content, port });

    expect(port.fileData.map(chunk => chunk.byteLength)).toEqual([maximum, 1]);
    expect(entries.map(entry => entry.fileOffset)).toEqual([0n, BigInt(maximum)]);
  });

  it("rejects gaps, overlap, and final size disagreement", async () => {
    const gap = importer({ port: new MemoryImportPort() });
    await expect(gap.writeChunk({ bytes: Uint8Array.of(1), offset: 1n }))
      .rejects.toMatchObject({ code: "non_sequential_chunk" });

    const size = importer({ port: new MemoryImportPort() });
    await size.writeChunk({ bytes: Uint8Array.of(1), offset: 0n });
    await expect(size.finalize({ size: 2n })).rejects.toMatchObject({ code: "size_mismatch" });
    await expect(size.finalize({ size: 1n })).rejects.toMatchObject({ code: "import_failed" });
  });
});

export const TEST_ONLY = {};
