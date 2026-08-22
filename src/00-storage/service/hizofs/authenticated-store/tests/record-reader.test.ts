import { describe, expect, it, vi } from "vitest";
import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createHomeRecordReference,
  decodeFileSystemCommitPayload,
  parseFileSystemId,
  recordFrameLayoutForPlaintextLength,
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
import type { HizoFSReadableBackend } from "@/00-storage/service/hizofs/physical-store/backend";
import { InMemoryCrashDurabilityBackend } from "@/00-storage/service/hizofs/physical-store/testing/in-memory-crash-durability-backend";
import type {
  AuthenticatedCryptoDiagnosticsObservation,
  AuthenticatedPhysicalAccessReasonObservation,
  AuthenticatedRecordDiagnosticsObservation,
} from "@/00-storage/service/hizofs/authenticated-store/diagnostics-hooks";


function pairedReadableBackend({
  backend,
  omitSecond = false,
}: {
  backend: HizoFSReadableBackend;
  omitSecond?: boolean;
}): Readonly<{
  backend: HizoFSReadableBackend;
  legacyReadExact: ReturnType<typeof vi.fn>;
  legacyReadExactWithFileSize: ReturnType<typeof vi.fn>;
  readPair: ReturnType<typeof vi.fn>;
}> {
  const legacyReadExact = vi.fn(async (parameters: Parameters<HizoFSReadableBackend["readExact"]>[0]) => (
    await backend.readExact(parameters)
  ));
  const legacyReadExactWithFileSize = vi.fn(async (
    parameters: Parameters<HizoFSReadableBackend["readExactWithFileSize"]>[0],
  ) => await backend.readExactWithFileSize(parameters));
  const readPair = vi.fn(async ({ first, path, second }: Parameters<
    NonNullable<HizoFSReadableBackend["readExactPairWithFileSize"]>
  >[0]) => {
    const firstResult = await backend.readExactWithFileSize({ ...first, path });
    const secondEnd = second.offset + BigInt(second.length);
    return {
      fileSize: firstResult.fileSize,
      first: firstResult.bytes,
      second: omitSecond || secondEnd > firstResult.fileSize
        ? undefined
        : await backend.readExact({ ...second, path }),
    };
  });
  return {
    backend: {
      getFileSize: async parameters => await backend.getFileSize(parameters),
      list: async parameters => await backend.list(parameters),
      readExact: legacyReadExact,
      readExactPairWithFileSize: readPair,
      readExactWithFileSize: legacyReadExactWithFileSize,
      readFileBounded: async parameters => await backend.readFileBounded(parameters),
    },
    legacyReadExact,
    legacyReadExactWithFileSize,
    readPair,
  };
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

  it("uses one paired snapshot read so both ranges come from the same file image", async () => {
    const physicalBackend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const created = await createInitialBootstrapSegment({
      backend: physicalBackend,
      fileSystemId,
      randomSource,
      rootKey,
    });
    const paired = pairedReadableBackend({ backend: physicalBackend });
    const physicalAccessObservations: AuthenticatedPhysicalAccessReasonObservation[] = [];

    const record = await readAuthenticatedHomeRecord({
      backend: paired.backend,
      diagnostics: {
        recordCodecOperation: () => {},
        recordCryptoOperation: () => {},
        recordPhysicalAccessReason: observation => physicalAccessObservations.push(observation),
        recordPublicationOperation: () => {},
        recordPersistedRecord: () => {},
      },
      fileSystemId,
      homeReference: created.activeCommitHomeRef,
      rootKey,
    });

    expect(decodeFileSystemCommitPayload({ bytes: record.plaintext }).commitSequence).toBe(1n);
    expect(paired.readPair).toHaveBeenCalledTimes(1);
    expect(paired.legacyReadExact).not.toHaveBeenCalled();
    expect(paired.legacyReadExactWithFileSize).not.toHaveBeenCalled();
    expect(physicalAccessObservations.filter(({ operation, reason }) => (
      operation === "read_exact" && reason === "segment_descriptor"
    ))).toHaveLength(1);
    expect(physicalAccessObservations.filter(({ operation, reason }) => (
      operation === "read_exact" && reason === "authenticated_record_resolution"
    ))).toHaveLength(1);
    rootKey.destroy();
  });

  it("rejects an oversized Physical Record Reference before paired backend I/O", async () => {
    const physicalBackend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const created = await createInitialBootstrapSegment({
      backend: physicalBackend,
      fileSystemId,
      randomSource,
      rootKey,
    });
    const paired = pairedReadableBackend({ backend: physicalBackend });
    const maximumMetadataFrameLength = recordFrameLayoutForPlaintextLength({
      plaintextLength: HIZOFS_V1_FORMAT_CONSTANTS.limits.metadataPlaintextBytes,
    }).frameLength;
    const oversizedReference = createHomeRecordReference({ fields: {
      ...created.activeCommitHomeRef,
      frameLength: maximumMetadataFrameLength + 8,
    } });

    await expect(readAuthenticatedHomeRecord({
      backend: paired.backend,
      fileSystemId,
      homeReference: oversizedReference,
      rootKey,
    })).rejects.toMatchObject({
      code: "control_plane_corrupt",
      message: "Physical Record Reference frame length exceeds its V1 bound",
    });
    expect(paired.readPair).not.toHaveBeenCalled();
    expect(paired.legacyReadExact).not.toHaveBeenCalled();
    expect(paired.legacyReadExactWithFileSize).not.toHaveBeenCalled();
    rootKey.destroy();
  });

  it("preserves the authenticated oversized-reference error on a paired snapshot miss", async () => {
    const physicalBackend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const created = await createInitialBootstrapSegment({
      backend: physicalBackend,
      fileSystemId,
      randomSource,
      rootKey,
    });
    const paired = pairedReadableBackend({ backend: physicalBackend, omitSecond: true });

    await expect(readAuthenticatedHomeRecord({
      backend: paired.backend,
      fileSystemId,
      homeReference: created.activeCommitHomeRef,
      rootKey,
    })).rejects.toMatchObject({
      code: "control_plane_corrupt",
      message: "Physical Record Reference exceeds its segment file",
    });
    expect(paired.readPair).toHaveBeenCalledTimes(1);
    expect(paired.legacyReadExact).not.toHaveBeenCalled();
    expect(paired.legacyReadExactWithFileSize).not.toHaveBeenCalled();
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
