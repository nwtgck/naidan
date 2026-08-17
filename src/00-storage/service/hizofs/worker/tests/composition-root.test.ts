import { createHash } from "node:crypto";
import nonemptyContainerPortable from "./test-fixtures/nonempty-container-portable-v1.json";
import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createCommitSequence,
  createFeatureBits,
  createFileSystemCommitPayload,
  createHomeRecordReference,
  createPhysicalRecordReference,
  createPublicationSequence,
  createSubvolumeId,
  createTimestampMilliseconds,
  createUInt64,
  createUnlockSequence,
  parseFileSystemId,
  parseMutationId,
  parsePublicationId,
  parseSegmentId,
  type FileSystemCommitPayload,
  type HomeRecordReference,
  type OpenedSuperblockCopies,
  type SuperblockLogicalState,
} from "@/00-storage/service/hizofs/00-format";
import type {
  HizoFSTransitionImportCandidate,
  HizoFSTransitionImportStatePort,
} from "@/00-storage/service/hizofs/api";
import { HizoFSStorageFileSystemSession } from "@/00-storage/service/hizofs/api/storage-file-system-session";
import {
  createInitialBootstrapSegment,
  readBootstrapRoot,
  readInitialBootstrapRoot,
} from "@/00-storage/service/hizofs/authenticated-store/bootstrap-segment-store";
import {
  createEmptyEncryptedContainer,
  createEmptyEncryptedContainerWithPassphrases,
  openEmptyEncryptedContainer,
  type OpenedEmptyEncryptedContainer,
} from "@/00-storage/service/hizofs/authenticated-store/empty-container-store";
import { createInitialUnlockEnvelopeCopies } from "@/00-storage/service/hizofs/authenticated-store/unlock-envelope-store";
import { createAuthenticatedMetadataMutationAuthority } from "@/00-storage/service/hizofs/authenticated-store/metadata-mutation-authority";
import { AuthenticatedSegmentWriterOwner } from "@/00-storage/service/hizofs/authenticated-store/active-segment-writer-owner";
import { PreparedMutationCommitPublicationError } from "@/00-storage/service/hizofs/authenticated-store/prepared-mutation-commit-store";
import type { AuthenticatedHizoFSPhysicalBytes } from "@/00-storage/service/hizofs/authenticated-store/physical-bytes";
import {
  createInitialSuperblockCopies,
  openSuperblockCopies,
} from "@/00-storage/service/hizofs/authenticated-store/superblock-store";
import {
  generateFileSystemRootKey,
  type FileSystemRootKeyProofDerivationCapability,
  type RandomByteSource,
} from "@/00-storage/service/hizofs/01-crypto";
import { ExplicitBulkCandidate } from "@/00-storage/service/hizofs/filesystem/bulk/explicit-bulk-candidate";
import { createCandidateFrameOrdinalAuthority } from "@/00-storage/service/hizofs/authenticated-store/candidate-frame-ordinal-authority";
import { createMaintenancePolicy } from "@/00-storage/service/hizofs/maintenance/maintenance-policy";
import { createMaintenanceRootSnapshot } from "@/00-storage/service/hizofs/maintenance/maintenance-root-snapshot";
import { createLogicalMaintenanceTraversalItem } from "@/00-storage/service/hizofs/maintenance/maintenance-traversal-item";
import { prepareMaintenanceCandidateSnapshot } from "@/00-storage/service/hizofs/maintenance/prepared-maintenance-candidate-snapshot";
import type {
  HizoFSDevelopmentWritableBackend,
  HizoFSPhysicalWriteBackend,
  HizoFSWritableFile,
} from "@/00-storage/service/hizofs/physical-store/backend";
import { OpfsWritableBackend } from "@/00-storage/service/hizofs/physical-store/opfs/opfs-writable-backend";
import { InMemoryOpfsDirectoryHandle } from "@/00-storage/service/test-support/in-memory-opfs";
import { InMemoryCrashDurabilityBackend } from "@/00-storage/service/hizofs/physical-store/testing/in-memory-crash-durability-backend";
import {
  CANONICAL_CONTAINER_ROOT,
  canonicalContainerDirectory,
  canonicalContainerPath,
  type CanonicalContainerDirectory,
} from "@/00-storage/service/hizofs/physical-store/paths";
import { createContainerCoordinationScope, parseContainerCoordinationScopeToken } from "@/00-storage/service/hizofs/runtime/container-coordination-scope";
import { HizoFSRuntimeDiagnosticsAccumulator } from "@/00-storage/service/hizofs/diagnostics/runtime-diagnostics";
import {
  createAuthenticatedApplicationGenerationDescriptor,
  createAuthenticatedStagedApplicationGenerationDescriptor,
} from "@/00-storage/service/hizofs/runtime/authenticated-application-generation";
import {
  createDurableGenerationIdentity,
  createSuccessorWorkingGenerationIdentity,
  createWorkingGenerationAuthorityEpoch,
  createWorkingGenerationIdentity,
  createWorkingGenerationNumber,
} from "@/00-storage/service/hizofs/runtime/application-generation-identity";
import { createTestingAuthenticatedDurableApplicationGenerationAuthority } from "@/00-storage/service/hizofs/runtime/testing/authenticated-application-generation-fixture";
import {
  STAGED_MUTATION_COMMIT_MATERIALIZATION_FRAME_BYTES,
  type DeferredPreparedMutationCommitPublication,
  type ResolvablePreparedMutationCommitDurablePublicationPort,
} from "@/00-storage/service/hizofs/filesystem/mutation/prepared-mutation-commit-publisher";
import type { CrossRealmLockPort } from "@/00-storage/service/hizofs/runtime/cross-realm-lock-coordinator";
import { InMemoryCrossRealmLockPort } from "@/00-storage/service/hizofs/runtime/testing/in-memory-cross-realm-lock-port";
import {
  captureAuthenticatedMaintenanceRoots,
  createAuthenticatedApplicationReadSessionResources,
  createBrowserHizoFSBenchmarkApplicationRuntime,
  createBrowserHizoFSTransitionTargetContainer,
  openBrowserHizoFSTransitionTargetEndpointSession,
  publishBrowserHizoFSTransitionTargetCandidate,
  verifyBrowserHizoFSTransitionTargetNormalOpen,
  HizoFSApplicationMutationCommittedDegradedError,
  HizoFSApplicationMutationSessionPoisonedError,
  openAuthenticatedDevelopmentWritableApplicationSessionFromCapability,
  openAuthenticatedDevelopmentWritableContainerCapability,
  openAuthenticatedReadOnlyApplicationSession,
  openAuthenticatedReadOnlyApplicationSessionFromCapability,
  openAuthenticatedReadOnlyContainerAuthority,
  openAuthenticatedReadOnlyContainerCapability,
  openAuthenticatedRootKeyProofContainerCapability,
  openAuthenticatedReadWriteApplicationSession,
  publishAuthenticatedExplicitBulkCommit,
  publishAuthenticatedOrdinaryEntryCreate,
  replaceAuthenticatedDevelopmentWritableSessionPassphrase,
  withAuthenticatedDevelopmentWritableSessionRetainedCredentials,
  withAuthenticatedDevelopmentWritableSessionRootKeyProof,
  TEST_ONLY as COMPOSITION_TEST_ONLY,
} from "@/00-storage/service/hizofs/worker/composition-root";
import { HizoFSWorkerRuntimeHost } from "@/00-storage/service/hizofs/worker/runtime-host";
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY,
  evaluateLazyPublicationRolloutGate,
  type HizoFSLazyDurabilityPolicy,
  type HizoFSLazyPublicationRolloutGateReceipt,
} from "@/00-storage/service/hizofs/runtime/runtime-policy";
const DEFAULT_EXPLICIT_BULK_TEST_LIMITS = Object.freeze({
  candidate: Object.freeze({ maxEntries: 100_000, maxInlineFileBytesTotal: 16 * 1024 * 1024 }),
  directoryImport: Object.freeze({ maximumEntryMutationsPerBatch: 64 }),
});

function maintenanceRootReference({ offset, seed }: { offset: bigint; seed: number }) {
  return createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: offset }),
    frameLength: 96,
    recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
    segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(seed) }),
  } });
}

function maintenanceRelocationRootReference({ offset, seed }: { offset: bigint; seed: number }) {
  return createPhysicalRecordReference({ fields: {
    byteOffset: createUInt64({ value: offset }),
    frameLength: 96,
    recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.relocation_index_page,
    segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(seed) }),
  } });
}

function maintenanceLogicalRoot(reference: ReturnType<typeof maintenanceRootReference>) {
  return createLogicalMaintenanceTraversalItem({ pageRole: "not_page", reference });
}

function maintenanceRuntimeCapture({
  epoch = 4,
  pinned = [maintenanceRootReference({ offset: 256n, seed: 3 })],
  sourcePinned = [],
}: {
  epoch?: number;
  pinned?: readonly ReturnType<typeof maintenanceRootReference>[];
  sourcePinned?: readonly ReturnType<typeof maintenanceRootReference>[];
} = {}) {
  const released = Promise.withResolvers<void>();
  const release = vi.fn(() => released.resolve());
  return {
    capture: {
      inspectorPinnedRoots: [],
      maintenanceRootEpoch: epoch,
      readerPinnedRoots: pinned,
      release,
      released: released.promise,
      sourceSegmentPinnedRoots: sourcePinned,
      unknownFeatureRoots: [],
      workingGenerationDependencyRoots: [],
      workingGenerationPageRoots: [],
    },
    release,
  };
}

function maintenanceCandidate({ frameCount = 2, seed = 7 }: { frameCount?: number; seed?: number } = {}) {
  const id = parseSegmentId({ bytes: new Uint8Array(16).fill(seed) });
  return Object.freeze({
    frameCount,
    frameOrdinalAuthority: createCandidateFrameOrdinalAuthority({
      frames: Array.from({ length: frameCount }, (_, ordinal) => ({
        frameLength: 128,
        physicalOffset: 64n + BigInt(ordinal * 128),
        recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
      })),
      segmentId: id,
    }),
    ownership: "sealed" as const,
    segmentId: id,
    totalFrameBytes: frameCount * 128,
  });
}

function maintenanceRemovalPlan({ seed = 7 }: { seed?: number } = {}) {
  return Object.freeze({
    disposition: "remove" as const,
    frameCount: 2,
    liveBytes: 0,
    liveFrameCount: 0,
    ownership: "sealed" as const,
    segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(seed) }),
    totalFrameBytes: 256,
  });
}

class DataSegmentWriteCountingBackend
  extends InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes> {
  public dataSegmentWriteAtOperations = 0;

  public override async writeAt(
    input: Parameters<InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>["writeAt"]>[0],
  ): ReturnType<InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>["writeAt"]> {
    if (input.file.path.startsWith("segments/data/")) this.dataSegmentWriteAtOperations += 1;
    return await super.writeAt(input);
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

function developmentBackend({ backend }: {
  backend: HizoFSPhysicalWriteBackend<AuthenticatedHizoFSPhysicalBytes>;
}): HizoFSDevelopmentWritableBackend<AuthenticatedHizoFSPhysicalBytes> {
  return {
    capabilities: {
      directoryEntryDurability: "not-demonstrated",
      fileDataDurability: "not-demonstrated",
    },
    closeFile: async ({ file }) => await backend.closeFile({ file }),
    createDirectoryExclusive: async ({ path }) => await backend.createDirectoryExclusive({ path }),
    createFileExclusive: async ({ path }) => await backend.createFileExclusive({ path }),
    getFileSize: async ({ path }) => await backend.getFileSize({ path }),
    getOpenFileSize: async ({ file }) => await backend.getOpenFileSize({ file }),
    list: async ({ directory }) => await backend.list({ directory }),
    openFileForUpdate: async ({ path }) => await backend.openFileForUpdate({ path }),
    readExact: async ({ length, offset, path }) => await backend.readExact({ length, offset, path }),
    readExactWithFileSize: async ({ length, offset, path }) => (
      await backend.readExactWithFileSize({ length, offset, path })
    ),
    readFileBounded: async ({ maximumByteLength, path }) => (
      await backend.readFileBounded({ maximumByteLength, path })
    ),
    removeFile: async ({ path }) => await backend.removeFile({ path }),
    syncDirectoryEntries: async ({ parent }) => await backend.syncDirectoryEntries({ parent }),
    syncFileData: async ({ file }) => await backend.syncFileData({ file }),
    truncate: async ({ file, length }) => await backend.truncate({ file, length }),
    writeAt: async ({ bytes, file, offset }) => await backend.writeAt({ bytes, file, offset }),
  };
}

function testBrowserLockManager(): LockManager {
  const held = new Set<string>();
  const request = async <T>(
    name: string,
    optionsOrCallback: LockOptions | LockGrantedCallback<T>,
    maybeCallback?: LockGrantedCallback<T>,
  ): Promise<Awaited<T>> => {
    const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
    if (callback === undefined) throw new Error("browser lock callback is required");
    held.add(name);
    try {
      return await callback({ name, mode: "exclusive" } as Lock);
    } finally {
      held.delete(name);
    }
  };
  return {
    query: async () => ({
      held: [...held].map(name => ({ clientId: "test", mode: "exclusive" as const, name })),
      pending: [],
    }),
    request: request as LockManager["request"],
  } as LockManager;
}

function runtimeHost({
  crossRealmLockPort = new InMemoryCrossRealmLockPort(),
  lazyDurability = DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY,
  lazyPublicationRollout,
}: {
  crossRealmLockPort?: CrossRealmLockPort;
  lazyDurability?: HizoFSLazyDurabilityPolicy;
  lazyPublicationRollout?: HizoFSLazyPublicationRolloutGateReceipt;
} = {}): HizoFSWorkerRuntimeHost {
  return new HizoFSWorkerRuntimeHost({
    crossRealmLockPort,
    ...(lazyPublicationRollout === undefined ? {} : { lazyPublicationRollout }),
    policy: {
      lazyDurability,
      maxDirectoryIteratorEntries: 32,
      maxHeldLockNames: 64,
      maxMaintenanceRootRegistrations: 64,
      maxReaderPins: 16,
      maxSegmentReferences: 16,
    },
    scope: createContainerCoordinationScope({
      token: parseContainerCoordinationScopeToken({ value: "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM" }),
    }),
  });
}

function immediateRuntimeHost(): HizoFSWorkerRuntimeHost {
  return runtimeHost({
    lazyDurability: {
      ...DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY,
      publicationModeRequest: "immediate",
    },
  });
}

async function collectPortableContainerFiles({
  backend,
  directory,
}: {
  backend: InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>;
  directory: CanonicalContainerDirectory;
}): Promise<readonly Readonly<{
  byteLength: number;
  hex: string;
  path: string;
  sha256: string;
}>[]> {
  const collected: {
    byteLength: number;
    hex: string;
    path: string;
    sha256: string;
  }[] = [];
  const visit = async ({ current }: { current: CanonicalContainerDirectory }): Promise<void> => {
    const entries = await backend.list({ directory: current });
    for (const entry of entries) {
      const path = current === CANONICAL_CONTAINER_ROOT ? entry.name : `${current}/${entry.name}`;
      switch (entry.kind) {
      case "directory":
        await visit({ current: canonicalContainerDirectory({ value: path }) });
        break;
      case "file": {
        if (entry.byteLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new RangeError(`portable fixture file is too large: ${path}`);
        }
        const byteLength = Number(entry.byteLength);
        const bytes = await backend.readFileBounded({
          maximumByteLength: byteLength,
          path: canonicalContainerPath({ value: path }),
        });
        if (bytes === undefined) throw new Error(`portable fixture file disappeared: ${path}`);
        collected.push({
          byteLength,
          hex: Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join(""),
          path,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
        break;
      }
      default: return entry satisfies never;
      }
    }
  };
  await visit({ current: directory });
  return collected.sort((left, right) => (left.path < right.path ? -1 : left.path === right.path ? 0 : 1));
}

async function createNonemptyPortableFixtureBackend(): Promise<
  InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>
  > {
  const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
  const randomSource = deterministicRandomSource();
  const supportedFeatureBits = createFeatureBits({ value: 0n });
  const opened = await createEmptyEncryptedContainer({
    backend,
    passphrase: "correct horse battery staple",
    randomSource,
    supportedFeatureBits,
  });
  let nextTimestamp = 1_700_000_000_000n;
  const session = await openAuthenticatedReadWriteApplicationSession({
    captureAuthority: async () => ({ revision: 1 }),
    recheckAuthority: async () => undefined,
    runtimeHost: immediateRuntimeHost(),
    verifyCapturedAuthority: async () => ({
      backend,
      canonicalBackingLocation: "memory://portable-nonempty.hizofs",
      explicitBulkLimits: {
        candidate: { maxEntries: 32, maxInlineFileBytesTotal: 4096 },
        directoryImport: { maximumEntryMutationsPerBatch: 16 },
      },
      fileMutationLimits: { maximumExtentMutationsPerBatch: 8 },
      opened,
      operationTimestamp: () => {
        const value = createTimestampMilliseconds({ value: nextTimestamp });
        nextTimestamp += 1n;
        return value;
      },
      randomSource,
      removalLimits: { deleteBatchSize: 16, maxVisitedInodes: 128 },
      recheckDurableGenerationAuthority: async () => undefined,
      rootSubvolumeId: createSubvolumeId({ value: 1n }),
      supportedFeatureBits,
      writableProfile: "release-qualified",
    }),
  });

  const hello = await session.root.getFileHandle({ create: true, name: "hello.txt" });
  const helloWritable = await hello.createWritable({ keepExistingData: false });
  await helloWritable.write({ data: new TextEncoder().encode("hello\n"), position: 0 });
  await helloWritable.close();
  const docs = await session.root.getDirectoryHandle({ create: true, name: "docs" });
  const nested = await docs.getFileHandle({ create: true, name: "nested.txt" });
  const nestedWritable = await nested.createWritable({ keepExistingData: false });
  await nestedWritable.write({ data: new TextEncoder().encode("nested\n"), position: 0 });
  await nestedWritable.close();
  await session.close();
  return backend;
}

async function writableFixture() {
  const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
  const randomSource = deterministicRandomSource();
  const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
  const supportedFeatureBits = createFeatureBits({ value: 0n });
  const rootKey = generateFileSystemRootKey({ randomSource });
  const bootstrap = await createInitialBootstrapSegment({ backend, fileSystemId, randomSource, rootKey });
  const baseCommitRoot = await readInitialBootstrapRoot({
    ...bootstrap,
    backend,
    fileSystemId,
    rootKey,
  });
  const baseSuperblock = await createInitialSuperblockCopies({
    backend,
    fileSystemId,
    logicalState: {
      activeCommitHomeRef: bootstrap.activeCommitHomeRef,
      activeCommitSequence: bootstrap.activeCommitSequence,
      activeMutationId: bootstrap.activeMutationId,
      fallbackCommitHomeRef: null,
      minimumUnlockSequence: createUnlockSequence({ value: 1n }),
      relocationIndexRootPhysicalRef: null,
      requiredFeatureBits: supportedFeatureBits,
    },
    randomSource,
    rootKey,
    supportedFeatureBits,
  });
  const authority = await createAuthenticatedMetadataMutationAuthority({
    backend,
    fileSystemId,
    randomSource,
    relocationIndexRootPhysicalRef: null,
    rootKey,
    supportedFeatureBits,
  });
  return {
    authority,
    backend,
    baseCommitRoot,
    baseSuperblock,
    fileSystemId,
    rootKey,
    supportedFeatureBits,
  };
}

function ordinaryCreateRequest({
  authority,
  baseCommitRoot,
  baseSuperblock,
  assertPublicationAllowed,
}: Readonly<{
  assertPublicationAllowed: () => void;
  authority: Awaited<ReturnType<typeof writableFixture>>["authority"];
  baseCommitRoot: Awaited<ReturnType<typeof writableFixture>>["baseCommitRoot"];
  baseSuperblock: Awaited<ReturnType<typeof writableFixture>>["baseSuperblock"];
}>): Parameters<typeof publishAuthenticatedOrdinaryEntryCreate>[0] {
  return {
    assertPublicationAllowed,
    authority,
    baseCommit: baseCommitRoot.commit,
    baseSuperblock,
    indexDiagnostics: undefined,
    maximumKnownInodeNumber: baseCommitRoot.rootDirectoryInode.inodeNumber,
    mutationId: parseMutationId({ bytes: new Uint8Array(16).fill(23) }),
    onCandidatePrepared: undefined,
    operationTimestamp: createTimestampMilliseconds({ value: 1_700_000_000_000n }),
    parent: baseCommitRoot.rootDirectoryInode,
    request: { type: "file" },
    target: {
      destinationExists: false,
      entryName: "created",
      parentAccess: "read_write",
      parentDirectoryInodeNumber: baseCommitRoot.rootDirectoryInode.inodeNumber,
      parentSubvolumeId: createSubvolumeId({ value: 1n }),
    },
  };
}

describe("HizoFS worker composition root", () => {
  it("projects an authenticated container into namespace-only application resources", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const opened = await createEmptyEncryptedContainer({
      backend,
      passphrase: "correct horse battery staple",
      randomSource: deterministicRandomSource(),
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    const resources = createAuthenticatedApplicationReadSessionResources({ backend, opened });

    expect(await resources.namespace.stat({ pathComponents: [] })).toMatchObject({
      inodeNumber: 1n,
      kind: "directory",
    });
    expect("rootKey" in resources).toBe(false);
    expect("backend" in resources).toBe(false);
    expect(resources.syncDurability).toBe("not-demonstrated");
    expect(opened.rootKey.isDestroyed()).toBe(false);

    await resources.releaseResources();
    await resources.releaseResources();
    expect(opened.rootKey.isDestroyed()).toBe(true);
  });

  it("opens a fallback application session through the authority handshake and rejects mutations", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const opened = await createEmptyEncryptedContainer({
      backend,
      passphrase: "correct horse battery staple",
      randomSource: deterministicRandomSource(),
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    const session = await openAuthenticatedReadOnlyApplicationSession({
      captureAuthority: async () => ({ revision: 1 }),
      recheckAuthority: async () => undefined,
      rootName: "fallback.hizofs",
      runtimeHost: runtimeHost(),
      verifyCapturedAuthority: async () => ({ backend, opened }),
    });

    expect(session.root).toMatchObject({ kind: "directory", name: "fallback.hizofs" });
    expect(await session.root.stat()).toMatchObject({ size: 0 });
    await expect(session.sync()).rejects.toMatchObject({
      code: "durability_not_demonstrated",
      implementation: "hizofs",
      retryable: false,
    });
    await expect(session.root.getFileHandle({ create: true, name: "blocked.bin" }))
      .rejects.toThrow("generation is read-only");
    expect(opened.rootKey.isDestroyed()).toBe(false);

    await session.close();
    expect(opened.rootKey.isDestroyed()).toBe(true);
  });

  it("installs runtime candidate authority before ordinary durable publication", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const supportedFeatureBits = createFeatureBits({ value: 0n });
    const opened = await createEmptyEncryptedContainer({
      backend,
      passphrase: "correct horse battery staple",
      randomSource,
      supportedFeatureBits,
    });
    const originalSyncFileData = backend.syncFileData.bind(backend);
    const reachedAuthoritySync = Promise.withResolvers<void>();
    const resumeAuthoritySync = Promise.withResolvers<void>();
    let blockNextSuperblockSync = false;
    backend.syncFileData = async ({ file }) => {
      await originalSyncFileData({ file });
      if (blockNextSuperblockSync && file.path.includes("superblock")) {
        blockNextSuperblockSync = false;
        reachedAuthoritySync.resolve();
        await resumeAuthoritySync.promise;
      }
    };
    const host = immediateRuntimeHost();
    const session = await openAuthenticatedReadWriteApplicationSession({
      captureAuthority: async () => ({ revision: 1 }),
      recheckAuthority: async () => undefined,
      runtimeHost: host,
      verifyCapturedAuthority: async () => ({
        backend,
        canonicalBackingLocation: "memory://composition-root-test.hizofs",
        explicitBulkLimits: DEFAULT_EXPLICIT_BULK_TEST_LIMITS,
        fileMutationLimits: { maximumExtentMutationsPerBatch: 2 },
        opened,
        operationTimestamp: () => createTimestampMilliseconds({ value: 1_700_000_000_000n }),
        randomSource,
        removalLimits: { deleteBatchSize: 2, maxVisitedInodes: 64 },
        recheckDurableGenerationAuthority: async () => undefined,
        rootSubvolumeId: createSubvolumeId({ value: 1n }),
        supportedFeatureBits,
        writableProfile: "release-qualified",
      }),
    });

    blockNextSuperblockSync = true;
    const mutation = session.root.getDirectoryHandle({ create: true, name: "docs" });
    await reachedAuthoritySync.promise;
    expect(host.workingCandidatePublicationState()).toBe("publishing");

    resumeAuthoritySync.resolve();
    await mutation;
    expect(host.workingCandidatePublicationState()).toBe("empty");
    const cleared = await host.beginMaintenanceRootCapture();
    expect(cleared.workingGenerationDependencyRoots).toEqual([]);
    cleared.release();
    await cleared.released;

    await session.close();
  });

  it("reuses allocator high-water proof across trusted ordinary-create successors", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const supportedFeatureBits = createFeatureBits({ value: 0n });
    const opened = await createEmptyEncryptedContainer({
      backend,
      passphrase: "correct horse battery staple",
      randomSource,
      supportedFeatureBits,
    });
    const indexOperations: string[] = [];
    const session = await openAuthenticatedReadWriteApplicationSession({
      captureAuthority: async () => ({ revision: 1 }),
      recheckAuthority: async () => undefined,
      runtimeHost: immediateRuntimeHost(),
      verifyCapturedAuthority: async () => ({
        backend,
        canonicalBackingLocation: "memory://composition-root-test.hizofs",
        explicitBulkLimits: DEFAULT_EXPLICIT_BULK_TEST_LIMITS,
        fileMutationLimits: { maximumExtentMutationsPerBatch: 2 },
        indexDiagnostics: {
          recordIndexOperation: ({ operation }) => indexOperations.push(operation),
        },
        opened,
        operationTimestamp: () => createTimestampMilliseconds({ value: 1_700_000_000_000n }),
        randomSource,
        removalLimits: { deleteBatchSize: 2, maxVisitedInodes: 64 },
        recheckDurableGenerationAuthority: async () => undefined,
        rootSubvolumeId: createSubvolumeId({ value: 1n }),
        supportedFeatureBits,
        writableProfile: "release-qualified",
      }),
    });

    const first = await session.root.getFileHandle({ create: true, name: "first.txt" });
    await session.root.getFileHandle({ create: true, name: "second.txt" });
    await session.root.getFileHandle({ create: true, name: "third.txt" });

    expect(indexOperations.filter(operation => operation === "seek_floor")).toHaveLength(1);
    expect(indexOperations.filter(operation => operation === "get")).toHaveLength(1);

    const writable = await first.createWritable({ keepExistingData: false });
    await writable.write({ data: Uint8Array.of(1), position: 0 });
    await writable.close();
    indexOperations.length = 0;
    await session.root.getFileHandle({ create: true, name: "after-file-mutation.txt" });
    expect(indexOperations.filter(operation => operation === "get")).toHaveLength(1);
    await session.close();
  });

  it("linearizes create-if-missing as one production mutation observation", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const supportedFeatureBits = createFeatureBits({ value: 0n });
    const passphrase = "correct horse battery staple";
    const opened = await createEmptyEncryptedContainer({
      backend,
      passphrase,
      randomSource,
      supportedFeatureBits,
    });
    const session = await openAuthenticatedReadWriteApplicationSession({
      captureAuthority: async () => ({ revision: 1 }),
      recheckAuthority: async () => undefined,
      runtimeHost: immediateRuntimeHost(),
      verifyCapturedAuthority: async () => ({
        backend,
        canonicalBackingLocation: "memory://composition-root-test.hizofs",
        explicitBulkLimits: DEFAULT_EXPLICIT_BULK_TEST_LIMITS,
        fileMutationLimits: { maximumExtentMutationsPerBatch: 2 },
        opened,
        operationTimestamp: () => createTimestampMilliseconds({ value: 1_700_000_000_000n }),
        randomSource,
        removalLimits: { deleteBatchSize: 2, maxVisitedInodes: 64 },
        recheckDurableGenerationAuthority: async () => undefined,
        rootSubvolumeId: createSubvolumeId({ value: 1n }),
        supportedFeatureBits,
        writableProfile: "release-qualified",
      }),
    });

    const first = await session.root.getFileHandle({ create: true, name: "stable.txt" });
    const second = await session.root.getFileHandle({ create: true, name: "stable.txt" });
    expect(second).toMatchObject({ kind: "file", name: first.name });
    await expect(session.root.getDirectoryHandle({ create: true, name: "stable.txt" }))
      .rejects.toThrow("Expected directory at stable.txt, found file");

    await session.close();
    const reopened = await openEmptyEncryptedContainer({ backend, passphrase, supportedFeatureBits });
    try {
      // Only the first ensure creates a successor. Same-kind ensure is an
      // explicit no-change result, and wrong-kind ensure never publishes.
      expect(reopened.commit.commitSequence).toBe(2n);
      const resources = createAuthenticatedApplicationReadSessionResources({ backend, opened: reopened });
      try {
        await expect(resources.namespace.stat({ pathComponents: ["stable.txt"] }))
          .resolves.toMatchObject({ kind: "file" });
      } finally {
        await resources.releaseResources();
      }
    } finally {
      if (!reopened.rootKey.isDestroyed()) reopened.rootKey.destroy();
    }
  });

  it("preserves ordinary mutation and writer-dependency cleanup failures in order", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const supportedFeatureBits = createFeatureBits({ value: 0n });
    const opened = await createEmptyEncryptedContainer({
      backend,
      passphrase: "correct horse battery staple",
      randomSource,
      supportedFeatureBits,
    });
    const host = runtimeHost();
    const acquireWorkingGenerationDependencyRoot = host.acquireWorkingGenerationDependencyRoot.bind(host);
    const releaseFailure = new Error("writer dependency release failed");
    vi.spyOn(host, "acquireWorkingGenerationDependencyRoot").mockImplementation(({ commitReference }) => {
      const registration = acquireWorkingGenerationDependencyRoot({ commitReference });
      return {
        ...registration,
        release: () => {
          registration.release();
          throw releaseFailure;
        },
      };
    });
    const operationFailure = new Error("operation timestamp failed");
    const session = await openAuthenticatedReadWriteApplicationSession({
      captureAuthority: async () => ({ revision: 1 }),
      recheckAuthority: async () => undefined,
      runtimeHost: host,
      verifyCapturedAuthority: async () => ({
        backend,
        canonicalBackingLocation: "memory://composition-root-test.hizofs",
        explicitBulkLimits: DEFAULT_EXPLICIT_BULK_TEST_LIMITS,
        fileMutationLimits: { maximumExtentMutationsPerBatch: 2 },
        opened,
        operationTimestamp: () => {
          throw operationFailure;
        },
        randomSource,
        removalLimits: { deleteBatchSize: 2, maxVisitedInodes: 64 },
        recheckDurableGenerationAuthority: async () => undefined,
        rootSubvolumeId: createSubvolumeId({ value: 1n }),
        supportedFeatureBits,
        writableProfile: "release-qualified",
      }),
    });

    const result = session.root.getDirectoryHandle({ create: true, name: "docs" });
    await expect(result).rejects.toBeInstanceOf(AggregateError);
    await expect(result).rejects.toMatchObject({
      errors: [operationFailure, releaseFailure],
    });
    const capture = await host.beginMaintenanceRootCapture();
    expect(capture.workingGenerationDependencyRoots).toEqual([]);
    capture.release();
    await capture.released;

    await session.close();
  });

  it("retains prepared writable base roots until commit or abort settles", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const supportedFeatureBits = createFeatureBits({ value: 0n });
    const opened = await createEmptyEncryptedContainer({
      backend,
      passphrase: "correct horse battery staple",
      randomSource,
      supportedFeatureBits,
    });
    const host = immediateRuntimeHost();
    const session = await openAuthenticatedReadWriteApplicationSession({
      captureAuthority: async () => ({ revision: 1 }),
      recheckAuthority: async () => undefined,
      runtimeHost: host,
      verifyCapturedAuthority: async () => ({
        backend,
        canonicalBackingLocation: "memory://composition-root-test.hizofs",
        explicitBulkLimits: DEFAULT_EXPLICIT_BULK_TEST_LIMITS,
        fileMutationLimits: { maximumExtentMutationsPerBatch: 2 },
        opened,
        operationTimestamp: () => createTimestampMilliseconds({ value: 1_700_000_000_000n }),
        randomSource,
        removalLimits: { deleteBatchSize: 2, maxVisitedInodes: 64 },
        recheckDurableGenerationAuthority: async () => undefined,
        rootSubvolumeId: createSubvolumeId({ value: 1n }),
        supportedFeatureBits,
        writableProfile: "release-qualified",
      }),
    });
    const file = await session.root.getFileHandle({ create: true, name: "prepared.bin" });
    const acquireWorkingGenerationDependencyRoot = host.acquireWorkingGenerationDependencyRoot.bind(host);
    const observedRoots: Parameters<typeof acquireWorkingGenerationDependencyRoot>[0]["commitReference"][] = [];
    const deferredReleases: (() => void)[] = [];
    let delegatedReleaseCalls = 0;
    const acquisition = vi.spyOn(host, "acquireWorkingGenerationDependencyRoot").mockImplementation(({ commitReference }) => {
      observedRoots.push(commitReference);
      const registration = acquireWorkingGenerationDependencyRoot({ commitReference });
      return {
        ...registration,
        release: () => {
          delegatedReleaseCalls += 1;
          deferredReleases.push(registration.release);
        },
      };
    });

    const committed = await file.createWritable({ keepExistingData: true });
    expect(acquisition).toHaveBeenCalledOnce();
    expect(delegatedReleaseCalls).toBe(0);
    await committed.close();
    expect(delegatedReleaseCalls).toBe(1);
    const retainedAfterCommit = await host.beginMaintenanceRootCapture();
    expect(retainedAfterCommit.workingGenerationDependencyRoots).toEqual([observedRoots[0]]);
    retainedAfterCommit.release();
    await retainedAfterCommit.released;
    deferredReleases.shift()?.();
    const clearedAfterCommit = await host.beginMaintenanceRootCapture();
    expect(clearedAfterCommit.workingGenerationDependencyRoots).toEqual([]);
    clearedAfterCommit.release();
    await clearedAfterCommit.released;

    const aborted = await file.createWritable({ keepExistingData: true });
    expect(acquisition).toHaveBeenCalledTimes(2);
    expect(delegatedReleaseCalls).toBe(1);
    await aborted.abort({ reason: "test abort" });
    expect(delegatedReleaseCalls).toBe(2);
    const retainedAfterAbort = await host.beginMaintenanceRootCapture();
    expect(retainedAfterAbort.workingGenerationDependencyRoots).toEqual([observedRoots[1]]);
    retainedAfterAbort.release();
    await retainedAfterAbort.released;
    deferredReleases.shift()?.();
    const clearedAfterAbort = await host.beginMaintenanceRootCapture();
    expect(clearedAfterAbort.workingGenerationDependencyRoots).toEqual([]);
    clearedAfterAbort.release();
    await clearedAfterAbort.released;

    await session.close();
    expect(opened.rootKey.isDestroyed()).toBe(true);
  });

  it("installs runtime candidate authority before prepared writable publication", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const supportedFeatureBits = createFeatureBits({ value: 0n });
    const opened = await createEmptyEncryptedContainer({
      backend,
      passphrase: "correct horse battery staple",
      randomSource,
      supportedFeatureBits,
    });
    const originalSyncFileData = backend.syncFileData.bind(backend);
    const reachedAuthoritySync = Promise.withResolvers<void>();
    const resumeAuthoritySync = Promise.withResolvers<void>();
    let blockNextSuperblockSync = false;
    backend.syncFileData = async ({ file }) => {
      await originalSyncFileData({ file });
      if (blockNextSuperblockSync && file.path.includes("superblock")) {
        blockNextSuperblockSync = false;
        reachedAuthoritySync.resolve();
        await resumeAuthoritySync.promise;
      }
    };
    const host = immediateRuntimeHost();
    const session = await openAuthenticatedReadWriteApplicationSession({
      captureAuthority: async () => ({ revision: 1 }),
      recheckAuthority: async () => undefined,
      runtimeHost: host,
      verifyCapturedAuthority: async () => ({
        backend,
        canonicalBackingLocation: "memory://composition-root-test.hizofs",
        explicitBulkLimits: DEFAULT_EXPLICIT_BULK_TEST_LIMITS,
        fileMutationLimits: { maximumExtentMutationsPerBatch: 2 },
        opened,
        operationTimestamp: () => createTimestampMilliseconds({ value: 1_700_000_000_000n }),
        randomSource,
        removalLimits: { deleteBatchSize: 2, maxVisitedInodes: 64 },
        recheckDurableGenerationAuthority: async () => undefined,
        rootSubvolumeId: createSubvolumeId({ value: 1n }),
        supportedFeatureBits,
        writableProfile: "release-qualified",
      }),
    });
    const file = await session.root.getFileHandle({ create: true, name: "candidate-root.bin" });
    const writable = await file.createWritable({ keepExistingData: false });
    await writable.write({ data: Uint8Array.of(1, 2, 3), position: 0 });

    blockNextSuperblockSync = true;
    const close = writable.close();
    await reachedAuthoritySync.promise;

    expect(host.workingCandidatePublicationState()).toBe("publishing");

    resumeAuthoritySync.resolve();
    await close;
    expect(host.workingCandidatePublicationState()).toBe("empty");
    const cleared = await host.beginMaintenanceRootCapture();
    expect(cleared.workingGenerationDependencyRoots).toEqual([]);
    cleared.release();
    await cleared.released;

    await session.close();
  });

  it("preserves prepared writable and writer-dependency release failures in order", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const supportedFeatureBits = createFeatureBits({ value: 0n });
    const opened = await createEmptyEncryptedContainer({
      backend,
      passphrase: "correct horse battery staple",
      randomSource,
      supportedFeatureBits,
    });
    const operationFailure = new Error("prepared writable staging failed");
    let rejectOperationTimestamp = false;
    const host = immediateRuntimeHost();
    const session = await openAuthenticatedReadWriteApplicationSession({
      captureAuthority: async () => ({ revision: 1 }),
      recheckAuthority: async () => undefined,
      runtimeHost: host,
      verifyCapturedAuthority: async () => ({
        backend,
        canonicalBackingLocation: "memory://composition-root-test.hizofs",
        explicitBulkLimits: DEFAULT_EXPLICIT_BULK_TEST_LIMITS,
        fileMutationLimits: { maximumExtentMutationsPerBatch: 2 },
        opened,
        operationTimestamp: () => {
          if (rejectOperationTimestamp) throw operationFailure;
          return createTimestampMilliseconds({ value: 1_700_000_000_000n });
        },
        randomSource,
        removalLimits: { deleteBatchSize: 2, maxVisitedInodes: 64 },
        recheckDurableGenerationAuthority: async () => undefined,
        rootSubvolumeId: createSubvolumeId({ value: 1n }),
        supportedFeatureBits,
        writableProfile: "release-qualified",
      }),
    });
    const file = await session.root.getFileHandle({ create: true, name: "poisoned.bin" });
    const acquireWorkingGenerationDependencyRoot = host.acquireWorkingGenerationDependencyRoot.bind(host);
    const releaseFailure = new Error("prepared writable root release failed");
    vi.spyOn(host, "acquireWorkingGenerationDependencyRoot").mockImplementation(({ commitReference }) => {
      const registration = acquireWorkingGenerationDependencyRoot({ commitReference });
      return {
        ...registration,
        release: () => {
          registration.release();
          throw releaseFailure;
        },
      };
    });

    const writable = await file.createWritable({ keepExistingData: true });
    rejectOperationTimestamp = true;
    await expect(writable.write({ data: Uint8Array.of(1), position: 0 }))
      .rejects.toBe(operationFailure);
    const closing = writable.close();
    await expect(closing).rejects.toBeInstanceOf(AggregateError);
    await expect(closing).rejects.toMatchObject({
      errors: [
        expect.objectContaining({
          cause: operationFailure,
          name: HizoFSApplicationMutationSessionPoisonedError.name,
        }),
        releaseFailure,
      ],
    });
    const capture = await host.beginMaintenanceRootCapture();
    expect(capture.workingGenerationDependencyRoots).toEqual([]);
    capture.release();
    await capture.released;

    await session.close();
    expect(opened.rootKey.isDestroyed()).toBe(true);
  });

  it("binds writable application creates to durable generation updates and reopen", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const supportedFeatureBits = createFeatureBits({ value: 0n });
    const passphrase = "correct horse battery staple";
    const opened = await createEmptyEncryptedContainer({
      backend,
      passphrase,
      randomSource,
      supportedFeatureBits,
    });
    let authorityRechecks = 0;
    let nextTimestamp = 1_700_000_000_000n;
    const session = await openAuthenticatedReadWriteApplicationSession({
      captureAuthority: async () => ({ revision: 1 }),
      recheckAuthority: async () => undefined,
      rootName: "writable.hizofs",
      runtimeHost: runtimeHost(),
      verifyCapturedAuthority: async () => ({
        backend,
        canonicalBackingLocation: "memory://composition-root-test.hizofs",
        opened,
        explicitBulkLimits: DEFAULT_EXPLICIT_BULK_TEST_LIMITS,
        fileMutationLimits: { maximumExtentMutationsPerBatch: 2 },
        operationTimestamp: () => {
          const timestamp = createTimestampMilliseconds({ value: nextTimestamp });
          nextTimestamp += 1n;
          return timestamp;
        },
        randomSource,
        removalLimits: { deleteBatchSize: 2, maxVisitedInodes: 64 },
        recheckDurableGenerationAuthority: async ({ commit, superblock }) => {
          authorityRechecks += 1;
          const current = await openSuperblockCopies({
            backend,
            fileSystemId: opened.fileSystemId,
            rootKey: opened.rootKey,
            supportedFeatureBits,
          });
          expect(current.logicalState.activeCommitSequence).toBe(commit.commitSequence);
          expect(current.logicalState.activeCommitSequence).toBe(superblock.logicalState.activeCommitSequence);
          expect(current.logicalState.activeMutationId).toEqual(commit.mutationId);
        },
        rootSubvolumeId: createSubvolumeId({ value: 1n }),
        supportedFeatureBits,
        writableProfile: "release-qualified",
      }),
    });

    const docs = await session.root.getDirectoryHandle({ create: true, name: "docs" });
    const nested = await docs.getFileHandle({ create: true, name: "nested.txt" });
    expect(await nested.stat()).toMatchObject({ size: 0 });
    expect(await session.root.getEntryHandle({ name: "docs" })).toMatchObject({ kind: "directory" });
    expect(await docs.getEntryHandle({ name: "nested.txt" })).toMatchObject({ kind: "file" });
    await expect(session.root.removeEntry({ name: "docs", recursive: false })).rejects.toThrow();
    expect(await docs.getEntryHandle({ name: "nested.txt" })).toMatchObject({ kind: "file" });
    await session.root.removeEntry({ name: "docs", recursive: true });
    await expect(session.root.getEntryHandle({ name: "docs" })).rejects.toThrow();
    // One runtime-owner-fenced durable head needs one physical authority
    // recheck regardless of how many ordinary mutations reuse it.
    expect(authorityRechecks).toBe(1);

    await session.sync();
    await session.root.getFileHandle({ create: true, name: "after-sync.txt" });
    // Publication changed the durable identity, so the next mutation must
    // authenticate that exact new head before reusing it.
    expect(authorityRechecks).toBe(2);
    await session.sync();
    await session.close();
    expect(opened.rootKey.isDestroyed()).toBe(true);

    const reopened = await openEmptyEncryptedContainer({
      backend,
      passphrase,
      supportedFeatureBits,
    });
    try {
      // Each explicit sync publishes only the exact latest candidate from its
      // dirty epoch; the second epoch adds after-sync.txt.
      expect(reopened.commit.commitSequence).toBe(3n);
      const resources = createAuthenticatedApplicationReadSessionResources({ backend, opened: reopened });
      try {
        await expect(resources.namespace.stat({ pathComponents: ["docs"] })).rejects.toThrow();
        await expect(resources.namespace.stat({ pathComponents: ["after-sync.txt"] }))
          .resolves.toMatchObject({ kind: "file" });
      } finally {
        await resources.releaseResources();
      }
    } finally {
      if (!reopened.rootKey.isDestroyed()) reopened.rootKey.destroy();
    }
  });

  it("lets a prepared writable finish while a dirty-age publication waits for its writer", async () => {
    vi.useFakeTimers();
    try {
      const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
      const randomSource = deterministicRandomSource();
      const supportedFeatureBits = createFeatureBits({ value: 0n });
      const passphrase = "correct horse battery staple";
      const opened = await createEmptyEncryptedContainer({
        backend,
        passphrase,
        randomSource,
        supportedFeatureBits,
      });
      const host = runtimeHost({
        lazyDurability: {
          ...DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY,
          maximumDirtyAgeMilliseconds: 1,
        },
      });
      const session = await openAuthenticatedReadWriteApplicationSession({
        captureAuthority: async () => ({ revision: 1 }),
        recheckAuthority: async () => undefined,
        runtimeHost: host,
        verifyCapturedAuthority: async () => ({
          backend,
          canonicalBackingLocation: "memory://queued-publication-prepared-writable.hizofs",
          explicitBulkLimits: DEFAULT_EXPLICIT_BULK_TEST_LIMITS,
          fileMutationLimits: { maximumExtentMutationsPerBatch: 2 },
          opened,
          operationTimestamp: () => createTimestampMilliseconds({ value: 1_700_000_000_000n }),
          randomSource,
          removalLimits: { deleteBatchSize: 2, maxVisitedInodes: 64 },
          recheckDurableGenerationAuthority: async () => undefined,
          rootSubvolumeId: createSubvolumeId({ value: 1n }),
          supportedFeatureBits,
          writableProfile: "release-qualified",
        }),
      });

      const file = await session.root.getFileHandle({ create: true, name: "queued.bin" });
      const writable = await file.createWritable({ keepExistingData: false });
      await writable.write({ data: Uint8Array.of(1, 2, 3, 4), position: 0 });

      await vi.advanceTimersByTimeAsync(1);
      await writable.close();
      vi.useRealTimers();
      await session.sync();
      await session.close();

      const reopened = await openEmptyEncryptedContainer({
        backend,
        passphrase,
        supportedFeatureBits,
      });
      try {
        const resources = createAuthenticatedApplicationReadSessionResources({ backend, opened: reopened });
        try {
          await expect(resources.namespace.stat({ pathComponents: ["queued.bin"] }))
            .resolves.toMatchObject({ fileSize: 4n, kind: "file" });
        } finally {
          await resources.releaseResources();
        }
      } finally {
        if (!reopened.rootKey.isDestroyed()) reopened.rootKey.destroy();
      }
    } finally {
      vi.useRealTimers();
    }
  }, 2_000);

  it("lets a prepared writable abort while dirty-age publication waits for its writer", async () => {
    vi.useFakeTimers();
    try {
      const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
      const randomSource = deterministicRandomSource();
      const supportedFeatureBits = createFeatureBits({ value: 0n });
      const passphrase = "correct horse battery staple";
      const opened = await createEmptyEncryptedContainer({
        backend,
        passphrase,
        randomSource,
        supportedFeatureBits,
      });
      const host = runtimeHost({
        lazyDurability: {
          ...DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY,
          maximumDirtyAgeMilliseconds: 1,
        },
      });
      const session = await openAuthenticatedReadWriteApplicationSession({
        captureAuthority: async () => ({ revision: 1 }),
        recheckAuthority: async () => undefined,
        runtimeHost: host,
        verifyCapturedAuthority: async () => ({
          backend,
          canonicalBackingLocation: "memory://queued-publication-aborted-writable.hizofs",
          explicitBulkLimits: DEFAULT_EXPLICIT_BULK_TEST_LIMITS,
          fileMutationLimits: { maximumExtentMutationsPerBatch: 2 },
          opened,
          operationTimestamp: () => createTimestampMilliseconds({ value: 1_700_000_000_000n }),
          randomSource,
          removalLimits: { deleteBatchSize: 2, maxVisitedInodes: 64 },
          recheckDurableGenerationAuthority: async () => undefined,
          rootSubvolumeId: createSubvolumeId({ value: 1n }),
          supportedFeatureBits,
          writableProfile: "release-qualified",
        }),
      });

      const file = await session.root.getFileHandle({ create: true, name: "aborted.bin" });
      const writable = await file.createWritable({ keepExistingData: false });
      await writable.write({ data: Uint8Array.of(9, 8, 7, 6), position: 0 });

      await vi.advanceTimersByTimeAsync(1);
      await writable.abort({ reason: new Error("benchmark-style cancellation") });
      vi.useRealTimers();
      await session.sync();
      await session.close();

      const reopened = await openEmptyEncryptedContainer({
        backend,
        passphrase,
        supportedFeatureBits,
      });
      try {
        const resources = createAuthenticatedApplicationReadSessionResources({ backend, opened: reopened });
        try {
          await expect(resources.namespace.stat({ pathComponents: ["aborted.bin"] }))
            .resolves.toMatchObject({ fileSize: 0n, kind: "file" });
        } finally {
          await resources.releaseResources();
        }
      } finally {
        if (!reopened.rootKey.isDestroyed()) reopened.rootKey.destroy();
      }
    } finally {
      vi.useRealTimers();
    }
  }, 2_000);

  it("repeats small-file writes while dirty-age publication queues behind prepared writers", async () => {
    vi.useFakeTimers();
    try {
      const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
      const randomSource = deterministicRandomSource();
      const supportedFeatureBits = createFeatureBits({ value: 0n });
      const passphrase = "correct horse battery staple";
      const opened = await createEmptyEncryptedContainer({
        backend,
        passphrase,
        randomSource,
        supportedFeatureBits,
      });
      const host = runtimeHost({
        lazyDurability: {
          ...DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY,
          maximumDirtyAgeMilliseconds: 1,
        },
      });
      let nextTimestamp = 1_700_000_000_000n;
      const session = await openAuthenticatedReadWriteApplicationSession({
        captureAuthority: async () => ({ revision: 1 }),
        recheckAuthority: async () => undefined,
        runtimeHost: host,
        verifyCapturedAuthority: async () => ({
          backend,
          canonicalBackingLocation: "memory://repeated-queued-publication-small-file-writes.hizofs",
          explicitBulkLimits: DEFAULT_EXPLICIT_BULK_TEST_LIMITS,
          fileMutationLimits: { maximumExtentMutationsPerBatch: 2 },
          opened,
          operationTimestamp: () => {
            const timestamp = createTimestampMilliseconds({ value: nextTimestamp });
            nextTimestamp += 1n;
            return timestamp;
          },
          randomSource,
          removalLimits: { deleteBatchSize: 2, maxVisitedInodes: 64 },
          recheckDurableGenerationAuthority: async () => undefined,
          rootSubvolumeId: createSubvolumeId({ value: 1n }),
          supportedFeatureBits,
          writableProfile: "release-qualified",
        }),
      });

      const file = await session.root.getFileHandle({ create: true, name: "repeated.bin" });
      for (let iteration = 0; iteration < 32; iteration += 1) {
        const writable = await file.createWritable({ keepExistingData: false });
        await writable.write({ data: Uint8Array.of(iteration & 0xff, 2, 3, 4), position: 0 });
        // Reproduce the browser ordering: a prior accepted mutation's dirty-age
        // timer fires while this prepared writable still owns the runtime writer.
        await vi.advanceTimersByTimeAsync(1);
        await writable.close();
      }

      vi.useRealTimers();
      await session.sync();
      await session.close();

      const reopened = await openEmptyEncryptedContainer({
        backend,
        passphrase,
        supportedFeatureBits,
      });
      try {
        const resources = createAuthenticatedApplicationReadSessionResources({ backend, opened: reopened });
        try {
          await expect(resources.namespace.stat({ pathComponents: ["repeated.bin"] }))
            .resolves.toMatchObject({ fileSize: 4n, kind: "file" });
        } finally {
          await resources.releaseResources();
        }
      } finally {
        if (!reopened.rootKey.isDestroyed()) reopened.rootKey.destroy();
      }
    } finally {
      vi.useRealTimers();
    }
  }, 15_000);

  it("lets an explicit bulk commit finish while dirty-age publication waits for its writer", async () => {
    vi.useFakeTimers();
    try {
      const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
      const randomSource = deterministicRandomSource();
      const supportedFeatureBits = createFeatureBits({ value: 0n });
      const passphrase = "correct horse battery staple";
      const opened = await createEmptyEncryptedContainer({
        backend,
        passphrase,
        randomSource,
        supportedFeatureBits,
      });
      const session = await openAuthenticatedReadWriteApplicationSession({
        captureAuthority: async () => ({ revision: 1 }),
        recheckAuthority: async () => undefined,
        runtimeHost: runtimeHost({
          lazyDurability: {
            ...DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY,
            maximumDirtyAgeMilliseconds: 1,
          },
        }),
        verifyCapturedAuthority: async () => ({
          backend,
          canonicalBackingLocation: "memory://queued-publication-explicit-bulk.hizofs",
          explicitBulkLimits: DEFAULT_EXPLICIT_BULK_TEST_LIMITS,
          fileMutationLimits: { maximumExtentMutationsPerBatch: 2 },
          opened,
          operationTimestamp: () => createTimestampMilliseconds({ value: 1_700_000_000_000n }),
          randomSource,
          removalLimits: { deleteBatchSize: 2, maxVisitedInodes: 64 },
          recheckDurableGenerationAuthority: async () => undefined,
          rootSubvolumeId: createSubvolumeId({ value: 1n }),
          supportedFeatureBits,
          writableProfile: "release-qualified",
        }),
      });
      if (!(session instanceof HizoFSStorageFileSystemSession)) {
        throw new Error("expected concrete HizoFS application session");
      }

      await session.root.getDirectoryHandle({ create: true, name: "bulk" });
      const openExplicitBulk = session.port.openExplicitBulk;
      if (openExplicitBulk === undefined) throw new Error("production session omitted explicit bulk support");
      const bulk = await openExplicitBulk({ path: ["bulk"] });
      await bulk.createEmptyFile({ name: "queued.txt" });

      // The target-directory create scheduled a dirty-age publication. Fire it
      // while this prepared bulk mutation still owns the runtime writer.
      await vi.advanceTimersByTimeAsync(1);
      await bulk.commit();

      vi.useRealTimers();
      await session.sync();
      await session.close();

      const reopened = await openEmptyEncryptedContainer({ backend, passphrase, supportedFeatureBits });
      try {
        const resources = createAuthenticatedApplicationReadSessionResources({ backend, opened: reopened });
        try {
          await expect(resources.namespace.stat({ pathComponents: ["bulk", "queued.txt"] }))
            .resolves.toMatchObject({ kind: "file" });
        } finally {
          await resources.releaseResources();
        }
      } finally {
        if (!reopened.rootKey.isDestroyed()) reopened.rootKey.destroy();
      }
    } finally {
      vi.useRealTimers();
    }
  }, 3_000);

  it("publishes at the accepted-mutation bound before admitting the next mutation", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const supportedFeatureBits = createFeatureBits({ value: 0n });
    const passphrase = "correct horse battery staple";
    const opened = await createEmptyEncryptedContainer({
      backend,
      passphrase,
      randomSource,
      supportedFeatureBits,
    });
    const initialCommitSequence = opened.commit.commitSequence;
    const host = runtimeHost({
      lazyDurability: {
        ...DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY,
        maximumAcceptedMutationsPerDirtyEpoch: 1,
      },
    });
    const session = await openAuthenticatedReadWriteApplicationSession({
      captureAuthority: async () => ({ revision: 1 }),
      recheckAuthority: async () => undefined,
      runtimeHost: host,
      verifyCapturedAuthority: async () => ({
        backend,
        canonicalBackingLocation: "memory://mutation-pressure-rollover.hizofs",
        explicitBulkLimits: DEFAULT_EXPLICIT_BULK_TEST_LIMITS,
        fileMutationLimits: { maximumExtentMutationsPerBatch: 2 },
        opened,
        operationTimestamp: () => createTimestampMilliseconds({ value: 1_700_000_000_000n }),
        randomSource,
        removalLimits: { deleteBatchSize: 2, maxVisitedInodes: 64 },
        recheckDurableGenerationAuthority: async () => undefined,
        rootSubvolumeId: createSubvolumeId({ value: 1n }),
        supportedFeatureBits,
        writableProfile: "release-qualified",
      }),
    });

    await session.root.getDirectoryHandle({ create: true, name: "first" });
    await session.root.getDirectoryHandle({ create: true, name: "second" });
    await session.sync();
    await session.close();

    const reopened = await openEmptyEncryptedContainer({
      backend,
      passphrase,
      supportedFeatureBits,
    });
    try {
      expect(reopened.commit.commitSequence).toBe(initialCommitSequence + 2n);
      const resources = createAuthenticatedApplicationReadSessionResources({ backend, opened: reopened });
      try {
        await expect(resources.namespace.stat({ pathComponents: ["first"] }))
          .resolves.toMatchObject({ kind: "directory" });
        await expect(resources.namespace.stat({ pathComponents: ["second"] }))
          .resolves.toMatchObject({ kind: "directory" });
      } finally {
        await resources.releaseResources();
      }
    } finally {
      if (!reopened.rootKey.isDestroyed()) reopened.rootKey.destroy();
    }
  });

  it("yields an already-queued concurrent mutation to resource-pressure publication", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const supportedFeatureBits = createFeatureBits({ value: 0n });
    const passphrase = "correct horse battery staple";
    const opened = await createEmptyEncryptedContainer({
      backend,
      passphrase,
      randomSource,
      supportedFeatureBits,
    });
    const initialCommitSequence = opened.commit.commitSequence;
    const host = runtimeHost({
      lazyDurability: {
        ...DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY,
        maximumAcceptedMutationsPerDirtyEpoch: 1,
      },
    });
    let nextTimestamp = 1_700_000_000_000n;
    const session = await openAuthenticatedReadWriteApplicationSession({
      captureAuthority: async () => ({ revision: 1 }),
      recheckAuthority: async () => undefined,
      runtimeHost: host,
      verifyCapturedAuthority: async () => ({
        backend,
        canonicalBackingLocation: "memory://concurrent-mutation-pressure-rollover.hizofs",
        explicitBulkLimits: DEFAULT_EXPLICIT_BULK_TEST_LIMITS,
        fileMutationLimits: { maximumExtentMutationsPerBatch: 2 },
        opened,
        operationTimestamp: () => {
          const timestamp = createTimestampMilliseconds({ value: nextTimestamp });
          nextTimestamp += 1n;
          return timestamp;
        },
        randomSource,
        removalLimits: { deleteBatchSize: 2, maxVisitedInodes: 64 },
        recheckDurableGenerationAuthority: async () => undefined,
        rootSubvolumeId: createSubvolumeId({ value: 1n }),
        supportedFeatureBits,
        writableProfile: "release-qualified",
      }),
    });

    await Promise.all([
      session.root.getDirectoryHandle({ create: true, name: "first-concurrent" }),
      session.root.getDirectoryHandle({ create: true, name: "second-concurrent" }),
    ]);
    await session.sync();
    await session.close();

    const reopened = await openEmptyEncryptedContainer({
      backend,
      passphrase,
      supportedFeatureBits,
    });
    try {
      expect(reopened.commit.commitSequence).toBe(initialCommitSequence + 2n);
      const resources = createAuthenticatedApplicationReadSessionResources({ backend, opened: reopened });
      try {
        await expect(resources.namespace.stat({ pathComponents: ["first-concurrent"] }))
          .resolves.toMatchObject({ kind: "directory" });
        await expect(resources.namespace.stat({ pathComponents: ["second-concurrent"] }))
          .resolves.toMatchObject({ kind: "directory" });
      } finally {
        await resources.releaseResources();
      }
    } finally {
      if (!reopened.rootKey.isDestroyed()) reopened.rootKey.destroy();
    }
  });

  it("rejects exact mutation resource overflow before Superblock publication", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const supportedFeatureBits = createFeatureBits({ value: 0n });
    const passphrase = "correct horse battery staple";
    const opened = await createEmptyEncryptedContainer({
      backend,
      passphrase,
      randomSource,
      supportedFeatureBits,
    });
    const initialCommitSequence = opened.commit.commitSequence;
    const host = runtimeHost({
      lazyDurability: {
        ...DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY,
        maximumDirtyMetadataBytes: 1,
        maximumUnpublishedPhysicalBytes: 1,
      },
    });
    const session = await openAuthenticatedReadWriteApplicationSession({
      captureAuthority: async () => ({ revision: 1 }),
      recheckAuthority: async () => undefined,
      runtimeHost: host,
      verifyCapturedAuthority: async () => ({
        backend,
        canonicalBackingLocation: "memory://resource-overflow.hizofs",
        explicitBulkLimits: DEFAULT_EXPLICIT_BULK_TEST_LIMITS,
        fileMutationLimits: { maximumExtentMutationsPerBatch: 2 },
        opened,
        operationTimestamp: () => createTimestampMilliseconds({ value: 1_700_000_000_000n }),
        randomSource,
        removalLimits: { deleteBatchSize: 2, maxVisitedInodes: 64 },
        recheckDurableGenerationAuthority: async () => undefined,
        rootSubvolumeId: createSubvolumeId({ value: 1n }),
        supportedFeatureBits,
        writableProfile: "release-qualified",
      }),
    });

    await expect(session.root.getDirectoryHandle({ create: true, name: "too-large" }))
      .rejects.toMatchObject({ code: "dirty_metadata_byte_limit_reached" });
    await session.close();

    const reopened = await openEmptyEncryptedContainer({
      backend,
      passphrase,
      supportedFeatureBits,
    });
    try {
      expect(reopened.commit.commitSequence).toBe(initialCommitSequence);
      const resources = createAuthenticatedApplicationReadSessionResources({ backend, opened: reopened });
      try {
        await expect(resources.namespace.stat({ pathComponents: ["too-large"] })).rejects.toThrow();
      } finally {
        await resources.releaseResources();
      }
    } finally {
      if (!reopened.rootKey.isDestroyed()) reopened.rootKey.destroy();
    }
  });

  it("rejects exact file-content resource overflow before Superblock publication", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const supportedFeatureBits = createFeatureBits({ value: 0n });
    const passphrase = "correct horse battery staple";
    const opened = await createEmptyEncryptedContainer({
      backend,
      passphrase,
      randomSource,
      supportedFeatureBits,
    });
    const host = runtimeHost({
      lazyDurability: {
        ...DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY,
        publicationModeRequest: "immediate",
        maximumDirtyMetadataBytes: DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY.maximumDirtyMetadataBytes,
        maximumUnpublishedPhysicalBytes: 2_048,
      },
    });
    const session = await openAuthenticatedReadWriteApplicationSession({
      captureAuthority: async () => ({ revision: 1 }),
      recheckAuthority: async () => undefined,
      runtimeHost: host,
      verifyCapturedAuthority: async () => ({
        backend,
        canonicalBackingLocation: "memory://file-resource-overflow.hizofs",
        explicitBulkLimits: DEFAULT_EXPLICIT_BULK_TEST_LIMITS,
        fileMutationLimits: { maximumExtentMutationsPerBatch: 2 },
        opened,
        operationTimestamp: () => createTimestampMilliseconds({ value: 1_700_000_000_000n }),
        randomSource,
        removalLimits: { deleteBatchSize: 2, maxVisitedInodes: 64 },
        recheckDurableGenerationAuthority: async () => undefined,
        rootSubvolumeId: createSubvolumeId({ value: 1n }),
        supportedFeatureBits,
        writableProfile: "release-qualified",
      }),
    });

    const file = await session.root.getFileHandle({ create: true, name: "bounded.bin" });
    const durableBeforeWrite = opened.commit.commitSequence + 1n;
    const writable = await file.createWritable({ keepExistingData: false });
    await writable.write({ data: new Uint8Array(4_096).fill(7), position: 0 });
    await expect(writable.close()).rejects.toMatchObject({
      code: "unpublished_physical_byte_limit_reached",
    });
    await session.close();

    const reopened = await openEmptyEncryptedContainer({
      backend,
      passphrase,
      supportedFeatureBits,
    });
    try {
      expect(reopened.commit.commitSequence).toBe(durableBeforeWrite);
      const resources = createAuthenticatedApplicationReadSessionResources({ backend, opened: reopened });
      try {
        const stat = await resources.namespace.stat({ pathComponents: ["bounded.bin"] });
        expect(stat).toMatchObject({ fileSize: 0n, kind: "file" });
      } finally {
        await resources.releaseResources();
      }
    } finally {
      if (!reopened.rootKey.isDestroyed()) reopened.rootKey.destroy();
    }
  });

  it("shares successful writable generations across sessions attached to one runtime", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const supportedFeatureBits = createFeatureBits({ value: 0n });
    const passphrase = "correct horse battery staple";
    const firstOpened = await createEmptyEncryptedContainer({
      backend,
      passphrase,
      randomSource,
      supportedFeatureBits,
    });
    const secondOpened = await openEmptyEncryptedContainer({
      backend,
      passphrase,
      supportedFeatureBits,
    });
    const host = runtimeHost();
    let nextTimestamp = 1_700_000_100_000n;
    const openSession = async ({ opened }: { opened: OpenedEmptyEncryptedContainer }) => (
      await openAuthenticatedReadWriteApplicationSession({
        captureAuthority: async () => ({ revision: 1 }),
        recheckAuthority: async () => undefined,
        rootName: "shared-runtime.hizofs",
        runtimeHost: host,
        verifyCapturedAuthority: async () => ({
          backend,
          canonicalBackingLocation: "memory://shared-runtime.hizofs",
          opened,
          explicitBulkLimits: DEFAULT_EXPLICIT_BULK_TEST_LIMITS,
          fileMutationLimits: { maximumExtentMutationsPerBatch: 2 },
          operationTimestamp: () => {
            const timestamp = createTimestampMilliseconds({ value: nextTimestamp });
            nextTimestamp += 1n;
            return timestamp;
          },
          randomSource,
          removalLimits: { deleteBatchSize: 2, maxVisitedInodes: 64 },
          recheckDurableGenerationAuthority: async ({ commit, superblock }) => {
            const current = await openSuperblockCopies({
              backend,
              fileSystemId: opened.fileSystemId,
              rootKey: opened.rootKey,
              supportedFeatureBits,
            });
            expect(current.logicalState.activeCommitSequence).toBe(commit.commitSequence);
            expect(current.logicalState.activeCommitSequence).toBe(superblock.logicalState.activeCommitSequence);
          },
          rootSubvolumeId: createSubvolumeId({ value: 1n }),
          supportedFeatureBits,
          writableProfile: "release-qualified",
        }),
      })
    );
    const first = await openSession({ opened: firstOpened });
    const second = await openSession({ opened: secondOpened });

    await first.root.getFileHandle({ create: true, name: "from-first.txt" });
    expect(await second.root.getEntryHandle({ name: "from-first.txt" })).toMatchObject({ kind: "file" });

    await second.root.getDirectoryHandle({ create: true, name: "from-second" });
    expect(await first.root.getEntryHandle({ name: "from-second" })).toMatchObject({ kind: "directory" });
    await Promise.all([first.sync(), second.sync()]);

    await first.close();
    await second.close();
    expect(firstOpened.rootKey.isDestroyed()).toBe(true);
    expect(secondOpened.rootKey.isDestroyed()).toBe(true);
  });

  it("batches sequential prepared-writable File Data across public write calls", async () => {
    const backend = new DataSegmentWriteCountingBackend({});
    const indexOperations: string[] = [];
    const randomSource = deterministicRandomSource();
    const supportedFeatureBits = createFeatureBits({ value: 0n });
    const opened = await createEmptyEncryptedContainer({
      backend,
      passphrase: "correct horse battery staple",
      randomSource,
      supportedFeatureBits,
    });
    const session = await openAuthenticatedReadWriteApplicationSession({
      captureAuthority: async () => ({ revision: 1 }),
      recheckAuthority: async () => undefined,
      runtimeHost: runtimeHost(),
      verifyCapturedAuthority: async () => ({
        backend,
        canonicalBackingLocation: "memory://prepared-writable-batch.hizofs",
        explicitBulkLimits: DEFAULT_EXPLICIT_BULK_TEST_LIMITS,
        fileMutationLimits: { maximumExtentMutationsPerBatch: 64 },
        indexDiagnostics: {
          recordIndexOperation: ({ operation }) => indexOperations.push(operation),
        },
        opened,
        operationTimestamp: () => createTimestampMilliseconds({ value: 1_700_000_000_000n }),
        randomSource,
        removalLimits: { deleteBatchSize: 64, maxVisitedInodes: 128 },
        recheckDurableGenerationAuthority: async () => undefined,
        rootSubvolumeId: createSubvolumeId({ value: 1n }),
        supportedFeatureBits,
        writableProfile: "release-qualified",
      }),
    });
    const file = await session.root.getFileHandle({ create: true, name: "sequential.bin" });
    const writable = await file.createWritable({ keepExistingData: false });
    const block = new Uint8Array(256 * 1024);
    block.fill(0x5a);

    await writable.write({ data: block, position: 0 });
    const writesAfterFirstStage = backend.dataSegmentWriteAtOperations;
    const indexOperationsAfterFirstStage = indexOperations.length;
    for (let index = 1; index < 4; index += 1) {
      await writable.write({ data: block, position: index * block.byteLength });
    }
    expect(backend.dataSegmentWriteAtOperations).toBe(writesAfterFirstStage);
    expect(indexOperations).toHaveLength(indexOperationsAfterFirstStage);

    // A non-tail overwrite cannot consume the append-only overlay. Materialize
    // it first so the general overlap-checked write observes the exact root.
    await writable.write({ data: Uint8Array.of(0x33), position: 3 });
    expect(indexOperations.length).toBeGreaterThan(indexOperationsAfterFirstStage);

    await writable.close();
    expect(backend.dataSegmentWriteAtOperations).toBe(writesAfterFirstStage + 1);
    expect(await file.stat()).toMatchObject({ size: block.byteLength * 4 });
    const readable = await file.openReadable({ mimeType: "application/octet-stream" });
    const persisted = new Uint8Array(block.byteLength * 4);
    expect(await readable.read({
      buffer: persisted,
      length: persisted.byteLength,
      offset: 0,
      position: 0,
      signal: undefined,
    })).toEqual({ bytesRead: persisted.byteLength });
    await readable.close();
    expect(persisted[3]).toBe(0x33);
    persisted[3] = 0x5a;
    expect(persisted.every(byte => byte === 0x5a)).toBe(true);

    await session.close();
    expect(opened.rootKey.isDestroyed()).toBe(true);
  });

  it("publishes sparse file writes and truncation through a prepared writable", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const supportedFeatureBits = createFeatureBits({ value: 0n });
    const passphrase = "correct horse battery staple";
    const opened = await createEmptyEncryptedContainer({
      backend,
      passphrase,
      randomSource,
      supportedFeatureBits,
    });
    let nextTimestamp = 1_700_000_000_000n;
    const session = await openAuthenticatedReadWriteApplicationSession({
      captureAuthority: async () => ({ revision: 1 }),
      recheckAuthority: async () => undefined,
      runtimeHost: runtimeHost(),
      verifyCapturedAuthority: async () => ({
        backend,
        canonicalBackingLocation: "memory://composition-root-test.hizofs",
        explicitBulkLimits: DEFAULT_EXPLICIT_BULK_TEST_LIMITS,
        fileMutationLimits: { maximumExtentMutationsPerBatch: 2 },
        opened,
        operationTimestamp: () => {
          const timestamp = createTimestampMilliseconds({ value: nextTimestamp });
          nextTimestamp += 1n;
          return timestamp;
        },
        randomSource,
        removalLimits: { deleteBatchSize: 2, maxVisitedInodes: 64 },
        recheckDurableGenerationAuthority: async () => undefined,
        rootSubvolumeId: createSubvolumeId({ value: 1n }),
        supportedFeatureBits,
        writableProfile: "release-qualified",
      }),
    });

    const file = await session.root.getFileHandle({ create: true, name: "sparse.bin" });
    const sparseOffset = HIZOFS_V1_FORMAT_CONSTANTS.limits.inlineFileBytes + 10;
    const writable = await file.createWritable({ keepExistingData: false });
    await writable.write({ data: new TextEncoder().encode("abcdef"), position: 0 });
    await writable.write({ data: new TextEncoder().encode("XY"), position: sparseOffset });
    await writable.write({ data: new TextEncoder().encode("ZZ"), position: 2 });
    // The first exact-tail append re-establishes the proof after the non-tail
    // writes; the second is held by the mutation-local extent overlay. Truncate
    // must materialize that overlay before preserving the first tail byte.
    await writable.write({ data: Uint8Array.of("T".charCodeAt(0)), position: sparseOffset + 2 });
    await writable.write({ data: Uint8Array.of("U".charCodeAt(0)), position: sparseOffset + 3 });
    await writable.truncate({ size: sparseOffset + 3 });
    await writable.close();

    expect(await file.stat()).toMatchObject({ size: sparseOffset + 3 });
    const readable = await file.openReadable({ mimeType: "application/octet-stream" });
    const bytes = new Uint8Array(sparseOffset + 3);
    expect(await readable.read({
      buffer: bytes,
      length: bytes.byteLength,
      offset: 0,
      position: 0,
      signal: undefined,
    })).toEqual({ bytesRead: bytes.byteLength });
    await readable.close();
    expect(new TextDecoder().decode(bytes.subarray(0, 6))).toBe("abZZef");
    expect(bytes.subarray(6, sparseOffset).every(byte => byte === 0)).toBe(true);
    expect(bytes[sparseOffset]).toBe("X".charCodeAt(0));
    expect(bytes[sparseOffset + 1]).toBe("Y".charCodeAt(0));
    expect(bytes[sparseOffset + 2]).toBe("T".charCodeAt(0));

    const aborted = await file.createWritable({ keepExistingData: true });
    await aborted.write({ data: Uint8Array.of(255), position: 0 });
    await aborted.abort({ reason: "test abort" });
    expect(await file.stat()).toMatchObject({ size: sparseOffset + 3 });

    await session.sync();
    await session.close();
    expect(opened.rootKey.isDestroyed()).toBe(true);

    const reopened = await openEmptyEncryptedContainer({
      backend,
      passphrase,
      supportedFeatureBits,
    });
    try {
      // File creation and content mutation coalesce into the same dirty epoch.
      expect(reopened.commit.commitSequence).toBe(2n);
      const resources = createAuthenticatedApplicationReadSessionResources({ backend, opened: reopened });
      try {
        const persisted = await resources.namespace.readFile({
          length: BigInt(sparseOffset + 3),
          offset: 0n,
          pathComponents: ["sparse.bin"],
        });
        expect(new TextDecoder().decode(persisted.subarray(0, 6))).toBe("abZZef");
        expect(persisted.subarray(6, sparseOffset).every(byte => byte === 0)).toBe(true);
        expect(persisted[sparseOffset]).toBe("X".charCodeAt(0));
        expect(persisted[sparseOffset + 1]).toBe("Y".charCodeAt(0));
        expect(persisted[sparseOffset + 2]).toBe("T".charCodeAt(0));
      } finally {
        await resources.releaseResources();
      }
    } finally {
      if (!reopened.rootKey.isDestroyed()) reopened.rootKey.destroy();
    }
  });

  it("resolves a lost file-publication response without retrying committed content", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const originalSyncFileData = backend.syncFileData.bind(backend);
    let failNextSuperblockDurabilityResponse = false;
    backend.syncFileData = async ({ file }) => {
      await originalSyncFileData({ file });
      if (failNextSuperblockDurabilityResponse && file.path.includes("superblock")) {
        failNextSuperblockDurabilityResponse = false;
        throw new Error("lost file-publication Superblock durability response");
      }
    };

    const randomSource = deterministicRandomSource();
    const supportedFeatureBits = createFeatureBits({ value: 0n });
    const passphrase = "correct horse battery staple";
    const opened = await createEmptyEncryptedContainer({
      backend,
      passphrase,
      randomSource,
      supportedFeatureBits,
    });
    let nextTimestamp = 1_700_000_000_000n;
    const session = await openAuthenticatedReadWriteApplicationSession({
      captureAuthority: async () => ({ revision: 1 }),
      recheckAuthority: async () => undefined,
      runtimeHost: immediateRuntimeHost(),
      verifyCapturedAuthority: async () => ({
        backend,
        canonicalBackingLocation: "memory://composition-root-test.hizofs",
        explicitBulkLimits: DEFAULT_EXPLICIT_BULK_TEST_LIMITS,
        fileMutationLimits: { maximumExtentMutationsPerBatch: 2 },
        opened,
        operationTimestamp: () => {
          const timestamp = createTimestampMilliseconds({ value: nextTimestamp });
          nextTimestamp += 1n;
          return timestamp;
        },
        randomSource,
        removalLimits: { deleteBatchSize: 2, maxVisitedInodes: 64 },
        recheckDurableGenerationAuthority: async () => undefined,
        rootSubvolumeId: createSubvolumeId({ value: 1n }),
        supportedFeatureBits,
        writableProfile: "release-qualified",
      }),
    });

    const file = await session.root.getFileHandle({ create: true, name: "committed.bin" });
    const writable = await file.createWritable({ keepExistingData: false });
    await writable.write({ data: new TextEncoder().encode("durable"), position: 0 });
    failNextSuperblockDurabilityResponse = true;
    await expect(writable.close()).rejects.toBeInstanceOf(HizoFSApplicationMutationCommittedDegradedError);

    const readable = await file.openReadable({ mimeType: "application/octet-stream" });
    const sameSessionBytes = new Uint8Array(7);
    await readable.read({
      buffer: sameSessionBytes,
      length: sameSessionBytes.byteLength,
      offset: 0,
      position: 0,
      signal: undefined,
    });
    await readable.close();
    expect(new TextDecoder().decode(sameSessionBytes)).toBe("durable");
    await expect(session.root.getFileHandle({ create: true, name: "must-not-retry.bin" }))
      .rejects.toBeInstanceOf(HizoFSApplicationMutationSessionPoisonedError);

    await session.close();
    const reopened = await openEmptyEncryptedContainer({ backend, passphrase, supportedFeatureBits });
    try {
      expect(reopened.commit.commitSequence).toBe(3n);
      expect(reopened.superblock.copyState).toBe("superblock_redundancy_degraded");
      const resources = createAuthenticatedApplicationReadSessionResources({ backend, opened: reopened });
      try {
        const persisted = await resources.namespace.readFile({
          offset: 0n,
          pathComponents: ["committed.bin"],
        });
        expect(new TextDecoder().decode(persisted)).toBe("durable");
      } finally {
        await resources.releaseResources();
      }
    } finally {
      if (!reopened.rootKey.isDestroyed()) reopened.rootKey.destroy();
    }
  });

  it("publishes ordinary moves atomically and preserves no-change and cycle semantics", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const supportedFeatureBits = createFeatureBits({ value: 0n });
    const passphrase = "correct horse battery staple";
    const opened = await createEmptyEncryptedContainer({
      backend,
      passphrase,
      randomSource,
      supportedFeatureBits,
    });
    let nextTimestamp = 1_700_000_000_000n;
    const session = await openAuthenticatedReadWriteApplicationSession({
      captureAuthority: async () => ({ revision: 1 }),
      recheckAuthority: async () => undefined,
      runtimeHost: runtimeHost(),
      verifyCapturedAuthority: async () => ({
        backend,
        canonicalBackingLocation: "memory://composition-root-test.hizofs",
        opened,
        explicitBulkLimits: DEFAULT_EXPLICIT_BULK_TEST_LIMITS,
        fileMutationLimits: { maximumExtentMutationsPerBatch: 2 },
        operationTimestamp: () => {
          const timestamp = createTimestampMilliseconds({ value: nextTimestamp });
          nextTimestamp += 1n;
          return timestamp;
        },
        randomSource,
        removalLimits: { deleteBatchSize: 2, maxVisitedInodes: 64 },
        recheckDurableGenerationAuthority: async () => undefined,
        rootSubvolumeId: createSubvolumeId({ value: 1n }),
        supportedFeatureBits,
        writableProfile: "release-qualified",
      }),
    });

    const source = await session.root.getDirectoryHandle({ create: true, name: "source" });
    const destination = await session.root.getDirectoryHandle({ create: true, name: "destination" });
    await source.getFileHandle({ create: true, name: "source.txt" });
    await destination.getFileHandle({ create: true, name: "replace.txt" });

    await source.moveEntry({
      destination,
      name: "source.txt",
      newName: "replace.txt",
      replace: true,
    });
    await expect(source.getEntryHandle({ name: "source.txt" })).rejects.toThrow();
    expect(await destination.getEntryHandle({ name: "replace.txt" })).toMatchObject({ kind: "file" });

    // Exact same-path moves resolve as verified no-ops and do not create a Commit.
    await destination.moveEntry({
      destination,
      name: "replace.txt",
      newName: "replace.txt",
      replace: false,
    });

    const nested = await source.getDirectoryHandle({ create: true, name: "nested" });
    await expect(session.root.moveEntry({
      destination: nested,
      name: "source",
      newName: "source",
      replace: false,
    })).rejects.toMatchObject({ code: "directory_cycle" });

    // Planning rejection closes only the mutation authority; the session remains usable.
    await source.getFileHandle({ create: true, name: "after-cycle.txt" });
    await session.sync();
    await session.close();
    expect(opened.rootKey.isDestroyed()).toBe(true);

    const reopened = await openEmptyEncryptedContainer({
      backend,
      passphrase,
      supportedFeatureBits,
    });
    try {
      // All accepted namespace changes publish as the latest candidate of one dirty epoch.
      expect(reopened.commit.commitSequence).toBe(2n);
      const resources = createAuthenticatedApplicationReadSessionResources({ backend, opened: reopened });
      try {
        await expect(resources.namespace.stat({ pathComponents: ["source", "source.txt"] })).rejects.toThrow();
        expect(await resources.namespace.stat({ pathComponents: ["destination", "replace.txt"] }))
          .toMatchObject({ kind: "file" });
        expect(await resources.namespace.stat({ pathComponents: ["source", "after-cycle.txt"] }))
          .toMatchObject({ kind: "file" });
      } finally {
        await resources.releaseResources();
      }
    } finally {
      if (!reopened.rootKey.isDestroyed()) reopened.rootKey.destroy();
    }
  });

  it("publishes whole-file reflinks and preserves Copy-on-Write isolation across reopen", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const supportedFeatureBits = createFeatureBits({ value: 0n });
    const passphrase = "correct horse battery staple";
    const opened = await createEmptyEncryptedContainer({
      backend,
      passphrase,
      randomSource,
      supportedFeatureBits,
    });
    let nextTimestamp = 1_700_000_000_000n;
    const session = await openAuthenticatedReadWriteApplicationSession({
      captureAuthority: async () => ({ revision: 1 }),
      recheckAuthority: async () => undefined,
      runtimeHost: runtimeHost(),
      verifyCapturedAuthority: async () => ({
        backend,
        canonicalBackingLocation: "memory://composition-root-test.hizofs",
        explicitBulkLimits: DEFAULT_EXPLICIT_BULK_TEST_LIMITS,
        fileMutationLimits: { maximumExtentMutationsPerBatch: 2 },
        opened,
        operationTimestamp: () => {
          const timestamp = createTimestampMilliseconds({ value: nextTimestamp });
          nextTimestamp += 1n;
          return timestamp;
        },
        randomSource,
        removalLimits: { deleteBatchSize: 2, maxVisitedInodes: 64 },
        recheckDurableGenerationAuthority: async () => undefined,
        rootSubvolumeId: createSubvolumeId({ value: 1n }),
        supportedFeatureBits,
        writableProfile: "release-qualified",
      }),
    });

    const source = await session.root.getFileHandle({ create: true, name: "source.bin" });
    const sourceBytes = Uint8Array.from(
      { length: HIZOFS_V1_FORMAT_CONSTANTS.limits.inlineFileBytes + 64 },
      (_, index) => index % 251,
    );
    const sourceWritable = await source.createWritable({ keepExistingData: false });
    await sourceWritable.write({ data: sourceBytes, position: 0 });
    await sourceWritable.close();

    const destination = await session.root.getDirectoryHandle({ create: true, name: "destination" });
    await destination.getFileHandle({ create: true, name: "clone.bin" });
    await expect(session.root.cloneFile({
      destination,
      name: "source.bin",
      newName: "clone.bin",
      replace: false,
    })).rejects.toMatchObject({ code: "destination_exists" });

    const clone = await session.root.cloneFile({
      destination,
      name: "source.bin",
      newName: "clone.bin",
      replace: true,
    });
    await expect(session.root.cloneFile({
      destination: session.root,
      name: "source.bin",
      newName: "source.bin",
      replace: true,
    })).rejects.toMatchObject({ code: "destructive_self_replace" });

    const cloneWritable = await clone.createWritable({ keepExistingData: true });
    await cloneWritable.write({ data: Uint8Array.of(9, 8, 7, 6), position: 2 });
    await cloneWritable.close();

    const readAll = async ({ file }: { file: typeof source }): Promise<Uint8Array> => {
      const stat = await file.stat();
      const bytes = new Uint8Array(stat.size);
      const readable = await file.openReadable({ mimeType: "application/octet-stream" });
      try {
        expect(await readable.read({
          buffer: bytes,
          length: bytes.byteLength,
          offset: 0,
          position: 0,
          signal: undefined,
        })).toEqual({ bytesRead: bytes.byteLength });
        return bytes;
      } finally {
        await readable.close();
      }
    };

    expect(await readAll({ file: source })).toEqual(sourceBytes);
    const cloneBytes = await readAll({ file: clone });
    expect(cloneBytes.subarray(0, 8)).toEqual(Uint8Array.of(0, 1, 9, 8, 7, 6, 6, 7));
    expect(cloneBytes.subarray(8)).toEqual(sourceBytes.subarray(8));

    // Planning rejection closes only the attempted metadata authority.
    await session.root.getFileHandle({ create: true, name: "after-rejection.bin" });
    await session.sync();
    await session.close();
    expect(opened.rootKey.isDestroyed()).toBe(true);

    const reopened = await openEmptyEncryptedContainer({ backend, passphrase, supportedFeatureBits });
    try {
      const resources = createAuthenticatedApplicationReadSessionResources({ backend, opened: reopened });
      try {
        const persistedSource = await resources.namespace.readFile({
          offset: 0n,
          pathComponents: ["source.bin"],
        });
        const persistedClone = await resources.namespace.readFile({
          offset: 0n,
          pathComponents: ["destination", "clone.bin"],
        });
        expect(persistedSource).toEqual(sourceBytes);
        expect(persistedClone).toEqual(cloneBytes);
        expect(await resources.namespace.stat({ pathComponents: ["after-rejection.bin"] }))
          .toMatchObject({ kind: "file" });
      } finally {
        await resources.releaseResources();
      }
    } finally {
      if (!reopened.rootKey.isDestroyed()) reopened.rootKey.destroy();
    }
  });

  it("retries the same automatic candidate after a definitely-not-published sync failure", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const supportedFeatureBits = createFeatureBits({ value: 0n });
    const passphrase = "correct horse battery staple";
    const opened = await createEmptyEncryptedContainer({
      backend,
      passphrase,
      randomSource,
      supportedFeatureBits,
    });
    const originalWriteAt = backend.writeAt.bind(backend);
    let failNextSuperblockWrite = false;
    backend.writeAt = async ({ bytes, file, offset }) => {
      if (failNextSuperblockWrite && file.path.includes("superblock")) {
        failNextSuperblockWrite = false;
        throw new Error("injected pre-publication Superblock write failure");
      }
      await originalWriteAt({ bytes, file, offset });
    };
    const host = runtimeHost({
      lazyDurability: {
        ...DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY,
        maximumDirtyAgeMilliseconds: 60_000,
      },
    });
    const session = await openAuthenticatedReadWriteApplicationSession({
      captureAuthority: async () => ({ revision: 1 }),
      recheckAuthority: async () => undefined,
      runtimeHost: host,
      verifyCapturedAuthority: async () => ({
        backend,
        canonicalBackingLocation: "memory://development-retry-publication.hizofs",
        explicitBulkLimits: DEFAULT_EXPLICIT_BULK_TEST_LIMITS,
        fileMutationLimits: { maximumExtentMutationsPerBatch: 2 },
        opened,
        operationTimestamp: () => createTimestampMilliseconds({ value: 1_700_000_000_000n }),
        randomSource,
        removalLimits: { deleteBatchSize: 2, maxVisitedInodes: 64 },
        recheckDurableGenerationAuthority: async () => undefined,
        rootSubvolumeId: createSubvolumeId({ value: 1n }),
        supportedFeatureBits,
        writableProfile: "release-qualified",
      }),
    });

    await session.root.getFileHandle({ create: true, name: "retry.txt" });
    failNextSuperblockWrite = true;
    await expect(session.sync()).rejects.toMatchObject({
      code: "durable_publication_failed",
      retryable: true,
    });
    expect(host.workingCandidatePublicationState()).toBe("installed");
    await expect(session.root.getFileHandle({ create: false, name: "retry.txt" }))
      .resolves.toMatchObject({ name: "retry.txt" });

    await expect(session.sync()).resolves.toBeUndefined();
    expect(host.workingCandidatePublicationState()).toBe("empty");
    const reopened = await openEmptyEncryptedContainer({ backend, passphrase, supportedFeatureBits });
    try {
      const resources = createAuthenticatedApplicationReadSessionResources({ backend, opened: reopened });
      try {
        expect(await resources.namespace.stat({ pathComponents: ["retry.txt"] }))
          .toMatchObject({ kind: "file" });
      } finally {
        await resources.releaseResources();
      }
    } finally {
      if (!reopened.rootKey.isDestroyed()) reopened.rootKey.destroy();
    }
    await session.close();
  });

  it("fences an active lazy candidate after an outcome-unknown sync and resolves it from authenticated reopen", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const originalSyncFileData = backend.syncFileData.bind(backend);
    const originalReadFileBounded = backend.readFileBounded.bind(backend);
    const publicationFailure = new Error("lost active lazy Superblock durability response");
    const resolutionFailure = new Error("active lazy Superblock authority reread failed");
    let failResolutionReads = false;
    let superblockDurabilityResponsesUntilFailure = 0;
    backend.syncFileData = async ({ file }) => {
      await originalSyncFileData({ file });
      if (superblockDurabilityResponsesUntilFailure > 0 && file.path.includes("superblock")) {
        superblockDurabilityResponsesUntilFailure -= 1;
        if (superblockDurabilityResponsesUntilFailure === 0) {
          failResolutionReads = true;
          throw publicationFailure;
        }
      }
    };
    backend.readFileBounded = async ({ maximumByteLength, path }) => {
      if (failResolutionReads && path.includes("superblock")) throw resolutionFailure;
      return await originalReadFileBounded({ maximumByteLength, path });
    };

    const randomSource = deterministicRandomSource();
    const supportedFeatureBits = createFeatureBits({ value: 0n });
    const passphrase = "correct horse battery staple";
    const opened = await createEmptyEncryptedContainer({
      backend,
      passphrase,
      randomSource,
      supportedFeatureBits,
    });
    const host = runtimeHost({
      lazyDurability: {
        ...DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY,
        maximumDirtyAgeMilliseconds: 60_000,
      },
    });
    const openSession = async ({ openedContainer }: {
      openedContainer: Awaited<ReturnType<typeof openEmptyEncryptedContainer>>;
    }) => await openAuthenticatedReadWriteApplicationSession({
      captureAuthority: async () => ({ revision: 1 }),
      recheckAuthority: async () => undefined,
      runtimeHost: host,
      verifyCapturedAuthority: async () => ({
        backend,
        canonicalBackingLocation: "memory://development-outcome-unknown.hizofs",
        explicitBulkLimits: DEFAULT_EXPLICIT_BULK_TEST_LIMITS,
        fileMutationLimits: { maximumExtentMutationsPerBatch: 2 },
        opened: openedContainer,
        operationTimestamp: () => createTimestampMilliseconds({ value: 1_700_000_000_000n }),
        randomSource,
        removalLimits: { deleteBatchSize: 2, maxVisitedInodes: 64 },
        recheckDurableGenerationAuthority: async () => undefined,
        rootSubvolumeId: createSubvolumeId({ value: 1n }),
        supportedFeatureBits,
        writableProfile: "release-qualified",
      }),
    });
    const session = await openSession({ openedContainer: opened });

    await session.root.getFileHandle({ create: true, name: "uncertain.txt" });
    // Lose the response only after both A/B copies have reached durable
    // storage so authenticated reopen can resolve a converged published head.
    superblockDurabilityResponsesUntilFailure = 2;
    await expect(session.sync()).rejects.toMatchObject({
      code: "durable_publication_outcome_unknown",
      retryable: false,
    });
    expect(host.workingCandidatePublicationState()).toBe("outcome_unknown");
    await expect(session.root.getFileHandle({ create: true, name: "blocked-after-unknown.txt" }))
      .rejects.toBeInstanceOf(HizoFSApplicationMutationSessionPoisonedError);

    failResolutionReads = false;
    const reopened = await openEmptyEncryptedContainer({ backend, passphrase, supportedFeatureBits });
    const resolvedSession = await openSession({ openedContainer: reopened });
    expect(host.workingCandidatePublicationState()).toBe("empty");
    await expect(resolvedSession.root.getFileHandle({ create: false, name: "uncertain.txt" }))
      .resolves.toMatchObject({ name: "uncertain.txt" });

    await resolvedSession.close();
    await session.close();
  });

  it("serializes the next public mutation behind in-flight background Commit materialization", async () => {
    const delegate = new InMemoryCrossRealmLockPort();
    const publicationLockRequested = Promise.withResolvers<void>();
    const releasePublicationLock = Promise.withResolvers<void>();
    let blockNextPublicationLock = false;
    const crossRealmLockPort: CrossRealmLockPort = {
      acquire: async ({ mode, name }) => {
        if (blockNextPublicationLock && mode === "exclusive" && name.includes("/publication/")) {
          blockNextPublicationLock = false;
          publicationLockRequested.resolve();
          await releasePublicationLock.promise;
        }
        return await delegate.acquire({ mode, name });
      },
      queryHeldLockNames: async () => await delegate.queryHeldLockNames(),
      tryAcquire: async ({ mode, name }) => await delegate.tryAcquire({ mode, name }),
    };
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const supportedFeatureBits = createFeatureBits({ value: 0n });
    const passphrase = "correct horse battery staple";
    const opened = await createEmptyEncryptedContainer({
      backend,
      passphrase,
      randomSource,
      supportedFeatureBits,
    });
    const host = runtimeHost({
      crossRealmLockPort,
      lazyDurability: {
        ...DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY,
        maximumDirtyAgeMilliseconds: 1,
      },
    });
    const session = await openAuthenticatedReadWriteApplicationSession({
      captureAuthority: async () => ({ revision: 1 }),
      recheckAuthority: async () => undefined,
      runtimeHost: host,
      verifyCapturedAuthority: async () => ({
        backend,
        canonicalBackingLocation: "memory://background-writer-serialization.hizofs",
        explicitBulkLimits: DEFAULT_EXPLICIT_BULK_TEST_LIMITS,
        fileMutationLimits: { maximumExtentMutationsPerBatch: 2 },
        opened,
        operationTimestamp: () => createTimestampMilliseconds({ value: 1_700_000_000_000n }),
        randomSource,
        removalLimits: { deleteBatchSize: 2, maxVisitedInodes: 64 },
        recheckDurableGenerationAuthority: async () => undefined,
        rootSubvolumeId: createSubvolumeId({ value: 1n }),
        supportedFeatureBits,
        writableProfile: "release-qualified",
      }),
    });

    await session.root.getFileHandle({ create: true, name: "first.txt" });
    blockNextPublicationLock = true;
    await publicationLockRequested.promise;

    let secondMutationCompleted = false;
    const secondMutation = session.root.getFileHandle({ create: true, name: "second.txt" }).then(handle => {
      secondMutationCompleted = true;
      return handle;
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(secondMutationCompleted).toBe(false);

    releasePublicationLock.resolve();
    await expect(secondMutation).resolves.toMatchObject({ name: "second.txt" });
    await session.close();
  });

  it("publishes the automatic development candidate from the dirty-age background trigger", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const supportedFeatureBits = createFeatureBits({ value: 0n });
    const passphrase = "correct horse battery staple";
    const opened = await createEmptyEncryptedContainer({
      backend,
      passphrase,
      randomSource,
      supportedFeatureBits,
    });
    const host = runtimeHost({
      lazyDurability: {
        ...DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY,
        maximumDirtyAgeMilliseconds: 1,
      },
    });
    let durableAuthorityRechecks = 0;
    const session = await openAuthenticatedReadWriteApplicationSession({
      captureAuthority: async () => ({ revision: 1 }),
      recheckAuthority: async () => undefined,
      runtimeHost: host,
      verifyCapturedAuthority: async () => ({
        backend,
        canonicalBackingLocation: "memory://development-background-publication.hizofs",
        explicitBulkLimits: DEFAULT_EXPLICIT_BULK_TEST_LIMITS,
        fileMutationLimits: { maximumExtentMutationsPerBatch: 2 },
        opened,
        operationTimestamp: () => createTimestampMilliseconds({ value: 1_700_000_000_000n }),
        randomSource,
        removalLimits: { deleteBatchSize: 2, maxVisitedInodes: 64 },
        recheckDurableGenerationAuthority: async () => {
          durableAuthorityRechecks += 1;
        },
        rootSubvolumeId: createSubvolumeId({ value: 1n }),
        supportedFeatureBits,
        writableProfile: "release-qualified",
      }),
    });

    await session.root.getFileHandle({ create: true, name: "background.txt" });
    expect(host.workingCandidatePublicationState()).not.toBe("empty");

    let published = false;
    for (let attempt = 0; attempt < 100 && !published; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
      const reopened = await openEmptyEncryptedContainer({ backend, passphrase, supportedFeatureBits });
      try {
        if (reopened.commit.commitSequence !== 2n) continue;
        const resources = createAuthenticatedApplicationReadSessionResources({ backend, opened: reopened });
        try {
          expect(await resources.namespace.stat({ pathComponents: ["background.txt"] }))
            .toMatchObject({ kind: "file" });
          published = true;
        } finally {
          await resources.releaseResources();
        }
      } finally {
        if (!reopened.rootKey.isDestroyed()) reopened.rootKey.destroy();
      }
    }
    expect(published).toBe(true);
    expect(host.workingCandidatePublicationState()).toBe("empty");
    expect(durableAuthorityRechecks).toBe(1);

    await session.root.getFileHandle({ create: true, name: "after-background.txt" });
    // Background publication changed the exact durable identity. The first
    // mutation on that new head must authenticate it instead of reusing the
    // previous head's physical A/B proof.
    expect(durableAuthorityRechecks).toBe(2);
    await session.sync();
    await session.close();
  });

  it("keeps a staged lazy candidate publishable after its originating session closes", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const supportedFeatureBits = createFeatureBits({ value: 0n });
    const passphrase = "correct horse battery staple";
    const opened = await createEmptyEncryptedContainer({
      backend,
      passphrase,
      randomSource,
      supportedFeatureBits,
    });
    const host = runtimeHost({
      lazyDurability: {
        ...DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY,
        maximumDirtyAgeMilliseconds: 60_000,
      },
    });
    const session = await openAuthenticatedReadWriteApplicationSession({
      captureAuthority: async () => ({ revision: 1 }),
      recheckAuthority: async () => undefined,
      runtimeHost: host,
      verifyCapturedAuthority: async () => ({
        backend,
        canonicalBackingLocation: "memory://session-close-dirty-writeback.hizofs",
        explicitBulkLimits: DEFAULT_EXPLICIT_BULK_TEST_LIMITS,
        fileMutationLimits: { maximumExtentMutationsPerBatch: 2 },
        opened,
        operationTimestamp: () => createTimestampMilliseconds({ value: 1_700_000_000_000n }),
        randomSource,
        removalLimits: { deleteBatchSize: 2, maxVisitedInodes: 64 },
        recheckDurableGenerationAuthority: async () => undefined,
        rootSubvolumeId: createSubvolumeId({ value: 1n }),
        supportedFeatureBits,
        writableProfile: "release-qualified",
      }),
    });

    await session.root.getFileHandle({ create: true, name: "after-close.txt" });
    expect(host.workingCandidatePublicationState()).toBe("installed");
    await session.close();

    await expect(host.flushAndDisposeIfIdleAndSafe()).resolves.toEqual({ status: "disposed" });
    const reopened = await openEmptyEncryptedContainer({ backend, passphrase, supportedFeatureBits });
    try {
      expect(reopened.commit.commitSequence).toBe(2n);
      const resources = createAuthenticatedApplicationReadSessionResources({ backend, opened: reopened });
      try {
        await expect(resources.namespace.stat({ pathComponents: ["after-close.txt"] }))
          .resolves.toMatchObject({ kind: "file" });
      } finally {
        await resources.releaseResources();
      }
    } finally {
      if (!reopened.rootKey.isDestroyed()) reopened.rootKey.destroy();
    }
  });

  it("retains a runtime-owned candidate root after session close when publication outcome resolution fails", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const originalSyncFileData = backend.syncFileData.bind(backend);
    const originalReadFileBounded = backend.readFileBounded.bind(backend);
    const publicationFailure = new Error("lost Superblock durability response");
    const resolutionFailure = new Error("Superblock authority reread failed");
    let failNextSuperblockDurabilityResponse = false;
    let failResolutionReads = false;
    backend.syncFileData = async ({ file }) => {
      await originalSyncFileData({ file });
      if (failNextSuperblockDurabilityResponse && file.path.includes("superblock")) {
        failNextSuperblockDurabilityResponse = false;
        failResolutionReads = true;
        throw publicationFailure;
      }
    };
    backend.readFileBounded = async ({ maximumByteLength, path }) => {
      if (failResolutionReads && path.includes("superblock")) throw resolutionFailure;
      return await originalReadFileBounded({ maximumByteLength, path });
    };

    const randomSource = deterministicRandomSource();
    const supportedFeatureBits = createFeatureBits({ value: 0n });
    const opened = await createEmptyEncryptedContainer({
      backend,
      passphrase: "correct horse battery staple",
      randomSource,
      supportedFeatureBits,
    });
    const host = immediateRuntimeHost();
    const session = await openAuthenticatedReadWriteApplicationSession({
      captureAuthority: async () => ({ revision: 1 }),
      recheckAuthority: async () => undefined,
      runtimeHost: host,
      verifyCapturedAuthority: async () => ({
        backend,
        canonicalBackingLocation: "memory://composition-root-test.hizofs",
        opened,
        explicitBulkLimits: DEFAULT_EXPLICIT_BULK_TEST_LIMITS,
        fileMutationLimits: { maximumExtentMutationsPerBatch: 2 },
        operationTimestamp: () => createTimestampMilliseconds({ value: 1_700_000_000_000n }),
        randomSource,
        removalLimits: { deleteBatchSize: 2, maxVisitedInodes: 64 },
        recheckDurableGenerationAuthority: async () => undefined,
        rootSubvolumeId: createSubvolumeId({ value: 1n }),
        supportedFeatureBits,
        writableProfile: "release-qualified",
      }),
    });

    failNextSuperblockDurabilityResponse = true;
    const failed = session.root.getFileHandle({ create: true, name: "unresolved.txt" });
    await expect(failed).rejects.toBeInstanceOf(AggregateError);
    await expect(failed).rejects.toMatchObject({
      errors: [expect.any(Error), resolutionFailure],
    });

    const retained = await host.beginMaintenanceRootCapture();
    expect(retained.workingGenerationDependencyRoots).toHaveLength(1);
    retained.release();
    await retained.released;
    expect(host.workingCandidatePublicationState()).toBe("outcome_unknown");
    await expect(session.root.getFileHandle({ create: true, name: "blocked.txt" }))
      .rejects.toBeInstanceOf(HizoFSApplicationMutationSessionPoisonedError);

    failResolutionReads = false;
    await session.close();
    const retainedAfterSessionClose = await host.beginMaintenanceRootCapture();
    expect(retainedAfterSessionClose.workingGenerationDependencyRoots).toHaveLength(1);
    retainedAfterSessionClose.release();
    await retainedAfterSessionClose.released;
    expect(host.workingCandidatePublicationState()).toBe("outcome_unknown");
  });

  it("lets an admitted candidate publish before close while rejecting the late capability return", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const supportedFeatureBits = createFeatureBits({ value: 0n });
    const passphrase = "correct horse battery staple";
    const opened = await createEmptyEncryptedContainer({
      backend,
      passphrase,
      randomSource,
      supportedFeatureBits,
    });
    const originalOpenFileForUpdate = backend.openFileForUpdate.bind(backend);
    const reachedAuthorityOpen = Promise.withResolvers<void>();
    const resumeAuthorityOpen = Promise.withResolvers<void>();
    let blockNextSuperblockOpen = false;
    backend.openFileForUpdate = async ({ path }) => {
      if (blockNextSuperblockOpen && path.includes("superblock")) {
        blockNextSuperblockOpen = false;
        reachedAuthorityOpen.resolve();
        await resumeAuthorityOpen.promise;
      }
      return await originalOpenFileForUpdate({ path });
    };

    const host = immediateRuntimeHost();
    const session = await openAuthenticatedReadWriteApplicationSession({
      captureAuthority: async () => ({ revision: 1 }),
      recheckAuthority: async () => undefined,
      runtimeHost: host,
      verifyCapturedAuthority: async () => ({
        backend,
        canonicalBackingLocation: "memory://composition-root-test.hizofs",
        opened,
        explicitBulkLimits: DEFAULT_EXPLICIT_BULK_TEST_LIMITS,
        fileMutationLimits: { maximumExtentMutationsPerBatch: 2 },
        operationTimestamp: () => createTimestampMilliseconds({ value: 1_700_000_000_000n }),
        randomSource,
        removalLimits: { deleteBatchSize: 2, maxVisitedInodes: 64 },
        recheckDurableGenerationAuthority: async () => undefined,
        rootSubvolumeId: createSubvolumeId({ value: 1n }),
        supportedFeatureBits,
        writableProfile: "release-qualified",
      }),
    });

    blockNextSuperblockOpen = true;
    const mutation = session.root.getFileHandle({ create: true, name: "must-not-publish.txt" });
    await reachedAuthorityOpen.promise;
    const closing = session.close();
    resumeAuthorityOpen.resolve();

    await expect(mutation).rejects.toThrow("HizoFS application session is closed");
    await expect(closing).resolves.toBeUndefined();
    const capture = await host.beginMaintenanceRootCapture();
    expect(capture.workingGenerationDependencyRoots).toEqual([]);
    capture.release();
    await capture.released;

    const reopened = await openEmptyEncryptedContainer({ backend, passphrase, supportedFeatureBits });
    try {
      expect(reopened.commit.commitSequence).toBe(2n);
      const resources = createAuthenticatedApplicationReadSessionResources({ backend, opened: reopened });
      try {
        await expect(resources.namespace.stat({ pathComponents: ["must-not-publish.txt"] }))
          .resolves.toMatchObject({ kind: "file" });
      } finally {
        await resources.releaseResources();
      }
    } finally {
      if (!reopened.rootKey.isDestroyed()) reopened.rootKey.destroy();
    }
  });

  it("resolves a lost first-Superblock response as committed, degraded, and non-retryable", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const originalSyncFileData = backend.syncFileData.bind(backend);
    let failNextSuperblockDurabilityResponse = false;
    backend.syncFileData = async ({ file }) => {
      await originalSyncFileData({ file });
      if (failNextSuperblockDurabilityResponse && file.path.includes("superblock")) {
        failNextSuperblockDurabilityResponse = false;
        throw new Error("lost first Superblock durability response");
      }
    };

    const randomSource = deterministicRandomSource();
    const supportedFeatureBits = createFeatureBits({ value: 0n });
    const passphrase = "correct horse battery staple";
    const opened = await createEmptyEncryptedContainer({
      backend,
      passphrase,
      randomSource,
      supportedFeatureBits,
    });
    let nextTimestamp = 1_700_000_000_000n;
    const session = await openAuthenticatedReadWriteApplicationSession({
      captureAuthority: async () => ({ revision: 1 }),
      recheckAuthority: async () => undefined,
      runtimeHost: immediateRuntimeHost(),
      verifyCapturedAuthority: async () => ({
        backend,
        canonicalBackingLocation: "memory://composition-root-test.hizofs",
        opened,
        explicitBulkLimits: DEFAULT_EXPLICIT_BULK_TEST_LIMITS,
        fileMutationLimits: { maximumExtentMutationsPerBatch: 2 },
        operationTimestamp: () => {
          const timestamp = createTimestampMilliseconds({ value: nextTimestamp });
          nextTimestamp += 1n;
          return timestamp;
        },
        randomSource,
        removalLimits: { deleteBatchSize: 2, maxVisitedInodes: 64 },
        recheckDurableGenerationAuthority: async () => undefined,
        rootSubvolumeId: createSubvolumeId({ value: 1n }),
        supportedFeatureBits,
        writableProfile: "release-qualified",
      }),
    });

    failNextSuperblockDurabilityResponse = true;
    await expect(session.root.getFileHandle({ create: true, name: "committed.txt" }))
      .rejects.toBeInstanceOf(HizoFSApplicationMutationCommittedDegradedError);
    expect(await session.root.getEntryHandle({ name: "committed.txt" })).toMatchObject({ kind: "file" });
    await expect(session.root.getFileHandle({ create: true, name: "must-not-retry.txt" }))
      .rejects.toBeInstanceOf(HizoFSApplicationMutationSessionPoisonedError);

    await session.close();
    expect(opened.rootKey.isDestroyed()).toBe(true);

    const reopened = await openEmptyEncryptedContainer({
      backend,
      passphrase,
      supportedFeatureBits,
    });
    try {
      expect(reopened.commit.commitSequence).toBe(2n);
      expect(reopened.superblock.copyState).toBe("superblock_redundancy_degraded");
      const resources = createAuthenticatedApplicationReadSessionResources({ backend, opened: reopened });
      try {
        expect(await resources.namespace.stat({ pathComponents: ["committed.txt"] })).toMatchObject({
          fileSize: 0n,
          kind: "file",
        });
      } finally {
        await resources.releaseResources();
      }
    } finally {
      if (!reopened.rootKey.isDestroyed()) reopened.rootKey.destroy();
    }
  });

  it("accepts a development lazy metadata mutation before sync and publishes the same candidate on sync", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const supportedFeatureBits = createFeatureBits({ value: 0n });
    const passphrase = "correct horse battery staple";
    const opened = await createEmptyEncryptedContainer({
      backend,
      passphrase,
      randomSource,
      supportedFeatureBits,
    });
    const host = runtimeHost({
      lazyDurability: {
        ...DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY,
        maximumDirtyAgeMilliseconds: 60_000,
      },
      lazyPublicationRollout: evaluateLazyPublicationRolloutGate({
        evidence: {
          accepted_only_success_timing: true,
          active_head_maintenance_clean_head: false,
          bounded_dirty_resources: true,
          fault_campaign: false,
          generation_target_sync: true,
          production_background_publication: true,
          provider_graceful_shutdown: true,
          single_runtime_write_authority: true,
          transition_and_credential_clean_head: true,
        },
      }),
    });
    let nextTimestamp = 1_700_000_000_000n;
    const session = await openAuthenticatedReadWriteApplicationSession({
      captureAuthority: async () => ({ revision: 1 }),
      recheckAuthority: async () => undefined,
      runtimeHost: host,
      verifyCapturedAuthority: async () => ({
        backend,
        canonicalBackingLocation: "memory://development-lazy-normal-path.hizofs",
        explicitBulkLimits: DEFAULT_EXPLICIT_BULK_TEST_LIMITS,
        fileMutationLimits: { maximumExtentMutationsPerBatch: 2 },
        opened,
        operationTimestamp: () => {
          const timestamp = createTimestampMilliseconds({ value: nextTimestamp });
          nextTimestamp += 1n;
          return timestamp;
        },
        randomSource,
        removalLimits: { deleteBatchSize: 2, maxVisitedInodes: 64 },
        recheckDurableGenerationAuthority: async () => undefined,
        rootSubvolumeId: createSubvolumeId({ value: 1n }),
        supportedFeatureBits,
        writableProfile: "release-qualified",
      }),
    });

    const acceptedFile = await session.root.getFileHandle({ create: true, name: "accepted.txt" });
    const writable = await acceptedFile.createWritable({ keepExistingData: false });
    await writable.write({ data: new TextEncoder().encode("lazy"), position: 0 });
    await writable.close();
    await expect(session.root.getFileHandle({ create: false, name: "accepted.txt" }))
      .resolves.toMatchObject({ name: "accepted.txt" });
    const sameRuntimeReadable = await acceptedFile.openReadable({ mimeType: "application/octet-stream" });
    expect(sameRuntimeReadable.size).toBe(4);

    const replacementText = "newer!";
    const replacementBytes = new TextEncoder().encode(replacementText);
    const replacementWritable = await acceptedFile.createWritable({ keepExistingData: false });
    await replacementWritable.write({ data: replacementBytes, position: 0 });
    await replacementWritable.close();

    const sameRuntimeBytes = new Uint8Array(4);
    expect(await sameRuntimeReadable.read({
      buffer: sameRuntimeBytes,
      length: sameRuntimeBytes.byteLength,
      offset: 0,
      position: 0,
      signal: undefined,
    })).toEqual({ bytesRead: 4 });
    await sameRuntimeReadable.close();
    expect(new TextDecoder().decode(sameRuntimeBytes)).toBe("lazy");

    const replacementReadable = await acceptedFile.openReadable({ mimeType: "application/octet-stream" });
    const replacementReadBytes = new Uint8Array(replacementBytes.byteLength);
    expect(replacementReadable.size).toBe(replacementBytes.byteLength);
    expect(await replacementReadable.read({
      buffer: replacementReadBytes,
      length: replacementReadBytes.byteLength,
      offset: 0,
      position: 0,
      signal: undefined,
    })).toEqual({ bytesRead: replacementBytes.byteLength });
    await replacementReadable.close();
    expect(new TextDecoder().decode(replacementReadBytes)).toBe(replacementText);

    const beforeSync = await openEmptyEncryptedContainer({ backend, passphrase, supportedFeatureBits });
    try {
      expect(beforeSync.commit.commitSequence).toBe(1n);
      const resources = createAuthenticatedApplicationReadSessionResources({ backend, opened: beforeSync });
      try {
        await expect(resources.namespace.stat({ pathComponents: ["accepted.txt"] })).rejects.toBeDefined();
      } finally {
        await resources.releaseResources();
      }
    } finally {
      if (!beforeSync.rootKey.isDestroyed()) beforeSync.rootKey.destroy();
    }

    await expect(session.sync()).resolves.toBeUndefined();
    const afterSync = await openEmptyEncryptedContainer({ backend, passphrase, supportedFeatureBits });
    try {
      expect(afterSync.commit.commitSequence).toBe(2n);
      const resources = createAuthenticatedApplicationReadSessionResources({ backend, opened: afterSync });
      try {
        expect(await resources.namespace.stat({ pathComponents: ["accepted.txt"] })).toMatchObject({
          fileSize: BigInt(replacementBytes.byteLength),
          kind: "file",
        });
        const persisted = await resources.namespace.readFile({
          offset: 0n,
          pathComponents: ["accepted.txt"],
        });
        expect(new TextDecoder().decode(persisted)).toBe(replacementText);
      } finally {
        await resources.releaseResources();
      }
    } finally {
      if (!afterSync.rootKey.isDestroyed()) afterSync.rootKey.destroy();
    }
    await session.close();
  });

  it("waits for a prepared writable before materializing a staged read snapshot", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const supportedFeatureBits = createFeatureBits({ value: 0n });
    const passphrase = "correct horse battery staple";
    const opened = await createEmptyEncryptedContainer({
      backend,
      passphrase,
      randomSource,
      supportedFeatureBits,
    });
    const host = runtimeHost({
      lazyDurability: {
        ...DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY,
        maximumDirtyAgeMilliseconds: 60_000,
      },
    });
    const session = await openAuthenticatedReadWriteApplicationSession({
      captureAuthority: async () => ({ revision: 1 }),
      recheckAuthority: async () => undefined,
      runtimeHost: host,
      verifyCapturedAuthority: async () => ({
        backend,
        canonicalBackingLocation: "memory://read-snapshot-prepared-writer.hizofs",
        explicitBulkLimits: DEFAULT_EXPLICIT_BULK_TEST_LIMITS,
        fileMutationLimits: { maximumExtentMutationsPerBatch: 2 },
        opened,
        operationTimestamp: () => createTimestampMilliseconds({ value: 1_700_000_000_000n }),
        randomSource,
        removalLimits: { deleteBatchSize: 2, maxVisitedInodes: 64 },
        recheckDurableGenerationAuthority: async () => undefined,
        rootSubvolumeId: createSubvolumeId({ value: 1n }),
        supportedFeatureBits,
        writableProfile: "release-qualified",
      }),
    });

    const dirtyFile = await session.root.getFileHandle({ create: true, name: "dirty.txt" });
    const heldWritable = await dirtyFile.createWritable({ keepExistingData: true });
    let snapshotSettled = false;
    if (session.createReadSnapshot === undefined) throw new Error("expected HizoFS read-snapshot support");
    const snapshotOperation = session.createReadSnapshot().then(snapshot => {
      snapshotSettled = true;
      return snapshot;
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(snapshotSettled).toBe(false);

    await heldWritable.close();
    const snapshot = await snapshotOperation;
    await expect(snapshot.root.getFileHandle({ create: false, name: "dirty.txt" }))
      .resolves.toMatchObject({ name: "dirty.txt" });
    await snapshot.close();
    await session.close();
  });

  it("publishes the accepted head before authenticated maintenance reads Superblock roots", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const supportedFeatureBits = createFeatureBits({ value: 0n });
    const passphrase = "correct horse battery staple";
    const opened = await createEmptyEncryptedContainer({
      backend,
      passphrase,
      randomSource,
      supportedFeatureBits,
    });
    const host = runtimeHost({
      lazyDurability: {
        ...DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY,
        maximumDirtyAgeMilliseconds: 60_000,
      },
      lazyPublicationRollout: evaluateLazyPublicationRolloutGate({
        evidence: {
          accepted_only_success_timing: true,
          active_head_maintenance_clean_head: true,
          bounded_dirty_resources: true,
          fault_campaign: false,
          generation_target_sync: true,
          production_background_publication: true,
          provider_graceful_shutdown: true,
          single_runtime_write_authority: true,
          transition_and_credential_clean_head: true,
        },
      }),
    });
    const session = await openAuthenticatedReadWriteApplicationSession({
      captureAuthority: async () => ({ revision: 1 }),
      recheckAuthority: async () => undefined,
      runtimeHost: host,
      verifyCapturedAuthority: async () => ({
        backend,
        canonicalBackingLocation: "memory://maintenance-clean-head-test.hizofs",
        explicitBulkLimits: DEFAULT_EXPLICIT_BULK_TEST_LIMITS,
        fileMutationLimits: { maximumExtentMutationsPerBatch: 2 },
        opened,
        operationTimestamp: () => createTimestampMilliseconds({ value: 1_700_000_000_000n }),
        randomSource,
        removalLimits: { deleteBatchSize: 2, maxVisitedInodes: 64 },
        recheckDurableGenerationAuthority: async () => undefined,
        rootSubvolumeId: createSubvolumeId({ value: 1n }),
        supportedFeatureBits,
        writableProfile: "release-qualified",
      }),
    });

    await session.root.getFileHandle({ create: true, name: "maintenance-visible.txt" });
    const beforeCapture = await openEmptyEncryptedContainer({ backend, passphrase, supportedFeatureBits });
    try {
      expect(beforeCapture.commit.commitSequence).toBe(1n);
    } finally {
      if (!beforeCapture.rootKey.isDestroyed()) beforeCapture.rootKey.destroy();
    }

    const policy = createMaintenancePolicy();
    const captured = await captureAuthenticatedMaintenanceRoots({
      authority: {
        backend,
        fileSystemId: opened.fileSystemId,
        rootKey: opened.rootKey,
        supportedFeatureBits,
      },
      candidateSnapshot: prepareMaintenanceCandidateSnapshot({ candidateSegments: [], policy }),
      policy,
      runtimeHost: host,
    });
    expect(captured.counts.activeCommit).toBeGreaterThan(0);
    expect(captured.counts.workingGenerationDependency).toBe(0);

    const afterCapture = await openEmptyEncryptedContainer({ backend, passphrase, supportedFeatureBits });
    try {
      expect(afterCapture.commit.commitSequence).toBe(2n);
      const resources = createAuthenticatedApplicationReadSessionResources({ backend, opened: afterCapture });
      try {
        await expect(resources.namespace.stat({ pathComponents: ["maintenance-visible.txt"] }))
          .resolves.toMatchObject({ kind: "file" });
      } finally {
        await resources.releaseResources();
      }
    } finally {
      if (!afterCapture.rootKey.isDestroyed()) afterCapture.rootKey.destroy();
    }
    await session.close();
  });

  it("opens an explicit bulk builder only for a freshly created session-local directory", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const supportedFeatureBits = createFeatureBits({ value: 0n });
    const opened = await createEmptyEncryptedContainer({
      backend,
      passphrase: "correct horse battery staple",
      randomSource,
      supportedFeatureBits,
    });
    let nextTimestamp = 1_700_000_000_000n;
    const session = await openAuthenticatedReadWriteApplicationSession({
      captureAuthority: async () => ({ revision: 1 }),
      recheckAuthority: async () => undefined,
      runtimeHost: runtimeHost(),
      verifyCapturedAuthority: async () => ({
        backend,
        canonicalBackingLocation: "memory://explicit-bulk-session-test.hizofs",
        explicitBulkLimits: {
          candidate: { maxEntries: 16, maxInlineFileBytesTotal: 1_024 },
          directoryImport: { maximumEntryMutationsPerBatch: 4 },
        },
        fileMutationLimits: { maximumExtentMutationsPerBatch: 2 },
        opened,
        operationTimestamp: () => {
          const timestamp = createTimestampMilliseconds({ value: nextTimestamp });
          nextTimestamp += 1n;
          return timestamp;
        },
        randomSource,
        removalLimits: { deleteBatchSize: 2, maxVisitedInodes: 64 },
        recheckDurableGenerationAuthority: async () => undefined,
        rootSubvolumeId: createSubvolumeId({ value: 1n }),
        supportedFeatureBits,
        writableProfile: "release-qualified",
      }),
    });
    if (!(session instanceof HizoFSStorageFileSystemSession)) {
      throw new Error("expected concrete HizoFS application session");
    }
    await expect(session.sync()).resolves.toBeUndefined();

    const target = await session.root.getDirectoryHandle({ create: true, name: "bulk" });
    const openExplicitBulk = session.port.openExplicitBulk;
    if (openExplicitBulk === undefined) throw new Error("production session omitted explicit bulk support");
    const bulk = await openExplicitBulk({ path: ["bulk"] });
    await bulk.createEmptyFile({ name: "first" });
    await bulk.createEmptyFile({ name: "second" });
    await bulk.commit();

    await expect(target.getFileHandle({ create: false, name: "first" })).resolves.toMatchObject({ name: "first" });
    await expect(target.getFileHandle({ create: false, name: "second" })).resolves.toMatchObject({ name: "second" });
    await expect(openExplicitBulk({ path: ["bulk"] })).rejects.toThrow(
      "explicit bulk target was not freshly created by this application session",
    );

    const invalidated = await session.root.getDirectoryHandle({ create: true, name: "invalidated" });
    await session.root.getFileHandle({ create: true, name: "ordinary" });
    await expect(openExplicitBulk({ path: ["invalidated"] })).rejects.toThrow(
      "explicit bulk target was not freshly created by this application session",
    );
    await expect(invalidated.getDirectoryHandle({ create: false, name: "missing" })).rejects.toBeDefined();

    await session.close();
    expect(opened.rootKey.isDestroyed()).toBe(true);
  });

  it("publishes one explicit bulk candidate through authenticated metadata and converged Superblocks", async () => {
    const fixture = await writableFixture();
    const candidate = new ExplicitBulkCandidate({
      limits: { maxEntries: 8, maxInlineFileBytesTotal: 64 },
      nextInodeNumber: fixture.baseCommitRoot.commit.nextInodeNumber,
      rootDirectory: fixture.baseCommitRoot.rootDirectoryInode,
    });
    candidate.createEmptyFile({
      name: "bulk-created",
      parentDirectoryInodeNumber: fixture.baseCommitRoot.rootDirectoryInode.inodeNumber,
      timestamp: createTimestampMilliseconds({ value: 1_700_000_000_000n }),
    });

    const result = await publishAuthenticatedExplicitBulkCommit({
      assertPublicationAllowed: () => undefined,
      authority: fixture.authority,
      baseCommit: fixture.baseCommitRoot.commit,
      baseSuperblock: fixture.baseSuperblock,
      candidate: candidate.seal(),
      directoryImportLimits: { maximumEntryMutationsPerBatch: 4 },
      indexDiagnostics: undefined,
      mutationId: parseMutationId({ bytes: new Uint8Array(16).fill(24) }),
      onCandidatePrepared: undefined,
    });

    expect(fixture.authority.state()).toBe("closed");
    expect(result.commitPayload.commitSequence).toBe(2n);
    expect(result.publication.superblock.copyState).toBe("normal");
    const reopened = await readBootstrapRoot({
      authority: {
        commitHomeRef: result.publication.commitHomeRef,
        commitSequence: result.commitPayload.commitSequence,
        mutationId: result.commitPayload.mutationId,
        type: "active",
      },
      backend: fixture.backend,
      fileSystemId: fixture.fileSystemId,
      relocationIndexRootPhysicalRef: null,
      rootKey: fixture.rootKey,
    });
    if (reopened.rootDirectoryInode.content.type !== "inline") throw new Error("expected inline root directory");
    expect(reopened.rootDirectoryInode.content.entries).toEqual([{
      inodeKind: "file",
      inodeNumber: 2n,
      name: "bulk-created",
      targetType: "inode",
    }]);
    fixture.rootKey.destroy();
  });

  it("publishes an ordinary create through authenticated metadata and converged Superblocks", async () => {
    const fixture = await writableFixture();
    const result = await publishAuthenticatedOrdinaryEntryCreate(ordinaryCreateRequest({
      assertPublicationAllowed: () => undefined,
      authority: fixture.authority,
      baseCommitRoot: fixture.baseCommitRoot,
      baseSuperblock: fixture.baseSuperblock,
    }));

    expect(fixture.authority.state()).toBe("closed");
    expect(result.commitPayload.commitSequence).toBe(2n);
    expect(result.publication.superblock.copyState).toBe("normal");
    expect(result.publication.superblock.logicalState.activeCommitHomeRef).toEqual(result.publication.commitHomeRef);
    const reopened = await readBootstrapRoot({
      authority: {
        commitHomeRef: result.publication.commitHomeRef,
        commitSequence: result.commitPayload.commitSequence,
        mutationId: result.commitPayload.mutationId,
        type: "active",
      },
      backend: fixture.backend,
      fileSystemId: fixture.fileSystemId,
      relocationIndexRootPhysicalRef: null,
      rootKey: fixture.rootKey,
    });
    expect(reopened.rootDirectoryInode).toMatchObject({
      inodeKind: "directory",
      inodeRevision: 2n,
    });
    if (reopened.rootDirectoryInode.content.type !== "inline") throw new Error("expected inline root directory");
    expect(reopened.rootDirectoryInode.content.entries).toEqual([{
      inodeKind: "file",
      inodeNumber: 2n,
      name: "created",
      targetType: "inode",
    }]);
    await expect(openSuperblockCopies({
      backend: fixture.backend,
      fileSystemId: fixture.fileSystemId,
      rootKey: fixture.rootKey,
      supportedFeatureBits: fixture.supportedFeatureBits,
    })).resolves.toMatchObject({
      copyState: "normal",
      logicalState: { activeCommitSequence: 2n },
    });
    fixture.rootKey.destroy();
  });

  it("closes mutation authority and preserves the selected Superblock when any publication gate rejects", async () => {
    for (const blockedGateCall of [1, 2, 3]) {
      const fixture = await writableFixture();
      let gateCall = 0;
      await expect(publishAuthenticatedOrdinaryEntryCreate(ordinaryCreateRequest({
        assertPublicationAllowed: () => {
          gateCall += 1;
          if (gateCall === blockedGateCall) throw new Error(`blocked gate ${blockedGateCall}`);
        },
        authority: fixture.authority,
        baseCommitRoot: fixture.baseCommitRoot,
        baseSuperblock: fixture.baseSuperblock,
      }))).rejects.toThrow(`blocked gate ${blockedGateCall}`);
      expect(fixture.authority.state()).toBe("closed");
      await expect(openSuperblockCopies({
        backend: fixture.backend,
        fileSystemId: fixture.fileSystemId,
        rootKey: fixture.rootKey,
        supportedFeatureBits: fixture.supportedFeatureBits,
      })).resolves.toMatchObject({
        copyState: "normal",
        logicalState: { activeCommitSequence: 1n },
      });
      fixture.rootKey.destroy();
    }
  });
  it("verifies external proof through a callback-scoped root-key capability", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const supportedFeatureBits = createFeatureBits({ value: 0n });
    const created = await createEmptyEncryptedContainer({
      backend,
      passphrase: "passphrase",
      supportedFeatureBits,
    });
    const expectedFileSystemId = created.fileSystemId;
    created.rootKey.destroy();
    let retained: FileSystemRootKeyProofDerivationCapability | undefined;

    const authority = await openAuthenticatedReadOnlyContainerAuthority({
      backend,
      passphrase: "passphrase",
      supportedFeatureBits,
      verifyProofAuthority: async ({ fileSystemId, rootKeyProof }) => {
        expect(fileSystemId).toBe(expectedFileSystemId);
        retained = rootKeyProof;
        const key = await rootKeyProof.deriveAesGcmKey({ info: new Uint8Array([1, 2, 3]) });
        expect(key.extractable).toBe(false);
      },
    });

    await expect(retained!.deriveAesGcmKey({ info: new Uint8Array() })).rejects.toThrow(
      "File System Root Key proof capability has expired",
    );
    expect(authority.opened.rootKey.isDestroyed()).toBe(false);
    authority.opened.rootKey.destroy();
  });

  it("proves an incomplete transition target through only its Unlock Envelope plane", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const created = await createInitialUnlockEnvelopeCopies({
      backend,
      passphrase: "passphrase",
    });
    const expectedFileSystemId = created.fileSystemId;
    created.rootKey.destroy();
    let retained: FileSystemRootKeyProofDerivationCapability | undefined;

    const result = await openAuthenticatedRootKeyProofContainerCapability({
      backend,
      passphrase: "passphrase",
      verifyProofAuthority: async ({ fileSystemId, rootKeyProof }) => {
        expect(fileSystemId).toBe(expectedFileSystemId);
        retained = rootKeyProof;
        await expect(rootKeyProof.deriveAesGcmKey({ info: new Uint8Array([4]) })).resolves.toBeInstanceOf(CryptoKey);
      },
    });

    expect(result.type).toBe("opened");
    if (result.type !== "opened") throw new Error("expected root-key proof capability");
    await expect(retained!.deriveAesGcmKey({ info: new Uint8Array() })).rejects.toThrow(
      "File System Root Key proof capability has expired",
    );
    await result.releaseResources();
  });

  it("returns an opaque read-only capability and keeps proof derivation callback-scoped", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const supportedFeatureBits = createFeatureBits({ value: 0n });
    const created = await createEmptyEncryptedContainer({
      backend,
      passphrase: "passphrase",
      supportedFeatureBits,
    });
    const expectedFileSystemId = created.fileSystemId;
    created.rootKey.destroy();
    let retained: FileSystemRootKeyProofDerivationCapability | undefined;

    const result = await openAuthenticatedReadOnlyContainerCapability({
      backend,
      passphrase: "passphrase",
      verifyProofAuthority: async ({ fileSystemId, rootKeyProof }) => {
        expect(fileSystemId).toBe(expectedFileSystemId);
        retained = rootKeyProof;
        await expect(rootKeyProof.deriveAesGcmKey({ info: new Uint8Array([9]) })).resolves.toBeInstanceOf(CryptoKey);
      },
    });

    expect(result.type).toBe("opened");
    if (result.type !== "opened") throw new Error("expected opened capability");
    expect(Object.keys(result.authority)).toEqual([]);
    await expect(retained!.deriveAesGcmKey({ info: new Uint8Array() })).rejects.toThrow(
      "File System Root Key proof capability has expired",
    );
    await result.releaseResources();
    await result.releaseResources();
  });

  it("records authenticated application record reads and writes in runtime diagnostics", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const supportedFeatureBits = createFeatureBits({ value: 0n });
    const diagnostics = new HizoFSRuntimeDiagnosticsAccumulator();
    const created = await createEmptyEncryptedContainer({
      backend,
      diagnostics,
      passphrase: "passphrase",
      randomSource: deterministicRandomSource(),
      supportedFeatureBits,
    });
    created.rootKey.destroy();
    const capability = await openAuthenticatedDevelopmentWritableContainerCapability({
      backend: developmentBackend({ backend }),
      passphrase: "passphrase",
      recordDiagnostics: diagnostics,
      verifyProofAuthority: async () => undefined,
    });
    if (capability.type !== "opened") throw new Error("expected development writable capability");
    const session = await openAuthenticatedDevelopmentWritableApplicationSessionFromCapability({
      authority: capability.authority,
      canonicalBackingLocation: "memory://runtime-record-diagnostics.hizofs",
      recheckAuthority: async () => undefined,
      runtimeHost: runtimeHost(),
    });

    try {
      const file = await session.root.getFileHandle({ create: true, name: "measured.bin" });
      const bytes = new Uint8Array(HIZOFS_V1_FORMAT_CONSTANTS.limits.inlineFileBytes + 32).fill(37);
      const writable = await file.createWritable({ keepExistingData: false });
      await writable.write({ data: bytes, position: 0 });
      await writable.close();
      const readable = await file.openReadable({ mimeType: "application/octet-stream" });
      const received = new Uint8Array(bytes.byteLength);
      expect(await readable.read({
        buffer: received,
        length: received.byteLength,
        offset: 0,
        position: 0,
        signal: undefined,
      })).toEqual({ bytesRead: received.byteLength });
      await readable.close();
      expect(received).toEqual(bytes);

      const records = diagnostics.snapshot().records;
      expect(records.inode_table_page.writeOperations).toBeGreaterThan(0);
      expect(records.file_extent_page.writeOperations).toBeGreaterThan(0);
      expect(records.file_data.writeOperations).toBeGreaterThan(0);
      expect(records.file_data.readOperations).toBeGreaterThan(0);
      expect(records.file_system_commit.writeOperations).toBeGreaterThan(0);
    } finally {
      await capability.releaseResources();
      await session.close();
    }
  });

  it("reuses a durably admitted tree-backed Directory successor without decoding it on the next create", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const supportedFeatureBits = createFeatureBits({ value: 0n });
    const diagnostics = new HizoFSRuntimeDiagnosticsAccumulator();
    const created = await createEmptyEncryptedContainer({
      backend,
      diagnostics,
      passphrase: "passphrase",
      randomSource: deterministicRandomSource(),
      supportedFeatureBits,
    });
    created.rootKey.destroy();
    const capability = await openAuthenticatedDevelopmentWritableContainerCapability({
      backend: developmentBackend({ backend }),
      passphrase: "passphrase",
      recordDiagnostics: diagnostics,
      verifyProofAuthority: async () => undefined,
    });
    if (capability.type !== "opened") throw new Error("expected development writable capability");
    const session = await openAuthenticatedDevelopmentWritableApplicationSessionFromCapability({
      authority: capability.authority,
      canonicalBackingLocation: "memory://directory-write-through-cache.hizofs",
      recheckAuthority: async () => undefined,
      runtimeHost: runtimeHost(),
    });

    try {
      for (let index = 0; index < 24; index += 1) {
        await session.root.getFileHandle({
          create: true,
          name: `seed-${String(index).padStart(2, "0")}-${"x".repeat(180)}`,
        });
      }
      const beforeNextCreate = diagnostics.snapshot();
      await session.root.getFileHandle({ create: true, name: "tree-backed-successor.txt" });
      const afterNextCreate = diagnostics.snapshot();
      expect(afterNextCreate.records.directory_page.readOperations)
        .toBe(beforeNextCreate.records.directory_page.readOperations);
      // WHY: session plaintext caching already prevents physical Directory Record reads here. The
      // durable decoded-page admission removes the remaining Directory page codec pass; at most
      // the Inode-page decode needed by this create remains observable.
      expect(afterNextCreate.phases.record_decode.operationCount - beforeNextCreate.phases.record_decode.operationCount)
        .toBeLessThan(2);
    } finally {
      await capability.releaseResources();
      await session.close();
    }
  });

  it("replaces the authenticated development session passphrase and reopens only with the replacement", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const supportedFeatureBits = createFeatureBits({ value: 0n });
    const created = await createEmptyEncryptedContainer({
      backend,
      passphrase: "old-passphrase",
      randomSource: deterministicRandomSource(),
      supportedFeatureBits,
    });
    created.rootKey.destroy();

    const capability = await openAuthenticatedDevelopmentWritableContainerCapability({
      backend: developmentBackend({ backend }),
      passphrase: "old-passphrase",
      verifyProofAuthority: async () => undefined,
    });
    if (capability.type !== "opened") throw new Error("expected development writable capability");
    let transferRechecks = 0;
    const host = runtimeHost();
    const session = await openAuthenticatedDevelopmentWritableApplicationSessionFromCapability({
      authority: capability.authority,
      canonicalBackingLocation: "memory://credential-update.hizofs",
      recheckAuthority: async () => {
        transferRechecks += 1;
      },
      rootName: "credential-update.hizofs",
      runtimeHost: host,
    });
    expect(transferRechecks).toBe(1);

    const beforeCredentialUpdate = await session.root.getFileHandle({
      create: true,
      name: "before-credential-update.bin",
    });
    const beforeCredentialUpdateBytes = new Uint8Array([19, 23, 29, 31]);
    const heldWriter = await beforeCredentialUpdate.createWritable({ keepExistingData: false });
    await heldWriter.write({ data: beforeCredentialUpdateBytes, position: 0 });

    let updateRechecks = 0;
    const credentialUpdate = replaceAuthenticatedDevelopmentWritableSessionPassphrase({
      recheckAuthority: async () => {
        updateRechecks += 1;
      },
      replacementPassphrase: "new-passphrase",
      session,
    });
    expect(updateRechecks).toBe(0);
    await heldWriter.close();
    await expect(credentialUpdate).resolves.toBe(session);
    expect(updateRechecks).toBe(2);
    await expect(session.root.getFileHandle({
      create: true,
      name: "after-credential-update.bin",
    })).resolves.toBeDefined();
    const managementBarrier = host.openManagementCleanHeadBarrier({});
    await managementBarrier.flushAndCaptureCleanGeneration();
    managementBarrier.release();

    await capability.releaseResources();
    await session.close();
    await expect(openEmptyEncryptedContainer({
      backend,
      passphrase: "old-passphrase",
      supportedFeatureBits,
    })).rejects.toMatchObject({ code: "credential_rejected" });
    const reopenedCapability = await openAuthenticatedDevelopmentWritableContainerCapability({
      backend: developmentBackend({ backend }),
      passphrase: "new-passphrase",
      verifyProofAuthority: async () => undefined,
    });
    if (reopenedCapability.type !== "opened") throw new Error("expected replacement credential to reopen capability");
    const reopenedSession = await openAuthenticatedDevelopmentWritableApplicationSessionFromCapability({
      authority: reopenedCapability.authority,
      canonicalBackingLocation: "memory://credential-update.hizofs",
      recheckAuthority: async () => undefined,
      runtimeHost: runtimeHost(),
    });
    const reopenedFile = await reopenedSession.root.getFileHandle({
      create: false,
      name: "before-credential-update.bin",
    });
    const reopenedReadable = await reopenedFile.openReadable({ mimeType: "application/octet-stream" });
    const reopenedBytes = new Uint8Array(beforeCredentialUpdateBytes.byteLength);
    await expect(reopenedReadable.read({
      buffer: reopenedBytes,
      length: reopenedBytes.byteLength,
      offset: 0,
      position: 0,
      signal: undefined,
    })).resolves.toEqual({ bytesRead: reopenedBytes.byteLength });
    expect(reopenedBytes).toEqual(beforeCredentialUpdateBytes);
    await expect(reopenedSession.root.getFileHandle({
      create: false,
      name: "after-credential-update.bin",
    })).resolves.toBeDefined();
    await reopenedReadable.close();
    await reopenedCapability.releaseResources();
    await reopenedSession.close();
  });

  it("scopes active-session root-key proof to one callback", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const created = await createEmptyEncryptedContainer({
      backend,
      passphrase: "passphrase",
      randomSource: deterministicRandomSource(),
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    const expectedFileSystemId = created.fileSystemId;
    created.rootKey.destroy();
    const capability = await openAuthenticatedDevelopmentWritableContainerCapability({
      backend: developmentBackend({ backend }),
      passphrase: "passphrase",
      verifyProofAuthority: async () => undefined,
    });
    if (capability.type !== "opened") throw new Error("expected development writable capability");
    const session = await openAuthenticatedDevelopmentWritableApplicationSessionFromCapability({
      authority: capability.authority,
      canonicalBackingLocation: "memory://session-proof.hizofs",
      recheckAuthority: async () => undefined,
      runtimeHost: runtimeHost(),
    });

    let retained: FileSystemRootKeyProofDerivationCapability | undefined;
    let releaseOperation!: () => void;
    const operationReleased = new Promise<void>(resolve => {
      releaseOperation = resolve;
    });
    let operationStarted!: () => void;
    const started = new Promise<void>(resolve => {
      operationStarted = resolve;
    });
    const proof = withAuthenticatedDevelopmentWritableSessionRootKeyProof({
      operation: async ({ fileSystemId, rootKeyProof }) => {
        expect(fileSystemId).toBe(expectedFileSystemId);
        retained = rootKeyProof;
        await expect(rootKeyProof.deriveAesGcmKey({ info: new Uint8Array([7]) })).resolves.toBeInstanceOf(CryptoKey);
        operationStarted();
        await operationReleased;
        return "proved" as const;
      },
      session,
    });
    await started;
    await expect(session.close()).rejects.toThrow("root-key proof operation is active");
    await expect(replaceAuthenticatedDevelopmentWritableSessionPassphrase({
      recheckAuthority: async () => undefined,
      replacementPassphrase: "replacement",
      session,
    })).rejects.toThrow("root-key proof operation");
    releaseOperation();
    await expect(proof).resolves.toBe("proved");
    await expect(retained!.deriveAesGcmKey({ info: new Uint8Array() })).rejects.toThrow("has expired");

    await capability.releaseResources();
    await session.close();
  });

  it("proves an explicit retained credential set without exposing the session Root Key", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const created = await createEmptyEncryptedContainerWithPassphrases({
      backend,
      passphrases: ["primary-passphrase", "recovery-passphrase"],
      randomSource: deterministicRandomSource(),
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    const expectedFileSystemId = created.fileSystemId;
    expect(created.credentialSlotIds).toHaveLength(2);

    const capability = await openAuthenticatedDevelopmentWritableContainerCapability({
      backend: developmentBackend({ backend }),
      passphrase: "primary-passphrase",
      verifyProofAuthority: async () => undefined,
    });
    if (capability.type !== "opened") throw new Error("expected development writable capability");
    const session = await openAuthenticatedDevelopmentWritableApplicationSessionFromCapability({
      authority: capability.authority,
      canonicalBackingLocation: "memory://retained-credentials.hizofs",
      recheckAuthority: async () => undefined,
      runtimeHost: runtimeHost(),
    });

    let rechecks = 0;
    let releaseOperation!: () => void;
    const operationReleased = new Promise<void>(resolve => {
      releaseOperation = resolve;
    });
    let operationStarted!: () => void;
    const started = new Promise<void>(resolve => {
      operationStarted = resolve;
    });
    let retainedRootKeyProof: FileSystemRootKeyProofDerivationCapability | undefined;
    const proof = withAuthenticatedDevelopmentWritableSessionRetainedCredentials({
      operation: async ({ fileSystemId, retainedCredentials, rootKeyProof }) => {
        expect(fileSystemId).toBe(expectedFileSystemId);
        expect(retainedCredentials.map(credential => credential.passphrase)).toEqual([
          "primary-passphrase",
          "recovery-passphrase",
        ]);
        expect(new Set(retainedCredentials.map(credential => credential.sourceSlotId)).size).toBe(2);
        retainedRootKeyProof = rootKeyProof;
        await expect(rootKeyProof.deriveAesGcmKey({ info: new Uint8Array([9]) })).resolves.toBeInstanceOf(CryptoKey);
        operationStarted();
        await operationReleased;
        return "proved" as const;
      },
      recheckAuthority: async () => {
        rechecks += 1;
      },
      retainedCredentials: [
        { passphrase: "primary-passphrase" },
        { passphrase: "recovery-passphrase" },
      ],
      session,
    });
    await started;
    await expect(session.close()).rejects.toThrow("re-encryption credential proof operation is active");
    await expect(withAuthenticatedDevelopmentWritableSessionRootKeyProof({
      operation: async () => undefined,
      session,
    })).rejects.toThrow("proving re-encryption credentials");
    await expect(replaceAuthenticatedDevelopmentWritableSessionPassphrase({
      recheckAuthority: async () => undefined,
      replacementPassphrase: "replacement-passphrase",
      session,
    })).rejects.toThrow("proving re-encryption credentials");
    releaseOperation();
    await expect(proof).resolves.toBe("proved");
    expect(rechecks).toBe(2);
    await expect(retainedRootKeyProof!.deriveAesGcmKey({ info: new Uint8Array() })).rejects.toThrow("has expired");

    let operationCalled = false;
    await expect(withAuthenticatedDevelopmentWritableSessionRetainedCredentials({
      operation: async () => {
        operationCalled = true;
      },
      recheckAuthority: async () => undefined,
      retainedCredentials: [{ passphrase: "wrong-passphrase" }],
      session,
    })).rejects.toMatchObject({ code: "credential_rejected" });
    expect(operationCalled).toBe(false);

    await capability.releaseResources();
    await session.close();
  }, 10_000);

  it("requires recovery when authority recheck fails after credential publication", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const supportedFeatureBits = createFeatureBits({ value: 0n });
    const diagnostics = new HizoFSRuntimeDiagnosticsAccumulator();
    const created = await createEmptyEncryptedContainer({
      backend,
      diagnostics,
      passphrase: "old-passphrase",
      randomSource: deterministicRandomSource(),
      supportedFeatureBits,
    });
    created.rootKey.destroy();
    const capability = await openAuthenticatedDevelopmentWritableContainerCapability({
      backend: developmentBackend({ backend }),
      passphrase: "old-passphrase",
      recordDiagnostics: diagnostics,
      verifyProofAuthority: async () => undefined,
    });
    if (capability.type !== "opened") throw new Error("expected development writable capability");
    const session = await openAuthenticatedDevelopmentWritableApplicationSessionFromCapability({
      authority: capability.authority,
      canonicalBackingLocation: "memory://credential-recheck.hizofs",
      recheckAuthority: async () => undefined,
      rootName: "credential-recheck.hizofs",
      runtimeHost: runtimeHost(),
    });
    const staleRoot = session.root;
    const staleFile = await staleRoot.getFileHandle({ create: true, name: "stable.bin" });
    const stableBytes = new Uint8Array([37, 41, 43]);
    const stableWritable = await staleFile.createWritable({ keepExistingData: false });
    await stableWritable.write({ data: stableBytes, position: 0 });
    await stableWritable.close();
    const staleReadable = await staleFile.openReadable({ mimeType: "application/octet-stream" });

    let rechecks = 0;
    await expect(replaceAuthenticatedDevelopmentWritableSessionPassphrase({
      recheckAuthority: async () => {
        rechecks += 1;
        if (rechecks === 2) throw new Error("Persistence Control authority changed");
      },
      replacementPassphrase: "new-passphrase",
      session,
    })).rejects.toThrow("Persistence Control authority changed");
    await expect(replaceAuthenticatedDevelopmentWritableSessionPassphrase({
      recheckAuthority: async () => undefined,
      replacementPassphrase: "another-passphrase",
      session,
    })).rejects.toThrow("requires recovery");
    const diagnosticsBeforeRejectedIo = diagnostics.snapshot();
    await expect(staleRoot.stat()).rejects.toMatchObject({ code: "recovery_required" });
    await expect(staleFile.stat()).rejects.toMatchObject({ code: "recovery_required" });
    await expect(staleReadable.read({
      buffer: new Uint8Array(stableBytes.byteLength),
      length: stableBytes.byteLength,
      offset: 0,
      position: 0,
      signal: undefined,
    })).rejects.toMatchObject({ code: "recovery_required" });
    await expect(session.root.getFileHandle({
      create: false,
      name: "stable.bin",
    })).rejects.toMatchObject({ code: "recovery_required" });
    await expect(session.createReadSnapshot?.()).rejects.toMatchObject({ code: "recovery_required" });
    expect(diagnostics.snapshot()).toEqual(diagnosticsBeforeRejectedIo);

    await staleReadable.close();
    await session.close();
    await expect(openEmptyEncryptedContainer({
      backend,
      passphrase: "old-passphrase",
      supportedFeatureBits,
    })).rejects.toMatchObject({ code: "credential_rejected" });
    const recoveredCapability = await openAuthenticatedDevelopmentWritableContainerCapability({
      backend: developmentBackend({ backend }),
      passphrase: "new-passphrase",
      verifyProofAuthority: async () => undefined,
    });
    if (recoveredCapability.type !== "opened") throw new Error("expected recovery credential to reopen capability");
    const recoveredSession = await openAuthenticatedDevelopmentWritableApplicationSessionFromCapability({
      authority: recoveredCapability.authority,
      canonicalBackingLocation: "memory://credential-recheck.hizofs",
      recheckAuthority: async () => undefined,
      runtimeHost: runtimeHost(),
    });
    const recoveredFile = await recoveredSession.root.getFileHandle({ create: false, name: "stable.bin" });
    const recoveredReadable = await recoveredFile.openReadable({ mimeType: "application/octet-stream" });
    const recoveredBytes = new Uint8Array(stableBytes.byteLength);
    await expect(recoveredReadable.read({
      buffer: recoveredBytes,
      length: recoveredBytes.byteLength,
      offset: 0,
      position: 0,
      signal: undefined,
    })).resolves.toEqual({ bytesRead: recoveredBytes.byteLength });
    expect(recoveredBytes).toEqual(stableBytes);
    await recoveredReadable.close();
    await recoveredCapability.releaseResources();
    await recoveredSession.close();
  });

  it("transfers one normal-read opaque capability into one authority-rechecked application session", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const created = await createEmptyEncryptedContainer({
      backend,
      passphrase: "passphrase",
      randomSource: deterministicRandomSource(),
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    created.rootKey.destroy();
    const opened = await openAuthenticatedReadOnlyContainerCapability({
      backend,
      passphrase: "passphrase",
      verifyProofAuthority: async () => undefined,
    });
    if (opened.type !== "opened") throw new Error("expected opened capability");
    let rechecks = 0;

    const session = await openAuthenticatedReadOnlyApplicationSessionFromCapability({
      authority: opened.authority,
      recheckAuthority: async () => {
        rechecks += 1;
      },
      rootName: "authority-bound.hizofs",
      runtimeHost: runtimeHost(),
    });

    expect(rechecks).toBe(1);
    expect(session.root).toMatchObject({ kind: "directory", name: "authority-bound.hizofs" });
    await expect(session.root.getFileHandle({ create: true, name: "blocked.bin" }))
      .rejects.toThrow("generation is read-only");
    await expect(openAuthenticatedReadOnlyApplicationSessionFromCapability({
      authority: opened.authority,
      recheckAuthority: async () => undefined,
      rootName: undefined,
      runtimeHost: runtimeHost(),
    })).rejects.toThrow("already transferred");

    await opened.releaseResources();
    await session.close();
  });

  it("does not promote a root-key-proof-only capability into an application session", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const created = await createInitialUnlockEnvelopeCopies({
      backend,
      passphrase: "passphrase",
    });
    created.rootKey.destroy();
    const opened = await openAuthenticatedRootKeyProofContainerCapability({
      backend,
      passphrase: "passphrase",
      verifyProofAuthority: async () => undefined,
    });
    if (opened.type !== "opened") throw new Error("expected opened capability");

    await expect(openAuthenticatedReadOnlyApplicationSessionFromCapability({
      authority: opened.authority,
      recheckAuthority: async () => undefined,
      rootName: undefined,
      runtimeHost: runtimeHost(),
    })).rejects.toThrow("root-key-proof-only capability");

    await opened.releaseResources();
  });

  it("destroys transferred authority when the final authority recheck fails", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const created = await createEmptyEncryptedContainer({
      backend,
      passphrase: "passphrase",
      randomSource: deterministicRandomSource(),
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    created.rootKey.destroy();
    const opened = await openAuthenticatedReadOnlyContainerCapability({
      backend,
      passphrase: "passphrase",
      verifyProofAuthority: async () => undefined,
    });
    if (opened.type !== "opened") throw new Error("expected opened capability");

    await expect(openAuthenticatedReadOnlyApplicationSessionFromCapability({
      authority: opened.authority,
      recheckAuthority: async () => {
        throw new Error("authority changed");
      },
      rootName: undefined,
      runtimeHost: runtimeHost(),
    })).rejects.toThrow("authority changed");
    await expect(openAuthenticatedReadOnlyApplicationSessionFromCapability({
      authority: opened.authority,
      recheckAuthority: async () => undefined,
      rootName: undefined,
      runtimeHost: runtimeHost(),
    })).rejects.toThrow("already transferred");
    await opened.releaseResources();
  });

  it("reports only credential rejection as an explicit open result", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const supportedFeatureBits = createFeatureBits({ value: 0n });
    const created = await createEmptyEncryptedContainer({
      backend,
      passphrase: "passphrase",
      supportedFeatureBits,
    });
    created.rootKey.destroy();
    let proofCalls = 0;

    await expect(openAuthenticatedReadOnlyContainerCapability({
      backend,
      passphrase: "wrong-passphrase",
      verifyProofAuthority: async () => {
        proofCalls += 1;
      },
    })).resolves.toEqual({ type: "credential_rejected" });
    expect(proofCalls).toBe(0);

    await expect(openAuthenticatedReadOnlyContainerCapability({
      backend,
      passphrase: "passphrase",
      verifyProofAuthority: async () => {
        throw new Error("proof infrastructure failed");
      },
    })).rejects.toThrow("proof infrastructure failed");
  });

  it("destroys the opened root key when external proof verification rejects", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const supportedFeatureBits = createFeatureBits({ value: 0n });
    const created = await createEmptyEncryptedContainer({
      backend,
      passphrase: "passphrase",
      supportedFeatureBits,
    });
    created.rootKey.destroy();
    let retained: FileSystemRootKeyProofDerivationCapability | undefined;

    await expect(openAuthenticatedReadOnlyContainerAuthority({
      backend,
      passphrase: "passphrase",
      supportedFeatureBits,
      verifyProofAuthority: async ({ rootKeyProof }) => {
        retained = rootKeyProof;
        throw new Error("control proof rejected");
      },
    })).rejects.toThrow("control proof rejected");
    await expect(retained!.deriveAesGcmKey({ info: new Uint8Array() })).rejects.toThrow(
      "File System Root Key proof capability has expired",
    );
  });


  it("creates a transition target at the exact reserved File System ID", async () => {
    let reservations = 0;
    let reservedRoot: InMemoryOpfsDirectoryHandle | undefined;
    const fileSystemId = await createBrowserHizoFSTransitionTargetContainer({
      passphrases: ["transition passphrase", "recovery passphrase"],
      randomSource: deterministicRandomSource(),
      reserveContainerRoot: async ({ fileSystemId: candidate }) => {
        reservations += 1;
        if (reservations === 1) return { type: "collision" };
        // Transition creation currently runs from the application Window realm,
        // where createSyncAccessHandle is unavailable. The production physical
        // backend must therefore complete this exact target flow through the
        // async OPFS writable-stream fallback.
        reservedRoot = new InMemoryOpfsDirectoryHandle({
          capabilityProfile: "window",
          name: candidate,
        });
        return {
          cleanup: async () => {
            reservedRoot = undefined;
          },
          containerRoot: reservedRoot as unknown as FileSystemDirectoryHandle,
          type: "reserved",
        };
      },
    });

    expect(reservations).toBe(2);
    expect(reservedRoot).toBeDefined();
    const backend = new OpfsWritableBackend<AuthenticatedHizoFSPhysicalBytes>({
      root: reservedRoot as unknown as FileSystemDirectoryHandle,
    });
    const opened = await openEmptyEncryptedContainer({
      backend,
      passphrase: "transition passphrase",
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    expect(opened.fileSystemId).toBe(fileSystemId);
    opened.rootKey.destroy();
    const recoveryOpened = await openEmptyEncryptedContainer({
      backend,
      passphrase: "recovery passphrase",
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    expect(recoveryOpened.fileSystemId).toBe(fileSystemId);
    recoveryOpened.rootKey.destroy();
  });

  it("reopens and verifies a sealed private transition candidate before publication", async () => {
    const root = new InMemoryOpfsDirectoryHandle({ capabilityProfile: "worker", name: "transition-target" });
    const backend = new OpfsWritableBackend<AuthenticatedHizoFSPhysicalBytes>({
      root: root as unknown as FileSystemDirectoryHandle,
    });
    const created = await createEmptyEncryptedContainer({
      backend,
      passphrase: "transition passphrase",
      randomSource: deterministicRandomSource(),
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    const fileSystemId = created.fileSystemId;
    created.rootKey.destroy();

    const operationIdentity = "transition-operation";
    let candidate: HizoFSTransitionImportCandidate | undefined;
    const runtimeStatePort: HizoFSTransitionImportStatePort = {
      loadCandidate: async ({ operationIdentity: requestedOperation }) => {
        if (requestedOperation !== operationIdentity) throw new TypeError("runtime state operation mismatch");
        return structuredClone(candidate);
      },
      stageCandidate: async ({ candidate: next, operationIdentity: requestedOperation }) => {
        if (requestedOperation !== operationIdentity) throw new TypeError("runtime state operation mismatch");
        candidate = structuredClone(next);
      },
    };
    const open = async () => await openBrowserHizoFSTransitionTargetEndpointSession({
      authorityIdentity: "hizofs-target",
      containerRoot: root as unknown as FileSystemDirectoryHandle,
      limits: {
        directory: { maximumEntryMutationsPerBatch: 2 },
        file: { maximumExtentMutationsPerBatch: 2 },
      },
      operationIdentity,
      passphrase: "transition passphrase",
      runtimeStatePort,
      verifyProofAuthority: async ({ fileSystemId: openedId }) => {
        expect(openedId).toBe(fileSystemId);
      },
    });

    const first = await open();
    await first.target.setRootMetadata({ metadata: { createdAt: 10n, modifiedAt: undefined } });
    await first.target.writeFileChunk({ bytes: Uint8Array.of(1, 2, 3), offset: 0n, path: ["data.bin"] });
    await first.target.finalizeFile({
      metadata: { createdAt: undefined, modifiedAt: 20n },
      path: ["data.bin"],
      size: 3n,
    });
    await first.target.completeNamespace();
    await expect(first.source.readRootMetadata()).resolves.toEqual({ createdAt: 10n, modifiedAt: undefined });
    await expect(first.source.listDirectory({ afterName: undefined, maximumEntries: 4, path: [] })).resolves.toEqual({
      entries: [{
        kind: "file",
        metadata: { createdAt: undefined, modifiedAt: 20n },
        name: "data.bin",
        size: 3n,
      }],
      state: "complete",
    });
    await expect(first.source.readFileChunk({ maximumBytes: 4, offset: 0n, path: ["data.bin"] })).resolves.toEqual({
      bytes: Uint8Array.of(1, 2, 3),
      state: "complete",
    });
    await first.close();

    const reopened = await open();
    await expect(reopened.source.readFileChunk({ maximumBytes: 2, offset: 1n, path: ["data.bin"] })).resolves.toEqual({
      bytes: Uint8Array.of(2, 3),
      state: "complete",
    });
    await reopened.close();
  });

  it("publishes one sealed transition candidate exactly once across retry", async () => {
    const root = new InMemoryOpfsDirectoryHandle({ capabilityProfile: "worker", name: "transition-publication-target" });
    const backend = new OpfsWritableBackend<AuthenticatedHizoFSPhysicalBytes>({
      root: root as unknown as FileSystemDirectoryHandle,
    });
    const created = await createEmptyEncryptedContainer({
      backend,
      passphrase: "transition passphrase",
      randomSource: deterministicRandomSource(),
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    const fileSystemId = created.fileSystemId;
    created.rootKey.destroy();

    const operationIdentity = "transition-publication-operation";
    let candidate: HizoFSTransitionImportCandidate | undefined;
    const runtimeStatePort: HizoFSTransitionImportStatePort = {
      loadCandidate: async ({ operationIdentity: requestedOperation }) => {
        if (requestedOperation !== operationIdentity) throw new TypeError("runtime state operation mismatch");
        return structuredClone(candidate);
      },
      stageCandidate: async ({ candidate: next, operationIdentity: requestedOperation }) => {
        if (requestedOperation !== operationIdentity) throw new TypeError("runtime state operation mismatch");
        candidate = structuredClone(next);
      },
    };
    const target = await openBrowserHizoFSTransitionTargetEndpointSession({
      authorityIdentity: "hizofs-target",
      containerRoot: root as unknown as FileSystemDirectoryHandle,
      limits: {
        directory: { maximumEntryMutationsPerBatch: 2 },
        file: { maximumExtentMutationsPerBatch: 2 },
      },
      operationIdentity,
      passphrase: "transition passphrase",
      runtimeStatePort,
      verifyProofAuthority: async ({ fileSystemId: openedId }) => {
        expect(openedId).toBe(fileSystemId);
      },
    });
    await target.target.setRootMetadata({ metadata: { createdAt: 10n, modifiedAt: 11n } });
    await target.target.writeFileChunk({ bytes: Uint8Array.of(7, 8, 9), offset: 0n, path: ["data.bin"] });
    await target.target.finalizeFile({
      metadata: { createdAt: 12n, modifiedAt: 13n },
      path: ["data.bin"],
      size: 3n,
    });
    await target.target.completeNamespace();
    await target.close();

    const publish = async () => await publishBrowserHizoFSTransitionTargetCandidate({
      assertPublicationAllowed: () => undefined,
      containerRoot: root as unknown as FileSystemDirectoryHandle,
      operationIdentity,
      passphrase: "transition passphrase",
      randomSource: deterministicRandomSource(),
      runtimeStatePort,
      verifyProofAuthority: async ({ fileSystemId: openedId }) => {
        expect(openedId).toBe(fileSystemId);
      },
    });
    const first = await publish();
    const second = await publish();
    expect(second).toEqual(first);

    const reopened = await openEmptyEncryptedContainer({
      backend,
      passphrase: "transition passphrase",
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    expect(reopened.commit.commitSequence).toBe(first.commitSequence);
    expect(reopened.commit.rootDirectoryInodeNumber).not.toBe(0n);
    reopened.rootKey.destroy();
    await expect(verifyBrowserHizoFSTransitionTargetNormalOpen({
      containerRoot: root as unknown as FileSystemDirectoryHandle,
      expectedFileSystemId: fileSystemId,
      passphrase: "transition passphrase",
      verifyProofAuthority: async ({ fileSystemId: openedId }) => {
        expect(openedId).toBe(fileSystemId);
      },
    })).resolves.toEqual({ credentialSlotCount: 1 });
    expect(candidate?.type).toBe("sealed");
  });

  it("connects browser benchmark composition to physical and persisted-record diagnostics", async () => {
    const originalLocks = navigator.locks;
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: testBrowserLockManager(),
    });
    const root = new InMemoryOpfsDirectoryHandle({ capabilityProfile: "worker", name: "opfs-root" });
    let runtime: Awaited<ReturnType<typeof createBrowserHizoFSBenchmarkApplicationRuntime>> | undefined;
    try {
      runtime = await createBrowserHizoFSBenchmarkApplicationRuntime({
        backingDirectory: root as unknown as FileSystemDirectoryHandle,
      });
      const initial = runtime.snapshotRuntimeDiagnostics();
      expect(initial.records.inode_table_page.writeOperations).toBeGreaterThan(0);
      expect(initial.records.file_system_commit.readOperations).toBeGreaterThan(0);
      expect(initial.phases.object_encrypt.operationCount).toBeGreaterThan(0);
      expect(initial.phases.object_decrypt.operationCount).toBeGreaterThan(0);
      expect(initial.phases.record_encode.operationCount).toBeGreaterThan(0);
      expect(initial.phases.record_decode.operationCount).toBeGreaterThan(0);
      expect(initial.phases.physical_write_at.operationCount).toBeGreaterThan(0);
      const metadataSegmentsBeforeMutations = initial.segmentWriters.metadata.created;

      const file = await runtime.session.root.getFileHandle({ create: true, name: "measured.bin" });
      const bytes = new Uint8Array(HIZOFS_V1_FORMAT_CONSTANTS.limits.inlineFileBytes + 32).fill(73);
      const writable = await file.createWritable({ keepExistingData: false });
      await writable.write({ data: bytes, position: 0 });
      await writable.close();
      await runtime.settleAcceptedGeneration();
      const beforeReopen = runtime.snapshotRuntimeDiagnostics();
      expect(beforeReopen.phases.commit_publication.operationCount).toBeGreaterThan(0);
      expect(beforeReopen.phases.index_update.operationCount).toBeGreaterThan(0);
      expect(beforeReopen.records.file_data.writeOperations).toBeGreaterThan(0);
      const commitReadsBeforeReopen = beforeReopen.records.file_system_commit.readOperations;
      const publicationsBeforeBulkTarget = beforeReopen.phases.commit_publication.operationCount;
      const indexBuildsBeforeBulkTarget = beforeReopen.phases.index_build.operationCount;
      const bulk = await runtime.createBulkBuilder();
      const afterBulkTarget = runtime.snapshotRuntimeDiagnostics();
      expect(afterBulkTarget.phases.commit_publication.operationCount)
        .toBe(publicationsBeforeBulkTarget);
      expect(afterBulkTarget.phases.index_build.operationCount)
        .toBe(indexBuildsBeforeBulkTarget);
      await bulk.createEmptyFile({ name: "bulk-a" });
      await bulk.createEmptyFile({ name: "bulk-b" });
      await bulk.commit();
      await runtime.settleAcceptedGeneration();
      const afterBulkCommit = runtime.snapshotRuntimeDiagnostics();
      expect(afterBulkCommit.phases.commit_publication.operationCount)
        .toBe(afterBulkTarget.phases.commit_publication.operationCount + 1);
      expect(afterBulkCommit.phases.index_build.operationCount)
        .toBeGreaterThan(afterBulkTarget.phases.index_build.operationCount);
      // WHY: lazy Commit materialization owns a candidate-scoped writer so a
      // session may rotate more than one metadata Segment across independent
      // dirty epochs. This diagnostics contract verifies that physical Segment
      // creation remains observable without requiring unsafe session-local
      // writer reuse across runtime-owned candidates.
      expect(afterBulkCommit.segmentWriters.metadata.created)
        .toBeGreaterThanOrEqual(metadataSegmentsBeforeMutations + 1);
      await expect(bulk.targetDirectory.getFileHandle({ create: false, name: "bulk-a" }))
        .resolves.toBeDefined();
      await expect(bulk.targetDirectory.getFileHandle({ create: false, name: "bulk-b" }))
        .resolves.toBeDefined();

      await runtime.reopen();
      expect(runtime.snapshotRuntimeDiagnostics().records.file_system_commit.readOperations)
        .toBeGreaterThan(commitReadsBeforeReopen);
    } finally {
      await runtime?.close();
      Object.defineProperty(navigator, "locks", {
        configurable: true,
        value: originalLocks,
      });
    }
  });

  it("preserves a single transition endpoint close failure", async () => {
    const closeFailure = new Error("transition target close failed");
    const abandonAuthority = vi.fn();
    const destroyRootKey = vi.fn();

    await expect(COMPOSITION_TEST_ONLY.settleTransitionEndpointClose({
      abandonAuthority,
      closeTarget: async () => {
        throw closeFailure;
      },
      destroyRootKey,
    })).rejects.toBe(closeFailure);
    expect(abandonAuthority).toHaveBeenCalledOnce();
    expect(destroyRootKey).toHaveBeenCalledOnce();
  });

  it("preserves transition target and authority cleanup failures in order", async () => {
    const closeFailure = new Error("transition target close failed");
    const abandonFailure = new Error("transition authority abandon failed");
    const destroyRootKey = vi.fn();

    const result = COMPOSITION_TEST_ONLY.settleTransitionEndpointClose({
      abandonAuthority: () => {
        throw abandonFailure;
      },
      closeTarget: async () => {
        throw closeFailure;
      },
      destroyRootKey,
    });
    await expect(result).rejects.toMatchObject({
      errors: [closeFailure, abandonFailure],
      message: "transition endpoint resource cleanup failed",
    });
    expect(destroyRootKey).toHaveBeenCalledOnce();
  });

  it("preserves transition endpoint open and authority cleanup failures", () => {
    const openFailure = new Error("transition endpoint open failed");
    const abandonFailure = new Error("transition authority abandon failed");
    const destroyRootKey = vi.fn();

    expect(() => COMPOSITION_TEST_ONLY.abandonTransitionEndpointAfterOpenFailure({
      abandonAuthority: () => {
        throw abandonFailure;
      },
      cause: openFailure,
      destroyRootKey,
    })).toThrow(expect.objectContaining({
      errors: [openFailure, abandonFailure],
      message: "transition endpoint open and resource cleanup failed",
    }));
    expect(destroyRootKey).toHaveBeenCalledOnce();
  });

  it("preserves the benchmark session-open failure when capability cleanup succeeds", async () => {
    const openFailure = new Error("benchmark session open failed");
    const releaseResources = vi.fn(async () => undefined);

    await expect(COMPOSITION_TEST_ONLY.releaseBenchmarkCapabilityAfterSessionOpenFailure({
      cause: openFailure,
      releaseResources,
    })).rejects.toBe(openFailure);
    expect(releaseResources).toHaveBeenCalledOnce();
  });

  it("preserves benchmark session-open and capability-cleanup failures together", async () => {
    const openFailure = new Error("benchmark session open failed");
    const cleanupFailure = new Error("benchmark capability cleanup failed");
    const releaseResources = vi.fn(async () => {
      throw cleanupFailure;
    });

    const result = COMPOSITION_TEST_ONLY.releaseBenchmarkCapabilityAfterSessionOpenFailure({
      cause: openFailure,
      releaseResources,
    });
    await expect(result).rejects.toMatchObject({
      errors: [openFailure, cleanupFailure],
      message: "benchmark session open and capability cleanup both failed",
    });
    expect(releaseResources).toHaveBeenCalledOnce();
  });

  it("measures the exact physical-store contract at the composition boundary", async () => {
    const diagnostics = new HizoFSRuntimeDiagnosticsAccumulator();
    const path = canonicalContainerPath({ value: "diagnostic-file" });
    const file = { path } as HizoFSWritableFile;
    const readExactPairWithFileSize = vi.fn(async () => ({
      fileSize: 0n,
      first: new Uint8Array() as AuthenticatedHizoFSPhysicalBytes,
      second: new Uint8Array() as AuthenticatedHizoFSPhysicalBytes,
    }));
    const syncFileDirectoryEntry = vi.fn(async () => undefined);
    const underlying: HizoFSDevelopmentWritableBackend<AuthenticatedHizoFSPhysicalBytes> = {
      capabilities: { directoryEntryDurability: "not-demonstrated", fileDataDurability: "not-demonstrated" },
      closeFile: async () => undefined,
      createDirectoryExclusive: async () => ({ parentEntrySyncRequired: false }),
      createFileExclusive: async () => file,
      getFileSize: async () => 0n,
      getOpenFileSize: async () => 0n,
      list: async () => [],
      openFileForUpdate: async () => file,
      provisionDirectoryHierarchy: async () => ({ parentEntriesRequiringSync: [] }),
      readExact: async () => new Uint8Array() as AuthenticatedHizoFSPhysicalBytes,
      readExactWithFileSize: async () => ({
        bytes: new Uint8Array() as AuthenticatedHizoFSPhysicalBytes,
        fileSize: 0n,
      }),
      readExactPairWithFileSize,
      readFileBounded: async () => new Uint8Array() as AuthenticatedHizoFSPhysicalBytes,
      removeFile: async () => undefined,
      syncDirectoryEntries: async () => undefined,
      syncFileDirectoryEntry,
      syncFileData: async () => undefined,
      truncate: async () => undefined,
      writeAt: async () => undefined,
    };
    let now = 0;
    const backend = COMPOSITION_TEST_ONLY.instrumentHizoFSWritableBackend({
      backend: underlying,
      clock: () => ++now,
      diagnostics,
    });
    await backend.createFileExclusive({ path });
    await backend.createDirectoryExclusive({ path: CANONICAL_CONTAINER_ROOT });
    if (backend.provisionDirectoryHierarchy === undefined) throw new Error("expected hierarchy provisioning capability");
    await backend.provisionDirectoryHierarchy({ path: CANONICAL_CONTAINER_ROOT });
    await backend.openFileForUpdate({ path });
    await backend.getOpenFileSize({ file });
    await backend.getFileSize({ path });
    await backend.readExact({ length: 0, offset: 0n, path });
    await backend.readExactWithFileSize({ length: 0, offset: 0n, path });
    if (backend.readExactPairWithFileSize === undefined) throw new Error("expected paired exact-read capability");
    await backend.readExactPairWithFileSize({
      first: { length: 0, offset: 0n },
      path,
      second: { length: 0, offset: 0n },
    });
    expect(readExactPairWithFileSize).toHaveBeenCalledOnce();
    await backend.readFileBounded({ maximumByteLength: 0, path });
    await backend.writeAt({ bytes: new Uint8Array() as AuthenticatedHizoFSPhysicalBytes, file, offset: 0n });
    await backend.truncate({ file, length: 0n });
    await backend.syncFileData({ file });
    await backend.closeFile({ file });
    if (backend.syncFileDirectoryEntry === undefined) throw new Error("expected exact file-entry confirmation capability");
    await backend.syncFileDirectoryEntry({ path });
    expect(syncFileDirectoryEntry).toHaveBeenCalledOnce();
    await backend.syncDirectoryEntries({ parent: CANONICAL_CONTAINER_ROOT });
    await backend.removeFile({ path });
    await backend.list({ directory: CANONICAL_CONTAINER_ROOT });

    diagnostics.recordPublicationScopeEvent({ event: "begin" });
    await backend.getFileSize({ path });
    await backend.getFileSize({ path });
    await backend.readExact({ length: 0, offset: 0n, path });
    await backend.readExact({ length: 0, offset: 0n, path });
    diagnostics.recordPublicationScopeEvent({ event: "end" });

    const physical = Object.entries(diagnostics.snapshot().phases)
      .filter(([phase]) => phase.startsWith("physical_"));
    expect(physical).toHaveLength(14);
    expect(diagnostics.snapshot().phases.physical_get_file_size).toEqual({ operationCount: 4, totalDurationMs: 4 });
    expect(diagnostics.snapshot().phases.physical_read_exact).toEqual({ operationCount: 5, totalDurationMs: 5 });
    expect(diagnostics.snapshot().phases.physical_sync_directory_entries).toEqual({
      operationCount: 2,
      totalDurationMs: 2,
    });
    for (const [phase, counter] of physical) {
      if (phase === "physical_get_file_size"
        || phase === "physical_read_exact"
        || phase === "physical_sync_directory_entries") continue;
      expect(counter).toEqual({ operationCount: 1, totalDurationMs: 1 });
    }
    expect(diagnostics.snapshot().publication).toEqual({
      completed: 1,
      overlapping: 0,
      getFileSize: {
        duplicateOperations: 1,
        maximumOperationsPerScope: 2,
        operations: 2,
        observedUniqueTargets: 1,
        truncatedScopes: 0,
        unclassifiedOperations: 0,
      },
      readExact: {
        duplicateOperations: 1,
        maximumOperationsPerScope: 2,
        operations: 2,
        observedUniqueTargets: 1,
        truncatedScopes: 0,
        unclassifiedOperations: 0,
      },
    });
  });


  describe("authenticated maintenance root-capture composition", () => {
    it("adopts prepared candidates and current active, fallback, and pinned roots inside the short gate", async () => {
      const gate = maintenanceRuntimeCapture();
      const readCurrentRoots = vi.fn(async () => ({
        activeCommitRoots: [maintenanceRootReference({ offset: 64n, seed: 1 })],
        fallbackCommitRoots: [maintenanceRootReference({ offset: 160n, seed: 2 })],
        historicalRootFeatureState: "supported_or_absent" as const,
        relocationIndexRoots: [maintenanceRelocationRootReference({ offset: 352n, seed: 4 })],
      }));
      const captured = await COMPOSITION_TEST_ONLY.captureAuthenticatedMaintenanceRootsWithReader({
        authority: { marker: "secret-owned" },
        candidateSnapshot: prepareMaintenanceCandidateSnapshot({
          candidateSegments: [],
          policy: createMaintenancePolicy(),
        }),
        policy: createMaintenancePolicy(),
        readCurrentRoots,
        runtimeHost: { beginCleanHeadMaintenanceRootCapture: async () => gate.capture },
      });

      expect(captured.snapshot.maintenanceRootEpoch).toBe(4);
      expect(captured.snapshot.roots).toHaveLength(4);
      expect(captured.counts).toMatchObject({
        activeCommit: 1,
        fallbackCommit: 1,
        readerPinned: 1,
        relocationIndex: 1,
      });
      expect(readCurrentRoots).toHaveBeenCalledOnce();
      expect(gate.release).toHaveBeenCalledOnce();
    });

    it("fails closed while an old logical source-Segment pin still exists", async () => {
      const sourcePinned = maintenanceRootReference({ offset: 448n, seed: 5 });
      const gate = maintenanceRuntimeCapture({ sourcePinned: [sourcePinned] });
      await expect(COMPOSITION_TEST_ONLY.captureAuthenticatedMaintenanceRootsWithReader({
        authority: {},
        candidateSnapshot: prepareMaintenanceCandidateSnapshot({
          candidateSegments: [],
          policy: createMaintenancePolicy(),
        }),
        policy: createMaintenancePolicy(),
        readCurrentRoots: async () => ({
          activeCommitRoots: [maintenanceRootReference({ offset: 64n, seed: 1 })],
          fallbackCommitRoots: [],
          historicalRootFeatureState: "supported_or_absent",
          relocationIndexRoots: [],
        }),
        runtimeHost: { beginCleanHeadMaintenanceRootCapture: async () => gate.capture },
      })).rejects.toThrow("cannot translate legacy logical source-Segment pins");
      expect(gate.release).toHaveBeenCalledOnce();
    });

    it("rejects maintenance while an authenticated historical root requires unsupported features", async () => {
      const gate = maintenanceRuntimeCapture();
      await expect(COMPOSITION_TEST_ONLY.captureAuthenticatedMaintenanceRootsWithReader({
        authority: {},
        candidateSnapshot: prepareMaintenanceCandidateSnapshot({
          candidateSegments: [],
          policy: createMaintenancePolicy(),
        }),
        policy: createMaintenancePolicy(),
        readCurrentRoots: async () => ({
          activeCommitRoots: [maintenanceRootReference({ offset: 64n, seed: 1 })],
          fallbackCommitRoots: [],
          historicalRootFeatureState: "unsupported",
          relocationIndexRoots: [],
        }),
        runtimeHost: { beginCleanHeadMaintenanceRootCapture: async () => gate.capture },
      })).rejects.toThrow(
        "maintenance is unavailable while an authenticated historical root requires unsupported features",
      );
      expect(gate.release).toHaveBeenCalledOnce();
    });

    it("releases the gate when authority reading or snapshot validation fails", async () => {
      const gate = maintenanceRuntimeCapture();
      const primary = new Error("Superblock authority read failed");
      await expect(COMPOSITION_TEST_ONLY.captureAuthenticatedMaintenanceRootsWithReader({
        authority: {},
        candidateSnapshot: prepareMaintenanceCandidateSnapshot({
          candidateSegments: [],
          policy: createMaintenancePolicy(),
        }),
        policy: createMaintenancePolicy(),
        readCurrentRoots: async () => {
          throw primary;
        },
        runtimeHost: { beginCleanHeadMaintenanceRootCapture: async () => gate.capture },
      })).rejects.toBe(primary);
      expect(gate.release).toHaveBeenCalledOnce();
    });

    it("preserves authority and gate-cleanup failures in operation order", async () => {
      const primary = new Error("authority failed");
      const releaseFailure = new Error("release failed");
      const completionFailure = new Error("release completion failed");
      const result = COMPOSITION_TEST_ONLY.settleRootCapture({
        capture: {
          inspectorPinnedRoots: [],
          maintenanceRootEpoch: 0,
          readerPinnedRoots: [],
          release: () => {
            throw releaseFailure;
          },
          released: Promise.reject(completionFailure),
          sourceSegmentPinnedRoots: [],
          unknownFeatureRoots: [],
          workingGenerationDependencyRoots: [],
          workingGenerationPageRoots: [],
        },
        operation: async () => {
          throw primary;
        },
      });
      await expect(result).rejects.toBeInstanceOf(AggregateError);
      await expect(result).rejects.toMatchObject({
        errors: [primary, releaseFailure, completionFailure],
      });
    });

    it("exposes deletion leases only after current roots and candidates still match", async () => {
      const active = maintenanceRootReference({ offset: 64n, seed: 1 });
      const fallback = maintenanceRootReference({ offset: 160n, seed: 2 });
      const pinned = maintenanceRootReference({ offset: 256n, seed: 3 });
      const candidate = maintenanceCandidate();
      const candidateSnapshot = prepareMaintenanceCandidateSnapshot({
        candidateSegments: [candidate],
        policy: createMaintenancePolicy(),
      });
      const beginSegmentDeletion = vi.fn(async ({ segmentId }:
      Parameters<HizoFSWorkerRuntimeHost["beginSegmentDeletion"]>[0]) => {
        void segmentId;
        return { release: vi.fn() };
      });
      const validation = await COMPOSITION_TEST_ONLY.validateAndPrepareAuthenticatedMaintenanceSweepWithReader({
        authority: {},
        capturedSnapshot: createMaintenanceRootSnapshot({
          candidateSegments: candidateSnapshot.candidateSegments,
          maintenanceRootEpoch: 4,
          roots: [maintenanceLogicalRoot(active), maintenanceLogicalRoot(fallback), maintenanceLogicalRoot(pinned)],
        }),
        currentCandidateSnapshot: candidateSnapshot,
        policy: createMaintenancePolicy(),
        readCurrentRoots: async () => ({
          activeCommitRoots: [active],
          fallbackCommitRoots: [fallback],
          historicalRootFeatureState: "supported_or_absent",
          relocationIndexRoots: [],
        }),
        runtimeHost: {
          beginCleanHeadMaintenanceRootCapture: async () => maintenanceRuntimeCapture({ pinned: [pinned] }).capture,
          beginSegmentDeletion,
        },
      });

      expect(validation.valid).toBe(true);
      if (!validation.valid) expect.unreachable("matching authority must validate");
      const lease = await validation.beginDeletion({ plan: maintenanceRemovalPlan() });
      expect(beginSegmentDeletion).toHaveBeenCalledOnce();
      expect(beginSegmentDeletion.mock.calls[0]?.[0].segmentId).toEqual(candidate.segmentId);
      lease.release();
    });

    it("rejects a changed root epoch before exposing any deletion lease", async () => {
      const active = maintenanceRootReference({ offset: 64n, seed: 1 });
      const candidateSnapshot = prepareMaintenanceCandidateSnapshot({
        candidateSegments: [maintenanceCandidate()],
        policy: createMaintenancePolicy(),
      });
      const beginSegmentDeletion = vi.fn();
      const validation = await COMPOSITION_TEST_ONLY.validateAndPrepareAuthenticatedMaintenanceSweepWithReader({
        authority: {},
        capturedSnapshot: createMaintenanceRootSnapshot({
          candidateSegments: candidateSnapshot.candidateSegments,
          maintenanceRootEpoch: 3,
          roots: [maintenanceLogicalRoot(active)],
        }),
        currentCandidateSnapshot: candidateSnapshot,
        policy: createMaintenancePolicy(),
        readCurrentRoots: async () => ({
          activeCommitRoots: [active],
          fallbackCommitRoots: [],
          historicalRootFeatureState: "supported_or_absent",
          relocationIndexRoots: [],
        }),
        runtimeHost: {
          beginCleanHeadMaintenanceRootCapture: async () => maintenanceRuntimeCapture({ epoch: 4, pinned: [] }).capture,
          beginSegmentDeletion,
        },
      });

      expect(validation).toEqual({ reason: "root_epoch_changed", valid: false });
      expect(beginSegmentDeletion).not.toHaveBeenCalled();
    });

    it("rejects a changed authenticated candidate contract before deletion", async () => {
      const active = maintenanceRootReference({ offset: 64n, seed: 1 });
      const capturedCandidate = maintenanceCandidate({ frameCount: 2 });
      const currentCandidate = maintenanceCandidate({ frameCount: 3 });
      const beginSegmentDeletion = vi.fn();
      const validation = await COMPOSITION_TEST_ONLY.validateAndPrepareAuthenticatedMaintenanceSweepWithReader({
        authority: {},
        capturedSnapshot: createMaintenanceRootSnapshot({
          candidateSegments: [capturedCandidate],
          maintenanceRootEpoch: 4,
          roots: [maintenanceLogicalRoot(active)],
        }),
        currentCandidateSnapshot: prepareMaintenanceCandidateSnapshot({
          candidateSegments: [currentCandidate],
          policy: createMaintenancePolicy(),
        }),
        policy: createMaintenancePolicy(),
        readCurrentRoots: async () => ({
          activeCommitRoots: [active],
          fallbackCommitRoots: [],
          historicalRootFeatureState: "supported_or_absent",
          relocationIndexRoots: [],
        }),
        runtimeHost: {
          beginCleanHeadMaintenanceRootCapture: async () => maintenanceRuntimeCapture({ epoch: 4, pinned: [] }).capture,
          beginSegmentDeletion,
        },
      });

      expect(validation).toEqual({ reason: "candidate_changed", valid: false });
      expect(beginSegmentDeletion).not.toHaveBeenCalled();
    });
  });

  it("recreates the exact non-empty portable container bytes", async () => {
    const firstBackend = await createNonemptyPortableFixtureBackend();
    const secondBackend = await createNonemptyPortableFixtureBackend();
    const firstFiles = await collectPortableContainerFiles({
      backend: firstBackend,
      directory: CANONICAL_CONTAINER_ROOT,
    });
    const secondFiles = await collectPortableContainerFiles({
      backend: secondBackend,
      directory: CANONICAL_CONTAINER_ROOT,
    });
    expect(nonemptyContainerPortable).toMatchObject({
      fileSystemId: "57XP043891T62-modnaes",
      passphrase: "correct horse battery staple",
      schema: "hizofs-v1-nonempty-container-fixture",
      schemaVersion: 1,
    });
    expect(secondFiles).toEqual(firstFiles);
    expect(firstFiles).toEqual(nonemptyContainerPortable.files);
  });

  it("reopens the non-empty portable container through normal authenticated reads", async () => {
    const backend = await createNonemptyPortableFixtureBackend();
    const authority = await openAuthenticatedReadOnlyContainerAuthority({
      backend,
      passphrase: "correct horse battery staple",
      supportedFeatureBits: createFeatureBits({ value: 0n }),
      verifyProofAuthority: async ({ fileSystemId }) => {
        expect(fileSystemId).toBe(nonemptyContainerPortable.fileSystemId);
      },
    });
    const session = await openAuthenticatedReadOnlyApplicationSession({
      captureAuthority: async () => ({ revision: 1 }),
      recheckAuthority: async () => undefined,
      runtimeHost: runtimeHost(),
      verifyCapturedAuthority: async () => authority,
    });
    try {
      const hello = await session.root.getFileHandle({ create: false, name: "hello.txt" });
      const docs = await session.root.getDirectoryHandle({ create: false, name: "docs" });
      const nested = await docs.getFileHandle({ create: false, name: "nested.txt" });
      const helloReadable = await hello.openReadable({ mimeType: "text/plain" });
      const nestedReadable = await nested.openReadable({ mimeType: "text/plain" });
      try {
        await expect(new Response(helloReadable.stream({
          end: undefined,
          signal: undefined,
          start: 0,
        })).text()).resolves.toBe("hello\n");
        await expect(new Response(nestedReadable.stream({
          end: undefined,
          signal: undefined,
          start: 0,
        })).text()).resolves.toBe("nested\n");
      } finally {
        await helloReadable.close();
        await nestedReadable.close();
      }
    } finally {
      await session.close();
    }
  });

  function selectedCandidatePublisherReference() {
    return createHomeRecordReference({ fields: {
      byteOffset: createUInt64({ value: 4_096n }),
      frameLength: 128,
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
      segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(9) }),
    } });
  }

  function selectedCandidatePublisherFixture() {
    const durableAuthority = createTestingAuthenticatedDurableApplicationGenerationAuthority();
    const base = createAuthenticatedApplicationGenerationDescriptor({
      commit: durableAuthority.commit,
      commitReference: durableAuthority.commitReference,
      durableAuthority,
      workingIdentity: createWorkingGenerationIdentity({
        authorityEpoch: createWorkingGenerationAuthorityEpoch(),
        generationNumber: createWorkingGenerationNumber({ value: 0n }),
        mutationId: durableAuthority.commit.mutationId,
      }),
    });
    const commitReference = selectedCandidatePublisherReference();
    const commit = createFileSystemCommitPayload({ payload: {
      ...base.commit,
      commitSequence: createCommitSequence({ value: base.commit.commitSequence + 1n }),
      mutationId: parseMutationId({ bytes: new Uint8Array(16).fill(7) }),
    } });
    const successor = createAuthenticatedApplicationGenerationDescriptor({
      commit,
      commitReference,
      durableAuthority,
      workingIdentity: createSuccessorWorkingGenerationIdentity({
        mutationId: commit.mutationId,
        previous: base.workingIdentity,
      }),
    });
    const intendedLogicalState: SuperblockLogicalState = Object.freeze({
      ...base.superblock.logicalState,
      activeCommitHomeRef: commitReference,
      activeCommitSequence: commit.commitSequence,
      activeMutationId: commit.mutationId,
      fallbackCommitHomeRef: base.superblock.logicalState.activeCommitHomeRef,
    });
    const superblock = ({ copyState }: {
    copyState: OpenedSuperblockCopies["copyState"];
  }): OpenedSuperblockCopies => Object.freeze({
      ...base.superblock,
      authenticatedLogicalStates: Object.freeze([intendedLogicalState, intendedLogicalState]),
      copyState,
      logicalState: intendedLogicalState,
      maximumStructurallyObservedPublicationSequence: createPublicationSequence({ value: 3n }),
      selectedPublicationId: parsePublicationId({ bytes: new Uint8Array(16).fill(6) }),
      selectedPublicationSequence: createPublicationSequence({ value: 3n }),
    });
    return { base, commit, commitReference, intendedLogicalState, successor, superblock };
  }

  function selectedCandidatePublisherDeferred({
    publishCandidate,
    resolvePublication,
  }: {
  publishCandidate: ResolvablePreparedMutationCommitDurablePublicationPort["publishCandidate"];
  resolvePublication: ResolvablePreparedMutationCommitDurablePublicationPort["resolvePublication"];
}): DeferredPreparedMutationCommitPublication & Readonly<{ abandon: ReturnType<typeof vi.fn> }> {
    const values = selectedCandidatePublisherFixture();
    const abandon = vi.fn();
    return Object.freeze({
      abandon,
      candidate: Object.freeze({
        commitHomeRef: values.commitReference,
        commitPayload: values.commit,
      }),
      publicationPort: Object.freeze({
        abandon,
        completeWorkingAcceptance: vi.fn(),
        completeExternallyResolvedPublication: vi.fn(),
        publishCandidate,
        resolvePublication,
      }),
    });
  }

  it("anchors every dirty-epoch candidate Sequence to the durable head while preserving working roots", () => {
    const values = selectedCandidatePublisherFixture();
    const workingCommit = createFileSystemCommitPayload({ payload: {
      ...values.successor.commit,
      commitSequence: createCommitSequence({ value: values.base.commit.commitSequence + 9n }),
      mutationId: parseMutationId({ bytes: new Uint8Array(16).fill(11) }),
      rootInodeTableRootHomeRef: createHomeRecordReference({ fields: {
        byteOffset: createUInt64({ value: 8_192n }),
        frameLength: 160,
        recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
        segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(12) }),
      } }),
    } });
    const working = createAuthenticatedApplicationGenerationDescriptor({
      commit: workingCommit,
      commitReference: values.successor.commitReference,
      durableAuthority: values.base.durableAuthority,
      workingIdentity: createWorkingGenerationIdentity({
        authorityEpoch: values.successor.workingIdentity.authorityEpoch,
        generationNumber: values.successor.workingIdentity.generationNumber,
        mutationId: workingCommit.mutationId,
      }),
    });

    const planningBase = COMPOSITION_TEST_ONLY.createMutationCandidatePlanningBaseCommit({ base: working });

    expect(planningBase.commitSequence).toBe(values.base.durableAuthority.commit.commitSequence);
    expect(planningBase.mutationId).toEqual(values.base.durableAuthority.commit.mutationId);
    expect(planningBase.rootInodeTableRootHomeRef).toEqual(working.commit.rootInodeTableRootHomeRef);
  });

  it("installs one exact detached candidate into runtime accepted ownership", () => {
    const values = selectedCandidatePublisherFixture();
    const prepared = selectedCandidatePublisherDeferred({
      publishCandidate: vi.fn(),
      resolvePublication: vi.fn(),
    });
    const events: string[] = [];
    const commitAcceptedSuccessor = vi.fn(() => events.push("accepted"));
    const replaceResourceReservation = vi.fn(() => events.push("reserved"));
    const admission = {
      commitAcceptedStagedSuccessor: vi.fn(),
      commitAcceptedSuccessor,
      replaceResourceReservation,
      reserveStagedCommitMaterializationHeadroom: vi.fn(),
      rollback: vi.fn(),
    };

    const publisher = COMPOSITION_TEST_ONLY.installPreparedMutationSelectedCandidate({
      admission,
      assertRuntimePublicationAllowed: () => undefined,
      base: values.base,
      deferred: prepared,
      resourceUsage: {
        appendedMetadataFrameBytes: 4_096,
        unpublishedPhysicalBytes: 8_192,
      },
      successor: values.successor,
    });

    expect(replaceResourceReservation).toHaveBeenCalledWith({
      dirtyMetadataBytes: 4_096,
      unpublishedPhysicalBytes: 8_192,
    });
    expect(events).toEqual(["reserved", "accepted"]);
    expect(commitAcceptedSuccessor).toHaveBeenCalledWith({
      publisher,
      successor: values.successor,
    });
    publisher.abandon();
    expect(prepared.abandon).toHaveBeenCalledOnce();
  });

  it("releases the foreground Segment writer lease before staged accepted visibility", async () => {
    const values = selectedCandidatePublisherFixture();
    const events: string[] = [];
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
    const foregroundLease = writerOwner.acquire();
    const replaceResourceReservation = vi.fn();
    const reserveStagedCommitMaterializationHeadroom = vi.fn();
    const prepareWorkingAcceptance = vi.fn(() => {
      foregroundLease.release({ disposition: "reuse" });
      events.push("foreground_writer_released");
    });
    const commitAcceptedStagedSuccessor = vi.fn(() => {
      const publicationLease = writerOwner.acquire();
      publicationLease.release({ disposition: "reuse" });
      events.push("accepted_visible");
    });
    const createMaterializationAuthority = vi.fn(async () => {
      throw new Error("foreground staging must not open a materialization authority");
    });
    const admission = {
      commitAcceptedStagedSuccessor,
      commitAcceptedSuccessor: vi.fn(),
      replaceResourceReservation,
      reserveStagedCommitMaterializationHeadroom,
      rollback: vi.fn(),
    };
    const resourceUsage = {
      appendedMetadataFrameBytes: 4_096,
      unpublishedPhysicalBytes: 8_192,
    };

    const installed = COMPOSITION_TEST_ONLY.prepareAndInstallStagedMutationSelectedCandidate({
      admission,
      assertCandidatePreparationAllowed: vi.fn(),
      assertRuntimePublicationAllowed: vi.fn(),
      base: values.base,
      commitPayload: values.commit,
      createMaterializationAuthority,
      prepareWorkingAcceptance,
      resourceUsage,
    });

    expect(replaceResourceReservation).toHaveBeenCalledWith({
      dirtyMetadataBytes: resourceUsage.appendedMetadataFrameBytes,
      unpublishedPhysicalBytes: resourceUsage.unpublishedPhysicalBytes,
    });
    expect(reserveStagedCommitMaterializationHeadroom).toHaveBeenCalledWith({
      bytes: STAGED_MUTATION_COMMIT_MATERIALIZATION_FRAME_BYTES,
    });
    expect(events).toEqual(["foreground_writer_released", "accepted_visible"]);
    expect(prepareWorkingAcceptance).toHaveBeenCalledOnce();
    expect(commitAcceptedStagedSuccessor).toHaveBeenCalledWith({
      publisher: installed.publisher,
      successor: installed.successor,
    });
    expect(createMaterializationAuthority).not.toHaveBeenCalled();
    expect("commitReference" in installed.successor).toBe(false);
    installed.publisher.abandon();
    await expect(writerOwner.close()).resolves.toBeUndefined();
    rootKey.destroy();
  });

  it("prepares and installs deferred runtime ownership without starting Superblock publication", async () => {
    const values = selectedCandidatePublisherFixture();
    const events: string[] = [];
    const detachedPublish = vi.fn();
    const detachedResolve = vi.fn();
    const detachedAbandon = vi.fn();
    const sourcePublish = vi.fn();
    const candidate = Object.freeze({
      commitHomeRef: values.commitReference,
      commitPayload: values.commit,
    });
    const commitAcceptedSuccessor = vi.fn(() => events.push("accepted"));
    const admission = {
      commitAcceptedStagedSuccessor: vi.fn(),
      commitAcceptedSuccessor,
      replaceResourceReservation: vi.fn(() => events.push("reserved")),
      reserveStagedCommitMaterializationHeadroom: vi.fn(),
      rollback: vi.fn(),
    };
    let preparationGateChecks = 0;

    const installed = await COMPOSITION_TEST_ONLY.prepareAndInstallDeferredMutationSelectedCandidate({
      admission,
      assertCandidatePreparationAllowed: () => {
        preparationGateChecks += 1;
        events.push(`gate_${preparationGateChecks}`);
      },
      assertRuntimePublicationAllowed: vi.fn(),
      base: values.base,
      commitPayload: values.commit,
      createSuccessor: ({ candidate: preparedCandidate }) => {
        expect(preparedCandidate).toBe(candidate);
        events.push("successor");
        return values.successor;
      },
      publicationPort: {
        appendCandidate: async () => {
          events.push("append");
          return candidate;
        },
        detachPreparedCandidatePublication: ({ candidate: preparedCandidate }) => {
          expect(preparedCandidate).toBe(candidate);
          events.push("detach");
          return {
            abandon: detachedAbandon,
            completeWorkingAcceptance: vi.fn(),
            completeExternallyResolvedPublication: vi.fn(),
            publishCandidate: detachedPublish,
            resolvePublication: detachedResolve,
          };
        },
        publishCandidate: sourcePublish,
      },
      resourceUsage: {
        appendedMetadataFrameBytes: 1_024,
        unpublishedPhysicalBytes: 2_048,
      },
    });

    expect(installed.successor).toBe(values.successor);
    expect(commitAcceptedSuccessor).toHaveBeenCalledWith({
      publisher: installed.publisher,
      successor: values.successor,
    });
    expect(events).toEqual([
      "gate_1",
      "append",
      "gate_2",
      "detach",
      "successor",
      "reserved",
      "accepted",
    ]);
    expect(sourcePublish).not.toHaveBeenCalled();
    expect(detachedPublish).not.toHaveBeenCalled();
    expect(detachedResolve).not.toHaveBeenCalled();
    expect(detachedAbandon).not.toHaveBeenCalled();
  });

  it("abandons detached authority and rolls back when successor construction fails", async () => {
    const values = selectedCandidatePublisherFixture();
    const abandon = vi.fn();
    const rollback = vi.fn();
    const failure = new Error("successor construction failed");

    await expect(COMPOSITION_TEST_ONLY.prepareAndInstallDeferredMutationSelectedCandidate({
      admission: {
        commitAcceptedStagedSuccessor: vi.fn(),
        commitAcceptedSuccessor: vi.fn(),
        replaceResourceReservation: vi.fn(),
        reserveStagedCommitMaterializationHeadroom: vi.fn(),
        rollback,
      },
      assertCandidatePreparationAllowed: vi.fn(),
      assertRuntimePublicationAllowed: vi.fn(),
      base: values.base,
      commitPayload: values.commit,
      createSuccessor: () => {
        throw failure;
      },
      publicationPort: {
        appendCandidate: async () => ({
          commitHomeRef: values.commitReference,
          commitPayload: values.commit,
        }),
        detachPreparedCandidatePublication: () => ({
          abandon,
          completeWorkingAcceptance: vi.fn(),
          completeExternallyResolvedPublication: vi.fn(),
          publishCandidate: vi.fn(),
          resolvePublication: vi.fn(),
        }),
        publishCandidate: vi.fn(),
      },
      resourceUsage: { appendedMetadataFrameBytes: 1, unpublishedPhysicalBytes: 1 },
    })).rejects.toBe(failure);

    expect(abandon).toHaveBeenCalledOnce();
    expect(rollback).toHaveBeenCalledOnce();
  });

  it("abandons detached authority and rolls back when runtime reservation fails", async () => {
    const values = selectedCandidatePublisherFixture();
    const abandon = vi.fn();
    const rollback = vi.fn();
    const failure = new Error("reservation failed");

    await expect(COMPOSITION_TEST_ONLY.prepareAndInstallDeferredMutationSelectedCandidate({
      admission: {
        commitAcceptedStagedSuccessor: vi.fn(),
        commitAcceptedSuccessor: vi.fn(),
        replaceResourceReservation: () => {
          throw failure;
        },
        reserveStagedCommitMaterializationHeadroom: vi.fn(),
        rollback,
      },
      assertCandidatePreparationAllowed: vi.fn(),
      assertRuntimePublicationAllowed: vi.fn(),
      base: values.base,
      commitPayload: values.commit,
      createSuccessor: () => values.successor,
      publicationPort: {
        appendCandidate: async () => ({
          commitHomeRef: values.commitReference,
          commitPayload: values.commit,
        }),
        detachPreparedCandidatePublication: () => ({
          abandon,
          completeWorkingAcceptance: vi.fn(),
          completeExternallyResolvedPublication: vi.fn(),
          publishCandidate: vi.fn(),
          resolvePublication: vi.fn(),
        }),
        publishCandidate: vi.fn(),
      },
      resourceUsage: { appendedMetadataFrameBytes: 1, unpublishedPhysicalBytes: 1 },
    })).rejects.toBe(failure);

    expect(abandon).toHaveBeenCalledOnce();
    expect(rollback).toHaveBeenCalledOnce();
  });

  const createMaterializationAttemptReceipt = () => Object.freeze({
    completeReusableCandidate: vi.fn(),
    fail: vi.fn(),
  });

  describe("staged mutation selected-candidate publisher", () => {
    function stagedPublisherFixture() {
      const values = selectedCandidatePublisherFixture();
      const stagedSuccessor = createAuthenticatedStagedApplicationGenerationDescriptor({
        commit: values.commit,
        durableAuthority: values.base.durableAuthority,
        workingIdentity: values.successor.workingIdentity,
      });
      return { stagedSuccessor, values };
    }

    it("materializes exactly one Commit at flush before any Superblock authority write", async () => {
      const { stagedSuccessor, values } = stagedPublisherFixture();
      const events: string[] = [];
      const appendCandidate = vi.fn(async () => {
        events.push("append");
        return Object.freeze({
          commitHomeRef: values.commitReference,
          commitPayload: values.commit,
        });
      });
      const detachedAbandon = vi.fn();
      const completeWorkingAcceptance = vi.fn(() => events.push("materialization-diagnostics-closed"));
      const publisher = COMPOSITION_TEST_ONLY.createStagedMutationSelectedCandidatePublisher({
        assertRuntimePublicationAllowed: () => events.push("gate"),
        baseDurableAuthority: values.base.durableAuthority,
        createMaterializationAuthority: async () => {
          events.push("open-materialization-authority");
          return {
            abandon: vi.fn(),
            appendCandidate,
            detachPreparedCandidatePublication: ({ candidate }) => {
              events.push("detach");
              return {
                abandon: detachedAbandon,
                completeWorkingAcceptance,
                completeExternallyResolvedPublication: vi.fn(),
                publishCandidate: async ({ beforeFirstAuthorityWrite }) => {
                  beforeFirstAuthorityWrite();
                  events.push("superblock-write");
                  return {
                    commitHomeRef: candidate.commitHomeRef,
                    superblock: values.superblock({ copyState: "normal" }),
                  };
                },
                resolvePublication: vi.fn(),
              };
            },
            publishCandidate: vi.fn(),
          };
        },
        staged: Object.freeze({ commitPayload: values.commit }),
        stagedSuccessor,
      });

      expect(appendCandidate).not.toHaveBeenCalled();
      const onCandidateMaterialized = vi.fn(() => events.push("materialized"));
      const materializationAttempt = createMaterializationAttemptReceipt();
      const onMaterializationAppendAttempt = vi.fn(({ frameBytes }: { frameBytes: number }) => {
        events.push("materialization-resource-attempt");
        expect(frameBytes).toBe(STAGED_MUTATION_COMMIT_MATERIALIZATION_FRAME_BYTES);
        return materializationAttempt;
      });
      const outcome = await publisher.publish({
        onCandidateMaterialized,
        onMaterializationAppendAttempt,
      });

      expect(outcome.type).toBe("published");
      expect(appendCandidate).toHaveBeenCalledOnce();
      expect(onCandidateMaterialized).toHaveBeenCalledWith({
        candidateDurableIdentity: createDurableGenerationIdentity({
          commitReference: values.commitReference,
          commitSequence: values.commit.commitSequence,
          mutationId: values.commit.mutationId,
        }),
      });
      expect(onMaterializationAppendAttempt).toHaveBeenCalledOnce();
      expect(events.indexOf("materialization-resource-attempt")).toBeLessThan(events.indexOf("append"));
      expect(events.indexOf("append")).toBeLessThan(events.indexOf("materialized"));
      expect(events.indexOf("materialized")).toBeLessThan(events.indexOf("superblock-write"));
      expect(materializationAttempt.completeReusableCandidate).toHaveBeenCalledOnce();
      expect(materializationAttempt.fail).not.toHaveBeenCalled();
      expect(completeWorkingAcceptance).toHaveBeenCalledOnce();
      expect(detachedAbandon).not.toHaveBeenCalled();
    });

    it("releases retained staged publication resources exactly once on terminal cleanup", async () => {
      const { stagedSuccessor, values } = stagedPublisherFixture();
      const releasePublicationResources = vi.fn();
      const completeExternallyResolvedPublication = vi.fn();
      const publisher = COMPOSITION_TEST_ONLY.createStagedMutationSelectedCandidatePublisher({
        assertRuntimePublicationAllowed: () => undefined,
        baseDurableAuthority: values.base.durableAuthority,
        createMaterializationAuthority: async () => ({
          abandon: vi.fn(),
          appendCandidate: async () => Object.freeze({
            commitHomeRef: values.commitReference,
            commitPayload: values.commit,
          }),
          detachPreparedCandidatePublication: ({ candidate }) => ({
            abandon: vi.fn(),
            completeWorkingAcceptance: vi.fn(),
            completeExternallyResolvedPublication,
            publishCandidate: async ({ beforeFirstAuthorityWrite }) => {
              beforeFirstAuthorityWrite();
              return {
                commitHomeRef: candidate.commitHomeRef,
                superblock: values.superblock({ copyState: "normal" }),
              };
            },
            resolvePublication: vi.fn(),
          }),
          publishCandidate: vi.fn(),
        }),
        releasePublicationResources,
        staged: Object.freeze({ commitPayload: values.commit }),
        stagedSuccessor,
      });

      await expect(publisher.publish({
        onCandidateMaterialized: vi.fn(),
        onMaterializationAppendAttempt: () => createMaterializationAttemptReceipt(),
      })).resolves.toMatchObject({ type: "published" });
      expect(releasePublicationResources).not.toHaveBeenCalled();

      publisher.completeOutcomeUnknownResolution({ outcome: "confirmed_published" });
      publisher.abandon();

      expect(completeExternallyResolvedPublication).toHaveBeenCalledWith({ outcome: "published" });
      expect(releasePublicationResources).toHaveBeenCalledOnce();
    });

    it("releases retained staged publication resources when abandoned before materialization", () => {
      const { stagedSuccessor, values } = stagedPublisherFixture();
      const releasePublicationResources = vi.fn();
      const createMaterializationAuthority = vi.fn();
      const publisher = COMPOSITION_TEST_ONLY.createStagedMutationSelectedCandidatePublisher({
        assertRuntimePublicationAllowed: () => undefined,
        baseDurableAuthority: values.base.durableAuthority,
        createMaterializationAuthority,
        releasePublicationResources,
        staged: Object.freeze({ commitPayload: values.commit }),
        stagedSuccessor,
      });

      publisher.abandon();
      publisher.abandon();

      expect(createMaterializationAuthority).not.toHaveBeenCalled();
      expect(releasePublicationResources).toHaveBeenCalledOnce();
    });

    it("keeps a staged Commit retryable when physical materialization append fails", async () => {
      const { stagedSuccessor, values } = stagedPublisherFixture();
      const appendFailure = new Error("Commit append failed before candidate materialization");
      const abandons: ReturnType<typeof vi.fn>[] = [];
      const appendCandidate = vi.fn()
        .mockRejectedValueOnce(appendFailure)
        .mockResolvedValueOnce(Object.freeze({
          commitHomeRef: values.commitReference,
          commitPayload: values.commit,
        }));
      const createMaterializationAuthority = vi.fn(async () => {
        const abandon = vi.fn();
        abandons.push(abandon);
        return {
          abandon,
          appendCandidate,
          detachPreparedCandidatePublication: ({ candidate }: {
            candidate: Readonly<{ commitHomeRef: HomeRecordReference; commitPayload: FileSystemCommitPayload }>;
          }) => ({
            abandon: vi.fn(),
            completeWorkingAcceptance: vi.fn(),
            completeExternallyResolvedPublication: vi.fn(),
            publishCandidate: async ({ beforeFirstAuthorityWrite }: { beforeFirstAuthorityWrite: () => void }) => {
              beforeFirstAuthorityWrite();
              return {
                commitHomeRef: candidate.commitHomeRef,
                superblock: values.superblock({ copyState: "normal" }),
              };
            },
            resolvePublication: vi.fn(),
          }),
          publishCandidate: vi.fn(),
        };
      });
      const publisher = COMPOSITION_TEST_ONLY.createStagedMutationSelectedCandidatePublisher({
        assertRuntimePublicationAllowed: () => undefined,
        baseDurableAuthority: values.base.durableAuthority,
        createMaterializationAuthority,
        staged: Object.freeze({ commitPayload: values.commit }),
        stagedSuccessor,
      });

      const firstAttempt = createMaterializationAttemptReceipt();
      await expect(publisher.publish({
        onCandidateMaterialized: vi.fn(),
        onMaterializationAppendAttempt: ({ frameBytes }) => {
          expect(frameBytes).toBe(STAGED_MUTATION_COMMIT_MATERIALIZATION_FRAME_BYTES);
          return firstAttempt;
        },
      })).resolves.toEqual({
        cause: appendFailure,
        refreshedDurableAuthority: values.base.durableAuthority,
        type: "not_published",
      });
      expect(firstAttempt.fail).toHaveBeenCalledOnce();
      expect(firstAttempt.completeReusableCandidate).not.toHaveBeenCalled();
      expect(abandons[0]).toHaveBeenCalledOnce();

      const secondAttempt = createMaterializationAttemptReceipt();
      await expect(publisher.publish({
        onCandidateMaterialized: vi.fn(),
        onMaterializationAppendAttempt: ({ frameBytes }) => {
          expect(frameBytes).toBe(STAGED_MUTATION_COMMIT_MATERIALIZATION_FRAME_BYTES);
          return secondAttempt;
        },
      })).resolves.toMatchObject({
        type: "published",
      });
      expect(secondAttempt.completeReusableCandidate).toHaveBeenCalledOnce();
      expect(secondAttempt.fail).not.toHaveBeenCalled();
      expect(createMaterializationAuthority).toHaveBeenCalledTimes(2);
      expect(appendCandidate).toHaveBeenCalledTimes(2);
    });

    it("refuses materialization before Commit append when resource risk cannot be reserved", async () => {
      const { stagedSuccessor, values } = stagedPublisherFixture();
      const appendCandidate = vi.fn(async () => Object.freeze({
        commitHomeRef: values.commitReference,
        commitPayload: values.commit,
      }));
      const materializationAuthorityAbandon = vi.fn();
      const publisher = COMPOSITION_TEST_ONLY.createStagedMutationSelectedCandidatePublisher({
        assertRuntimePublicationAllowed: () => undefined,
        baseDurableAuthority: values.base.durableAuthority,
        createMaterializationAuthority: async () => ({
          abandon: materializationAuthorityAbandon,
          appendCandidate,
          detachPreparedCandidatePublication: vi.fn(),
          publishCandidate: vi.fn(),
        }),
        staged: Object.freeze({ commitPayload: values.commit }),
        stagedSuccessor,
      });
      const resourceFailure = new Error("materialization risk exceeds dirty resource limit");

      await expect(publisher.publish({
        onCandidateMaterialized: vi.fn(),
        onMaterializationAppendAttempt: ({ frameBytes }) => {
          expect(frameBytes).toBe(STAGED_MUTATION_COMMIT_MATERIALIZATION_FRAME_BYTES);
          throw resourceFailure;
        },
      })).resolves.toEqual({
        cause: resourceFailure,
        refreshedDurableAuthority: values.base.durableAuthority,
        type: "not_published",
      });
      expect(appendCandidate).not.toHaveBeenCalled();
      expect(materializationAuthorityAbandon).toHaveBeenCalledOnce();
    });

    it("reuses one materialized Commit across a definitely-not-published retry", async () => {
      const { stagedSuccessor, values } = stagedPublisherFixture();
      const appendCandidate = vi.fn(async () => Object.freeze({
        commitHomeRef: values.commitReference,
        commitPayload: values.commit,
      }));
      const preAuthorityFailure = new Error("publication gate failed before authority write");
      const publishCandidate = vi.fn()
        .mockRejectedValueOnce(preAuthorityFailure)
        .mockImplementationOnce(async ({ beforeFirstAuthorityWrite, candidate }) => {
          beforeFirstAuthorityWrite();
          return {
            commitHomeRef: candidate.commitHomeRef,
            superblock: values.superblock({ copyState: "normal" }),
          };
        });
      const publisher = COMPOSITION_TEST_ONLY.createStagedMutationSelectedCandidatePublisher({
        assertRuntimePublicationAllowed: () => undefined,
        baseDurableAuthority: values.base.durableAuthority,
        createMaterializationAuthority: async () => ({
          abandon: vi.fn(),
          appendCandidate,
          detachPreparedCandidatePublication: ({ candidate }) => ({
            abandon: vi.fn(),
            completeWorkingAcceptance: vi.fn(),
            completeExternallyResolvedPublication: vi.fn(),
            publishCandidate: request => publishCandidate({ ...request, candidate }),
            resolvePublication: vi.fn(),
          }),
          publishCandidate: vi.fn(),
        }),
        staged: Object.freeze({ commitPayload: values.commit }),
        stagedSuccessor,
      });

      await expect(publisher.publish({
        onCandidateMaterialized: vi.fn(),
        onMaterializationAppendAttempt: () => createMaterializationAttemptReceipt(),
      })).resolves.toMatchObject({
        cause: preAuthorityFailure,
        type: "not_published",
      });
      await expect(publisher.publish({
        onCandidateMaterialized: vi.fn(),
        onMaterializationAppendAttempt: () => createMaterializationAttemptReceipt(),
      })).resolves.toMatchObject({
        type: "published",
      });
      expect(appendCandidate).toHaveBeenCalledOnce();
      expect(publishCandidate).toHaveBeenCalledTimes(2);
    });

    it("abandons an unreachable materialized Commit and stays retryable when runtime root binding fails", async () => {
      const { stagedSuccessor, values } = stagedPublisherFixture();
      const detachedAbandons: ReturnType<typeof vi.fn>[] = [];
      const appendCandidate = vi.fn(async () => Object.freeze({
        commitHomeRef: values.commitReference,
        commitPayload: values.commit,
      }));
      const createMaterializationAuthority = vi.fn(async () => {
        const detachedAbandon = vi.fn();
        detachedAbandons.push(detachedAbandon);
        return {
          abandon: vi.fn(),
          appendCandidate,
          detachPreparedCandidatePublication: ({ candidate }: {
            candidate: Readonly<{ commitHomeRef: HomeRecordReference; commitPayload: FileSystemCommitPayload }>;
          }) => ({
            abandon: detachedAbandon,
            completeWorkingAcceptance: vi.fn(),
            completeExternallyResolvedPublication: vi.fn(),
            publishCandidate: async ({ beforeFirstAuthorityWrite }: {
              beforeFirstAuthorityWrite: () => void;
            }) => {
              beforeFirstAuthorityWrite();
              return {
                commitHomeRef: candidate.commitHomeRef,
                superblock: values.superblock({ copyState: "normal" }),
              };
            },
            resolvePublication: vi.fn(),
          }),
          publishCandidate: vi.fn(),
        };
      });
      const publisher = COMPOSITION_TEST_ONLY.createStagedMutationSelectedCandidatePublisher({
        assertRuntimePublicationAllowed: () => undefined,
        baseDurableAuthority: values.base.durableAuthority,
        createMaterializationAuthority,
        staged: Object.freeze({ commitPayload: values.commit }),
        stagedSuccessor,
      });
      const rootFailure = new Error("maintenance root limit reached");

      await expect(publisher.publish({
        onCandidateMaterialized: () => {
          throw rootFailure;
        },
        onMaterializationAppendAttempt: () => createMaterializationAttemptReceipt(),
      })).resolves.toEqual({
        cause: rootFailure,
        refreshedDurableAuthority: values.base.durableAuthority,
        type: "not_published",
      });
      expect(detachedAbandons[0]).toHaveBeenCalledOnce();

      await expect(publisher.publish({
        onCandidateMaterialized: vi.fn(),
        onMaterializationAppendAttempt: () => createMaterializationAttemptReceipt(),
      })).resolves.toMatchObject({ type: "published" });
      expect(createMaterializationAuthority).toHaveBeenCalledTimes(2);
      expect(appendCandidate).toHaveBeenCalledTimes(2);
    });
  });

  describe("prepared mutation selected-candidate publisher", () => {
    it("publishes the exact detached candidate and returns a durable successor", async () => {
      const values = selectedCandidatePublisherFixture();
      const resolvePublication = vi.fn();
      const prepared = selectedCandidatePublisherDeferred({
        publishCandidate: async ({ beforeFirstAuthorityWrite, candidate }) => {
          beforeFirstAuthorityWrite();
          return { commitHomeRef: candidate.commitHomeRef, superblock: values.superblock({ copyState: "normal" }) };
        },
        resolvePublication,
      });
      const assertRuntimePublicationAllowed = vi.fn();

      const onCandidateMaterialized = vi.fn();
      const outcome = await COMPOSITION_TEST_ONLY.createPreparedMutationSelectedCandidatePublisher({
        assertRuntimePublicationAllowed,
        base: values.base,
        deferred: prepared,
        successor: values.successor,
      }).publish({
        onCandidateMaterialized,
        onMaterializationAppendAttempt: () => createMaterializationAttemptReceipt(),
      });

      expect(outcome).toMatchObject({ type: "published" });
      if (outcome.type !== "published") {
        throw new Error("expected published outcome");
      }
      expect(outcome.durableSuccessor.workingIdentity).toBe(values.successor.workingIdentity);
      expect(outcome.durableSuccessor.durableAuthority.identity.commitSequence).toBe(values.commit.commitSequence);
      expect(onCandidateMaterialized).toHaveBeenCalledWith({
        candidateDurableIdentity: createDurableGenerationIdentity({
          commitReference: values.commitReference,
          commitSequence: values.commit.commitSequence,
          mutationId: values.commit.mutationId,
        }),
      });
      expect(assertRuntimePublicationAllowed).toHaveBeenCalledTimes(2);
      expect(resolvePublication).not.toHaveBeenCalled();
    });

    it("classifies a final runtime gate rejection as definitely not published", async () => {
      const values = selectedCandidatePublisherFixture();
      const gateFailure = new Error("runtime authority changed");
      const prepared = selectedCandidatePublisherDeferred({
        publishCandidate: async ({ beforeFirstAuthorityWrite }) => {
          beforeFirstAuthorityWrite();
          throw new Error("unreachable");
        },
        resolvePublication: vi.fn(),
      });
      let gateCount = 0;
      const outcome = await COMPOSITION_TEST_ONLY.createPreparedMutationSelectedCandidatePublisher({
        assertRuntimePublicationAllowed: () => {
          gateCount += 1;
          if (gateCount === 2) {
            throw gateFailure;
          }
        },
        base: values.base,
        deferred: prepared,
        successor: values.successor,
      }).publish({
        onCandidateMaterialized: vi.fn(),
        onMaterializationAppendAttempt: () => createMaterializationAttemptReceipt(),
      });

      expect(outcome).toEqual({
        cause: gateFailure,
        refreshedDurableAuthority: values.base.durableAuthority,
        type: "not_published",
      });
      expect(prepared.abandon).not.toHaveBeenCalled();
    });

    it("rereads authority and keeps the working candidate on a not-published failure", async () => {
      const values = selectedCandidatePublisherFixture();
      const publicationFailure = new PreparedMutationCommitPublicationError({
        cause: new Error("write failed"),
        commitHomeRef: values.commitReference,
        commitPayload: values.commit,
        intendedLogicalState: values.intendedLogicalState,
      });
      const publishCandidate = vi.fn().mockRejectedValueOnce(publicationFailure).mockResolvedValueOnce({
        commitHomeRef: values.commitReference,
        superblock: values.superblock({ copyState: "normal" }),
      });
      const prepared = selectedCandidatePublisherDeferred({
        publishCandidate,
        resolvePublication: async () => ({ superblock: values.base.superblock, type: "not_published" }),
      });
      const publisher = COMPOSITION_TEST_ONLY.createPreparedMutationSelectedCandidatePublisher({
        assertRuntimePublicationAllowed: () => undefined,
        base: values.base,
        deferred: prepared,
        successor: values.successor,
      });

      const outcome = await publisher.publish({
        onCandidateMaterialized: vi.fn(),
        onMaterializationAppendAttempt: () => createMaterializationAttemptReceipt(),
      });
      expect(outcome).toMatchObject({ cause: publicationFailure, type: "not_published" });
      await expect(publisher.publish({
        onCandidateMaterialized: vi.fn(),
        onMaterializationAppendAttempt: () => createMaterializationAttemptReceipt(),
      })).resolves.toMatchObject({ type: "published" });
      expect(publishCandidate).toHaveBeenCalledTimes(2);
    });

    it("reports a conflicting authority as outcome unknown", async () => {
      const values = selectedCandidatePublisherFixture();
      const publicationFailure = new PreparedMutationCommitPublicationError({
        cause: new Error("write failed"),
        commitHomeRef: values.commitReference,
        commitPayload: values.commit,
        intendedLogicalState: values.intendedLogicalState,
      });
      const prepared = selectedCandidatePublisherDeferred({
        publishCandidate: async () => {
          throw publicationFailure;
        },
        resolvePublication: async () => ({ superblock: values.base.superblock, type: "publication_conflict" }),
      });

      await expect(COMPOSITION_TEST_ONLY.createPreparedMutationSelectedCandidatePublisher({
        assertRuntimePublicationAllowed: () => undefined,
        base: values.base,
        deferred: prepared,
        successor: values.successor,
      }).publish({
        onCandidateMaterialized: vi.fn(),
        onMaterializationAppendAttempt: () => createMaterializationAttemptReceipt(),
      })).resolves.toMatchObject({ type: "outcome_unknown" });
    });

    it("does not acknowledge a published authority until both Superblock copies converge", async () => {
      const values = selectedCandidatePublisherFixture();
      const publicationFailure = new PreparedMutationCommitPublicationError({
        cause: new Error("second copy failed"),
        commitHomeRef: values.commitReference,
        commitPayload: values.commit,
        intendedLogicalState: values.intendedLogicalState,
      });
      const prepared = selectedCandidatePublisherDeferred({
        publishCandidate: async () => {
          throw publicationFailure;
        },
        resolvePublication: async () => ({
          superblock: values.superblock({ copyState: "superblock_redundancy_degraded" }),
          type: "published",
        }),
      });

      await expect(COMPOSITION_TEST_ONLY.createPreparedMutationSelectedCandidatePublisher({
        assertRuntimePublicationAllowed: () => undefined,
        base: values.base,
        deferred: prepared,
        successor: values.successor,
      }).publish({
        onCandidateMaterialized: vi.fn(),
        onMaterializationAppendAttempt: () => createMaterializationAttemptReceipt(),
      })).resolves.toMatchObject({ type: "outcome_unknown" });
    });
  });
});

export const TEST_ONLY = {};
