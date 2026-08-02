import { describe, expect, it } from "vitest";
import emptyContainerGolden from "./test-fixtures/empty-container-v1.json";
import emptyContainerPortable from "./test-fixtures/empty-container-portable-v1.json";
import {
  HIZOFS_SUPERBLOCK_FILES,
  HIZOFS_UNLOCK_ENVELOPE_FILES,
  HIZOFS_V1_FORMAT_CONSTANTS,
  createCommitSequence,
  createFeatureBits,
  createFileSystemCommitPayload,
  createPublicationSequence,
  createSuperblockHeader,
  encodeFileSystemCommitPayload,
  encodeSuperblockHeader,
  encodeSuperblockPlaintext,
  parseFileSystemId,
  segmentIdToRelativePath,
  type FileSystemId,
  type PublicationId,
  type SuperblockPlaintextV1,
} from "@/00-storage/service/hizofs/00-format";
import {
  authenticatedHizoFSPhysicalBytes,
  type AuthenticatedHizoFSPhysicalBytes,
} from "@/00-storage/service/hizofs/authenticated-store/physical-bytes";
import {
  createEmptyEncryptedContainer,
  createEmptyEncryptedContainerWithPassphrases,
  openEmptyEncryptedContainer,
} from "@/00-storage/service/hizofs/authenticated-store/empty-container-store";
import {
  createInitialBootstrapSegment,
  readInitialBootstrapRoot,
} from "@/00-storage/service/hizofs/authenticated-store/bootstrap-segment-store";
import {
  createAuthenticatedSegmentWriter,
  encodedHizoFSRecord,
} from "@/00-storage/service/hizofs/authenticated-store/record-appender";
import type { SuperblockLogicalState } from "@/00-storage/service/hizofs/authenticated-store/superblock-store";
import {
  prepareInitialUnlockEnvelopeCopies,
  publishInitialUnlockEnvelopeCopies,
} from "@/00-storage/service/hizofs/authenticated-store/unlock-envelope-store";
import { createAuthenticatedWholeFile } from "@/00-storage/service/hizofs/authenticated-store/whole-file";
import {
  encryptSuperblock,
  generateMutationId,
  generatePublicationId,
  generateSuperblockNonce,
  plaintextSuperblockBytes,
  type FileSystemRootKey,
  type RandomByteSource,
} from "@/00-storage/service/hizofs/01-crypto";
import {
  CANONICAL_CONTAINER_ROOT,
  canonicalContainerDirectory,
  canonicalContainerPath,
  type CanonicalContainerDirectory,
} from "@/00-storage/service/hizofs/physical-store/paths";
import {
  DeterministicPhysicalStoreFaultInjector,
  InjectedPhysicalStoreFault,
} from "@/00-storage/service/hizofs/physical-store/testing/deterministic-fault-injector";
import { InMemoryCrashDurabilityBackend } from "@/00-storage/service/hizofs/physical-store/testing/in-memory-crash-durability-backend";
import type { HizoFSReadableBackend } from "@/00-storage/service/hizofs/physical-store/backend";

function deterministicRandomSource(): RandomByteSource {
  let next = 1;
  return ({ bytes }) => {
    for (let index = 0; index < bytes.byteLength; index += 1) {
      bytes[index] = next;
      next = next === 251 ? 1 : next + 1;
    }
  };
}

const supportedFeatureBits = createFeatureBits({ value: 0n });

type GoldenFile = Readonly<{
  byteLength: number;
  path: string;
  sha256: string;
}>;

function toHex({ bytes }: { bytes: Uint8Array }): string {
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}



async function verifyPortableGoldenFiles({
  backend,
}: {
  backend: InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>;
}): Promise<void> {
  expect(emptyContainerPortable.schema).toBe("hizofs-v1-empty-container-fixture");
  expect(emptyContainerPortable.schemaVersion).toBe(1);
  expect(emptyContainerPortable.files.map(entry => entry.path)).toEqual(
    emptyContainerGolden.map(entry => entry.path),
  );
  for (const entry of emptyContainerPortable.files) {
    const bytes = await backend.readFileBounded({
      maximumByteLength: entry.byteLength,
      path: canonicalContainerPath({ value: entry.path }),
    });
    if (bytes === undefined) throw new Error(`portable fixture file disappeared: ${entry.path}`);
    expect(bytes.byteLength).toBe(entry.byteLength);
    expect(toHex({ bytes })).toBe(entry.hex);
  }
}

async function corruptLastByte({
  backend,
  path,
}: {
  backend: InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>;
  path: string;
}): Promise<void> {
  const canonicalPath = canonicalContainerPath({ value: path });
  const bytes = await backend.readFileBounded({ maximumByteLength: 65_536, path: canonicalPath });
  if (bytes === undefined || bytes.byteLength === 0) throw new Error(`cannot corrupt missing or empty file: ${path}`);
  const corrupted = Uint8Array.from(bytes);
  const lastByteIndex = corrupted.byteLength - 1;
  const lastByte = corrupted[lastByteIndex];
  if (lastByte === undefined) throw new Error(`cannot corrupt missing final byte: ${path}`);
  corrupted[lastByteIndex] = lastByte ^ 0x01;
  const file = await backend.openFileForUpdate({ path: canonicalPath });
  try {
    await backend.writeAt({
      bytes: authenticatedHizoFSPhysicalBytes({ bytes: corrupted }),
      file,
      offset: 0n,
    });
    await backend.syncFileData({ file });
  } finally {
    await backend.closeFile({ file });
  }
}

async function publishSuperblockFixture({
  backend,
  copy,
  fileSystemId,
  logicalState,
  publicationSequence,
  randomSource,
  rootKey,
  usedPublicationIds,
}: {
  backend: InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>;
  copy: 0 | 1;
  fileSystemId: FileSystemId;
  logicalState: SuperblockLogicalState;
  publicationSequence: bigint;
  randomSource: RandomByteSource;
  rootKey: FileSystemRootKey;
  usedPublicationIds: PublicationId[];
}): Promise<void> {
  const nonce = generateSuperblockNonce({ randomSource });
  const publicationId = await generatePublicationId({
    isUsed: async ({ id }) => usedPublicationIds.some(used => toHex({ bytes: used }) === toHex({ bytes: id })),
    randomSource,
  });
  usedPublicationIds.push(publicationId);
  let flags = HIZOFS_V1_FORMAT_CONSTANTS.flags.superblockFallbackCommitPresent;
  if (logicalState.relocationIndexRootPhysicalRef !== null) {
    flags |= HIZOFS_V1_FORMAT_CONSTANTS.flags.superblockRelocationIndexRootPresent;
  }
  const header = createSuperblockHeader({
    activeCommitSequence: logicalState.activeCommitSequence,
    copy,
    fileSystemId,
    flags,
    nonce,
    publicationSequence: createPublicationSequence({ value: publicationSequence }),
  });
  const exactHeader = encodeSuperblockHeader({ header });
  const plaintext: SuperblockPlaintextV1 = {
    activeCommitHomeRef: logicalState.activeCommitHomeRef,
    activeMutationId: logicalState.activeMutationId,
    fallbackCommitHomeRef: logicalState.fallbackCommitHomeRef,
    minimumUnlockSequence: logicalState.minimumUnlockSequence,
    publicationId,
    relocationIndexRootPhysicalRef: logicalState.relocationIndexRootPhysicalRef,
    requiredFeatureBits: logicalState.requiredFeatureBits,
  };
  const encrypted = await encryptSuperblock({
    copy,
    exactHeader,
    fileSystemId,
    nonce,
    plaintext: plaintextSuperblockBytes({ bytes: encodeSuperblockPlaintext({ flags, plaintext }) }),
    publicationSequence: header.publicationSequence,
    rootKey,
  });
  const bytes = new Uint8Array(exactHeader.byteLength + encrypted.byteLength);
  bytes.set(exactHeader);
  bytes.set(encrypted, exactHeader.byteLength);
  await createAuthenticatedWholeFile({
    backend,
    bytes: authenticatedHizoFSPhysicalBytes({ bytes }),
    path: canonicalContainerPath({ value: HIZOFS_SUPERBLOCK_FILES[copy] }),
  });
}

async function collectGoldenFiles({
  backend,
  directory = CANONICAL_CONTAINER_ROOT,
}: {
  backend: InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>;
  directory?: CanonicalContainerDirectory;
}): Promise<readonly GoldenFile[]> {
  const files: GoldenFile[] = [];
  for (const entry of await backend.list({ directory })) {
    const value = directory === "" ? entry.name : `${directory}/${entry.name}`;
    switch (entry.kind) {
    case "directory":
      files.push(...await collectGoldenFiles({
        backend,
        directory: canonicalContainerDirectory({ value }),
      }));
      break;
    case "file": {
      const bytes = await backend.readFileBounded({
        maximumByteLength: Number(entry.byteLength),
        path: canonicalContainerPath({ value }),
      });
      if (bytes === undefined) throw new Error(`golden file disappeared: ${value}`);
      const digestInput = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(digestInput).set(bytes);
      files.push({
        byteLength: bytes.byteLength,
        path: value,
        sha256: toHex({ bytes: new Uint8Array(await crypto.subtle.digest("SHA-256", digestInput)) }),
      });
      break;
    }
    default:
      throw new Error(`Unhandled golden entry: ${((entry satisfies never) as { readonly kind: string }).kind}`);
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

describe("HizoFS empty encrypted container", () => {
  it("creates, closes, reopens, and traverses an empty root", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const opened = await createEmptyEncryptedContainer({
      backend,
      passphrase: emptyContainerPortable.passphrase,
      randomSource: deterministicRandomSource(),
      supportedFeatureBits,
    });

    expect(opened.fileSystemId).toBe(emptyContainerPortable.fileSystemId);
    expect(opened.credentialCopyState).toBe("normal");
    expect(opened.dataOpenMode).toBe("normal");
    expect(opened.superblockCopyState).toBe("normal");
    expect(opened.rootDirectoryInode.content).toEqual({ entries: [], type: "inline" });
    expect(opened.commit.commitSequence).toBe(1n);
    expect(opened.rootKey.isDestroyed()).toBe(false);
    expect(backend.openHandleCount()).toBe(0);
    opened.rootKey.destroy();
    await backend.crashAndRecover();

    const reopened = await openEmptyEncryptedContainer({
      backend,
      passphrase: emptyContainerPortable.passphrase,
      supportedFeatureBits,
    });
    expect(reopened.fileSystemId).toBe(opened.fileSystemId);
    expect(reopened.rootDirectoryInode.inodeNumber).toBe(1n);
    expect(await collectGoldenFiles({ backend })).toEqual(emptyContainerGolden);
    await verifyPortableGoldenFiles({ backend });
    reopened.rootKey.destroy();
    expect(backend.openHandleCount()).toBe(0);
  });

  it("uses an explicitly reserved File System ID for transition target creation", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const fileSystemId = parseFileSystemId({ value: "transitionTarget00001" });
    const opened = await createEmptyEncryptedContainer({
      backend,
      fileSystemId,
      passphrase: "correct horse battery staple",
      randomSource: deterministicRandomSource(),
      supportedFeatureBits,
    });

    expect(opened.fileSystemId).toBe(fileSystemId);
    opened.rootKey.destroy();
    await expect(openEmptyEncryptedContainer({
      backend,
      passphrase: "correct horse battery staple",
      supportedFeatureBits,
    })).resolves.toMatchObject({ fileSystemId });
  });

  it("does not acknowledge an interrupted second Superblock publication", async () => {
    const faultInjector = new DeterministicPhysicalStoreFaultInjector({
      schedule: [{ occurrence: 5, operation: "createFileExclusive", timing: "after" }],
    });
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({ faultInjector });

    await expect(createEmptyEncryptedContainer({
      backend,
      passphrase: "passphrase",
      randomSource: deterministicRandomSource(),
      supportedFeatureBits,
    })).rejects.toBeInstanceOf(InjectedPhysicalStoreFault);
    expect(backend.openHandleCount()).toBe(0);
    expect(() => faultInjector.assertExhausted()).not.toThrow();

    await backend.crashAndRecover();
    const reopened = await openEmptyEncryptedContainer({
      backend,
      passphrase: "passphrase",
      supportedFeatureBits,
    });
    expect(reopened.superblockCopyState).toBe("superblock_redundancy_degraded");
    expect(reopened.rootDirectoryInode.content).toEqual({ entries: [], type: "inline" });
    reopened.rootKey.destroy();
  });

  it("does not acknowledge a target whose second initial credential copy is interrupted", async () => {
    const faultInjector = new DeterministicPhysicalStoreFaultInjector({
      // The bootstrap Segment and first Unlock Envelope copy are the first two
      // whole-file creations. Failing after creation of the second copy proves
      // that one authenticated credential copy is not enough to acknowledge a
      // transition target before its Superblock authority exists.
      schedule: [{ occurrence: 3, operation: "createFileExclusive", timing: "after" }],
    });
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({ faultInjector });

    await expect(createEmptyEncryptedContainerWithPassphrases({
      backend,
      passphrases: ["primary retained credential", "secondary retained credential"],
      randomSource: deterministicRandomSource(),
      supportedFeatureBits,
    })).rejects.toBeInstanceOf(InjectedPhysicalStoreFault);
    expect(backend.openHandleCount()).toBe(0);
    expect(() => faultInjector.assertExhausted()).not.toThrow();

    await backend.crashAndRecover();
    expect(await backend.getFileSize({
      path: canonicalContainerPath({ value: HIZOFS_UNLOCK_ENVELOPE_FILES[0] }),
    })).toBeGreaterThan(0n);
    expect(await backend.getFileSize({
      path: canonicalContainerPath({ value: HIZOFS_UNLOCK_ENVELOPE_FILES[1] }),
    })).toBeUndefined();
    for (const passphrase of ["primary retained credential", "secondary retained credential"]) {
      await expect(openEmptyEncryptedContainer({
        backend,
        passphrase,
        supportedFeatureBits,
      })).rejects.toMatchObject({ code: "incomplete_container" });
    }
    expect(backend.openHandleCount()).toBe(0);
  });

  it("rejects a wrong passphrase after a completed create", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const opened = await createEmptyEncryptedContainer({
      backend,
      passphrase: "right",
      randomSource: deterministicRandomSource(),
      supportedFeatureBits,
    });
    opened.rootKey.destroy();

    await expect(openEmptyEncryptedContainer({
      backend,
      passphrase: "wrong",
      supportedFeatureBits,
    })).rejects.toMatchObject({ code: "credential_rejected" });
    expect(backend.openHandleCount()).toBe(0);
  });

  it("falls back to one authenticated Superblock copy and rejects loss of both", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const opened = await createEmptyEncryptedContainer({
      backend,
      passphrase: "passphrase",
      randomSource: deterministicRandomSource(),
      supportedFeatureBits,
    });
    opened.rootKey.destroy();

    await corruptLastByte({ backend, path: HIZOFS_SUPERBLOCK_FILES[1] });
    const degraded = await openEmptyEncryptedContainer({
      backend,
      passphrase: "passphrase",
      supportedFeatureBits,
    });
    expect(degraded.superblockCopyState).toBe("superblock_redundancy_degraded");
    degraded.rootKey.destroy();

    await corruptLastByte({ backend, path: HIZOFS_SUPERBLOCK_FILES[0] });
    await expect(openEmptyEncryptedContainer({
      backend,
      passphrase: "passphrase",
      supportedFeatureBits,
    })).rejects.toMatchObject({ code: "control_plane_corrupt" });
    expect(backend.openHandleCount()).toBe(0);
  });

  it("fails closed when the active metadata segment is corrupted", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const opened = await createEmptyEncryptedContainer({
      backend,
      passphrase: "passphrase",
      randomSource: deterministicRandomSource(),
      supportedFeatureBits,
    });
    opened.rootKey.destroy();
    const segment = (await collectGoldenFiles({ backend })).find(file => file.path.startsWith("segments/"));
    if (segment === undefined) throw new Error("expected initial metadata segment");
    await corruptLastByte({ backend, path: segment.path });

    await expect(openEmptyEncryptedContainer({
      backend,
      passphrase: "passphrase",
      supportedFeatureBits,
    })).rejects.toMatchObject({ code: "control_plane_corrupt" });
    expect(backend.openHandleCount()).toBe(0);
  });

  it("opens only the explicit previous Commit read-only when the active Commit is unavailable", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const prepared = await prepareInitialUnlockEnvelopeCopies({
      passphrase: "passphrase",
      randomSource,
    });
    try {
      const fallbackAuthority = await createInitialBootstrapSegment({
        backend,
        fileSystemId: prepared.fileSystemId,
        randomSource,
        rootKey: prepared.rootKey,
      });
      const fallbackRoot = await readInitialBootstrapRoot({
        ...fallbackAuthority,
        backend,
        fileSystemId: prepared.fileSystemId,
        rootKey: prepared.rootKey,
      });
      const writer = await createAuthenticatedSegmentWriter({
        backend,
        fileSystemId: prepared.fileSystemId,
        randomSource,
        rootKey: prepared.rootKey,
        segmentClass: "metadata",
      });
      const activeMutationId = await generateMutationId({ isUsed: async () => false, randomSource });
      const activeCommitSequence = createCommitSequence({ value: 2n });
      const activeCommit = createFileSystemCommitPayload({ payload: {
        commitSequence: activeCommitSequence,
        mutationId: activeMutationId,
        nestedSubvolumeTableRootHomeRef: fallbackRoot.commit.nestedSubvolumeTableRootHomeRef,
        nextInodeNumber: fallbackRoot.commit.nextInodeNumber,
        nextSubvolumeId: fallbackRoot.commit.nextSubvolumeId,
        rootDirectoryInodeNumber: fallbackRoot.commit.rootDirectoryInodeNumber,
        rootInodeTableRootHomeRef: fallbackRoot.commit.rootInodeTableRootHomeRef,
      } });
      const [appended] = await writer.append({ records: [encodedHizoFSRecord({
        plaintext: encodeFileSystemCommitPayload({ payload: activeCommit }),
        recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
      })] });
      if (appended?.type !== "home") throw new Error("expected an ordinary active Commit record");
      await writer.seal();
      await publishInitialUnlockEnvelopeCopies({ backend, prepared });
      const logicalState: SuperblockLogicalState = {
        activeCommitHomeRef: appended.homeReference,
        activeCommitSequence,
        activeMutationId,
        fallbackCommitHomeRef: fallbackAuthority.activeCommitHomeRef,
        minimumUnlockSequence: prepared.unlockSequence,
        relocationIndexRootPhysicalRef: null,
        requiredFeatureBits: supportedFeatureBits,
      };
      const usedPublicationIds: PublicationId[] = [];
      await publishSuperblockFixture({
        backend,
        copy: 0,
        fileSystemId: prepared.fileSystemId,
        logicalState,
        publicationSequence: 1n,
        randomSource,
        rootKey: prepared.rootKey,
        usedPublicationIds,
      });
      await publishSuperblockFixture({
        backend,
        copy: 1,
        fileSystemId: prepared.fileSystemId,
        logicalState,
        publicationSequence: 2n,
        randomSource,
        rootKey: prepared.rootKey,
        usedPublicationIds,
      });
      prepared.rootKey.destroy();
      await backend.removeFile({
        path: canonicalContainerPath({
          value: segmentIdToRelativePath({ id: writer.physicalSegmentId, segmentClass: writer.segmentClass }),
        }),
      });

      const opened = await openEmptyEncryptedContainer({
        backend,
        passphrase: "passphrase",
        supportedFeatureBits,
      });
      expect(opened.dataOpenMode).toBe("fallback_read_only");
      expect(opened.commit.commitSequence).toBe(1n);
      expect(opened.rootDirectoryInode.content).toEqual({ entries: [], type: "inline" });
      opened.rootKey.destroy();
      expect(backend.openHandleCount()).toBe(0);
    } finally {
      if (!prepared.rootKey.isDestroyed()) prepared.rootKey.destroy();
    }
  });

  it("reopens as degraded after one Superblock copy is lost", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const opened = await createEmptyEncryptedContainer({
      backend,
      passphrase: "passphrase",
      randomSource: deterministicRandomSource(),
      supportedFeatureBits,
    });
    opened.rootKey.destroy();
    await backend.removeFile({
      path: canonicalContainerPath({ value: HIZOFS_SUPERBLOCK_FILES[1] }),
    });

    const reopened = await openEmptyEncryptedContainer({
      backend,
      passphrase: "passphrase",
      supportedFeatureBits,
    });
    expect(reopened.superblockCopyState).toBe("superblock_redundancy_degraded");
    expect(reopened.rootDirectoryInode.content).toEqual({ entries: [], type: "inline" });
    reopened.rootKey.destroy();
  });
});

describe("read-only container open contract", () => {
  it("opens through the readable backend surface without writable capability", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const created = await createEmptyEncryptedContainer({
      backend,
      passphrase: "passphrase",
      randomSource: deterministicRandomSource(),
      supportedFeatureBits,
    });
    created.rootKey.destroy();

    const readableBackend: HizoFSReadableBackend = {
      getFileSize: async ({ path }) => await backend.getFileSize({ path }),
      list: async ({ directory }) => await backend.list({ directory }),
      readExact: async ({ length, offset, path }) => await backend.readExact({ length, offset, path }),
      readFileBounded: async ({ maximumByteLength, path }) => await backend.readFileBounded({
        maximumByteLength,
        path,
      }),
    };

    const reopened = await openEmptyEncryptedContainer({
      backend: readableBackend,
      passphrase: "passphrase",
      supportedFeatureBits,
    });
    expect(reopened.dataOpenMode).toBe("normal");
    expect(reopened.rootDirectoryInode.content).toEqual({ entries: [], type: "inline" });
    reopened.rootKey.destroy();
  });
});
