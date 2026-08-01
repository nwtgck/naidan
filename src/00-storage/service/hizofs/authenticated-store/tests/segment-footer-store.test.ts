import { describe, expect, it } from "vitest";
import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  parseFileSystemId,
  segmentIdToRelativePath,
} from "@/00-storage/service/hizofs/00-format";
import { createInitialBootstrapSegment } from "@/00-storage/service/hizofs/authenticated-store/bootstrap-segment-store";
import {
  readAuthenticatedSegmentIndex,
  TEST_ONLY as SEGMENT_FOOTER_TEST_ONLY,
} from "@/00-storage/service/hizofs/authenticated-store/segment-footer-store";
import {
  authenticatedHizoFSPhysicalBytes,
  type AuthenticatedHizoFSPhysicalBytes,
} from "@/00-storage/service/hizofs/authenticated-store/physical-bytes";
import { generateFileSystemRootKey, type RandomByteSource } from "@/00-storage/service/hizofs/crypto";
import { canonicalContainerPath } from "@/00-storage/service/hizofs/physical-store/paths";
import { DeterministicPhysicalStoreFaultInjector } from "@/00-storage/service/hizofs/physical-store/testing/deterministic-fault-injector";
import { InMemoryCrashDurabilityBackend } from "@/00-storage/service/hizofs/physical-store/testing/in-memory-crash-durability-backend";
import type {
  AuthenticatedCryptoDiagnosticsObservation,
  AuthenticatedStoreDiagnosticsPort,
} from "@/00-storage/service/hizofs/authenticated-store/runtime-diagnostics-port";

function deterministicRandomSource(): RandomByteSource {
  let next = 1;
  return ({ bytes }) => {
    for (let index = 0; index < bytes.byteLength; index += 1) {
      bytes[index] = next;
      next = next === 251 ? 1 : next + 1;
    }
  };
}

async function createBootstrap(): Promise<{
  backend: InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>;
  fileSystemId: ReturnType<typeof parseFileSystemId>;
  physicalSegmentId: Awaited<ReturnType<typeof createInitialBootstrapSegment>>["activeCommitHomeRef"]["segmentId"];
  randomSource: RandomByteSource;
  rootKey: ReturnType<typeof generateFileSystemRootKey>;
}> {
  const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
  const randomSource = deterministicRandomSource();
  const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
  const rootKey = generateFileSystemRootKey({ randomSource });
  const created = await createInitialBootstrapSegment({ backend, fileSystemId, randomSource, rootKey });
  return {
    backend,
    fileSystemId,
    physicalSegmentId: created.activeCommitHomeRef.segmentId,
    randomSource,
    rootKey,
  };
}

function segmentPath({ physicalSegmentId }: {
  physicalSegmentId: Awaited<ReturnType<typeof createInitialBootstrapSegment>>["activeCommitHomeRef"]["segmentId"];
}) {
  return canonicalContainerPath({ value: segmentIdToRelativePath({
    id: physicalSegmentId,
    segmentClass: "metadata",
  }) });
}

describe("authenticated Segment Footer store", () => {
  it("publishes and reopens a sealed footer", async () => {
    const fixture = await createBootstrap();
    const cryptoObservations: AuthenticatedCryptoDiagnosticsObservation[] = [];
    const diagnostics: AuthenticatedStoreDiagnosticsPort = {
      recordCodecOperation: () => {},
      recordCryptoOperation: observation => cryptoObservations.push(observation),
      recordPublicationOperation: () => {},
      recordPersistedRecord: () => undefined,
    };

    const sealed = await SEGMENT_FOOTER_TEST_ONLY.sealAuthenticatedSegmentForTesting({
      backend: fixture.backend,
      diagnostics,
      fileSystemId: fixture.fileSystemId,
      physicalSegmentId: fixture.physicalSegmentId,
      randomSource: fixture.randomSource,
      rootKey: fixture.rootKey,
      segmentClass: "metadata",
    });
    expect(sealed.state).toBe("sealed");
    expect(sealed.frames).toHaveLength(2);
    expect(sealed.footer).toBeDefined();

    const reopened = await readAuthenticatedSegmentIndex({
      backend: fixture.backend,
      diagnostics,
      fileSystemId: fixture.fileSystemId,
      physicalSegmentId: fixture.physicalSegmentId,
      rootKey: fixture.rootKey,
      segmentClass: "metadata",
    });
    expect(reopened).toEqual(sealed);
    expect(cryptoObservations.some(({ operation }) => operation === "encrypt")).toBe(true);
    expect(cryptoObservations.some(({ operation }) => operation === "decrypt")).toBe(true);
    expect(cryptoObservations.every(({ durationMs }) => Number.isFinite(durationMs) && durationMs >= 0)).toBe(true);
    expect(fixture.backend.openHandleCount()).toBe(0);
    fixture.rootKey.destroy();
  });

  it("discards the whole footer and falls back to the authenticated frame prefix when the tag is corrupt", async () => {
    const fixture = await createBootstrap();
    const sealed = await SEGMENT_FOOTER_TEST_ONLY.sealAuthenticatedSegmentForTesting({
      backend: fixture.backend,
      fileSystemId: fixture.fileSystemId,
      physicalSegmentId: fixture.physicalSegmentId,
      randomSource: fixture.randomSource,
      rootKey: fixture.rootKey,
      segmentClass: "metadata",
    });
    if (sealed.footer === undefined) throw new Error("sealed footer invariant failed");
    const tagOffset = sealed.footer.physicalOffset
      + BigInt(HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.segmentFooterHeader)
      + BigInt(sealed.footer.header.plaintextIndexLength);
    const path = segmentPath({ physicalSegmentId: fixture.physicalSegmentId });
    const original = await fixture.backend.readExact({ length: 1, offset: tagOffset, path });
    original[0] = (original[0] ?? 0) ^ 0xff;
    const file = await fixture.backend.openFileForUpdate({ path });
    await fixture.backend.writeAt({ bytes: authenticatedHizoFSPhysicalBytes({ bytes: original }), file, offset: tagOffset });
    await fixture.backend.syncFileData({ file });
    await fixture.backend.closeFile({ file });

    const reopened = await readAuthenticatedSegmentIndex({
      backend: fixture.backend,
      fileSystemId: fixture.fileSystemId,
      physicalSegmentId: fixture.physicalSegmentId,
      rootKey: fixture.rootKey,
      segmentClass: "metadata",
    });
    expect(reopened.state).toBe("footer_unusable");
    expect(reopened.frames).toHaveLength(2);
    expect(reopened.footer).toBeUndefined();
    fixture.rootKey.destroy();
  });

  it("treats a torn footer as unusable without losing the valid record prefix", async () => {
    const fixture = await createBootstrap();
    await SEGMENT_FOOTER_TEST_ONLY.sealAuthenticatedSegmentForTesting({
      backend: fixture.backend,
      fileSystemId: fixture.fileSystemId,
      physicalSegmentId: fixture.physicalSegmentId,
      randomSource: fixture.randomSource,
      rootKey: fixture.rootKey,
      segmentClass: "metadata",
    });
    const path = segmentPath({ physicalSegmentId: fixture.physicalSegmentId });
    const fileSize = await fixture.backend.getFileSize({ path });
    if (fileSize === undefined) throw new Error("segment size invariant failed");
    const file = await fixture.backend.openFileForUpdate({ path });
    await fixture.backend.truncate({ file, length: fileSize - 10n });
    await fixture.backend.syncFileData({ file });
    await fixture.backend.closeFile({ file });

    const reopened = await readAuthenticatedSegmentIndex({
      backend: fixture.backend,
      fileSystemId: fixture.fileSystemId,
      physicalSegmentId: fixture.physicalSegmentId,
      rootKey: fixture.rootKey,
      segmentClass: "metadata",
    });
    expect(reopened.state).toBe("footer_unusable");
    expect(reopened.frames).toHaveLength(2);
    fixture.rootKey.destroy();
  });

  it("re-flushes an already visible footer before succeeding after an outcome-unknown write", async () => {
    const faultInjector = new DeterministicPhysicalStoreFaultInjector({
      schedule: [{ occurrence: 2, operation: "writeAt", timing: "after" }],
    });
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({ faultInjector });
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const created = await createInitialBootstrapSegment({ backend, fileSystemId, randomSource, rootKey });

    await expect(SEGMENT_FOOTER_TEST_ONLY.sealAuthenticatedSegmentForTesting({
      backend,
      fileSystemId,
      physicalSegmentId: created.activeCommitHomeRef.segmentId,
      randomSource,
      rootKey,
      segmentClass: "metadata",
    })).rejects.toThrow("injected physical-store fault");
    faultInjector.assertExhausted();
    expect(backend.openHandleCount()).toBe(0);

    const retried = await SEGMENT_FOOTER_TEST_ONLY.sealAuthenticatedSegmentForTesting({
      backend,
      fileSystemId,
      physicalSegmentId: created.activeCommitHomeRef.segmentId,
      randomSource,
      rootKey,
      segmentClass: "metadata",
    });
    expect(retried.state).toBe("sealed");
    await backend.crashAndRecover();
    await expect(readAuthenticatedSegmentIndex({
      backend,
      fileSystemId,
      physicalSegmentId: created.activeCommitHomeRef.segmentId,
      rootKey,
      segmentClass: "metadata",
    })).resolves.toMatchObject({ state: "sealed" });
    rootKey.destroy();
  });

  it("does not convert destroyed secret capability misuse into footer corruption", async () => {
    const fixture = await createBootstrap();
    await SEGMENT_FOOTER_TEST_ONLY.sealAuthenticatedSegmentForTesting({
      backend: fixture.backend,
      fileSystemId: fixture.fileSystemId,
      physicalSegmentId: fixture.physicalSegmentId,
      randomSource: fixture.randomSource,
      rootKey: fixture.rootKey,
      segmentClass: "metadata",
    });
    fixture.rootKey.destroy();

    await expect(readAuthenticatedSegmentIndex({
      backend: fixture.backend,
      fileSystemId: fixture.fileSystemId,
      physicalSegmentId: fixture.physicalSegmentId,
      rootKey: fixture.rootKey,
      segmentClass: "metadata",
    })).rejects.toThrow("File System Root Key has been destroyed");
  });
});
