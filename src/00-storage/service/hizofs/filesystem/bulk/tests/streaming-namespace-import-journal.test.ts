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
  type HomeRecordReference,
} from "@/00-storage/service/hizofs/00-format";
import {
  StreamingNamespaceImportJournal,
  StreamingNamespaceImportJournalError,
  type StreamingNamespaceImportJournalBinding,
  type StreamingNamespaceImportJournalPort,
  type StreamingNamespaceImportJournalRecord,
} from "@/00-storage/service/hizofs/filesystem/bulk/streaming-namespace-import-journal";
import type {
  SealedStreamingNamespaceImport,
  StreamingNamespaceImportCheckpoint,
} from "@/00-storage/service/hizofs/filesystem/bulk/streaming-namespace-import";
import { describe, expect, it } from "vitest";

function homeReference({ offset }: { offset: bigint }): HomeRecordReference {
  return createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: offset }),
    frameLength: 96,
    recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
    segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(Number(offset % 251n) + 1) }),
  } });
}

const binding = (operationIdentity = "operation-a"): StreamingNamespaceImportJournalBinding => ({
  operationIdentity,
  sourceAuthorityIdentity: "source-authority-a",
  sourceEndpointIdentity: "plain",
  targetAuthorityIdentity: "target-authority-a",
  targetEndpointIdentity: "hizofs-a",
});

const checkpoint = (): StreamingNamespaceImportCheckpoint => ({
  activeFile: {
    file: { extentRoot: homeReference({ offset: 256n }), nextOffset: createFileOffset({ value: 7n }) },
    inodeNumber: createInodeNumber({ value: 2n }),
    path: ["nested", "file.bin"],
  },
  directories: [{
    directory: {
      content: { entries: [], type: "inline" },
      inodeNumber: createInodeNumber({ value: 1n }),
      inodeRevision: createInodeRevision({ value: 1n }),
      previousName: undefined,
      timestamps: { createdAt: createTimestampMilliseconds({ value: 10n }), modifiedAt: null },
    },
    path: [],
  }],
  nextInodeNumber: createInodeNumber({ value: 3n }),
  rootDirectoryInodeNumber: createInodeNumber({ value: 1n }),
  rootInodeTableRootHomeRef: homeReference({ offset: 128n }),
});

const sealed = (): SealedStreamingNamespaceImport => ({
  nextInodeNumber: createInodeNumber({ value: 4n }),
  rootDirectoryInodeNumber: createInodeNumber({ value: 1n }),
  rootInodeTableRootHomeRef: homeReference({ offset: 512n }),
});

class MemoryPort implements StreamingNamespaceImportJournalPort {
  readonly records = new Map<string, StreamingNamespaceImportJournalRecord>();
  failAfterClear = false;
  failAfterPublish = false;

  async clear({ binding: expectedBinding, expectedGeneration }: {
    binding: StreamingNamespaceImportJournalBinding;
    expectedGeneration: bigint;
  }): Promise<void> {
    const current = this.records.get(expectedBinding.operationIdentity);
    if (current === undefined || current.generation !== expectedGeneration
      || current.binding.targetAuthorityIdentity !== expectedBinding.targetAuthorityIdentity) {
      throw new Error("journal compare-and-swap conflict");
    }
    this.records.delete(expectedBinding.operationIdentity);
    if (this.failAfterClear) {
      this.failAfterClear = false;
      throw new Error("simulated response loss after journal clear");
    }
  }

  async load({ operationIdentity }: { operationIdentity: string }): Promise<StreamingNamespaceImportJournalRecord | undefined> {
    return this.records.get(operationIdentity);
  }

  async publish({ expectedGeneration, record }: {
    expectedGeneration: bigint | undefined;
    record: StreamingNamespaceImportJournalRecord;
  }): Promise<void> {
    const current = this.records.get(record.binding.operationIdentity);
    if (current?.generation !== expectedGeneration) throw new Error("journal compare-and-swap conflict");
    this.records.set(record.binding.operationIdentity, structuredClone(record));
    if (this.failAfterPublish) {
      this.failAfterPublish = false;
      throw new Error("simulated response loss after journal publish");
    }
  }
}

describe("StreamingNamespaceImportJournal", () => {
  it("saves and reopens an active checkpoint bound to the exact operation authorities and endpoints", async () => {
    const port = new MemoryPort();
    const opened = await StreamingNamespaceImportJournal.open({ binding: binding(), port });
    expect(opened.candidate).toBeUndefined();

    const source = checkpoint();
    await opened.journal.saveActive({ checkpoint: source });
    source.activeFile?.path.slice().push("mutated");

    const reopened = await StreamingNamespaceImportJournal.open({ binding: binding(), port });
    expect(reopened.candidate?.type).toBe("active");
    if (reopened.candidate?.type !== "active") throw new Error("expected active candidate");
    expect(reopened.candidate.checkpoint).not.toBe(source);
    expect(reopened.candidate.checkpoint.activeFile?.path).toEqual(["nested", "file.bin"]);
    expect(reopened.candidate.checkpoint.activeFile?.file.nextOffset).toBe(7n);
    expect(encodeHomeRecordReference({ reference: reopened.candidate.checkpoint.rootInodeTableRootHomeRef }))
      .toEqual(encodeHomeRecordReference({ reference: checkpoint().rootInodeTableRootHomeRef }));
    expect(port.records.get("operation-a")?.generation).toBe(0n);
  });

  it("persists the sealed private root as a distinct terminal candidate", async () => {
    const port = new MemoryPort();
    const opened = await StreamingNamespaceImportJournal.open({ binding: binding(), port });
    await opened.journal.saveSealed({ sealed: sealed() });
    const reopened = await StreamingNamespaceImportJournal.open({ binding: binding(), port });
    expect(reopened.candidate?.type).toBe("sealed");
    if (reopened.candidate?.type !== "sealed") throw new Error("expected sealed candidate");
    expect(reopened.candidate.sealed.nextInodeNumber).toBe(sealed().nextInodeNumber);
    expect(reopened.candidate.sealed.rootDirectoryInodeNumber).toBe(sealed().rootDirectoryInodeNumber);
    expect(encodeHomeRecordReference({ reference: reopened.candidate.sealed.rootInodeTableRootHomeRef }))
      .toEqual(encodeHomeRecordReference({ reference: sealed().rootInodeTableRootHomeRef }));
  });

  it("resolves publish and clear response loss by rereading the exact outcome", async () => {
    const port = new MemoryPort();
    const opened = await StreamingNamespaceImportJournal.open({ binding: binding(), port });
    port.failAfterPublish = true;
    await expect(opened.journal.saveActive({ checkpoint: checkpoint() })).resolves.toBeUndefined();
    expect(port.records.get("operation-a")?.generation).toBe(0n);
    port.failAfterClear = true;
    await expect(opened.journal.clear()).resolves.toBeUndefined();
    expect(port.records.size).toBe(0);
  });

  it("rejects endpoint or authority reuse under the same operation identity", async () => {
    const port = new MemoryPort();
    const opened = await StreamingNamespaceImportJournal.open({ binding: binding(), port });
    await opened.journal.saveActive({ checkpoint: checkpoint() });

    await expect(StreamingNamespaceImportJournal.open({
      binding: { ...binding(), targetAuthorityIdentity: "other-authority" },
      port,
    })).rejects.toMatchObject<Partial<StreamingNamespaceImportJournalError>>({ code: "binding_conflict" });
  });

  it("prevents stale owners from overwriting or clearing a newer checkpoint", async () => {
    const port = new MemoryPort();
    const first = await StreamingNamespaceImportJournal.open({ binding: binding(), port });
    await first.journal.saveActive({ checkpoint: checkpoint() });
    const stale = await StreamingNamespaceImportJournal.open({ binding: binding(), port });
    await first.journal.saveActive({ checkpoint: checkpoint() });

    await expect(stale.journal.saveSealed({ sealed: sealed() })).rejects.toThrow("compare-and-swap conflict");
    await expect(stale.journal.clear()).rejects.toThrow("compare-and-swap conflict");
  });

  it("clears only the exact current generation", async () => {
    const port = new MemoryPort();
    const opened = await StreamingNamespaceImportJournal.open({ binding: binding(), port });
    await opened.journal.saveActive({ checkpoint: checkpoint() });
    await opened.journal.clear();
    expect(await port.load({ operationIdentity: "operation-a" })).toBeUndefined();
    await opened.journal.clear();
  });

  it("rejects malformed journal records before restoring private state", async () => {
    const port = new MemoryPort();
    port.records.set("operation-a", {
      binding: binding(),
      candidate: { checkpoint: { ...checkpoint(), directories: [] }, type: "active" },
      generation: -1n,
      schemaVersion: 1,
    });
    await expect(StreamingNamespaceImportJournal.open({ binding: binding(), port }))
      .rejects.toMatchObject<Partial<StreamingNamespaceImportJournalError>>({ code: "invalid_record" });
  });

  it("rejects empty binding identities before reading storage", async () => {
    const port = new MemoryPort();
    await expect(StreamingNamespaceImportJournal.open({
      binding: { ...binding(), operationIdentity: "" },
      port,
    })).rejects.toMatchObject<Partial<StreamingNamespaceImportJournalError>>({ code: "invalid_binding" });
    expect(port.records.size).toBe(0);
  });
});
