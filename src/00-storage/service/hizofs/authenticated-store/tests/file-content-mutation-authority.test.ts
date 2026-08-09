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
  public openFileForUpdateOperations = 0;

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
    // Metadata pages are provisional until the mutation is flushed for
    // acceptance. Abandonment drops those pages instead of leaving physical
    // orphan Records behind. File Data remains operation-scoped and durable.
    await expect(readAuthenticatedDirectoryPage({
      backend,
      fileSystemId,
      homeReference: directoryRoot,
      isRoot: true,
      relocationIndexRootPhysicalRef: null,
      rootKey,
    })).rejects.toThrow();
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
