import { createHash } from "node:crypto";
import nonemptyContainerPortable from "./test-fixtures/nonempty-container-portable-v1.json";
import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createFeatureBits,
  createHomeRecordReference,
  createPhysicalRecordReference,
  createSubvolumeId,
  createTimestampMilliseconds,
  createUInt64,
  createUnlockSequence,
  parseFileSystemId,
  parseMutationId,
  parseSegmentId,
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
} from "@/00-storage/service/hizofs/authenticated-store/empty-container-store";
import { createInitialUnlockEnvelopeCopies } from "@/00-storage/service/hizofs/authenticated-store/unlock-envelope-store";
import { createAuthenticatedMetadataMutationAuthority } from "@/00-storage/service/hizofs/authenticated-store/metadata-mutation-authority";
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
import { InMemoryCrossRealmLockPort } from "@/00-storage/service/hizofs/runtime/testing/in-memory-cross-realm-lock-port";
import {
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
      writerDependencyRoots: [],
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

function runtimeHost(): HizoFSWorkerRuntimeHost {
  return new HizoFSWorkerRuntimeHost({
    crossRealmLockPort: new InMemoryCrossRealmLockPort(),
    policy: {
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
    runtimeHost: runtimeHost(),
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
      recheckGenerationAuthority: async () => undefined,
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
    knownInodeNumbers: [baseCommitRoot.rootDirectoryInode.inodeNumber],
    mutationId: parseMutationId({ bytes: new Uint8Array(16).fill(23) }),
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
    await expect(session.root.getFileHandle({ create: true, name: "blocked.bin" }))
      .rejects.toThrow("generation is read-only");
    expect(opened.rootKey.isDestroyed()).toBe(false);

    await session.close();
    expect(opened.rootKey.isDestroyed()).toBe(true);
  });

  it("registers the base Commit as an ordinary mutation writer dependency", async () => {
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
    const acquireWriterDependencyRoot = host.acquireWriterDependencyRoot.bind(host);
    const deferredReleases: (() => void)[] = [];
    let delegatedReleaseCalls = 0;
    const acquisition = vi.spyOn(host, "acquireWriterDependencyRoot").mockImplementation(({ commitReference }) => {
      const registration = acquireWriterDependencyRoot({ commitReference });
      return {
        ...registration,
        release: () => {
          delegatedReleaseCalls += 1;
          deferredReleases.push(registration.release);
        },
      };
    });
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
        recheckGenerationAuthority: async () => undefined,
        rootSubvolumeId: createSubvolumeId({ value: 1n }),
        supportedFeatureBits,
        writableProfile: "release-qualified",
      }),
    });

    await session.root.getDirectoryHandle({ create: true, name: "docs" });

    expect(acquisition).toHaveBeenCalledOnce();
    expect(acquisition).toHaveBeenCalledWith({
      commitReference: opened.superblock.logicalState.activeCommitHomeRef,
    });
    expect(delegatedReleaseCalls).toBe(1);
    const held = await host.beginMaintenanceRootCapture();
    expect(held.writerDependencyRoots).toEqual([
      opened.superblock.logicalState.activeCommitHomeRef,
    ]);
    held.release();
    await held.released;

    expect(deferredReleases).toHaveLength(1);
    deferredReleases[0]?.();
    const cleared = await host.beginMaintenanceRootCapture();
    expect(cleared.writerDependencyRoots).toEqual([]);
    cleared.release();
    await cleared.released;

    await session.close();
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
    const acquireWriterDependencyRoot = host.acquireWriterDependencyRoot.bind(host);
    const releaseFailure = new Error("writer dependency release failed");
    vi.spyOn(host, "acquireWriterDependencyRoot").mockImplementation(({ commitReference }) => {
      const registration = acquireWriterDependencyRoot({ commitReference });
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
        recheckGenerationAuthority: async () => undefined,
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
    expect(capture.writerDependencyRoots).toEqual([]);
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
    const host = runtimeHost();
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
        recheckGenerationAuthority: async () => undefined,
        rootSubvolumeId: createSubvolumeId({ value: 1n }),
        supportedFeatureBits,
        writableProfile: "release-qualified",
      }),
    });
    const file = await session.root.getFileHandle({ create: true, name: "prepared.bin" });
    const acquireWriterDependencyRoot = host.acquireWriterDependencyRoot.bind(host);
    const observedRoots: Parameters<typeof acquireWriterDependencyRoot>[0]["commitReference"][] = [];
    const deferredReleases: (() => void)[] = [];
    let delegatedReleaseCalls = 0;
    const acquisition = vi.spyOn(host, "acquireWriterDependencyRoot").mockImplementation(({ commitReference }) => {
      observedRoots.push(commitReference);
      const registration = acquireWriterDependencyRoot({ commitReference });
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
    expect(retainedAfterCommit.writerDependencyRoots).toEqual([observedRoots[0]]);
    retainedAfterCommit.release();
    await retainedAfterCommit.released;
    deferredReleases.shift()?.();
    const clearedAfterCommit = await host.beginMaintenanceRootCapture();
    expect(clearedAfterCommit.writerDependencyRoots).toEqual([]);
    clearedAfterCommit.release();
    await clearedAfterCommit.released;

    const aborted = await file.createWritable({ keepExistingData: true });
    expect(acquisition).toHaveBeenCalledTimes(2);
    expect(delegatedReleaseCalls).toBe(1);
    await aborted.abort({ reason: "test abort" });
    expect(delegatedReleaseCalls).toBe(2);
    const retainedAfterAbort = await host.beginMaintenanceRootCapture();
    expect(retainedAfterAbort.writerDependencyRoots).toEqual([observedRoots[1]]);
    retainedAfterAbort.release();
    await retainedAfterAbort.released;
    deferredReleases.shift()?.();
    const clearedAfterAbort = await host.beginMaintenanceRootCapture();
    expect(clearedAfterAbort.writerDependencyRoots).toEqual([]);
    clearedAfterAbort.release();
    await clearedAfterAbort.released;

    await session.close();
    expect(opened.rootKey.isDestroyed()).toBe(true);
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
    const host = runtimeHost();
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
        recheckGenerationAuthority: async () => undefined,
        rootSubvolumeId: createSubvolumeId({ value: 1n }),
        supportedFeatureBits,
        writableProfile: "release-qualified",
      }),
    });
    const file = await session.root.getFileHandle({ create: true, name: "poisoned.bin" });
    const acquireWriterDependencyRoot = host.acquireWriterDependencyRoot.bind(host);
    const releaseFailure = new Error("prepared writable root release failed");
    vi.spyOn(host, "acquireWriterDependencyRoot").mockImplementation(({ commitReference }) => {
      const registration = acquireWriterDependencyRoot({ commitReference });
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
    expect(capture.writerDependencyRoots).toEqual([]);
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
        recheckGenerationAuthority: async ({ commit, superblock }) => {
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
    expect(authorityRechecks).toBe(4);

    await session.close();
    expect(opened.rootKey.isDestroyed()).toBe(true);

    const reopened = await openEmptyEncryptedContainer({
      backend,
      passphrase,
      supportedFeatureBits,
    });
    try {
      expect(reopened.commit.commitSequence).toBe(4n);
      const resources = createAuthenticatedApplicationReadSessionResources({ backend, opened: reopened });
      try {
        await expect(resources.namespace.stat({ pathComponents: ["docs"] })).rejects.toThrow();
      } finally {
        await resources.releaseResources();
      }
    } finally {
      if (!reopened.rootKey.isDestroyed()) reopened.rootKey.destroy();
    }
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
        recheckGenerationAuthority: async () => undefined,
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
    await writable.truncate({ size: sparseOffset + 1 });
    await writable.close();

    expect(await file.stat()).toMatchObject({ size: sparseOffset + 1 });
    const readable = await file.openReadable({ mimeType: "application/octet-stream" });
    const bytes = new Uint8Array(sparseOffset + 1);
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

    const aborted = await file.createWritable({ keepExistingData: true });
    await aborted.write({ data: Uint8Array.of(255), position: 0 });
    await aborted.abort({ reason: "test abort" });
    expect(await file.stat()).toMatchObject({ size: sparseOffset + 1 });

    await session.close();
    expect(opened.rootKey.isDestroyed()).toBe(true);

    const reopened = await openEmptyEncryptedContainer({
      backend,
      passphrase,
      supportedFeatureBits,
    });
    try {
      expect(reopened.commit.commitSequence).toBe(3n);
      const resources = createAuthenticatedApplicationReadSessionResources({ backend, opened: reopened });
      try {
        const persisted = await resources.namespace.readFile({
          length: BigInt(sparseOffset + 1),
          offset: 0n,
          pathComponents: ["sparse.bin"],
        });
        expect(new TextDecoder().decode(persisted.subarray(0, 6))).toBe("abZZef");
        expect(persisted.subarray(6, sparseOffset).every(byte => byte === 0)).toBe(true);
        expect(persisted[sparseOffset]).toBe("X".charCodeAt(0));
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
        recheckGenerationAuthority: async () => undefined,
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
        recheckGenerationAuthority: async () => undefined,
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
    await session.close();
    expect(opened.rootKey.isDestroyed()).toBe(true);

    const reopened = await openEmptyEncryptedContainer({
      backend,
      passphrase,
      supportedFeatureBits,
    });
    try {
      // Seven durable mutations: two directories, two files, one move, nested directory, and final file.
      expect(reopened.commit.commitSequence).toBe(8n);
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
        recheckGenerationAuthority: async () => undefined,
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
        recheckGenerationAuthority: async () => undefined,
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
        recheckGenerationAuthority: async () => undefined,
        rootSubvolumeId: createSubvolumeId({ value: 1n }),
        supportedFeatureBits,
        writableProfile: "release-qualified",
      }),
    });
    if (!(session instanceof HizoFSStorageFileSystemSession)) {
      throw new Error("expected concrete HizoFS application session");
    }

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
    const session = await openAuthenticatedDevelopmentWritableApplicationSessionFromCapability({
      authority: capability.authority,
      canonicalBackingLocation: "memory://credential-update.hizofs",
      recheckAuthority: async () => {
        transferRechecks += 1;
      },
      rootName: "credential-update.hizofs",
      runtimeHost: runtimeHost(),
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
  });

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

      const file = await runtime.session.root.getFileHandle({ create: true, name: "measured.bin" });
      const bytes = new Uint8Array(HIZOFS_V1_FORMAT_CONSTANTS.limits.inlineFileBytes + 32).fill(73);
      const writable = await file.createWritable({ keepExistingData: false });
      await writable.write({ data: bytes, position: 0 });
      await writable.close();
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
        .toBe(publicationsBeforeBulkTarget + 1);
      expect(afterBulkTarget.phases.index_build.operationCount)
        .toBe(indexBuildsBeforeBulkTarget);
      await bulk.createEmptyFile({ name: "bulk-a" });
      await bulk.createEmptyFile({ name: "bulk-b" });
      await bulk.commit();
      const afterBulkCommit = runtime.snapshotRuntimeDiagnostics();
      expect(afterBulkCommit.phases.commit_publication.operationCount)
        .toBe(afterBulkTarget.phases.commit_publication.operationCount + 1);
      expect(afterBulkCommit.phases.index_build.operationCount)
        .toBeGreaterThan(afterBulkTarget.phases.index_build.operationCount);
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
    const underlying: HizoFSDevelopmentWritableBackend<AuthenticatedHizoFSPhysicalBytes> = {
      capabilities: { directoryEntryDurability: "not-demonstrated", fileDataDurability: "not-demonstrated" },
      closeFile: async () => undefined,
      createDirectoryExclusive: async () => undefined,
      createFileExclusive: async () => file,
      getFileSize: async () => 0n,
      list: async () => [],
      openFileForUpdate: async () => file,
      readExact: async () => new Uint8Array() as AuthenticatedHizoFSPhysicalBytes,
      readExactWithFileSize: async () => ({
        bytes: new Uint8Array() as AuthenticatedHizoFSPhysicalBytes,
        fileSize: 0n,
      }),
      readFileBounded: async () => new Uint8Array() as AuthenticatedHizoFSPhysicalBytes,
      removeFile: async () => undefined,
      syncDirectoryEntries: async () => undefined,
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
    await backend.openFileForUpdate({ path });
    await backend.getFileSize({ path });
    await backend.readExact({ length: 0, offset: 0n, path });
    await backend.readExactWithFileSize({ length: 0, offset: 0n, path });
    await backend.readFileBounded({ maximumByteLength: 0, path });
    await backend.writeAt({ bytes: new Uint8Array() as AuthenticatedHizoFSPhysicalBytes, file, offset: 0n });
    await backend.truncate({ file, length: 0n });
    await backend.syncFileData({ file });
    await backend.closeFile({ file });
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
    expect(physical).toHaveLength(13);
    expect(diagnostics.snapshot().phases.physical_get_file_size).toEqual({ operationCount: 3, totalDurationMs: 3 });
    expect(diagnostics.snapshot().phases.physical_read_exact).toEqual({ operationCount: 4, totalDurationMs: 4 });
    for (const [phase, counter] of physical) {
      if (phase === "physical_get_file_size" || phase === "physical_read_exact") continue;
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
        runtimeHost: { beginMaintenanceRootCapture: async () => gate.capture },
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
        runtimeHost: { beginMaintenanceRootCapture: async () => gate.capture },
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
        runtimeHost: { beginMaintenanceRootCapture: async () => gate.capture },
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
        runtimeHost: { beginMaintenanceRootCapture: async () => gate.capture },
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
          writerDependencyRoots: [],
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
          beginMaintenanceRootCapture: async () => maintenanceRuntimeCapture({ pinned: [pinned] }).capture,
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
          beginMaintenanceRootCapture: async () => maintenanceRuntimeCapture({ epoch: 4, pinned: [] }).capture,
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
          beginMaintenanceRootCapture: async () => maintenanceRuntimeCapture({ epoch: 4, pinned: [] }).capture,
          beginSegmentDeletion,
        },
      });

      expect(validation).toEqual({ reason: "candidate_changed", valid: false });
      expect(beginSegmentDeletion).not.toHaveBeenCalled();
    });
  });

  it("recreates the exact non-empty portable container bytes", async () => {
    const backend = await createNonemptyPortableFixtureBackend();
    expect(nonemptyContainerPortable).toMatchObject({
      fileSystemId: "57XP043891T62-modnaes",
      passphrase: "correct horse battery staple",
      schema: "hizofs-v1-nonempty-container-fixture",
      schemaVersion: 1,
    });
    expect(await collectPortableContainerFiles({
      backend,
      directory: CANONICAL_CONTAINER_ROOT,
    })).toEqual(nonemptyContainerPortable.files);
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

});

export const TEST_ONLY = {};
