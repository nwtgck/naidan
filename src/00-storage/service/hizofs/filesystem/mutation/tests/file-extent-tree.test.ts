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
import {
  applyFileExtentTreeMutations,
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

class MemoryPagePort {
  readonly pages = new Map<string, FileExtentPage>();
  #nextOffset = 1_024n;

  async readPage({ reference: value }: {
    isRoot: boolean;
    reference: HomeRecordReference;
  }): Promise<FileExtentPage> {
    const page = this.pages.get(identity({ value }));
    if (page === undefined) throw new Error("missing File Extent page");
    return page;
  }

  async writePage({ page }: {
    isRoot: boolean;
    page: FileExtentPage;
  }): Promise<HomeRecordReference> {
    const value = reference({
      kind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_extent_page,
      offset: this.#nextOffset,
    });
    this.#nextOffset += 128n;
    this.pages.set(identity({ value }), page);
    return value;
  }
}

function extent({ fileOffset, seed }: { fileOffset: bigint; seed: bigint }) {
  return {
    byteLength: 4,
    dataOffset: 0,
    fileDataHomeRef: reference({
      kind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_data,
      offset: seed,
    }),
    fileOffset: createFileOffset({ value: fileOffset }),
  };
}

describe("File Extent tree", () => {
  it("applies canonical sparse extent changes and supports predecessor iteration", async () => {
    const port = new MemoryPagePort();
    const root = reference({
      kind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_extent_page,
      offset: 128n,
    });
    port.pages.set(identity({ value: root }), {
      entries: [extent({ fileOffset: 0n, seed: 256n }), extent({ fileOffset: 100n, seed: 384n })],
      level: 0,
      type: "leaf",
    });
    const pageStore = createFileExtentTreePageStore({ pagePort: port });
    const inserted = extent({ fileOffset: 50n, seed: 512n });
    const nextRoot = await applyFileExtentTreeMutations({
      changes: [
        { entry: inserted, type: "set" },
        { key: createFileOffset({ value: 100n }), type: "delete" },
      ],
      pageStore,
      rootReference: root,
    });

    const entries = [];
    for await (const entry of fileExtentEntriesFromFloor({
      fileOffset: createFileOffset({ value: 51n }),
      pageStore,
      rootReference: nextRoot,
    })) entries.push(entry);
    expect(entries.map(entry => entry.fileOffset)).toEqual([50n]);
    expect(entries[0]).toEqual(inserted);
  });
});

export const TEST_ONLY = {};
