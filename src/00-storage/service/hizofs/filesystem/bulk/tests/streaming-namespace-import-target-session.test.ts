import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createHomeRecordReference,
  createInodeNumber,
  createInodeRevision,
  createTimestampMilliseconds,
  createUInt64,
  parseSegmentId,
  encodeHomeRecordReference,
  type HomeRecordReference,
} from "@/00-storage/service/hizofs/00-format";
import {
  StreamingNamespaceImportTargetSession,
} from "@/00-storage/service/hizofs/filesystem/bulk/streaming-namespace-import-target-session";
import type {
  SealedStreamingNamespaceImport,
  StreamingNamespaceImportCheckpoint,
} from "@/00-storage/service/hizofs/filesystem/bulk/streaming-namespace-import";
import type {
  StreamingNamespaceImportRuntimeCandidate,
  StreamingNamespaceImportRuntimeStatePort,
} from "@/00-storage/service/hizofs/filesystem/bulk/streaming-namespace-import-runtime-state";
import { describe, expect, it, vi } from "vitest";

function homeReference({ offset }: { offset: bigint }): HomeRecordReference {
  return createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: offset }),
    frameLength: 96,
    recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
    segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(Number(offset % 251n) + 1) }),
  } });
}

const operationIdentity = "operation-a";

const checkpoint = (): StreamingNamespaceImportCheckpoint => ({
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
  rootInodeTableRootHomeRef: homeReference({ offset: 128n }),
});

const sealed = (): SealedStreamingNamespaceImport => ({
  nextInodeNumber: createInodeNumber({ value: 3n }),
  rootDirectoryInodeNumber: createInodeNumber({ value: 1n }),
  rootInodeTableRootHomeRef: homeReference({ offset: 256n }),
});

class MemoryPort implements StreamingNamespaceImportRuntimeStatePort {
  candidate: StreamingNamespaceImportRuntimeCandidate | undefined;

  async loadCandidate({ operationIdentity: requestedOperation }: {
    operationIdentity: string;
  }): Promise<StreamingNamespaceImportRuntimeCandidate | undefined> {
    if (requestedOperation !== operationIdentity) throw new Error("runtime state belongs to another operation");
    return structuredClone(this.candidate);
  }

  async stageCandidate({ candidate, operationIdentity: requestedOperation }: {
    candidate: StreamingNamespaceImportRuntimeCandidate;
    operationIdentity: string;
  }): Promise<void> {
    if (requestedOperation !== operationIdentity) throw new Error("runtime state belongs to another operation");
    this.candidate = structuredClone(candidate);
  }
}

function actor({ activeCheckpoint = checkpoint(), sealedCandidate = sealed() }: {
  activeCheckpoint?: StreamingNamespaceImportCheckpoint;
  sealedCandidate?: SealedStreamingNamespaceImport;
} = {}) {
  return {
    checkpoint: vi.fn(async () => structuredClone(activeCheckpoint)),
    ensureDirectory: vi.fn(async () => undefined),
    finalize: vi.fn(async () => structuredClone(sealedCandidate)),
    finalizeFile: vi.fn(async () => undefined),
    writeFileChunk: vi.fn(async () => undefined),
    writeSymlink: vi.fn(async () => undefined),
  };
}

describe("StreamingNamespaceImportTargetSession", () => {
  it("maps exact metadata, checkpoints an active slice, and restores it", async () => {
    const port = new MemoryPort();
    const firstActor = actor();
    const session = await StreamingNamespaceImportTargetSession.open({
      createImport: () => firstActor,
      operationIdentity,
      restoreImport: () => {
        throw new Error("unexpected restore");
      },
      runtimeStatePort: port,
    });
    await session.target.setRootMetadata({ metadata: { createdAt: undefined, modifiedAt: undefined } });
    await session.target.ensureDirectory({
      metadata: { createdAt: 10n, modifiedAt: undefined },
      path: ["nested"],
    });
    await session.target.writeFileChunk({ bytes: Uint8Array.of(1, 2), offset: 0n, path: ["file"] });
    await session.target.finalizeFile({
      metadata: { createdAt: undefined, modifiedAt: 20n },
      path: ["file"],
      size: 2n,
    });
    await session.target.writeSymlink({
      metadata: { createdAt: undefined, modifiedAt: undefined },
      path: ["link"],
      target: "file",
    });
    await session.close();

    expect(firstActor.ensureDirectory).toHaveBeenCalledWith({
      path: ["nested"],
      timestamps: { createdAt: createTimestampMilliseconds({ value: 10n }), modifiedAt: null },
    });
    expect(firstActor.finalizeFile).toHaveBeenCalledWith({
      path: ["file"],
      size: 2n,
      timestamps: { createdAt: null, modifiedAt: createTimestampMilliseconds({ value: 20n }) },
    });
    expect(port.candidate?.type).toBe("active");

    const restoredActor = actor();
    let restoredCheckpoint: StreamingNamespaceImportCheckpoint | undefined;
    const restoreImport = vi.fn(({ checkpoint: value }: { checkpoint: StreamingNamespaceImportCheckpoint }) => {
      restoredCheckpoint = value;
      return restoredActor;
    });
    const reopened = await StreamingNamespaceImportTargetSession.open({
      createImport: () => {
        throw new Error("unexpected create");
      },
      operationIdentity,
      restoreImport,
      runtimeStatePort: port,
    });
    expect(restoreImport).toHaveBeenCalledTimes(1);
    expect(restoredCheckpoint?.nextInodeNumber).toBe(checkpoint().nextInodeNumber);
    expect(restoredCheckpoint?.directories).toHaveLength(1);
    expect(encodeHomeRecordReference({ reference: restoredCheckpoint?.rootInodeTableRootHomeRef as HomeRecordReference }))
      .toEqual(encodeHomeRecordReference({ reference: checkpoint().rootInodeTableRootHomeRef }));
    await reopened.close();
  });

  it("seals once, stages the private root, and reopens without recreating an importer", async () => {
    const port = new MemoryPort();
    const firstActor = actor();
    const session = await StreamingNamespaceImportTargetSession.open({
      createImport: () => firstActor,
      operationIdentity,
      restoreImport: () => {
        throw new Error("unexpected restore");
      },
      runtimeStatePort: port,
    });
    await session.target.setRootMetadata({ metadata: { createdAt: undefined, modifiedAt: undefined } });
    await session.target.completeNamespace();
    await session.target.completeNamespace();
    expect(firstActor.finalize).toHaveBeenCalledTimes(1);
    const firstSealed = session.sealedCandidate();
    expect(firstSealed.nextInodeNumber).toBe(sealed().nextInodeNumber);
    expect(encodeHomeRecordReference({ reference: firstSealed.rootInodeTableRootHomeRef }))
      .toEqual(encodeHomeRecordReference({ reference: sealed().rootInodeTableRootHomeRef }));
    expect(port.candidate?.type).toBe("sealed");
    await session.close();

    const createImport = vi.fn(() => actor());
    const restoreImport = vi.fn(() => actor());
    const reopened = await StreamingNamespaceImportTargetSession.open({
      createImport,
      operationIdentity,
      restoreImport,
      runtimeStatePort: port,
    });
    expect(createImport).not.toHaveBeenCalled();
    expect(restoreImport).not.toHaveBeenCalled();
    const reopenedSealed = reopened.sealedCandidate();
    expect(reopenedSealed.rootDirectoryInodeNumber).toBe(sealed().rootDirectoryInodeNumber);
    expect(encodeHomeRecordReference({ reference: reopenedSealed.rootInodeTableRootHomeRef }))
      .toEqual(encodeHomeRecordReference({ reference: sealed().rootInodeTableRootHomeRef }));
    await expect(reopened.target.ensureDirectory({
      metadata: { createdAt: undefined, modifiedAt: undefined },
      path: ["late"],
    })).rejects.toMatchObject({ code: "candidate_already_sealed" });
  });


  it("retries sealing after a candidate staging failure without finalizing twice", async () => {
    class FailBeforeCommitPort extends MemoryPort {
      failNextPublish = true;

      override async stageCandidate({ candidate, operationIdentity: requestedOperation }: {
        candidate: StreamingNamespaceImportRuntimeCandidate;
        operationIdentity: string;
      }): Promise<void> {
        if (this.failNextPublish) {
          this.failNextPublish = false;
          throw new Error("injected runtime staging failure");
        }
        await super.stageCandidate({ candidate, operationIdentity: requestedOperation });
      }
    }

    const port = new FailBeforeCommitPort();
    const firstActor = actor();
    const session = await StreamingNamespaceImportTargetSession.open({
      createImport: () => firstActor,
      operationIdentity,
      restoreImport: () => {
        throw new Error("unexpected restore");
      },
      runtimeStatePort: port,
    });
    await session.target.setRootMetadata({ metadata: { createdAt: undefined, modifiedAt: undefined } });

    await expect(session.target.completeNamespace()).rejects.toThrow("injected runtime staging failure");
    await session.target.completeNamespace();

    expect(firstActor.finalize).toHaveBeenCalledTimes(1);
    expect(port.candidate?.type).toBe("sealed");
  });

  it("requires one exact root metadata handshake and rejects changes after initialization", async () => {
    const port = new MemoryPort();
    const firstActor = actor();
    const createImport = vi.fn(() => firstActor);
    const session = await StreamingNamespaceImportTargetSession.open({
      createImport,
      operationIdentity,
      restoreImport: () => {
        throw new Error("unexpected restore");
      },
      runtimeStatePort: port,
    });

    await expect(session.target.ensureDirectory({
      metadata: { createdAt: undefined, modifiedAt: undefined },
      path: ["early"],
    })).rejects.toMatchObject({ code: "root_metadata_required" });

    await session.target.setRootMetadata({ metadata: { createdAt: 10n, modifiedAt: undefined } });
    await session.target.setRootMetadata({ metadata: { createdAt: 10n, modifiedAt: undefined } });
    expect(createImport).toHaveBeenCalledTimes(1);
    expect(createImport).toHaveBeenCalledWith({ rootMetadata: { createdAt: 10n, modifiedAt: undefined } });

    await expect(session.target.setRootMetadata({
      metadata: { createdAt: 11n, modifiedAt: undefined },
    })).rejects.toMatchObject({ code: "root_metadata_conflict" });
  });

  it("revokes an active session only after its checkpoint is staged", async () => {
    const port = new MemoryPort();
    const firstActor = actor();
    const session = await StreamingNamespaceImportTargetSession.open({
      createImport: () => firstActor,
      operationIdentity,
      restoreImport: () => {
        throw new Error("unexpected restore");
      },
      runtimeStatePort: port,
    });
    await session.target.setRootMetadata({ metadata: { createdAt: undefined, modifiedAt: undefined } });
    await session.close();
    await session.close();
    await expect(session.target.writeFileChunk({
      bytes: Uint8Array.of(1),
      offset: 0n,
      path: ["late"],
    })).rejects.toMatchObject({ code: "already_closed" });
    expect(firstActor.checkpoint).toHaveBeenCalledTimes(1);
  });
});
