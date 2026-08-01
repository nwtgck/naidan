import { describe, expect, it } from "vitest";
import {
  HIZOFS_SUPERBLOCK_FILES,
  HIZOFS_V1_FORMAT_CONSTANTS,
  createCommitSequence,
  createFeatureBits,
  createHomeRecordReference,
  createPhysicalRecordReference,
  createPublicationSequence,
  createSuperblockHeader,
  createUInt64,
  createUnlockSequence,
  decodeSuperblockHeader,
  decodeSuperblockPlaintext,
  encodeSuperblockHeader,
  parseFileSystemId,
  parseMutationId,
  parseSegmentId,
  type SuperblockPlaintextV1,
} from "@/00-storage/service/hizofs/00-format";
import {
  authenticatedSuperblockBytes,
  decryptAuthenticatedSuperblock,
  generateFileSystemRootKey,
  superblockNonce,
  type FileSystemRootKey,
  type RandomByteSource,
} from "@/00-storage/service/hizofs/crypto";
import { authenticatedHizoFSPhysicalBytes, type AuthenticatedHizoFSPhysicalBytes } from "@/00-storage/service/hizofs/authenticated-store/physical-bytes";
import type {
  AuthenticatedCryptoDiagnosticsObservation,
  AuthenticatedStoreDiagnosticsPort,
} from "@/00-storage/service/hizofs/authenticated-store/runtime-diagnostics-port";
import {
  createInitialSuperblockCopies,
  openSuperblockCopies,
  publishMutationSuperblockCopies,
  publishRelocationSuperblockCopies,
  publishUnlockFloorSuperblockCopies,
  resolveMutationSuperblockPublication,
  resolveRelocationSuperblockPublication,
  resolveUnlockFloorSuperblockPublication,
  SuperblockMutationPublicationError,
  SuperblockRelocationPublicationError,
  SuperblockUnlockFloorPublicationError,
  SuperblockPublicationConflictError,
  type SuperblockLogicalState,
} from "@/00-storage/service/hizofs/authenticated-store/superblock-store";
import { canonicalContainerPath } from "@/00-storage/service/hizofs/physical-store/paths";
import { DeterministicPhysicalStoreFaultInjector } from "@/00-storage/service/hizofs/physical-store/testing/deterministic-fault-injector";
import { InMemoryCrashDurabilityBackend } from "@/00-storage/service/hizofs/physical-store/testing/in-memory-crash-durability-backend";

function deterministicRandomSource(): RandomByteSource {
  let next = 1;
  return ({ bytes }) => {
    for (let index = 0; index < bytes.byteLength; index += 1) {
      bytes[index] = next;
      next = next === 251 ? 1 : next + 1;
    }
  };
}

function initialLogicalState(): SuperblockLogicalState {
  return {
    activeCommitHomeRef: createHomeRecordReference({ fields: {
      byteOffset: createUInt64({ value: 64n }),
      frameLength: 96,
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
      segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(7) }),
    } }),
    activeCommitSequence: createCommitSequence({ value: 1n }),
    activeMutationId: parseMutationId({ bytes: new Uint8Array(16).fill(3) }),
    fallbackCommitHomeRef: null,
    minimumUnlockSequence: createUnlockSequence({ value: 1n }),
    relocationIndexRootPhysicalRef: null,
    requiredFeatureBits: createFeatureBits({ value: 0n }),
  };
}


function relocationLogicalState({ previous, seed = 13 }: {
  previous: SuperblockLogicalState;
  seed?: number;
}): SuperblockLogicalState {
  return {
    ...previous,
    relocationIndexRootPhysicalRef: createPhysicalRecordReference({ fields: {
      byteOffset: createUInt64({ value: 64n }),
      frameLength: 96,
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.relocation_index_page,
      segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(seed) }),
    } }),
  };
}

function nextLogicalState({ previous }: { previous: SuperblockLogicalState }): SuperblockLogicalState {
  return {
    ...previous,
    activeCommitHomeRef: createHomeRecordReference({ fields: {
      byteOffset: createUInt64({ value: 160n }),
      frameLength: 112,
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
      segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(9) }),
    } }),
    activeCommitSequence: createCommitSequence({ value: previous.activeCommitSequence + 1n }),
    activeMutationId: parseMutationId({ bytes: new Uint8Array(16).fill(5) }),
    fallbackCommitHomeRef: previous.activeCommitHomeRef,
  };
}

async function readRawCopy({ backend, copy, fileSystemId, rootKey }: {
  backend: InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>;
  copy: 0 | 1;
  fileSystemId: ReturnType<typeof parseFileSystemId>;
  rootKey: FileSystemRootKey;
}): Promise<{ header: ReturnType<typeof decodeSuperblockHeader>; plaintext: SuperblockPlaintextV1 }> {
  const bytes = await backend.readFileBounded({
    maximumByteLength: HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.superblockFile,
    path: canonicalContainerPath({ value: HIZOFS_SUPERBLOCK_FILES[copy] }),
  });
  if (bytes === undefined) throw new Error("expected Superblock copy");
  const headerSize = HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.superblockHeader;
  const headerBytes = bytes.subarray(0, headerSize);
  const header = decodeSuperblockHeader({ bytes: headerBytes });
  const plaintextBytes = await decryptAuthenticatedSuperblock({
    ciphertext: authenticatedSuperblockBytes({ bytes: bytes.subarray(headerSize) }),
    copy,
    exactHeader: headerBytes,
    fileSystemId,
    nonce: superblockNonce({ bytes: header.nonce }),
    publicationSequence: header.publicationSequence,
    rootKey,
  });
  return { header, plaintext: decodeSuperblockPlaintext({ bytes: plaintextBytes, flags: header.flags }) };
}

describe("HizoFS Superblock store", () => {
  it("publishes converged initial copies with distinct physical evidence", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const logicalState = initialLogicalState();
    const cryptoObservations: AuthenticatedCryptoDiagnosticsObservation[] = [];
    const diagnostics: AuthenticatedStoreDiagnosticsPort = {
      recordCodecOperation: () => {},
      recordCryptoOperation: observation => cryptoObservations.push(observation),
      recordPublicationOperation: () => {},
      recordPersistedRecord: () => undefined,
    };

    const created = await createInitialSuperblockCopies({
      backend,
      diagnostics,
      fileSystemId,
      logicalState,
      randomSource,
      rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    expect(created.copyState).toBe("normal");
    expect(created.selectedPublicationSequence).toBe(2n);

    const copy0 = await readRawCopy({ backend, copy: 0, fileSystemId, rootKey });
    const copy1 = await readRawCopy({ backend, copy: 1, fileSystemId, rootKey });
    expect(copy0.header.publicationSequence).toBe(1n);
    expect(copy1.header.publicationSequence).toBe(2n);
    expect(copy0.header.nonce).not.toEqual(copy1.header.nonce);
    expect(copy0.plaintext.publicationId).not.toEqual(copy1.plaintext.publicationId);
    expect(copy0.plaintext.activeCommitHomeRef).toEqual(copy1.plaintext.activeCommitHomeRef);
    expect(copy0.plaintext.fallbackCommitHomeRef).toBeNull();
    expect(copy1.plaintext.fallbackCommitHomeRef).toBeNull();

    const opened = await openSuperblockCopies({
      backend,
      diagnostics,
      fileSystemId,
      rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    expect(opened.copyState).toBe("normal");
    expect(opened.logicalState).toEqual(logicalState);
    expect(opened.selectedPublicationSequence).toBe(2n);
    expect(cryptoObservations.map(({ operation }) => operation)).toEqual([
      "encrypt",
      "decrypt",
      "encrypt",
      "decrypt",
      "decrypt",
      "decrypt",
    ]);
    expect(cryptoObservations.every(({ durationMs }) => Number.isFinite(durationMs) && durationMs >= 0)).toBe(true);
    expect(backend.openHandleCount()).toBe(0);
    rootKey.destroy();
  });

  it("selects the surviving authenticated copy as degraded", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    await createInitialSuperblockCopies({
      backend,
      fileSystemId,
      logicalState: initialLogicalState(),
      randomSource,
      rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    await backend.removeFile({ path: canonicalContainerPath({ value: HIZOFS_SUPERBLOCK_FILES[1] }) });

    const opened = await openSuperblockCopies({
      backend,
      fileSystemId,
      rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    expect(opened.copyState).toBe("superblock_redundancy_degraded");
    expect(opened.authenticatedLogicalStates).toEqual([opened.logicalState]);
    expect(opened.selectedPublicationSequence).toBe(1n);
    rootKey.destroy();
  });

  it("does not misclassify a destroyed root-key capability as copy corruption", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    await createInitialSuperblockCopies({
      backend,
      fileSystemId,
      logicalState: initialLogicalState(),
      randomSource,
      rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    rootKey.destroy();

    await expect(openSuperblockCopies({
      backend,
      fileSystemId,
      rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    })).rejects.toThrow("destroyed");
  });

  it("fails closed when selected state requires an unsupported feature", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    await createInitialSuperblockCopies({
      backend,
      fileSystemId,
      logicalState: {
        ...initialLogicalState(),
        requiredFeatureBits: createFeatureBits({ value: 1n }),
      },
      randomSource,
      rootKey,
      supportedFeatureBits: createFeatureBits({ value: 1n }),
    });

    await expect(openSuperblockCopies({
      backend,
      fileSystemId,
      rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    })).rejects.toMatchObject({ code: "unsupported_required_feature" });
    rootKey.destroy();
  });

  it("reports an authenticated older root that requires unsupported features", async () => {
    const faultInjector = new DeterministicPhysicalStoreFaultInjector({
      schedule: [{ occurrence: 4, operation: "writeAt", timing: "before" }],
    });
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({ faultInjector });
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const initial = await createInitialSuperblockCopies({
      backend,
      fileSystemId,
      logicalState: {
        ...initialLogicalState(),
        requiredFeatureBits: createFeatureBits({ value: 1n }),
      },
      randomSource,
      rootKey,
      supportedFeatureBits: createFeatureBits({ value: 1n }),
    });
    const supportedLogicalState = {
      ...nextLogicalState({ previous: initial.logicalState }),
      requiredFeatureBits: createFeatureBits({ value: 0n }),
    };

    const failure = await publishMutationSuperblockCopies({
      backend,
      base: initial,
      fileSystemId,
      firstPublicationSequence: createPublicationSequence({ value: 3n }),
      logicalState: supportedLogicalState,
      randomSource,
      rootKey,
      secondPublicationSequence: createPublicationSequence({ value: 4n }),
      supportedFeatureBits: createFeatureBits({ value: 1n }),
    }).catch((cause: unknown) => cause);
    expect(failure).toMatchObject({ outcome: "committed_redundancy_degraded" });

    const opened = await openSuperblockCopies({
      backend,
      fileSystemId,
      rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    expect(opened.logicalState).toEqual(supportedLogicalState);
    expect(opened.copyState).toBe("superblock_redundancy_degraded");
    expect(opened.authenticatedLogicalStates).toHaveLength(2);
    expect(opened.authenticatedLogicalStates).toContainEqual(supportedLogicalState);
    expect(opened.historicalRootFeatureState).toBe("unsupported");
    faultInjector.assertExhausted();
    rootKey.destroy();
  });

  it("publishes a mutation to the opposite copy before converging the selected copy", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const initial = await createInitialSuperblockCopies({
      backend,
      fileSystemId,
      logicalState: initialLogicalState(),
      randomSource,
      rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    expect(initial.maximumStructurallyObservedPublicationSequence).toBe(2n);
    const logicalState = nextLogicalState({ previous: initial.logicalState });

    const published = await publishMutationSuperblockCopies({
      backend,
      base: initial,
      fileSystemId,
      firstPublicationSequence: createPublicationSequence({ value: 3n }),
      logicalState,
      randomSource,
      rootKey,
      secondPublicationSequence: createPublicationSequence({ value: 4n }),
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });

    expect(published.copyState).toBe("normal");
    expect(published.logicalState).toEqual(logicalState);
    expect(published.maximumStructurallyObservedPublicationSequence).toBe(4n);
    const copy0 = await readRawCopy({ backend, copy: 0, fileSystemId, rootKey });
    const copy1 = await readRawCopy({ backend, copy: 1, fileSystemId, rootKey });
    expect(copy0.header.publicationSequence).toBe(3n);
    expect(copy1.header.publicationSequence).toBe(4n);
    expect(copy0.plaintext.activeMutationId).toEqual(logicalState.activeMutationId);
    expect(copy1.plaintext.fallbackCommitHomeRef).toEqual(initial.logicalState.activeCommitHomeRef);
    expect(backend.openHandleCount()).toBe(0);
    rootKey.destroy();
  });

  it("rejects non-consecutive reserved Publication Sequences before modifying a copy", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const initial = await createInitialSuperblockCopies({
      backend,
      fileSystemId,
      logicalState: initialLogicalState(),
      randomSource,
      rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });

    await expect(publishMutationSuperblockCopies({
      backend,
      base: initial,
      fileSystemId,
      firstPublicationSequence: createPublicationSequence({ value: 4n }),
      logicalState: nextLogicalState({ previous: initial.logicalState }),
      randomSource,
      rootKey,
      secondPublicationSequence: createPublicationSequence({ value: 5n }),
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    })).rejects.toThrow("reserved Publication Sequences");
    const reopened = await openSuperblockCopies({
      backend, fileSystemId, rootKey, supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    expect(reopened.logicalState).toEqual(initial.logicalState);
    rootKey.destroy();
  });

  it("reports outcome resolution required when first-copy durability succeeds but its response is lost", async () => {
    const faultInjector = new DeterministicPhysicalStoreFaultInjector({
      schedule: [{ occurrence: 3, operation: "syncFileData", timing: "after" }],
    });
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({ faultInjector });
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const initial = await createInitialSuperblockCopies({
      backend, fileSystemId, logicalState: initialLogicalState(), randomSource, rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    const logicalState = nextLogicalState({ previous: initial.logicalState });

    const failure = await publishMutationSuperblockCopies({
      backend, base: initial, fileSystemId,
      firstPublicationSequence: createPublicationSequence({ value: 3n }),
      logicalState, randomSource, rootKey,
      secondPublicationSequence: createPublicationSequence({ value: 4n }),
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    }).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(SuperblockMutationPublicationError);
    expect(failure).toMatchObject({ outcome: "outcome_resolution_required" });
    expect(backend.openHandleCount()).toBe(0);
    await backend.crashAndRecover();
    const reopened = await openSuperblockCopies({
      backend, fileSystemId, rootKey, supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    expect(reopened.logicalState).toEqual(logicalState);
    expect(reopened.copyState).toBe("superblock_redundancy_degraded");
    faultInjector.assertExhausted();
    rootKey.destroy();
  });

  it("resolves a lost first-copy response by rereading authority instead of retrying", async () => {
    const faultInjector = new DeterministicPhysicalStoreFaultInjector({
      schedule: [{ occurrence: 3, operation: "syncFileData", timing: "after" }],
    });
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({ faultInjector });
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const base = await createInitialSuperblockCopies({
      backend,
      fileSystemId,
      logicalState: initialLogicalState(),
      randomSource,
      rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    const intendedLogicalState = nextLogicalState({ previous: base.logicalState });

    await expect(publishMutationSuperblockCopies({
      backend,
      base,
      fileSystemId,
      firstPublicationSequence: createPublicationSequence({ value: 3n }),
      logicalState: intendedLogicalState,
      randomSource,
      rootKey,
      secondPublicationSequence: createPublicationSequence({ value: 4n }),
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    })).rejects.toMatchObject({ outcome: "outcome_resolution_required" });

    await expect(resolveMutationSuperblockPublication({
      backend,
      base,
      fileSystemId,
      intendedLogicalState,
      rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    })).resolves.toMatchObject({
      superblock: { copyState: "superblock_redundancy_degraded" },
      type: "published",
    });
    faultInjector.assertExhausted();
    rootKey.destroy();
  });

  it("resolves a pre-write revocation as not published", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const base = await createInitialSuperblockCopies({
      backend,
      fileSystemId,
      logicalState: initialLogicalState(),
      randomSource,
      rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    const intendedLogicalState = nextLogicalState({ previous: base.logicalState });
    await expect(publishMutationSuperblockCopies({
      backend,
      base,
      beforeFirstAuthorityWrite: () => {
        throw new Error("publication revoked");
      },
      fileSystemId,
      firstPublicationSequence: createPublicationSequence({ value: 3n }),
      logicalState: intendedLogicalState,
      randomSource,
      rootKey,
      secondPublicationSequence: createPublicationSequence({ value: 4n }),
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    })).rejects.toMatchObject({ outcome: "not_published" });

    await expect(resolveMutationSuperblockPublication({
      backend,
      base,
      fileSystemId,
      intendedLogicalState,
      rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    })).resolves.toMatchObject({ type: "not_published" });
    rootKey.destroy();
  });

  it("reports committed degraded when the second-copy write fails after the commit point", async () => {
    const faultInjector = new DeterministicPhysicalStoreFaultInjector({
      schedule: [{ occurrence: 4, operation: "writeAt", timing: "before" }],
    });
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({ faultInjector });
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const initial = await createInitialSuperblockCopies({
      backend, fileSystemId, logicalState: initialLogicalState(), randomSource, rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    const logicalState = nextLogicalState({ previous: initial.logicalState });

    const failure = await publishMutationSuperblockCopies({
      backend, base: initial, fileSystemId,
      firstPublicationSequence: createPublicationSequence({ value: 3n }),
      logicalState, randomSource, rootKey,
      secondPublicationSequence: createPublicationSequence({ value: 4n }),
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    }).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(SuperblockMutationPublicationError);
    expect(failure).toMatchObject({ outcome: "committed_redundancy_degraded" });
    const reopened = await openSuperblockCopies({
      backend, fileSystemId, rootKey, supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    expect(reopened.logicalState).toEqual(logicalState);
    expect(reopened.copyState).toBe("superblock_redundancy_degraded");
    expect(backend.openHandleCount()).toBe(0);
    faultInjector.assertExhausted();
    rootKey.destroy();
  });


  it("reserves after a structurally observed higher sequence even when that copy fails authentication", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    await createInitialSuperblockCopies({
      backend, fileSystemId, logicalState: initialLogicalState(), randomSource, rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    const path = canonicalContainerPath({ value: HIZOFS_SUPERBLOCK_FILES[0] });
    const raw = await backend.readFileBounded({
      maximumByteLength: HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.superblockFile,
      path,
    });
    if (raw === undefined) throw new Error("expected Superblock copy");
    const headerSize = HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.superblockHeader;
    const oldHeader = decodeSuperblockHeader({ bytes: raw.subarray(0, headerSize) });
    const higherHeader = encodeSuperblockHeader({ header: createSuperblockHeader({
      activeCommitSequence: oldHeader.activeCommitSequence,
      copy: 0,
      fileSystemId,
      flags: oldHeader.flags,
      nonce: superblockNonce({ bytes: oldHeader.nonce }),
      publicationSequence: createPublicationSequence({ value: 10n }),
    }) });
    const invalid = new Uint8Array(raw);
    invalid.set(higherHeader, 0);
    const file = await backend.openFileForUpdate({ path });
    await backend.writeAt({ bytes: authenticatedHizoFSPhysicalBytes({ bytes: invalid }), file, offset: 0n });
    await backend.syncFileData({ file });
    await backend.closeFile({ file });

    const opened = await openSuperblockCopies({
      backend, fileSystemId, rootKey, supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    expect(opened.selectedPublicationSequence).toBe(2n);
    expect(opened.maximumStructurallyObservedPublicationSequence).toBe(10n);
    expect(opened.copyState).toBe("superblock_redundancy_degraded");
    rootKey.destroy();
  });

  it("checks the final publication gate before recreating a missing opposite copy", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    await createInitialSuperblockCopies({
      backend,
      fileSystemId,
      logicalState: initialLogicalState(),
      randomSource,
      rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    const missingPath = canonicalContainerPath({ value: HIZOFS_SUPERBLOCK_FILES[0] });
    await backend.removeFile({ path: missingPath });
    const degraded = await openSuperblockCopies({
      backend,
      fileSystemId,
      rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    expect(degraded.selectedCopy).toBe(1);

    const failure = await publishMutationSuperblockCopies({
      backend,
      base: degraded,
      beforeFirstAuthorityWrite: () => {
        throw new Error("publication revoked");
      },
      fileSystemId,
      firstPublicationSequence: createPublicationSequence({ value: 3n }),
      logicalState: nextLogicalState({ previous: degraded.logicalState }),
      randomSource,
      rootKey,
      secondPublicationSequence: createPublicationSequence({ value: 4n }),
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    }).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(SuperblockMutationPublicationError);
    expect(failure).toMatchObject({ outcome: "not_published" });
    await expect(backend.readFileBounded({
      maximumByteLength: HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.superblockFile,
      path: missingPath,
    })).resolves.toBeUndefined();
    rootKey.destroy();
  });

  it("rejects an old captured base when another publication has already advanced authority", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const initial = await createInitialSuperblockCopies({
      backend, fileSystemId, logicalState: initialLogicalState(), randomSource, rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    await publishMutationSuperblockCopies({
      backend, base: initial, fileSystemId,
      firstPublicationSequence: createPublicationSequence({ value: 3n }),
      logicalState: nextLogicalState({ previous: initial.logicalState }),
      randomSource, rootKey,
      secondPublicationSequence: createPublicationSequence({ value: 4n }),
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });

    const staleAttempt = publishMutationSuperblockCopies({
      backend, base: initial, fileSystemId,
      firstPublicationSequence: createPublicationSequence({ value: 3n }),
      logicalState: nextLogicalState({ previous: initial.logicalState }),
      randomSource, rootKey,
      secondPublicationSequence: createPublicationSequence({ value: 4n }),
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    await expect(staleAttempt).rejects.toBeInstanceOf(SuperblockPublicationConflictError);
    const reopened = await openSuperblockCopies({
      backend, fileSystemId, rootKey, supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    expect(reopened.logicalState.activeCommitSequence).toBe(2n);
    rootKey.destroy();
  });


  it("publishes a relocation-only authority change without changing Commit or Mutation state", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const base = await createInitialSuperblockCopies({
      backend,
      fileSystemId,
      logicalState: initialLogicalState(),
      randomSource,
      rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    const intended = relocationLogicalState({ previous: base.logicalState });
    const published = await publishRelocationSuperblockCopies({
      backend,
      base,
      fileSystemId,
      firstPublicationSequence: createPublicationSequence({ value: 3n }),
      logicalState: intended,
      randomSource,
      rootKey,
      secondPublicationSequence: createPublicationSequence({ value: 4n }),
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    expect(published.copyState).toBe("normal");
    expect(published.authenticatedLogicalStates).toEqual([intended, intended]);
    expect(published.logicalState).toEqual(intended);
    expect(published.logicalState.activeCommitHomeRef).toEqual(base.logicalState.activeCommitHomeRef);
    expect(published.logicalState.activeCommitSequence).toBe(base.logicalState.activeCommitSequence);
    expect(published.logicalState.activeMutationId).toEqual(base.logicalState.activeMutationId);
    expect(published.logicalState.fallbackCommitHomeRef).toEqual(base.logicalState.fallbackCommitHomeRef);
    expect(published.maximumStructurallyObservedPublicationSequence).toBe(4n);
    rootKey.destroy();
  });

  it("rejects relocation publication that changes logical filesystem authority", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const base = await createInitialSuperblockCopies({
      backend,
      fileSystemId,
      logicalState: initialLogicalState(),
      randomSource,
      rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    await expect(publishRelocationSuperblockCopies({
      backend,
      base,
      fileSystemId,
      firstPublicationSequence: createPublicationSequence({ value: 3n }),
      logicalState: {
        ...relocationLogicalState({ previous: base.logicalState }),
        activeMutationId: parseMutationId({ bytes: new Uint8Array(16).fill(99) }),
      },
      randomSource,
      rootKey,
      secondPublicationSequence: createPublicationSequence({ value: 4n }),
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    })).rejects.toThrow("preserve Commit, Mutation");
    expect((await openSuperblockCopies({
      backend,
      fileSystemId,
      rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    })).logicalState).toEqual(base.logicalState);
    rootKey.destroy();
  });

  it("resolves a lost first-copy relocation response by rereading authority", async () => {
    const faultInjector = new DeterministicPhysicalStoreFaultInjector({
      schedule: [{ occurrence: 3, operation: "syncFileData", timing: "after" }],
    });
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({ faultInjector });
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const base = await createInitialSuperblockCopies({
      backend,
      fileSystemId,
      logicalState: initialLogicalState(),
      randomSource,
      rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    const intended = relocationLogicalState({ previous: base.logicalState });
    const failure = await publishRelocationSuperblockCopies({
      backend,
      base,
      fileSystemId,
      firstPublicationSequence: createPublicationSequence({ value: 3n }),
      logicalState: intended,
      randomSource,
      rootKey,
      secondPublicationSequence: createPublicationSequence({ value: 4n }),
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    }).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(SuperblockRelocationPublicationError);
    expect(failure).toMatchObject({ outcome: "outcome_resolution_required" });
    await backend.crashAndRecover();
    await expect(resolveRelocationSuperblockPublication({
      backend,
      base,
      fileSystemId,
      intendedLogicalState: intended,
      rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    })).resolves.toMatchObject({ type: "published" });
    faultInjector.assertExhausted();
    rootKey.destroy();
  });


  it("publishes a minimum Unlock Sequence update without changing filesystem authority", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const base = await createInitialSuperblockCopies({
      backend, fileSystemId, logicalState: initialLogicalState(), randomSource, rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    const intended: SuperblockLogicalState = {
      ...base.logicalState,
      minimumUnlockSequence: createUnlockSequence({ value: 2n }),
    };
    const published = await publishUnlockFloorSuperblockCopies({
      backend,
      base,
      fileSystemId,
      firstPublicationSequence: createPublicationSequence({ value: 3n }),
      logicalState: intended,
      randomSource,
      rootKey,
      secondPublicationSequence: createPublicationSequence({ value: 4n }),
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    expect(published.logicalState).toEqual(intended);
    expect(published.copyState).toBe("normal");
    expect(published.selectedPublicationSequence).toBe(4n);
    rootKey.destroy();
  });

  it("rejects credential floor updates that alter or do not advance other authority", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const base = await createInitialSuperblockCopies({
      backend, fileSystemId, logicalState: initialLogicalState(), randomSource, rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    await expect(publishUnlockFloorSuperblockCopies({
      backend,
      base,
      fileSystemId,
      firstPublicationSequence: createPublicationSequence({ value: 3n }),
      logicalState: base.logicalState,
      randomSource,
      rootKey,
      secondPublicationSequence: createPublicationSequence({ value: 4n }),
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    })).rejects.toThrow("strictly increase");
    await expect(publishUnlockFloorSuperblockCopies({
      backend,
      base,
      fileSystemId,
      firstPublicationSequence: createPublicationSequence({ value: 3n }),
      logicalState: nextLogicalState({ previous: { ...base.logicalState, minimumUnlockSequence: createUnlockSequence({ value: 2n }) } }),
      randomSource,
      rootKey,
      secondPublicationSequence: createPublicationSequence({ value: 4n }),
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    })).rejects.toThrow("must preserve");
    rootKey.destroy();
  });

  it("resolves response loss and preserves the new credential floor after second-copy failure", async () => {
    const faultInjector = new DeterministicPhysicalStoreFaultInjector({
      schedule: [{ occurrence: 4, operation: "writeAt", timing: "before" }],
    });
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({ faultInjector });
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const base = await createInitialSuperblockCopies({
      backend, fileSystemId, logicalState: initialLogicalState(), randomSource, rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    const intended = { ...base.logicalState, minimumUnlockSequence: createUnlockSequence({ value: 2n }) };
    const failure = await publishUnlockFloorSuperblockCopies({
      backend,
      base,
      fileSystemId,
      firstPublicationSequence: createPublicationSequence({ value: 3n }),
      logicalState: intended,
      randomSource,
      rootKey,
      secondPublicationSequence: createPublicationSequence({ value: 4n }),
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    }).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(SuperblockUnlockFloorPublicationError);
    expect(failure).toMatchObject({ outcome: "published_redundancy_degraded" });
    await expect(resolveUnlockFloorSuperblockPublication({
      backend, base, fileSystemId, intendedLogicalState: intended, rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    })).resolves.toMatchObject({ type: "published" });
    faultInjector.assertExhausted();
    rootKey.destroy();
  });

});
