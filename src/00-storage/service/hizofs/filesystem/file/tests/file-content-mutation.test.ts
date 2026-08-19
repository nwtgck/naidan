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
  PreparedFileExtentRangeWriteBatch,
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
      staged = batch.stage({
        limits: { maximumExtentMutationsPerBatch: 64 },
        plan,
        source: staged,
      });
    }

    expect(memory.pagePort.writeCount).toBe(writesBeforeBatch);
    expect(memory.data.size).toBe(1);
    const flushed = await batch.flush({
      limits: { maximumExtentMutationsPerBatch: 64 },
      port: memory.port,
      source: staged,
    });
    expect(memory.pagePort.writeCount).toBe(writesBeforeBatch + 1);
    expect(memory.data.size).toBe(2);
    if (flushed.inode.content.type !== "tree") throw new Error("expected extent-backed inode");
    const result = await entries({ port: memory, root: flushed.inode.content.extentTreeRootHomeRef });
    expect(result).toHaveLength(4);
    expect(result.map(entry => ({
      byteLength: entry.byteLength,
      dataOffset: entry.dataOffset,
      fileOffset: entry.fileOffset,
    }))).toEqual([
      { byteLength: inlineLimit + 1, dataOffset: 0, fileOffset: 0n },
      { byteLength: 7, dataOffset: 0, fileOffset: BigInt(inlineLimit + 1) },
      { byteLength: 7, dataOffset: 7, fileOffset: BigInt(inlineLimit + 8) },
      { byteLength: 7, dataOffset: 14, fileOffset: BigInt(inlineLimit + 15) },
    ]);
  });

  it("coalesces bounded non-tail writes into shared File Data Records while preserving write order", async () => {
    const memory = new MemoryContentPort();
    const root = reference({
      kind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_extent_page,
      offset: 1_704n,
    });
    memory.pagePort.pages.set(identity({ value: root }), {
      entries: [extent({ byteLength: 100, fileOffset: 0n, seed: 2_704n })],
      level: 0,
      type: "leaf",
    });
    let staged = fileInode({
      content: { extentTreeRootHomeRef: root, type: "tree" },
      fileSize: 100n,
    });
    const batch = PreparedFileExtentRangeWriteBatch.create({ source: staged });
    for (const [position, value] of [[10n, 0x31], [30n, 0x42]] as const) {
      const plan = prepareFileWritePlan({
        bytes: new Uint8Array(4).fill(value),
        operationTimestamp,
        position: createFileOffset({ value: position }),
        source: staged,
      });
      if (plan === null || plan.action !== "copy_on_write_extent_range") throw new Error("expected extent range plan");
      expect(batch.canStage({
        byteLength: plan.writeBytes.byteLength,
        limits: { maximumExtentMutationsPerBatch: 64 },
        source: staged,
        writeOffset: plan.writeOffset,
      })).toBe(true);
      staged = batch.stage({
        limits: { maximumExtentMutationsPerBatch: 64 },
        plan,
        source: staged,
      });
    }

    expect(memory.data.size).toBe(0);
    const flushed = await batch.flush({
      limits: { maximumExtentMutationsPerBatch: 64 },
      port: memory.port,
      source: staged,
    });
    expect(memory.data.size).toBe(1);
    expect(memory.pagePort.writeCount).toBe(1);
    if (flushed.content.type !== "tree") throw new Error("expected extent-backed inode");
    const result = await entries({ port: memory, root: flushed.content.extentTreeRootHomeRef });
    const written = result.filter(entry => entry.fileDataHomeRef.byteOffset >= 50_000n);
    expect(written).toHaveLength(2);
    expect(written.map(entry => ({
      byteLength: entry.byteLength,
      dataOffset: entry.dataOffset,
      fileOffset: entry.fileOffset,
    }))).toEqual([
      { byteLength: 4, dataOffset: 0, fileOffset: 10n },
      { byteLength: 4, dataOffset: 4, fileOffset: 30n },
    ]);
    expect(written[0]?.fileDataHomeRef).toEqual(written[1]?.fileDataHomeRef);
  });

  it("falls back to bounded sequential extent updates when sparse capture exceeds its limit", async () => {
    const memory = new MemoryContentPort();
    const root = reference({
      kind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_extent_page,
      offset: 1_720n,
    });
    memory.pagePort.pages.set(identity({ value: root }), {
      entries: [
        extent({ byteLength: 4, fileOffset: 0n, seed: 2_720n }),
        extent({ byteLength: 4, fileOffset: 4n, seed: 2_848n }),
        extent({ byteLength: 4, fileOffset: 8n, seed: 2_976n }),
        extent({ byteLength: 4, fileOffset: 20n, seed: 3_104n }),
        extent({ byteLength: 4, fileOffset: 24n, seed: 3_232n }),
        extent({ byteLength: 4, fileOffset: 28n, seed: 3_360n }),
      ],
      level: 0,
      type: "leaf",
    });
    let staged = fileInode({
      content: { extentTreeRootHomeRef: root, type: "tree" },
      fileSize: 40n,
    });
    const batch = PreparedFileExtentRangeWriteBatch.create({ source: staged });
    for (const [position, value] of [[0n, 0x31], [20n, 0x42]] as const) {
      const plan = prepareFileWritePlan({
        bytes: new Uint8Array(12).fill(value),
        operationTimestamp,
        position: createFileOffset({ value: position }),
        source: staged,
      });
      if (plan === null || plan.action !== "copy_on_write_extent_range") throw new Error("expected extent range plan");
      staged = batch.stage({ limits: { maximumExtentMutationsPerBatch: 2 }, plan, source: staged });
    }

    const flushed = await batch.flush({
      limits: { maximumExtentMutationsPerBatch: 2 },
      port: memory.port,
      source: staged,
    });
    expect(memory.pagePort.writeCount).toBeGreaterThan(1);
    if (flushed.content.type !== "tree") throw new Error("expected extent-backed inode");
    const result = await entries({ port: memory, root: flushed.content.extentTreeRootHomeRef });
    const written = result.filter(entry => entry.fileDataHomeRef.byteOffset >= 50_000n);
    expect(written.map(entry => [entry.fileOffset, entry.byteLength])).toEqual([[0n, 12], [20n, 12]]);
  });

  it("preserves last-write-wins for overlapping writes in one range-write batch", async () => {
    const memory = new MemoryContentPort();
    const root = reference({
      kind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_extent_page,
      offset: 1_720n,
    });
    memory.pagePort.pages.set(identity({ value: root }), {
      entries: [extent({ byteLength: 20, fileOffset: 0n, seed: 2_720n })],
      level: 0,
      type: "leaf",
    });
    let staged = fileInode({
      content: { extentTreeRootHomeRef: root, type: "tree" },
      fileSize: 20n,
    });
    const batch = PreparedFileExtentRangeWriteBatch.create({ source: staged });
    for (const [position, value] of [[4n, 0x31], [6n, 0x42]] as const) {
      const plan = prepareFileWritePlan({
        bytes: new Uint8Array(4).fill(value),
        operationTimestamp,
        position: createFileOffset({ value: position }),
        source: staged,
      });
      if (plan === null || plan.action !== "copy_on_write_extent_range") throw new Error("expected extent range plan");
      staged = batch.stage({ limits: { maximumExtentMutationsPerBatch: 64 }, plan, source: staged });
    }
    const flushed = await batch.flush({
      limits: { maximumExtentMutationsPerBatch: 64 },
      port: memory.port,
      source: staged,
    });
    expect(memory.pagePort.writeCount).toBe(1);
    if (flushed.content.type !== "tree") throw new Error("expected extent-backed inode");
    const result = await entries({ port: memory, root: flushed.content.extentTreeRootHomeRef });
    const written = result.filter(entry => entry.fileDataHomeRef.byteOffset >= 50_000n);
    expect(written.map(entry => ({
      byteLength: entry.byteLength,
      dataOffset: entry.dataOffset,
      fileOffset: entry.fileOffset,
    }))).toEqual([
      { byteLength: 2, dataOffset: 0, fileOffset: 4n },
      { byteLength: 4, dataOffset: 4, fileOffset: 6n },
    ]);
  });

  it("bounds and zeroizes owned non-tail plaintext when a range-write batch is discarded", async () => {
    const memory = new MemoryContentPort();
    const root = reference({
      kind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_extent_page,
      offset: 1_728n,
    });
    memory.pagePort.pages.set(identity({ value: root }), {
      entries: [extent({ byteLength: 20, fileOffset: 0n, seed: 2_728n })],
      level: 0,
      type: "leaf",
    });
    let staged = fileInode({
      content: { extentTreeRootHomeRef: root, type: "tree" },
      fileSize: 20n,
    });
    const batch = PreparedFileExtentRangeWriteBatch.create({ source: staged });
    const firstPlan = prepareFileWritePlan({
      bytes: new Uint8Array(4).fill(0x5a),
      operationTimestamp,
      position: createFileOffset({ value: 2n }),
      source: staged,
    });
    if (firstPlan === null || firstPlan.action !== "copy_on_write_extent_range") throw new Error("expected extent range plan");
    const owned = firstPlan.writeBytes;
    staged = batch.stage({ limits: { maximumExtentMutationsPerBatch: 1 }, plan: firstPlan, source: staged });
    expect(batch.canStage({
      byteLength: 1,
      limits: { maximumExtentMutationsPerBatch: 1 },
      source: staged,
      writeOffset: createFileOffset({ value: 3n }),
    })).toBe(false);
    batch.discard();
    expect(owned.every(byte => byte === 0)).toBe(true);
    await expect(batch.flush({
      limits: { maximumExtentMutationsPerBatch: 1 },
      port: memory.port,
      source: staged,
    })).rejects.toThrow("batch is closed");
  });

  it("does not absorb pure tail appends into the non-tail range-write batch", async () => {
    const memory = new MemoryContentPort();
    const root = reference({
      kind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_extent_page,
      offset: 1_712n,
    });
    memory.pagePort.pages.set(identity({ value: root }), {
      entries: [extent({ byteLength: 100, fileOffset: 0n, seed: 2_712n })],
      level: 0,
      type: "leaf",
    });
    const source = fileInode({
      content: { extentTreeRootHomeRef: root, type: "tree" },
      fileSize: 100n,
    });
    const batch = PreparedFileExtentRangeWriteBatch.create({ source });
    expect(batch.canStage({
      byteLength: 4,
      limits: { maximumExtentMutationsPerBatch: 64 },
      source,
      writeOffset: source.fileSize,
    })).toBe(false);
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
    const maximumPayload = HIZOFS_V1_FORMAT_CONSTANTS.limits.fileDataPlaintextBytes;
    for (let index = 0; index < 2; index += 1) {
      const plan = prepareFileWritePlan({
        bytes: new Uint8Array(maximumPayload).fill(index + 2),
        operationTimestamp,
        position: staged.fileSize,
        source: staged,
      });
      if (plan === null || plan.action !== "copy_on_write_extent_range") throw new Error("expected tail extent write plan");
      staged = batch.stage({
        limits: { maximumExtentMutationsPerBatch: 2 },
        plan,
        source: staged,
      });
    }
    expect(batch.canStage({
      byteLength: 1,
      limits: { maximumExtentMutationsPerBatch: 2 },
      source: staged,
      writeOffset: staged.fileSize,
    })).toBe(false);

    await batch.flush({
      limits: { maximumExtentMutationsPerBatch: 2 },
      port: memory.port,
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
      port: memory.port,
      source: staged,
    })).rejects.toThrow("batch is closed");
  });

  it("zeroizes owned tail plaintext when the prepared batch is discarded", async () => {
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
      limits: { maximumExtentMutationsPerBatch: 64 },
      plan: firstPlan,
      port: memory.port,
      source,
    });
    if (first.appendTailWitness === undefined) throw new Error("expected append-tail witness");
    const batch = PreparedFileExtentTailAppendBatch.create({ source: first.inode, witness: first.appendTailWitness });
    const plan = prepareFileWritePlan({
      bytes: new Uint8Array(32).fill(0x5a),
      operationTimestamp,
      position: first.inode.fileSize,
      source: first.inode,
    });
    if (plan === null || plan.action !== "copy_on_write_extent_range") throw new Error("expected tail extent write plan");
    const ownedWriteBytes = plan.writeBytes;
    batch.stage({
      limits: { maximumExtentMutationsPerBatch: 64 },
      plan,
      source: first.inode,
    });

    expect(ownedWriteBytes.some(byte => byte !== 0)).toBe(true);
    batch.discard();
    expect(ownedWriteBytes.every(byte => byte === 0)).toBe(true);
    expect(batch.canStage({
      byteLength: 1,
      limits: { maximumExtentMutationsPerBatch: 64 },
      source: first.inode,
      writeOffset: first.inode.fileSize,
    })).toBe(false);
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
    const staged = batch.stage({
      limits: { maximumExtentMutationsPerBatch: 2 },
      plan,
      source: first.inode,
    });

    memory.pagePort.failNextWrite = true;
    await expect(batch.flush({
      limits: { maximumExtentMutationsPerBatch: 2 },
      port: memory.port,
      source: staged,
    })).rejects.toThrow("injected File Extent page write failure");
    await expect(batch.flush({
      limits: { maximumExtentMutationsPerBatch: 2 },
      port: memory.port,
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

  it("truncates an extent-backed file to zero without traversing the old extent tree", async () => {
    const memory = new MemoryContentPort();
    const root = reference({
      kind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_extent_page,
      offset: 3_872n,
    });
    memory.pagePort.pages.set(identity({ value: root }), {
      entries: [
        extent({ byteLength: 10, fileOffset: 0n, seed: 4_000n }),
        extent({ byteLength: 10, fileOffset: 20n, seed: 4_128n }),
        extent({ byteLength: 5, fileOffset: 40n, seed: 4_256n }),
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
      targetFileSize: createFileOffset({ value: 0n }),
    });
    if (plan === null) throw new Error("expected truncate plan");

    const inode = await prepareFileTruncateMutation({ limits, plan, port: memory.port, source });
    expect(memory.pagePort.readCount).toBe(0);
    expect(memory.pagePort.writeCount).toBe(1);
    if (inode.content.type !== "tree") throw new Error("expected extent-backed inode");
    expect(await entries({ port: memory, root: inode.content.extentTreeRootHomeRef })).toEqual([]);
    expect(inode.fileSize).toBe(0n);
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
