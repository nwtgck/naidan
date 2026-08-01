import {
  HizoFSTransitionImportJournal,
  type HizoFSTransitionImportJournalBinding,
} from "@/00-storage/service/hizofs/api";
import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createHomeRecordReference,
  createInodeNumber,
  createInodeRevision,
  createUInt64,
  parseFileSystemId,
  parseSegmentId,
} from "@/00-storage/service/hizofs/00-format";
import type { StreamingNamespaceImportCheckpoint } from "@/00-storage/service/hizofs/filesystem/bulk/streaming-namespace-import";
import { parseTransitionOperationId } from "@/00-storage/service/naidan-persistence-control/00-format";
import type {
  AuthenticatedTransitionProgressBinding,
  AuthenticatedTransitionProgressSnapshot,
} from "@/00-storage/service/naidan-persistence-control/transition/authenticated-transition-progress-companion";
import { createTransitionNamespaceCopyCursor } from "@/00-storage/service/naidan-persistence-control/transition/namespace-copy";
import type { TransitionRuntimeProgress } from "@/00-storage/service/naidan-persistence-control/transition/transition-coordinator";
import { HizoFSTransitionProgressBridge } from "@/00-storage/service/naidan-opfs/hizofs-transition-progress-bridge";
import { describe, expect, it, vi } from "vitest";

const operationId = parseTransitionOperationId({ value: "operation000000000001" });
const targetFileSystemId = parseFileSystemId({ value: "abcdefghijklmnopqrstu" });
const binding: AuthenticatedTransitionProgressBinding = {
  operationId,
  providerCheckpointCodec: "hizofs-streaming-namespace-import-v1",
  sourceAuthorityIdentity: "plain-authority-1",
  sourceEndpoint: { type: "plain" },
  targetAuthorityIdentity: "hizofs-candidate-1",
  targetEndpoint: { fileSystemId: targetFileSystemId, type: "hizofs" },
};

function checkpoint(): StreamingNamespaceImportCheckpoint {
  const rootReference = createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: 128n }),
    frameLength: 96,
    recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
    segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(7) }),
  } });
  return {
    activeFile: undefined,
    directories: [{
      directory: {
        content: { entries: [], type: "inline" },
        inodeNumber: createInodeNumber({ value: 1n }),
        inodeRevision: createInodeRevision({ value: 1n }),
        previousName: undefined,
        timestamps: { createdAt: null, modifiedAt: null },
      },
      path: [],
    }],
    nextInodeNumber: createInodeNumber({ value: 2n }),
    rootDirectoryInodeNumber: createInodeNumber({ value: 1n }),
    rootInodeTableRootHomeRef: rootReference,
  };
}

function progress(): TransitionRuntimeProgress {
  return {
    copyCursor: createTransitionNamespaceCopyCursor(),
    operationId,
    source: { type: "plain" },
    sourceAuthorityIdentity: binding.sourceAuthorityIdentity,
    stage: "copying",
    target: binding.targetEndpoint,
  };
}

class MemoryCompanion {
  snapshot: AuthenticatedTransitionProgressSnapshot | undefined;
  readonly publish = vi.fn(async ({ expectedJournalGeneration, progress: next }: {
    expectedJournalGeneration: bigint | undefined;
    progress: AuthenticatedTransitionProgressSnapshot;
  }) => {
    if (this.snapshot?.journalGeneration !== expectedJournalGeneration) throw new Error("companion CAS conflict");
    this.snapshot = structuredClone(next);
    return structuredClone(next);
  });
  readonly load = vi.fn(async () => structuredClone(this.snapshot));
  readonly clear = vi.fn(async ({ expectedJournalGeneration }: { expectedJournalGeneration: bigint }) => {
    if (this.snapshot?.journalGeneration !== expectedJournalGeneration) throw new Error("companion clear conflict");
    this.snapshot = undefined;
  });
}

function journalBinding(): HizoFSTransitionImportJournalBinding {
  return {
    operationIdentity: operationId,
    sourceAuthorityIdentity: binding.sourceAuthorityIdentity,
    sourceEndpointIdentity: "{\"type\":\"plain\"}",
    targetAuthorityIdentity: binding.targetAuthorityIdentity,
    targetEndpointIdentity: `{"type":"hizofs","fileSystemId":"${targetFileSystemId}"}`,
  };
}

describe("HizoFS transition-progress bridge", () => {
  it("publishes portable progress and a staged provider checkpoint as one generation", async () => {
    const companion = new MemoryCompanion();
    const bridge = new HizoFSTransitionProgressBridge({ binding, companion });
    const opened = await HizoFSTransitionImportJournal.open({
      binding: journalBinding(),
      port: bridge.providerJournalPort,
    });

    await opened.journal.saveActive({ checkpoint: checkpoint() });
    expect(companion.publish).not.toHaveBeenCalled();
    await bridge.progressPort.save({ progress: progress() });

    expect(companion.publish).toHaveBeenCalledTimes(1);
    expect(companion.snapshot?.journalGeneration).toBe(0n);
    const resumed = new HizoFSTransitionProgressBridge({ binding, companion });
    await expect(resumed.progressPort.load({ operationId })).resolves.toEqual(progress());
    const reopened = await HizoFSTransitionImportJournal.open({
      binding: journalBinding(),
      port: resumed.providerJournalPort,
    });
    expect(reopened.candidate?.type).toBe("active");
  });

  it("does not persist a provider checkpoint if the process stops before portable progress publication", async () => {
    const companion = new MemoryCompanion();
    const bridge = new HizoFSTransitionProgressBridge({ binding, companion });
    const opened = await HizoFSTransitionImportJournal.open({
      binding: journalBinding(),
      port: bridge.providerJournalPort,
    });
    await opened.journal.saveActive({ checkpoint: checkpoint() });

    const restarted = new HizoFSTransitionProgressBridge({ binding, companion });
    await expect(restarted.progressPort.load({ operationId })).resolves.toBeUndefined();
    const journal = await HizoFSTransitionImportJournal.open({
      binding: journalBinding(),
      port: restarted.providerJournalPort,
    });
    expect(journal.candidate).toBeUndefined();
  });

  it("advances portable verification progress without changing the sealed candidate", async () => {
    const companion = new MemoryCompanion();
    const bridge = new HizoFSTransitionProgressBridge({ binding, companion });
    const opened = await HizoFSTransitionImportJournal.open({
      binding: journalBinding(),
      port: bridge.providerJournalPort,
    });
    await opened.journal.saveSealed({ sealed: {
      nextInodeNumber: createInodeNumber({ value: 2n }),
      rootDirectoryInodeNumber: createInodeNumber({ value: 1n }),
      rootInodeTableRootHomeRef: checkpoint().rootInodeTableRootHomeRef,
    } });
    await bridge.progressPort.save({ progress: progress() });

    const resumed = new HizoFSTransitionProgressBridge({ binding, companion });
    const loadedJournal = await HizoFSTransitionImportJournal.open({
      binding: journalBinding(),
      port: resumed.providerJournalPort,
    });
    expect(loadedJournal.candidate?.type).toBe("sealed");
    const nextProgress = { ...progress(), copyCursor: { ...createTransitionNamespaceCopyCursor(), completedEntries: 1n } };
    await resumed.progressPort.save({ progress: nextProgress });
    expect(companion.snapshot?.journalGeneration).toBe(1n);

    const secondResume = new HizoFSTransitionProgressBridge({ binding, companion });
    const stillSealed = await HizoFSTransitionImportJournal.open({
      binding: journalBinding(),
      port: secondResume.providerJournalPort,
    });
    expect(stillSealed.candidate?.type).toBe("sealed");
  });

  it("rejects portable progress before any provider checkpoint is staged", async () => {
    const companion = new MemoryCompanion();
    const bridge = new HizoFSTransitionProgressBridge({ binding, companion });
    await expect(bridge.progressPort.save({ progress: progress() }))
      .rejects.toThrow("before the target checkpoint is staged");
  });

  it("clears only the exact authenticated companion generation", async () => {
    const companion = new MemoryCompanion();
    const bridge = new HizoFSTransitionProgressBridge({ binding, companion });
    const opened = await HizoFSTransitionImportJournal.open({
      binding: journalBinding(),
      port: bridge.providerJournalPort,
    });
    await opened.journal.saveActive({ checkpoint: checkpoint() });
    await bridge.progressPort.save({ progress: progress() });
    await bridge.progressPort.clear({ operationId });
    expect(companion.snapshot).toBeUndefined();
    expect(companion.clear).toHaveBeenCalledWith({ expectedJournalGeneration: 0n });
  });
});
