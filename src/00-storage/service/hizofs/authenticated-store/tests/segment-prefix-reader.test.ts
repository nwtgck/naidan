import { describe, expect, it, vi } from "vitest";
import { HIZOFS_V1_FORMAT_CONSTANTS, parseFileSystemId, segmentIdToRelativePath } from "@/00-storage/service/hizofs/00-format";
import { createInitialBootstrapSegment } from "@/00-storage/service/hizofs/authenticated-store/bootstrap-segment-store";
import {
  authenticatedHizoFSPhysicalBytes,
  type AuthenticatedHizoFSPhysicalBytes,
} from "@/00-storage/service/hizofs/authenticated-store/physical-bytes";
import { scanAuthenticatedSegmentPrefix } from "@/00-storage/service/hizofs/authenticated-store/segment-prefix-reader";
import { generateFileSystemRootKey, type RandomByteSource } from "@/00-storage/service/hizofs/01-crypto";
import * as HizoFSCrypto from "@/00-storage/service/hizofs/01-crypto";
import { InMemoryCrashDurabilityBackend } from "@/00-storage/service/hizofs/physical-store/testing/in-memory-crash-durability-backend";
import { canonicalContainerPath } from "@/00-storage/service/hizofs/physical-store/paths";

class ReadFailingBackend extends InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes> {
  #failReads = false;

  public failSubsequentReads(): void {
    this.#failReads = true;
  }

  public override async readExact(
    input: Parameters<InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>["readExact"]>[0],
  ): Promise<Uint8Array> {
    if (this.#failReads) throw new Error("backend read failure");
    return await super.readExact(input);
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

describe("authenticated Segment valid-prefix scan", () => {
  it("authenticates the complete bootstrap prefix", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const created = await createInitialBootstrapSegment({ backend, fileSystemId, randomSource, rootKey });

    const result = await scanAuthenticatedSegmentPrefix({
      backend,
      fileSystemId,
      physicalSegmentId: created.activeCommitHomeRef.segmentId,
      rootKey,
      segmentClass: "metadata",
    });
    expect(result.state).toBe("complete_unsealed");
    expect(result.frames).toHaveLength(2);
    expect(result.frames.map(frame => frame.physicalOffset)).toEqual([
      64n,
      created.activeCommitHomeRef.byteOffset,
    ]);
    rootKey.destroy();
  });

  it("does not misclassify a destroyed root key as segment corruption", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const created = await createInitialBootstrapSegment({ backend, fileSystemId, randomSource, rootKey });
    rootKey.destroy();

    await expect(scanAuthenticatedSegmentPrefix({
      backend,
      fileSystemId,
      physicalSegmentId: created.activeCommitHomeRef.segmentId,
      rootKey,
      segmentClass: "metadata",
    })).rejects.toThrow("File System Root Key has been destroyed");
  });

  it("normalizes Segment Header authentication tampering as corruption", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const created = await createInitialBootstrapSegment({ backend, fileSystemId, randomSource, rootKey });
    const path = canonicalContainerPath({ value: segmentIdToRelativePath({
      id: created.activeCommitHomeRef.segmentId,
      segmentClass: "metadata",
    }) });
    const tagOffset = BigInt(HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.segmentHeader - 1);
    const tampered = await backend.readExact({ length: 1, offset: tagOffset, path });
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    const file = await backend.openFileForUpdate({ path });
    await backend.writeAt({ bytes: authenticatedHizoFSPhysicalBytes({ bytes: tampered }), file, offset: tagOffset });
    await backend.syncFileData({ file });
    await backend.closeFile({ file });

    await expect(scanAuthenticatedSegmentPrefix({
      backend,
      fileSystemId,
      physicalSegmentId: created.activeCommitHomeRef.segmentId,
      rootKey,
      segmentClass: "metadata",
    })).rejects.toMatchObject({ code: "control_plane_corrupt" });
    rootKey.destroy();
  });

  it("rethrows a non-authentication Segment Header crypto failure", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const created = await createInitialBootstrapSegment({ backend, fileSystemId, randomSource, rootKey });
    const failure = new Error("segment header crypto runtime failure");
    const decrypt = vi.spyOn(HizoFSCrypto, "decryptAuthenticatedSegmentHeader").mockRejectedValue(failure);
    try {
      await expect(scanAuthenticatedSegmentPrefix({
        backend,
        fileSystemId,
        physicalSegmentId: created.activeCommitHomeRef.segmentId,
        rootKey,
        segmentClass: "metadata",
      })).rejects.toBe(failure);
    } finally {
      decrypt.mockRestore();
      rootKey.destroy();
    }
  });

  it("returns an abandoned prefix only for authenticated Record Frame tampering", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const created = await createInitialBootstrapSegment({ backend, fileSystemId, randomSource, rootKey });
    const path = canonicalContainerPath({ value: segmentIdToRelativePath({
      id: created.activeCommitHomeRef.segmentId,
      segmentClass: "metadata",
    }) });
    const frameOffset = BigInt(HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.segmentHeader);
    const ciphertextOffset = frameOffset + BigInt(HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.recordFrameHeader);
    const tampered = await backend.readExact({ length: 1, offset: ciphertextOffset, path });
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    const file = await backend.openFileForUpdate({ path });
    await backend.writeAt({ bytes: authenticatedHizoFSPhysicalBytes({ bytes: tampered }), file, offset: ciphertextOffset });
    await backend.syncFileData({ file });
    await backend.closeFile({ file });

    await expect(scanAuthenticatedSegmentPrefix({
      backend,
      fileSystemId,
      physicalSegmentId: created.activeCommitHomeRef.segmentId,
      rootKey,
      segmentClass: "metadata",
    })).resolves.toMatchObject({ frames: [], nextOffset: frameOffset, state: "abandoned_unsealed" });
    rootKey.destroy();
  });

  it("rethrows a non-authentication Record Frame crypto failure instead of abandoning healthy bytes", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const created = await createInitialBootstrapSegment({ backend, fileSystemId, randomSource, rootKey });
    const failure = new DOMException("record crypto unavailable", "NotSupportedError");
    const decrypt = vi.spyOn(HizoFSCrypto, "decryptAuthenticatedRecord").mockRejectedValue(failure);
    try {
      await expect(scanAuthenticatedSegmentPrefix({
        backend,
        fileSystemId,
        physicalSegmentId: created.activeCommitHomeRef.segmentId,
        rootKey,
        segmentClass: "metadata",
      })).rejects.toBe(failure);
    } finally {
      decrypt.mockRestore();
      rootKey.destroy();
    }
  });

  it("propagates backend read failure instead of treating it as a corrupt tail", async () => {
    const backend = new ReadFailingBackend({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const created = await createInitialBootstrapSegment({ backend, fileSystemId, randomSource, rootKey });
    backend.failSubsequentReads();

    await expect(scanAuthenticatedSegmentPrefix({
      backend,
      fileSystemId,
      physicalSegmentId: created.activeCommitHomeRef.segmentId,
      rootKey,
      segmentClass: "metadata",
    })).rejects.toThrow("backend read failure");
    rootKey.destroy();
  });

  it("classifies a truncated Segment Header as authenticated-store corruption", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const created = await createInitialBootstrapSegment({ backend, fileSystemId, randomSource, rootKey });
    const path = canonicalContainerPath({ value: segmentIdToRelativePath({
      id: created.activeCommitHomeRef.segmentId,
      segmentClass: "metadata",
    }) });
    const file = await backend.openFileForUpdate({ path });
    await backend.truncate({ file, length: 1n });
    await backend.syncFileData({ file });
    await backend.closeFile({ file });

    await expect(scanAuthenticatedSegmentPrefix({
      backend,
      fileSystemId,
      physicalSegmentId: created.activeCommitHomeRef.segmentId,
      rootKey,
      segmentClass: "metadata",
    })).rejects.toMatchObject({ code: "control_plane_corrupt" });
    rootKey.destroy();
  });

  it("stops at the first torn tail without scanning for later magic", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const created = await createInitialBootstrapSegment({ backend, fileSystemId, randomSource, rootKey });
    const path = canonicalContainerPath({ value: segmentIdToRelativePath({
      id: created.activeCommitHomeRef.segmentId,
      segmentClass: "metadata",
    }) });
    const originalSize = await backend.getFileSize({ path });
    expect(originalSize).toBeDefined();
    const file = await backend.openFileForUpdate({ path });
    const tornTail = new Uint8Array(96);
    tornTail.set(new TextEncoder().encode("not-a-frame"), 0);
    tornTail.set(new TextEncoder().encode("HZRECORD"), 40);
    await backend.writeAt({
      bytes: authenticatedHizoFSPhysicalBytes({ bytes: tornTail }),
      file,
      offset: originalSize!,
    });
    await backend.syncFileData({ file });
    await backend.closeFile({ file });

    const result = await scanAuthenticatedSegmentPrefix({
      backend,
      fileSystemId,
      physicalSegmentId: created.activeCommitHomeRef.segmentId,
      rootKey,
      segmentClass: "metadata",
    });
    expect(result.state).toBe("abandoned_unsealed");
    expect(result.frames).toHaveLength(2);
    expect(result.nextOffset).toBe(originalSize);
    expect(backend.openHandleCount()).toBe(0);
    rootKey.destroy();
  });
});
