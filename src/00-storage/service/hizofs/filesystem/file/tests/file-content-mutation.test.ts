import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createFileOffset,
  createHomeRecordReference,
  createInodeNumber,
  createInodeRevision,
  createTimestampMilliseconds,
  createUInt64,
  encodeHomeRecordReference,
  parseSegmentId,
  type FileExtentPage,
  type FileInodeEntry,
  type HomeRecordReference,
} from "@/00-storage/service/hizofs/00-format";
import type { ImmutableBTreeDiagnosticsObservation } from "@/00-storage/service/hizofs/diagnostics/immutable-btree-diagnostics";
import {
  PreparedFileExtentTailAppendBatch,
  prepareFileTruncateMutation,
  prepareFileWriteMutation,
  prepareFileWriteMutationWithAppendTailWitness,
  type FileContentMutationPort,
} from "@/00-storage/service/hizofs/filesystem/file/file-content-mutation";
import { prepareFileTruncatePlan } from "@/00-storage/service/hizofs/filesystem/file/file-truncate-plan";
import { prepareFileWritePlan } from "@/00-storage/service/hizofs/filesystem/file/file-write-plan";
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

class MemoryPagePort {
  readonly observations: ImmutableBTreeDiagnosticsObservation[] = [];
  readonly operationDiagnostics = {
    operation: "update" as const,
    port: {
      recordIndexOperation: (observation: ImmutableBTreeDiagnosticsObservation): void => {
        this.observations.push(observation);
      },
    },
  };
  readonly pages = new Map<string, FileExtentPage>();
  failNextWrite = false;
  readCount = 0;
  writeCount = 0;
  private nextOffset = 10_000n;

  async readPage({ reference: value }: {
    isRoot: boolean;
    reference: HomeRecordReference;
  }): Promise<FileExtentPage> {
    this.readCount += 1;
    const page = this.pages.get(identity({ value }));
    if (page === undefined) throw new Error("missing File Extent page");
    return page;
  }

  async writePage({ page }: {
    isRoot: boolean;
    page: FileExtentPage;
  }): Promise<HomeRecordReference> {
    this.writeCount += 1;
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error("injected File Extent page write failure");
    }
    const value = reference({
      kind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_extent_page,
      offset: this.nextOffset,
    });
    this.nextOffset += 128n;
    this.pages.set(identity({ value }), page);
    return value;
  }
}

class MemoryContentPort {
  readonly data = new Map<string, Uint8Array>();
  readonly pagePort = new MemoryPagePort();
  readonly extentPageStore = createFileExtentTreePageStore({ pagePort: this.pagePort });
  private nextDataOffset = 50_000n;

  readonly port: FileContentMutationPort = {
    extentPageStore: this.extentPageStore,
    writeFileData: async ({ bytes }) => {
      const value = reference({
        kind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_data,
        offset: this.nextDataOffset,
      });
      this.nextDataOffset += 128n;
      this.data.set(identity({ value }), new Uint8Array(bytes));
      return value;
    },
  };
}

function fileInode({ content, fileSize = 0n, revision = 1n }: {
  content: FileInodeEntry["content"];
  fileSize?: bigint;
  revision?: bigint;
}): FileInodeEntry {
  return {
    content,
    fileSize: createFileOffset({ value: fileSize }),
    inodeKind: "file",
    inodeNumber: createInodeNumber({ value: 7n }),
    inodeRevision: createInodeRevision({ value: revision }),
    timestamps: {
      createdAt: createTimestampMilliseconds({ value: 10n }),
      modifiedAt: createTimestampMilliseconds({ value: 11n }),
    },
  };
}

function extent({ byteLength, dataOffset = 0, fileOffset, seed }: {
  byteLength: number;
  dataOffset?: number;
  fileOffset: bigint;
  seed: bigint;
}) {
  return {
    byteLength,
    dataOffset,
    fileDataHomeRef: reference({
      kind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_data,
      offset: seed,
    }),
    fileOffset: createFileOffset({ value: fileOffset }),
  };
}

async function entries({ port, root }: {
  port: MemoryContentPort;
  root: HomeRecordReference;
}) {
  const result = [];
  for await (const entry of fileExtentEntriesFromFloor({
    fileOffset: createFileOffset({ value: 0n }),
    pageStore: port.extentPageStore,
    rootReference: root,
  })) result.push(entry);
  return result;
}

const operationTimestamp = createTimestampMilliseconds({ value: 20n });
const limits = { maximumExtentMutationsPerBatch: 1 } as const;

describe("file content mutation", () => {
  it("copy-on-write replaces only an overlapping range and preserves boundary fragments", async () => {
    const memory = new MemoryContentPort();
    const root = reference({
      kind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_extent_page,
      offset: 1_000n,
    });
    const left = extent({ byteLength: 10, dataOffset: 2, fileOffset: 0n, seed: 2_000n });
    const right = extent({ byteLength: 10, fileOffset: 20n, seed: 3_000n });
    memory.pagePort.pages.set(identity({ value: root }), {
      entries: [left, right],
      level: 0,
      type: "leaf",
    });
    const source = fileInode({
      content: { extentTreeRootHomeRef: root, type: "tree" },
      fileSize: 30n,
    });
    const plan = prepareFileWritePlan({
      bytes: new Uint8Array(20).fill(9),
      operationTimestamp,
      position: createFileOffset({ value: 5n }),
      source,
    });
    if (plan === null) throw new Error("expected write plan");

    const inode = await prepareFileWriteMutation({ limits, plan, port: memory.port, source });
    if (inode.content.type !== "tree") throw new Error("expected extent-backed inode");
    const result = await entries({ port: memory, root: inode.content.extentTreeRootHomeRef });

    expect(result.map(entry => ({
      byteLength: entry.byteLength,
      dataOffset: entry.dataOffset,
      fileOffset: entry.fileOffset,
    }))).toEqual([
      { byteLength: 5, dataOffset: 2, fileOffset: 0n },
      { byteLength: 20, dataOffset: 0, fileOffset: 5n },
      { byteLength: 5, dataOffset: 5, fileOffset: 25n },
    ]);
    expect(inode.fileSize).toBe(30n);
    expect(inode.inodeRevision).toBe(2n);
  });

  it("applies overlap removal, boundary preservation, and replacement in one tree update when bounded", async () => {
    const memory = new MemoryContentPort();
    const root = reference({
      kind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_extent_page,
      offset: 1_504n,
    });
    memory.pagePort.pages.set(identity({ value: root }), {
      entries: [extent({ byteLength: 10, dataOffset: 4, fileOffset: 0n, seed: 2_504n })],
      level: 0,
      type: "leaf",
    });
    const source = fileInode({
      content: { extentTreeRootHomeRef: root, type: "tree" },
      fileSize: 10n,
    });
    const plan = prepareFileWritePlan({
      bytes: new Uint8Array(5).fill(7),
      operationTimestamp,
      position: createFileOffset({ value: 2n }),
      source,
    });
    if (plan === null) throw new Error("expected write plan");

    const inode = await prepareFileWriteMutation({
      limits: { maximumExtentMutationsPerBatch: 128 },
      plan,
      port: memory.port,
      source,
    });
    if (inode.content.type !== "tree") throw new Error("expected extent-backed inode");
    const updates = memory.pagePort.observations.filter(observation => observation.operation === "update");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.structural.inputMutations).toBe(3);
    expect((await entries({ port: memory, root: inode.content.extentTreeRootHomeRef })).map(entry => ({
      byteLength: entry.byteLength,
      dataOffset: entry.dataOffset,
      fileOffset: entry.fileOffset,
    }))).toEqual([
      { byteLength: 2, dataOffset: 4, fileOffset: 0n },
      { byteLength: 5, dataOffset: 0, fileOffset: 2n },
      { byteLength: 3, dataOffset: 11, fileOffset: 7n },
    ]);
  });

  it("lets the replacement win when overlap removal targets the same extent key", async () => {
    const memory = new MemoryContentPort();
    const root = reference({
      kind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_extent_page,
      offset: 1_600n,
    });
    memory.pagePort.pages.set(identity({ value: root }), {
      entries: [extent({ byteLength: 10, dataOffset: 3, fileOffset: 0n, seed: 2_600n })],
      level: 0,
      type: "leaf",
    });
    const source = fileInode({
      content: { extentTreeRootHomeRef: root, type: "tree" },
      fileSize: 10n,
    });
    const plan = prepareFileWritePlan({
      bytes: new Uint8Array(4).fill(8),
      operationTimestamp,
      position: createFileOffset({ value: 0n }),
      source,
    });
    if (plan === null) throw new Error("expected write plan");

    const inode = await prepareFileWriteMutation({
      limits: { maximumExtentMutationsPerBatch: 128 },
      plan,
      port: memory.port,
      source,
    });
    if (inode.content.type !== "tree") throw new Error("expected extent-backed inode");
    const updates = memory.pagePort.observations.filter(observation => observation.operation === "update");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.structural.inputMutations).toBe(2);
    expect((await entries({ port: memory, root: inode.content.extentTreeRootHomeRef })).map(entry => ({
      byteLength: entry.byteLength,
      dataOffset: entry.dataOffset,
      fileOffset: entry.fileOffset,
    }))).toEqual([
      { byteLength: 4, dataOffset: 0, fileOffset: 0n },
      { byteLength: 6, dataOffset: 7, fileOffset: 4n },
    ]);
  });

  it("promotes inline content without allocating sparse holes", async () => {
    const memory = new MemoryContentPort();
    const source = fileInode({
      content: { bytes: new TextEncoder().encode("abc"), type: "inline" },
      fileSize: 3n,
    });
    const plan = prepareFileWritePlan({
      bytes: new TextEncoder().encode("XY"),
      operationTimestamp,
      position: createFileOffset({ value: BigInt(HIZOFS_V1_FORMAT_CONSTANTS.limits.inlineFileBytes) + 10n }),
      source,
    });
    if (plan === null) throw new Error("expected write plan");

    const inode = await prepareFileWriteMutation({ limits, plan, port: memory.port, source });
    if (inode.content.type !== "tree") throw new Error("expected extent-backed inode");
    const result = await entries({ port: memory, root: inode.content.extentTreeRootHomeRef });

    const sparseWriteOffset = BigInt(HIZOFS_V1_FORMAT_CONSTANTS.limits.inlineFileBytes) + 10n;
    expect(result.map(entry => [entry.fileOffset, entry.byteLength])).toEqual([[0n, 3], [sparseWriteOffset, 2]]);
    expect(inode.fileSize).toBe(sparseWriteOffset + 2n);
  });

  it("reuses only a mutation-owned append-tail witness to skip the redundant overlap scan", async () => {
    const memory = new MemoryContentPort();
    const inlineLimit = HIZOFS_V1_FORMAT_CONSTANTS.limits.inlineFileBytes;
    const source = fileInode({ content: { bytes: new Uint8Array(), type: "inline" } });
    const firstPlan = prepareFileWritePlan({
      bytes: new Uint8Array(inlineLimit + 1).fill(3),
      operationTimestamp,
      position: createFileOffset({ value: 0n }),
      source,
    });
    if (firstPlan === null) throw new Error("expected first write plan");
    const first = await prepareFileWriteMutationWithAppendTailWitness({
      appendTailWitness: undefined,
      limits: { maximumExtentMutationsPerBatch: 128 },
      plan: firstPlan,
      port: memory.port,
      source,
    });
    expect(first.appendTailWitness).toBeDefined();
    if (first.inode.content.type !== "tree") throw new Error("expected extent-backed inode");

    memory.pagePort.readCount = 0;
    const secondPlan = prepareFileWritePlan({
      bytes: new Uint8Array(7).fill(4),
      operationTimestamp,
      position: first.inode.fileSize,
      source: first.inode,
    });
    if (secondPlan === null) throw new Error("expected second write plan");
    const second = await prepareFileWriteMutationWithAppendTailWitness({
      appendTailWitness: first.appendTailWitness,
      limits: { maximumExtentMutationsPerBatch: 128 },
      plan: secondPlan,
      port: memory.port,
      source: first.inode,
    });

    // One authenticated B+tree read remains for the actual immutable update.
    // The general overlap scan would read the same root once more.
    expect(memory.pagePort.readCount).toBe(1);
    expect(second.appendTailWitness).toBeDefined();
    expect(second.inode.fileSize).toBe(first.inode.fileSize + 7n);
  });

  it("re-establishes the append-tail witness after an overlap-checked tail append", async () => {
    const memory = new MemoryContentPort();
    const inlineLimit = HIZOFS_V1_FORMAT_CONSTANTS.limits.inlineFileBytes;
    const source = fileInode({ content: { bytes: new Uint8Array(), type: "inline" } });
    const firstPlan = prepareFileWritePlan({
      bytes: new Uint8Array(inlineLimit + 1).fill(3),
      operationTimestamp,
      position: createFileOffset({ value: 0n }),
      source,
    });
    if (firstPlan === null) throw new Error("expected first write plan");
    const first = await prepareFileWriteMutationWithAppendTailWitness({
      appendTailWitness: undefined,
      limits: { maximumExtentMutationsPerBatch: 128 },
      plan: firstPlan,
      port: memory.port,
      source,
    });

    const secondPlan = prepareFileWritePlan({
      bytes: Uint8Array.of(9),
      operationTimestamp,
      position: first.inode.fileSize,
      source: first.inode,
    });
    if (secondPlan === null) throw new Error("expected second write plan");
    const second = await prepareFileWriteMutationWithAppendTailWitness({
      appendTailWitness: undefined,
      limits: { maximumExtentMutationsPerBatch: 128 },
      plan: secondPlan,
      port: memory.port,
      source: first.inode,
    });

    expect(second.appendTailWitness).toBeDefined();
  });

  it("materializes repeated proven tail appends through one bounded extent-tree update", async () => {
    const memory = new MemoryContentPort();
    const inlineLimit = HIZOFS_V1_FORMAT_CONSTANTS.limits.inlineFileBytes;
    const source = fileInode({ content: { bytes: new Uint8Array(), type: "inline" } });
    const firstPlan = prepareFileWritePlan({
      bytes: new Uint8Array(inlineLimit + 1).fill(3),
      operationTimestamp,
      position: createFileOffset({ value: 0n }),
      source,
    });
    if (firstPlan === null) throw new Error("expected first write plan");
    const first = await prepareFileWriteMutationWithAppendTailWitness({
      appendTailWitness: undefined,
      limits: { maximumExtentMutationsPerBatch: 64 },
      plan: firstPlan,
      port: memory.port,
      source,
    });
    if (first.appendTailWitness === undefined) throw new Error("expected append-tail witness");
    const writesBeforeBatch = memory.pagePort.writeCount;
    const batch = PreparedFileExtentTailAppendBatch.create({
      source: first.inode,
      witness: first.appendTailWitness,
    });
    let staged = first.inode;
    for (let index = 0; index < 3; index += 1) {
      const plan = prepareFileWritePlan({
        bytes: new Uint8Array(7).fill(index + 4),
        operationTimestamp,
        position: staged.fileSize,
        source: staged,
      });
      if (plan === null || plan.action !== "copy_on_write_extent_range") throw new Error("expected tail extent write plan");
      expect(batch.canStage({
        byteLength: plan.writeBytes.byteLength,
        limits: { maximumExtentMutationsPerBatch: 64 },
        source: staged,
        writeOffset: plan.writeOffset,
      })).toBe(true);
      staged = await batch.stage({ plan, port: memory.port, source: staged });
    }

    expect(memory.pagePort.writeCount).toBe(writesBeforeBatch);
    const flushed = await batch.flush({
      limits: { maximumExtentMutationsPerBatch: 64 },
      pageStore: memory.extentPageStore,
      source: staged,
    });
    expect(memory.pagePort.writeCount).toBe(writesBeforeBatch + 1);
    if (flushed.inode.content.type !== "tree") throw new Error("expected extent-backed inode");
    const result = await entries({ port: memory, root: flushed.inode.content.extentTreeRootHomeRef });
    expect(result).toHaveLength(4);
    expect(result.map(entry => entry.fileOffset)).toEqual([
      0n,
      BigInt(inlineLimit + 1),
      BigInt(inlineLimit + 8),
      BigInt(inlineLimit + 15),
    ]);
  });

  it("bounds and consumes the prepared tail-append capability", async () => {
    const memory = new MemoryContentPort();
    const inlineLimit = HIZOFS_V1_FORMAT_CONSTANTS.limits.inlineFileBytes;
    const source = fileInode({ content: { bytes: new Uint8Array(), type: "inline" } });
    const firstPlan = prepareFileWritePlan({
      bytes: new Uint8Array(inlineLimit + 1).fill(1),
      operationTimestamp,
      position: createFileOffset({ value: 0n }),
      source,
    });
    if (firstPlan === null) throw new Error("expected first write plan");
    const first = await prepareFileWriteMutationWithAppendTailWitness({
      appendTailWitness: undefined,
      limits: { maximumExtentMutationsPerBatch: 2 },
      plan: firstPlan,
      port: memory.port,
      source,
    });
    if (first.appendTailWitness === undefined) throw new Error("expected append-tail witness");
    const batch = PreparedFileExtentTailAppendBatch.create({
      source: first.inode,
      witness: first.appendTailWitness,
    });
    let staged = first.inode;
    for (let index = 0; index < 2; index += 1) {
      const plan = prepareFileWritePlan({
        bytes: Uint8Array.of(index + 2),
        operationTimestamp,
        position: staged.fileSize,
        source: staged,
      });
      if (plan === null || plan.action !== "copy_on_write_extent_range") throw new Error("expected tail extent write plan");
      staged = await batch.stage({ plan, port: memory.port, source: staged });
    }
    expect(batch.canStage({
      byteLength: 1,
      limits: { maximumExtentMutationsPerBatch: 2 },
      source: staged,
      writeOffset: staged.fileSize,
    })).toBe(false);

    await batch.flush({
      limits: { maximumExtentMutationsPerBatch: 2 },
      pageStore: memory.extentPageStore,
      source: staged,
    });
    expect(batch.canStage({
      byteLength: 1,
      limits: { maximumExtentMutationsPerBatch: 2 },
      source: staged,
      writeOffset: staged.fileSize,
    })).toBe(false);
    await expect(batch.flush({
      limits: { maximumExtentMutationsPerBatch: 2 },
      pageStore: memory.extentPageStore,
      source: staged,
    })).rejects.toThrow("batch is closed");
  });

  it("consumes the prepared tail-append capability when materialization fails", async () => {
    const memory = new MemoryContentPort();
    const inlineLimit = HIZOFS_V1_FORMAT_CONSTANTS.limits.inlineFileBytes;
    const source = fileInode({ content: { bytes: new Uint8Array(), type: "inline" } });
    const firstPlan = prepareFileWritePlan({
      bytes: new Uint8Array(inlineLimit + 1).fill(1),
      operationTimestamp,
      position: createFileOffset({ value: 0n }),
      source,
    });
    if (firstPlan === null) throw new Error("expected first write plan");
    const first = await prepareFileWriteMutationWithAppendTailWitness({
      appendTailWitness: undefined,
      limits: { maximumExtentMutationsPerBatch: 2 },
      plan: firstPlan,
      port: memory.port,
      source,
    });
    if (first.appendTailWitness === undefined) throw new Error("expected append-tail witness");
    const batch = PreparedFileExtentTailAppendBatch.create({
      source: first.inode,
      witness: first.appendTailWitness,
    });
    const plan = prepareFileWritePlan({
      bytes: Uint8Array.of(2),
      operationTimestamp,
      position: first.inode.fileSize,
      source: first.inode,
    });
    if (plan === null || plan.action !== "copy_on_write_extent_range") throw new Error("expected tail extent write plan");
    const staged = await batch.stage({ plan, port: memory.port, source: first.inode });

    memory.pagePort.failNextWrite = true;
    await expect(batch.flush({
      limits: { maximumExtentMutationsPerBatch: 2 },
      pageStore: memory.extentPageStore,
      source: staged,
    })).rejects.toThrow("injected File Extent page write failure");
    await expect(batch.flush({
      limits: { maximumExtentMutationsPerBatch: 2 },
      pageStore: memory.extentPageStore,
      source: staged,
    })).rejects.toThrow("batch is closed");
  });

  it("drops the append-tail witness before a non-tail overwrite", async () => {
    const memory = new MemoryContentPort();
    const inlineLimit = HIZOFS_V1_FORMAT_CONSTANTS.limits.inlineFileBytes;
    const source = fileInode({ content: { bytes: new Uint8Array(), type: "inline" } });
    const firstPlan = prepareFileWritePlan({
      bytes: new Uint8Array(inlineLimit + 1).fill(3),
      operationTimestamp,
      position: createFileOffset({ value: 0n }),
      source,
    });
    if (firstPlan === null) throw new Error("expected first write plan");
    const first = await prepareFileWriteMutationWithAppendTailWitness({
      appendTailWitness: undefined,
      limits: { maximumExtentMutationsPerBatch: 128 },
      plan: firstPlan,
      port: memory.port,
      source,
    });
    const overwritePlan = prepareFileWritePlan({
      bytes: new Uint8Array(3).fill(8),
      operationTimestamp,
      position: createFileOffset({ value: 1n }),
      source: first.inode,
    });
    if (overwritePlan === null) throw new Error("expected overwrite plan");
    const overwritten = await prepareFileWriteMutationWithAppendTailWitness({
      appendTailWitness: first.appendTailWitness,
      limits: { maximumExtentMutationsPerBatch: 128 },
      plan: overwritePlan,
      port: memory.port,
      source: first.inode,
    });
    expect(overwritten.appendTailWitness).toBeUndefined();
  });

  it("trims all extents after the new size in bounded batches", async () => {
    const memory = new MemoryContentPort();
    const root = reference({
      kind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_extent_page,
      offset: 4_000n,
    });
    memory.pagePort.pages.set(identity({ value: root }), {
      entries: [
        extent({ byteLength: 10, fileOffset: 0n, seed: 4_096n }),
        extent({ byteLength: 10, fileOffset: 20n, seed: 4_224n }),
        extent({ byteLength: 5, fileOffset: 40n, seed: 4_352n }),
      ],
      level: 0,
      type: "leaf",
    });
    const source = fileInode({
      content: { extentTreeRootHomeRef: root, type: "tree" },
      fileSize: 45n,
    });
    const plan = prepareFileTruncatePlan({
      operationTimestamp,
      source,
      targetFileSize: createFileOffset({ value: 22n }),
    });
    if (plan === null) throw new Error("expected truncate plan");

    const inode = await prepareFileTruncateMutation({ limits, plan, port: memory.port, source });
    if (inode.content.type !== "tree") throw new Error("expected extent-backed inode");
    const result = await entries({ port: memory, root: inode.content.extentTreeRootHomeRef });

    expect(result.map(entry => [entry.fileOffset, entry.byteLength])).toEqual([[0n, 10], [20n, 2]]);
    expect(inode.fileSize).toBe(22n);
  });

  it("extends an extent-backed file by changing only logical size", async () => {
    const memory = new MemoryContentPort();
    const root = reference({
      kind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_extent_page,
      offset: 5_000n,
    });
    memory.pagePort.pages.set(identity({ value: root }), {
      entries: [extent({ byteLength: 4, fileOffset: 0n, seed: 5_120n })],
      level: 0,
      type: "leaf",
    });
    const source = fileInode({
      content: { extentTreeRootHomeRef: root, type: "tree" },
      fileSize: 4n,
    });
    const plan = prepareFileTruncatePlan({
      operationTimestamp,
      source,
      targetFileSize: createFileOffset({ value: 100n }),
    });
    if (plan === null) throw new Error("expected truncate plan");

    const inode = await prepareFileTruncateMutation({ limits, plan, port: memory.port, source });
    expect(inode.content).toEqual({ extentTreeRootHomeRef: root, type: "tree" });
    expect(inode.fileSize).toBe(100n);
    expect(memory.data.size).toBe(0);
  });

  it("rejects a plan captured from a different inode revision", async () => {
    const memory = new MemoryContentPort();
    const source = fileInode({ content: { bytes: new Uint8Array(), type: "inline" } });
    const plan = prepareFileWritePlan({
      bytes: Uint8Array.of(1),
      operationTimestamp,
      position: createFileOffset({ value: 0n }),
      source,
    });
    if (plan === null) throw new Error("expected write plan");

    await expect(prepareFileWriteMutation({
      limits,
      plan,
      port: memory.port,
      source: fileInode({ content: { bytes: new Uint8Array(), type: "inline" }, revision: 2n }),
    })).rejects.toThrow("captured inode revision");
  });
});

export const TEST_ONLY = {};
