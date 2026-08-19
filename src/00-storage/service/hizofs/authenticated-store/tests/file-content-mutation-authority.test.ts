import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createFeatureBits,
  createFileOffset,
  parseFileSystemId,
} from "@/00-storage/service/hizofs/00-format";
import {
  TEST_ONLY,
  createAuthenticatedFileContentMutationAuthority,
} from "@/00-storage/service/hizofs/authenticated-store/file-content-mutation-authority";
import { AuthenticatedSegmentWriterOwner } from "@/00-storage/service/hizofs/authenticated-store/active-segment-writer-owner";
import { readAuthenticatedDirectoryPage } from "@/00-storage/service/hizofs/authenticated-store/directory-page-store";
import { TEST_ONLY as FILE_DATA_APPEND_BATCH_TEST_ONLY } from "@/00-storage/service/hizofs/authenticated-store/file-data-append-batch";
import { readAuthenticatedFileData } from "@/00-storage/service/hizofs/authenticated-store/file-data-store";
import {
  appendAuthenticatedFileExtentPage,
  readAuthenticatedFileExtentPage,
} from "@/00-storage/service/hizofs/authenticated-store/file-extent-page-store";
import { createAuthenticatedSegmentWriter } from "@/00-storage/service/hizofs/authenticated-store/record-appender";
import type { AuthenticatedHizoFSPhysicalBytes } from "@/00-storage/service/hizofs/authenticated-store/physical-bytes";
import {
  generateFileSystemRootKey,
  type RandomByteSource,
} from "@/00-storage/service/hizofs/01-crypto";
import { InMemoryCrashDurabilityBackend } from "@/00-storage/service/hizofs/physical-store/testing/in-memory-crash-durability-backend";
import { describe, expect, it } from "vitest";

class CountingInMemoryBackend
  extends InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes> {
  public closeFileOperations = 0;
  public failNextSyncFileData: Error | undefined;
  public openFileForUpdateOperations = 0;
  public writeAtOperations = 0;

  public override async closeFile(
    input: Parameters<InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>["closeFile"]>[0],
  ): ReturnType<InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>["closeFile"]> {
    this.closeFileOperations += 1;
    return await super.closeFile(input);
  }

  public override async openFileForUpdate(
    input: Parameters<InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>["openFileForUpdate"]>[0],
  ): ReturnType<InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>["openFileForUpdate"]> {
    this.openFileForUpdateOperations += 1;
    return await super.openFileForUpdate(input);
  }

  public override async writeAt(
    input: Parameters<InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>["writeAt"]>[0],
  ): ReturnType<InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>["writeAt"]> {
    this.writeAtOperations += 1;
    return await super.writeAt(input);
  }

  public override async syncFileData(
    input: Parameters<InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>["syncFileData"]>[0],
  ): ReturnType<InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>["syncFileData"]> {
    const failure = this.failNextSyncFileData;
    if (failure !== undefined) {
      this.failNextSyncFileData = undefined;
      throw failure;
    }
    return await super.syncFileData(input);
  }
}

function deterministicRandomSource(): RandomByteSource {
  let next = 1;
  return ({ bytes }) => {
    for (let index = 0; index < bytes.byteLength; index += 1) {
      bytes[index] = next;
      next = next === 251 ? 1 : next + 1;
    }
  };
}

describe("authenticated file content mutation authority", () => {
  it("owns data and extent writers and closes them together", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const authority = await createAuthenticatedFileContentMutationAuthority({
      backend,
      fileSystemId,
      randomSource,
      relocationIndexRootPhysicalRef: null,
      rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    const directoryRoot = await authority.writeDirectoryPage({
      isRoot: true,
      page: { entries: [], level: 0, type: "leaf" },
    });
    await expect(authority.readDirectoryPage({ isRoot: true, reference: directoryRoot })).resolves.toEqual({
      entries: [],
      level: 0,
      type: "leaf",
    });
    const fileDataHomeRef = await authority.writeFileData({ bytes: Uint8Array.of(9, 8, 7) });
    const extentRoot = await authority.writeFileExtentPage({
      isRoot: true,
      page: {
        entries: [{
          byteLength: 3,
          dataOffset: 0,
          fileDataHomeRef,
          fileOffset: createFileOffset({ value: 100n }),
        }],
        level: 0,
        type: "leaf",
      },
    });
    expect(authority.resourceUsage()).toEqual({
      appendedMetadataFrameBytes: directoryRoot.frameLength + extentRoot.frameLength,
      unpublishedPhysicalBytes: directoryRoot.frameLength + extentRoot.frameLength + fileDataHomeRef.frameLength,
    });
    authority.abandon();

    expect(authority.state()).toBe("closed");
    // Reading a provisional metadata reference above flushes its bounded batch,
    // so that exact Directory page remains physically readable after abandon.
    await expect(readAuthenticatedDirectoryPage({
      backend,
      fileSystemId,
      homeReference: directoryRoot,
      isRoot: true,
      relocationIndexRootPhysicalRef: null,
      rootKey,
    })).resolves.toEqual({ entries: [], level: 0, type: "leaf" });
    await expect(readAuthenticatedFileData({
      backend,
      fileSystemId,
      homeReference: fileDataHomeRef,
      relocationIndexRootPhysicalRef: null,
      rootKey,
    })).resolves.toEqual(Uint8Array.of(9, 8, 7));
    await expect(readAuthenticatedFileExtentPage({
      backend,
      fileSystemId,
      homeReference: extentRoot,
      isRoot: true,
      relocationIndexRootPhysicalRef: null,
      rootKey,
    })).rejects.toThrow();
    await expect(authority.writeFileData({ bytes: Uint8Array.of(1) })).rejects.toThrow("closed");
    rootKey.destroy();
  });

  it("releases shared data and metadata writer leases before staged file acceptance becomes visible", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const writerOwner = new AuthenticatedSegmentWriterOwner({
      backend,
      fileSystemId,
      randomSource,
      rootKey,
      segmentClass: "metadata",
    });
    const dataWriterOwner = new AuthenticatedSegmentWriterOwner({
      backend,
      fileSystemId,
      randomSource,
      rootKey,
      segmentClass: "data",
    });
    const authority = await createAuthenticatedFileContentMutationAuthority({
      backend,
      dataWriterOwner,
      fileSystemId,
      randomSource,
      relocationIndexRootPhysicalRef: null,
      rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
      metadataWriterOwner: writerOwner,
    });

    expect(() => writerOwner.acquire()).toThrow("already has a lease");
    const beforeDataAppendLease = dataWriterOwner.acquire();
    beforeDataAppendLease.release({ disposition: "reuse" });
    await authority.writeFileData({ bytes: Uint8Array.of(5, 4, 3) });
    expect(() => dataWriterOwner.acquire()).toThrow("already has a lease");
    expect(() => authority.prepareWorkingAcceptanceWithoutCandidate()).toThrow(
      "provisional File Data Records are pending",
    );
    await authority.flushPendingFileDataRecords();
    authority.prepareWorkingAcceptanceWithoutCandidate();

    const publicationLease = writerOwner.acquire();
    publicationLease.release({ disposition: "reuse" });
    const nextDataLease = dataWriterOwner.acquire();
    nextDataLease.release({ disposition: "reuse" });
    expect(authority.state()).toBe("active");
    authority.completeWorkingAcceptanceWithoutCandidate();
    expect(authority.state()).toBe("closed");
    await expect(writerOwner.close()).resolves.toBeUndefined();
    await expect(dataWriterOwner.close()).resolves.toBeUndefined();
    rootKey.destroy();
  });

  it("keeps shared File Data writes provisional until the mutation is flushed or accepted", async () => {
    const backend = new CountingInMemoryBackend({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const dataWriterOwner = new AuthenticatedSegmentWriterOwner({
      backend,
      fileSystemId,
      randomSource,
      rootKey,
      segmentClass: "data",
    });
    const authority = await createAuthenticatedFileContentMutationAuthority({
      backend,
      dataWriterOwner,
      fileSystemId,
      randomSource,
      relocationIndexRootPhysicalRef: null,
      rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });

    const firstBytes = Uint8Array.of(1, 2, 3);
    const firstReference = await authority.writeFileData({ bytes: firstBytes });
    firstBytes.fill(99);
    const writesAfterFirstStage = backend.writeAtOperations;
    const secondReference = await authority.writeFileData({ bytes: Uint8Array.of(4, 5, 6) });
    const thirdReference = await authority.writeFileData({ bytes: Uint8Array.of(7, 8, 9) });

    expect(backend.writeAtOperations).toBe(writesAfterFirstStage);
    await authority.flushPendingFileDataRecords();
    expect(backend.writeAtOperations).toBe(writesAfterFirstStage + 1);
    for (const [reference, bytes] of [
      [firstReference, Uint8Array.of(1, 2, 3)],
      [secondReference, Uint8Array.of(4, 5, 6)],
      [thirdReference, Uint8Array.of(7, 8, 9)],
    ] as const) {
      await expect(readAuthenticatedFileData({
        backend,
        fileSystemId,
        homeReference: reference,
        relocationIndexRootPhysicalRef: null,
        rootKey,
      })).resolves.toEqual(bytes);
    }
    authority.abandon();
    await expect(dataWriterOwner.close()).resolves.toBeUndefined();
    rootKey.destroy();
  });

  it("discards unflushed shared File Data when a prepared mutation is abandoned", async () => {
    const backend = new CountingInMemoryBackend({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const dataWriterOwner = new AuthenticatedSegmentWriterOwner({
      backend,
      fileSystemId,
      randomSource,
      rootKey,
      segmentClass: "data",
    });
    const authority = await createAuthenticatedFileContentMutationAuthority({
      backend,
      dataWriterOwner,
      fileSystemId,
      randomSource,
      relocationIndexRootPhysicalRef: null,
      rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });

    const reference = await authority.writeFileData({ bytes: Uint8Array.of(1, 3, 5, 7) });
    const writesBeforeAbandon = backend.writeAtOperations;
    authority.abandon();
    expect(backend.writeAtOperations).toBe(writesBeforeAbandon);
    await expect(readAuthenticatedFileData({
      backend,
      fileSystemId,
      homeReference: reference,
      relocationIndexRootPhysicalRef: null,
      rootKey,
    })).rejects.toThrow();

    await expect(dataWriterOwner.close()).resolves.toBeUndefined();
    rootKey.destroy();
  });

  it("closes the mutation and releases its shared writer lease when File Data flush fails", async () => {
    const backend = new CountingInMemoryBackend({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const dataWriterOwner = new AuthenticatedSegmentWriterOwner({
      backend,
      fileSystemId,
      randomSource,
      rootKey,
      segmentClass: "data",
    });
    const authority = await createAuthenticatedFileContentMutationAuthority({
      backend,
      dataWriterOwner,
      fileSystemId,
      randomSource,
      relocationIndexRootPhysicalRef: null,
      rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });

    const reference = await authority.writeFileData({ bytes: Uint8Array.of(2, 4, 6, 8) });
    backend.failNextSyncFileData = new Error("injected File Data sync failure");
    await expect(authority.flushPendingFileDataRecords()).rejects.toThrow("injected File Data sync failure");
    expect(authority.state()).toBe("closed");
    const recoveredLease = dataWriterOwner.acquire();
    recoveredLease.release({ disposition: "reuse" });
    // The failed sync occurs after writeAt, so unreachable physical residue is
    // allowed to remain. Closing the mutation and releasing its lease prevents
    // those uncertain bytes from becoming an accepted working-generation root.
    await expect(readAuthenticatedFileData({
      backend,
      fileSystemId,
      homeReference: reference,
      relocationIndexRootPhysicalRef: null,
      rootKey,
    })).resolves.toEqual(Uint8Array.of(2, 4, 6, 8));

    await expect(dataWriterOwner.close()).resolves.toBeUndefined();
    rootKey.destroy();
  });

  it("flushes a shared File Data batch before its bounded frame-byte budget can grow", async () => {
    const backend = new CountingInMemoryBackend({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const dataWriterOwner = new AuthenticatedSegmentWriterOwner({
      backend,
      fileSystemId,
      randomSource,
      rootKey,
      segmentClass: "data",
    });
    const authority = await createAuthenticatedFileContentMutationAuthority({
      backend,
      dataWriterOwner,
      fileSystemId,
      randomSource,
      relocationIndexRootPhysicalRef: null,
      rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    const payload = new Uint8Array(HIZOFS_V1_FORMAT_CONSTANTS.limits.fileDataPlaintextBytes);
    payload.fill(7);
    const frameLength = TEST_ONLY.fileDataFrameLength({ plaintextLength: payload.byteLength });
    const recordsPerBatch = Math.floor(
      FILE_DATA_APPEND_BATCH_TEST_ONLY.MAXIMUM_PENDING_FRAME_BYTES / frameLength,
    );
    expect(recordsPerBatch).toBeGreaterThan(0);

    await authority.writeFileData({ bytes: payload });
    const writesAfterFirstStage = backend.writeAtOperations;
    for (let index = 1; index < recordsPerBatch; index += 1) {
      await authority.writeFileData({ bytes: payload });
    }
    expect(backend.writeAtOperations).toBe(writesAfterFirstStage);

    await authority.writeFileData({ bytes: payload });
    expect(backend.writeAtOperations).toBe(writesAfterFirstStage + 1);
    await authority.flushPendingFileDataRecords();
    expect(backend.writeAtOperations).toBe(writesAfterFirstStage + 2);

    authority.abandon();
    await expect(dataWriterOwner.close()).resolves.toBeUndefined();
    rootKey.destroy();
  });

  it("keeps one standard sequential-write payload inside one bounded File Data append batch", async () => {
    const backend = new CountingInMemoryBackend({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const dataWriterOwner = new AuthenticatedSegmentWriterOwner({
      backend,
      fileSystemId,
      randomSource,
      rootKey,
      segmentClass: "data",
    });
    const authority = await createAuthenticatedFileContentMutationAuthority({
      backend,
      dataWriterOwner,
      fileSystemId,
      randomSource,
      relocationIndexRootPhysicalRef: null,
      rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    const payload = new Uint8Array(256 * 1024).fill(13);

    await authority.writeFileData({ bytes: payload });
    const writesAfterWriterProvision = backend.writeAtOperations;
    for (let index = 1; index < 64; index += 1) {
      await authority.writeFileData({ bytes: payload });
    }
    expect(backend.writeAtOperations).toBe(writesAfterWriterProvision);

    await authority.flushPendingFileDataRecords();
    expect(backend.writeAtOperations).toBe(writesAfterWriterProvision + 1);

    authority.abandon();
    await expect(dataWriterOwner.close()).resolves.toBeUndefined();
    rootKey.destroy();
  });

  it("rolls a bounded shared File Data batch across the Data Segment record-area limit", async () => {
    const backend = new CountingInMemoryBackend({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const dataWriterOwner = new AuthenticatedSegmentWriterOwner({
      backend,
      fileSystemId,
      randomSource,
      rootKey,
      segmentClass: "data",
    });
    const authority = await createAuthenticatedFileContentMutationAuthority({
      backend,
      dataWriterOwner,
      fileSystemId,
      randomSource,
      relocationIndexRootPhysicalRef: null,
      rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    const payload = new Uint8Array(HIZOFS_V1_FORMAT_CONSTANTS.limits.fileDataPlaintextBytes).fill(11);
    const frameLength = TEST_ONLY.fileDataFrameLength({ plaintextLength: payload.byteLength });
    const recordCount = Math.floor(
      HIZOFS_V1_FORMAT_CONSTANTS.limits.dataSegmentDataBytes / frameLength,
    ) + 2;
    const references = [];
    for (let index = 0; index < recordCount; index += 1) {
      references.push(await authority.writeFileData({ bytes: payload }));
    }
    await authority.flushPendingFileDataRecords();

    expect(new Set(references.map(reference => reference.segmentId)).size).toBeGreaterThan(1);
    await expect(readAuthenticatedFileData({
      backend,
      fileSystemId,
      homeReference: references.at(-1)!,
      relocationIndexRootPhysicalRef: null,
      rootKey,
    })).resolves.toEqual(payload);

    authority.abandon();
    await expect(dataWriterOwner.close()).resolves.toBeUndefined();
    rootKey.destroy();
  }, 15_000);

  it("reuses one shared data Segment writer across accepted and abandoned file mutations", async () => {
    const backend = new CountingInMemoryBackend({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const dataWriterOwner = new AuthenticatedSegmentWriterOwner({
      backend,
      fileSystemId,
      randomSource,
      rootKey,
      segmentClass: "data",
    });

    const createAuthority = async () => await createAuthenticatedFileContentMutationAuthority({
      backend,
      dataWriterOwner,
      fileSystemId,
      randomSource,
      relocationIndexRootPhysicalRef: null,
      rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    const firstAuthority = await createAuthority();
    const firstReference = await firstAuthority.writeFileData({ bytes: Uint8Array.of(1, 2, 3) });
    await firstAuthority.flushPendingFileDataRecords();
    firstAuthority.completeWorkingAcceptanceWithoutCandidate();
    await expect(readAuthenticatedFileData({
      backend,
      fileSystemId,
      homeReference: firstReference,
      relocationIndexRootPhysicalRef: null,
      rootKey,
    })).resolves.toEqual(Uint8Array.of(1, 2, 3));

    const secondAuthority = await createAuthority();
    const secondReference = await secondAuthority.writeFileData({ bytes: Uint8Array.of(4, 5, 6) });
    secondAuthority.abandon();

    const thirdAuthority = await createAuthority();
    const thirdReference = await thirdAuthority.writeFileData({ bytes: Uint8Array.of(7, 8, 9) });
    await thirdAuthority.flushPendingFileDataRecords();
    thirdAuthority.completeWorkingAcceptanceWithoutCandidate();

    expect(secondReference.segmentId).toEqual(firstReference.segmentId);
    expect(thirdReference.segmentId).toEqual(firstReference.segmentId);
    expect(backend.openFileForUpdateOperations).toBe(1);
    expect(backend.openHandleCount()).toBe(1);
    await expect(dataWriterOwner.close()).resolves.toBeUndefined();
    expect(backend.openHandleCount()).toBe(0);
    await expect(readAuthenticatedFileData({
      backend,
      fileSystemId,
      homeReference: thirdReference,
      relocationIndexRootPhysicalRef: null,
      rootKey,
    })).resolves.toEqual(Uint8Array.of(7, 8, 9));
    rootKey.destroy();
  });

  it("closes accepted file content authority without materializing a Commit candidate", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const authority = await createAuthenticatedFileContentMutationAuthority({
      backend,
      fileSystemId,
      randomSource,
      relocationIndexRootPhysicalRef: null,
      rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    const fileDataHomeRef = await authority.writeFileData({ bytes: Uint8Array.of(4, 5, 6) });
    const before = authority.resourceUsage();

    authority.completeWorkingAcceptanceWithoutCandidate();

    expect(authority.state()).toBe("closed");
    expect(authority.resourceUsage()).toEqual(before);
    await expect(readAuthenticatedFileData({
      backend,
      fileSystemId,
      homeReference: fileDataHomeRef,
      relocationIndexRootPhysicalRef: null,
      rootKey,
    })).resolves.toEqual(Uint8Array.of(4, 5, 6));
    await expect(authority.writeFileData({ bytes: Uint8Array.of(7) })).rejects.toThrow("closed");
    expect(() => authority.completeWorkingAcceptanceWithoutCandidate()).toThrow("closed");
    rootKey.destroy();
  });

  it("rejects overlapping operations and abandon while a read is in progress", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const sourceWriter = await createAuthenticatedSegmentWriter({
      backend,
      fileSystemId,
      randomSource,
      rootKey,
      segmentClass: "metadata",
    });
    const extentRoot = await appendAuthenticatedFileExtentPage({
      isRoot: true,
      page: { entries: [], level: 0, type: "leaf" },
      writer: sourceWriter,
    });
    await sourceWriter.seal();
    const authority = await createAuthenticatedFileContentMutationAuthority({
      backend,
      fileSystemId,
      randomSource,
      relocationIndexRootPhysicalRef: null,
      rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    const originalReadExact = backend.readExact.bind(backend);
    const readEntered = Promise.withResolvers<void>();
    const releaseRead = Promise.withResolvers<void>();
    backend.readExact = async ({ length, offset, path }) => {
      readEntered.resolve();
      await releaseRead.promise;
      return await originalReadExact({ length, offset, path });
    };

    const read = authority.readFileExtentPage({ isRoot: true, reference: extentRoot });
    await readEntered.promise;
    await expect(authority.writeFileData({ bytes: Uint8Array.of(1) })).rejects.toThrow(
      "operation already in progress",
    );
    expect(() => authority.abandon()).toThrow("while an operation is in progress");
    releaseRead.resolve();
    await expect(read).resolves.toMatchObject({ entries: [], type: "leaf" });
    authority.abandon();
    rootKey.destroy();
  });

  it("computes aligned File Data frames and rotates before the segment bound", () => {
    const maximumFrame = TEST_ONLY.fileDataFrameLength({
      plaintextLength: HIZOFS_V1_FORMAT_CONSTANTS.limits.fileDataPlaintextBytes,
    });
    expect(maximumFrame % 8).toBe(0);
    expect(TEST_ONLY.segmentCanFit({
      frameCount: 0,
      nextFrameLength: maximumFrame,
      recordAreaBytes: 0,
    })).toBe(true);
    expect(TEST_ONLY.segmentCanFit({
      frameCount: HIZOFS_V1_FORMAT_CONSTANTS.limits.dataFramesPerSegment,
      nextFrameLength: maximumFrame,
      recordAreaBytes: 0,
    })).toBe(false);
    expect(TEST_ONLY.segmentCanFit({
      frameCount: 1,
      nextFrameLength: maximumFrame,
      recordAreaBytes: HIZOFS_V1_FORMAT_CONSTANTS.limits.dataSegmentDataBytes - maximumFrame + 1,
    })).toBe(false);
  });
});

export const TEST_ONLY_EXPORT = {};
