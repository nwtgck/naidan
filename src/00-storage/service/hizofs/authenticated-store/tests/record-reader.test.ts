import { describe, expect, it, vi } from "vitest";
import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  decodeFileSystemCommitPayload,
  parseFileSystemId,
  segmentIdToRelativePath,
} from "@/00-storage/service/hizofs/00-format";
import { createInitialBootstrapSegment } from "@/00-storage/service/hizofs/authenticated-store/bootstrap-segment-store";
import {
  authenticatedHizoFSPhysicalBytes,
  type AuthenticatedHizoFSPhysicalBytes,
} from "@/00-storage/service/hizofs/authenticated-store/physical-bytes";
import { readAuthenticatedHomeRecord } from "@/00-storage/service/hizofs/authenticated-store/record-reader";
import { generateFileSystemRootKey, type RandomByteSource } from "@/00-storage/service/hizofs/01-crypto";
import * as HizoFSCrypto from "@/00-storage/service/hizofs/01-crypto";
import { canonicalContainerPath } from "@/00-storage/service/hizofs/physical-store/paths";
import { InMemoryCrashDurabilityBackend } from "@/00-storage/service/hizofs/physical-store/testing/in-memory-crash-durability-backend";
import type {
  AuthenticatedCryptoDiagnosticsObservation,
  AuthenticatedPhysicalAccessReasonObservation,
  AuthenticatedRecordDiagnosticsObservation,
} from "@/00-storage/service/hizofs/authenticated-store/diagnostics-hooks";

function deterministicRandomSource(): RandomByteSource {
  let next = 1;
  return ({ bytes }) => {
    for (let index = 0; index < bytes.byteLength; index += 1) {
      bytes[index] = next;
      next = next === 251 ? 1 : next + 1;
    }
  };
}

describe("authenticated Record Frame reader", () => {
  it("reports a successful authenticated read with canonical record and byte measurements", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const created = await createInitialBootstrapSegment({ backend, fileSystemId, randomSource, rootKey });
    const cryptoObservations: AuthenticatedCryptoDiagnosticsObservation[] = [];
    const physicalAccessObservations: AuthenticatedPhysicalAccessReasonObservation[] = [];
    const observations: AuthenticatedRecordDiagnosticsObservation[] = [];

    const record = await readAuthenticatedHomeRecord({
      backend,
      diagnostics: {
        recordCodecOperation: () => {},
        recordCryptoOperation: observation => cryptoObservations.push(observation),
        recordPhysicalAccessReason: observation => physicalAccessObservations.push(observation),
        recordPublicationOperation: () => {},
        recordPersistedRecord: observation => observations.push(observation),
      },
      fileSystemId,
      homeReference: created.activeCommitHomeRef,
      rootKey,
    });

    expect(cryptoObservations.map(({ operation }) => operation)).toEqual(["decrypt", "decrypt"]);
    expect(cryptoObservations.every(({ durationMs }) => Number.isFinite(durationMs) && durationMs >= 0)).toBe(true);
    expect(physicalAccessObservations.filter(({ operation, reason }) => (
      operation === "read_exact" && reason === "authenticated_record_resolution"
    ))).toHaveLength(1);
    expect(physicalAccessObservations.filter(({ operation, reason }) => (
      operation === "read_exact" && reason === "segment_descriptor"
    ))).toHaveLength(1);
    expect(physicalAccessObservations.filter(({ operation, reason }) => (
      operation === "get_file_size" && reason === "segment_descriptor"
    ))).toHaveLength(0);
    expect(observations).toEqual([{
      operation: "read",
      physicalBytes: created.activeCommitHomeRef.frameLength,
      plaintextBytes: record.plaintext.byteLength,
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
    }]);
    rootKey.destroy();
  });

  it("reads a logical record directly at its home location", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const created = await createInitialBootstrapSegment({ backend, fileSystemId, randomSource, rootKey });

    const record = await readAuthenticatedHomeRecord({
      backend,
      fileSystemId,
      homeReference: created.activeCommitHomeRef,
      rootKey,
    });
    expect(decodeFileSystemCommitPayload({ bytes: record.plaintext }).commitSequence).toBe(1n);
    expect(record.header.homeOffset).toBe(created.activeCommitHomeRef.byteOffset);
    rootKey.destroy();
  });

  it("normalizes a structurally corrupt Segment Header for explicit fallback handling", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const created = await createInitialBootstrapSegment({ backend, fileSystemId, randomSource, rootKey });
    const path = canonicalContainerPath({ value: segmentIdToRelativePath({
      id: created.activeCommitHomeRef.segmentId,
      segmentClass: "metadata",
    }) });
    const header = await backend.readExact({
      length: HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.segmentHeader,
      offset: 0n,
      path,
    });
    header[0] = (header[0] ?? 0) ^ 0x01;
    const file = await backend.openFileForUpdate({ path });
    try {
      await backend.writeAt({ bytes: authenticatedHizoFSPhysicalBytes({ bytes: header }), file, offset: 0n });
      await backend.syncFileData({ file });
    } finally {
      await backend.closeFile({ file });
    }
    await expect(readAuthenticatedHomeRecord({
      backend,
      fileSystemId,
      homeReference: created.activeCommitHomeRef,
      rootKey,
    })).rejects.toMatchObject({ code: "control_plane_corrupt" });
    rootKey.destroy();
  });

  it("normalizes authenticated Record Frame tampering as corruption", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const created = await createInitialBootstrapSegment({ backend, fileSystemId, randomSource, rootKey });
    const path = canonicalContainerPath({ value: segmentIdToRelativePath({
      id: created.activeCommitHomeRef.segmentId,
      segmentClass: "metadata",
    }) });
    const ciphertextOffset = created.activeCommitHomeRef.byteOffset
      + BigInt(HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.recordFrameHeader);
    const tampered = await backend.readExact({ length: 1, offset: ciphertextOffset, path });
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    const file = await backend.openFileForUpdate({ path });
    await backend.writeAt({ bytes: authenticatedHizoFSPhysicalBytes({ bytes: tampered }), file, offset: ciphertextOffset });
    await backend.syncFileData({ file });
    await backend.closeFile({ file });

    await expect(readAuthenticatedHomeRecord({
      backend,
      fileSystemId,
      homeReference: created.activeCommitHomeRef,
      rootKey,
    })).rejects.toMatchObject({ code: "control_plane_corrupt" });
    rootKey.destroy();
  });

  it("rethrows a non-authentication crypto failure without classifying healthy bytes as corrupt", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const created = await createInitialBootstrapSegment({ backend, fileSystemId, randomSource, rootKey });
    const failure = new DOMException("crypto runtime unavailable", "InvalidStateError");
    const decrypt = vi.spyOn(HizoFSCrypto, "decryptAuthenticatedRecord").mockRejectedValue(failure);
    try {
      await expect(readAuthenticatedHomeRecord({
        backend,
        fileSystemId,
        homeReference: created.activeCommitHomeRef,
        rootKey,
      })).rejects.toBe(failure);
    } finally {
      decrypt.mockRestore();
      rootKey.destroy();
    }
  });

  it("does not convert destroyed secret capability misuse into corruption", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const created = await createInitialBootstrapSegment({ backend, fileSystemId, randomSource, rootKey });
    rootKey.destroy();

    await expect(readAuthenticatedHomeRecord({
      backend,
      fileSystemId,
      homeReference: created.activeCommitHomeRef,
      rootKey,
    })).rejects.toThrow("File System Root Key has been destroyed");
  });
});
