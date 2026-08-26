import {
  createFeatureBits,
  createSubvolumeId,
  createTimestampMilliseconds,
  type CredentialSlotId,
  type FeatureBits,
  type FileSystemId,
  type UnlockSequence,
} from "@/00-storage/service/hizofs/00-format";
import type { FileSystemRootKey, RandomByteSource } from "@/00-storage/service/hizofs/01-crypto";
import {
  createEmptyEncryptedContainer,
  openEmptyEncryptedContainer,
  openEmptyEncryptedContainerWithRootKey,
  type OpenedEmptyEncryptedContainer,
} from "@/00-storage/service/hizofs/authenticated-store/empty-container-store";
import type { AuthenticatedHizoFSPhysicalBytes } from "@/00-storage/service/hizofs/authenticated-store/physical-bytes";
import type { HizoFSDevelopmentWritableBackend, HizoFSPhysicalWriteBackend } from "@/00-storage/service/hizofs/physical-store/backend";
import { InMemoryCrashDurabilityBackend } from "@/00-storage/service/hizofs/physical-store/testing/in-memory-crash-durability-backend";
import type { DeterministicPhysicalStoreFaultInjector } from "@/00-storage/service/hizofs/physical-store/testing/deterministic-fault-injector";
import { createContainerCoordinationScope, parseContainerCoordinationScopeToken } from "@/00-storage/service/hizofs/runtime/container-coordination-scope";
import { DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY } from "@/00-storage/service/hizofs/runtime/runtime-policy";
import { InMemoryCrossRealmLockPort } from "@/00-storage/service/hizofs/runtime/testing/in-memory-cross-realm-lock-port";
import type { StorageDirectoryHandle, StorageFileSystemSession } from "@/00-storage/service/storage-file-system/types";
import {
  openAuthenticatedDevelopmentWritableApplicationSessionFromCapability,
  openAuthenticatedDevelopmentWritableContainerCapability,
  openAuthenticatedReadOnlyApplicationSession,
  openAuthenticatedReadOnlyContainerAuthority,
  openAuthenticatedReadWriteApplicationSession,
  replaceAuthenticatedDevelopmentWritableSessionPassphrase,
} from "@/00-storage/service/hizofs/worker/composition-root";
import { HizoFSWorkerRuntimeHost } from "@/00-storage/service/hizofs/worker/runtime-host";
import type { HizoFSV1ObservableEntry, HizoFSV1ObservableState } from "@/00-storage/service/hizofs/v1-format-tests/model/reference-filesystem-model";
import { compareObservableNamesByUtf8 } from "@/00-storage/service/hizofs/v1-format-tests/model/observable-state-order";
import type { HizoFSV1FormatScenario, HizoFSV1FormatScenarioOperation } from "@/00-storage/service/hizofs/v1-format-tests/scenarios/scenario-types";
import { exactObject } from "@/utils/exact-object";
import {
  restoreFrozenPortableContainer,
  restoreFrozenPortableContainerIntoBackend,
  validateFrozenPortableContainerFixture,
} from "@/00-storage/service/hizofs/v1-format-tests/support/portable-container";

const SUPPORTED_FEATURE_BITS = createFeatureBits({ value: 0n });
const DEFAULT_PASSPHRASE = "correct horse battery staple";

function deterministicRandomSource(): RandomByteSource {
  // Keep fixture/test execution reproducible without making random-request count or ordering a V1 contract.
  // A long-period stream matters here because large namespace scenarios legitimately consume many persisted nonces.
  let state = 0x6d2b79f5;
  return ({ bytes }) => {
    for (let index = 0; index < bytes.byteLength; index += 1) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      bytes[index] = state >>> 24;
    }
  };
}

function runtimeHost(): HizoFSWorkerRuntimeHost {
  return new HizoFSWorkerRuntimeHost({
    crossRealmLockPort: new InMemoryCrossRealmLockPort(),
    policy: {
      lazyDurability: { ...DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY, publicationModeRequest: "immediate" },
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

type CredentialWritableScenarioSession = Readonly<{
  backend: InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>;
  fileSystemId: string;
  flushAndCaptureCleanGeneration: () => Promise<void>;
  releaseResources: () => Promise<void>;
  session: StorageFileSystemSession;
}>;

async function openCredentialWritableScenarioSessionFromBackend({ backend, fileSystemId, passphrase }: {
  backend: InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>;
  fileSystemId: string;
  passphrase: string;
}): Promise<CredentialWritableScenarioSession> {
  const capability = await openAuthenticatedDevelopmentWritableContainerCapability({
    backend: developmentBackend({ backend }),
    passphrase,
    verifyProofAuthority: async () => undefined,
  });
  const openedCapability = (() => {
    switch (capability.type) {
    case "opened": return capability;
    case "credential_rejected": throw new Error("credential was rejected while opening the V1 test container");
    default: return capability satisfies never;
    }
  })();
  const host = runtimeHost();
  const session = await openAuthenticatedDevelopmentWritableApplicationSessionFromCapability({
    authority: openedCapability.authority,
    canonicalBackingLocation: "memory://hizofs-v1-format-credential-lifecycle.hizofs",
    recheckAuthority: async () => undefined,
    rootName: "hizofs-v1-format-credential-lifecycle.hizofs",
    runtimeHost: host,
  });
  return {
    backend,
    fileSystemId,
    flushAndCaptureCleanGeneration: async () => {
      const barrier = host.openManagementCleanHeadBarrier({});
      try {
        await barrier.flushAndCaptureCleanGeneration();
      } finally {
        barrier.release();
      }
    },
    releaseResources: openedCapability.releaseResources,
    session,
  };
}

export async function createCredentialWritableScenarioSession({ passphrase }: {
  passphrase: string;
}): Promise<CredentialWritableScenarioSession> {
  const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
  const created = await createEmptyEncryptedContainer({
    backend,
    passphrase,
    randomSource: deterministicRandomSource(),
    supportedFeatureBits: SUPPORTED_FEATURE_BITS,
  });
  const fileSystemId = created.fileSystemId;
  created.rootKey.destroy();
  return await openCredentialWritableScenarioSessionFromBackend({ backend, fileSystemId, passphrase });
}

export async function openFrozenFixtureCredentialWritableScenarioSession({ fixtureJson, faultInjector }: {
  faultInjector?: DeterministicPhysicalStoreFaultInjector;
  fixtureJson: unknown;
}): Promise<CredentialWritableScenarioSession & Readonly<{ passphrase: string }>> {
  const fixture = validateFrozenPortableContainerFixture({ fixture: fixtureJson });
  const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({ faultInjector });
  await restoreFrozenPortableContainerIntoBackend({ backend, fixture });
  return {
    ...await openCredentialWritableScenarioSessionFromBackend({
      backend,
      fileSystemId: fixture.fileSystemId,
      passphrase: fixture.passphrase,
    }),
    passphrase: fixture.passphrase,
  };
}

export async function replaceCredentialWritableScenarioPassphrase({ replacementPassphrase, session }: {
  replacementPassphrase: string;
  session: StorageFileSystemSession;
}): Promise<void> {
  await replaceAuthenticatedDevelopmentWritableSessionPassphrase({
    recheckAuthority: async () => undefined,
    replacementPassphrase,
    session,
  });
}

type WritableScenarioSession = Readonly<{
  backend: InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>;
  fileSystemId: string;
  passphrase: string;
  session: StorageFileSystemSession;
}>;

async function openWritableScenarioSessionFromOpened({ backend, opened, randomSource }: {
  backend: InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>;
  opened: OpenedEmptyEncryptedContainer;
  randomSource: RandomByteSource;
}): Promise<StorageFileSystemSession> {
  let nextTimestamp = 1_700_000_000_000n;
  return await openAuthenticatedReadWriteApplicationSession({
    captureAuthority: async () => ({ revision: 1 }),
    recheckAuthority: async () => undefined,
    runtimeHost: runtimeHost(),
    verifyCapturedAuthority: async () => ({
      backend,
      canonicalBackingLocation: "memory://hizofs-v1-format-tests.hizofs",
      explicitBulkLimits: {
        candidate: { maxEntries: 128, maxInlineFileBytesTotal: 1024 * 1024 },
        directoryImport: { maximumEntryMutationsPerBatch: 32 },
      },
      fileMutationLimits: { maximumExtentMutationsPerBatch: 32 },
      opened,
      operationTimestamp: () => {
        const value = createTimestampMilliseconds({ value: nextTimestamp });
        nextTimestamp += 1n;
        return value;
      },
      randomSource,
      removalLimits: { deleteBatchSize: 32 },
      recheckDurableGenerationAuthority: async () => undefined,
      rootSubvolumeId: createSubvolumeId({ value: 1n }),
      supportedFeatureBits: SUPPORTED_FEATURE_BITS,
      writableProfile: "release-qualified",
    }),
  });
}

async function createWritableScenarioSessionFromBackend({ backend }: {
  backend: InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>;
}): Promise<WritableScenarioSession> {
  const randomSource = deterministicRandomSource();
  const opened = await createEmptyEncryptedContainer({
    backend,
    passphrase: DEFAULT_PASSPHRASE,
    randomSource,
    supportedFeatureBits: SUPPORTED_FEATURE_BITS,
  });
  const session = await openWritableScenarioSessionFromOpened({ backend, opened, randomSource });
  return { backend, fileSystemId: opened.fileSystemId, passphrase: DEFAULT_PASSPHRASE, session };
}

export async function createWritableScenarioSession(): Promise<WritableScenarioSession> {
  return await createWritableScenarioSessionFromBackend({
    backend: new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({}),
  });
}

export async function openFrozenFixtureWritableScenarioSession({ fixtureJson }: {
  fixtureJson: unknown;
}): Promise<WritableScenarioSession> {
  const fixture = validateFrozenPortableContainerFixture({ fixture: fixtureJson });
  const backend = await restoreFrozenPortableContainer({ fixture });
  const randomSource = deterministicRandomSource();
  const opened = await openEmptyEncryptedContainer({
    backend,
    passphrase: fixture.passphrase,
    supportedFeatureBits: SUPPORTED_FEATURE_BITS,
  });
  const session = await openWritableScenarioSessionFromOpened({ backend, opened, randomSource });
  return {
    backend,
    fileSystemId: opened.fileSystemId,
    passphrase: fixture.passphrase,
    session,
  };
}

export async function openFaultCampaignWritableScenarioSession({
  backend,
  fileSystemId,
  rootKey,
  unlockingSlotId,
  unlockSequence,
}: {
  backend: InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>;
  fileSystemId: FileSystemId;
  rootKey: FileSystemRootKey;
  unlockingSlotId: CredentialSlotId;
  unlockSequence: UnlockSequence;
}): Promise<StorageFileSystemSession> {
  const opened = await openEmptyEncryptedContainerWithRootKey({
    backend,
    expectedUnlockSequence: unlockSequence,
    fileSystemId,
    rootKey,
    supportedFeatureBits: SUPPORTED_FEATURE_BITS,
    unlockingSlotId,
  });
  return await openWritableScenarioSessionFromOpened({
    backend,
    opened,
    randomSource: deterministicRandomSource(),
  });
}

export async function openFreshReadOnlySessionWithFeatureBits({
  backend,
  expectedFileSystemId,
  passphrase,
  supportedFeatureBits,
}: {
  backend: InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>;
  expectedFileSystemId: string | undefined;
  passphrase: string;
  supportedFeatureBits: FeatureBits;
}): Promise<StorageFileSystemSession> {
  const authority = await openAuthenticatedReadOnlyContainerAuthority({
    backend,
    passphrase,
    supportedFeatureBits,
    verifyProofAuthority: async ({ fileSystemId }) => {
      if (expectedFileSystemId !== undefined && fileSystemId !== expectedFileSystemId) {
        throw new Error(`unexpected fixture filesystem id: ${fileSystemId}`);
      }
    },
  });
  return await openAuthenticatedReadOnlyApplicationSession({
    captureAuthority: async () => ({ revision: 1 }),
    recheckAuthority: async () => undefined,
    runtimeHost: runtimeHost(),
    verifyCapturedAuthority: async () => authority,
  });
}

export async function openFreshReadOnlySession({ backend, expectedFileSystemId, passphrase }: {
  backend: InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>;
  expectedFileSystemId: string | undefined;
  passphrase: string;
}): Promise<StorageFileSystemSession> {
  return await openFreshReadOnlySessionWithFeatureBits({
    backend,
    expectedFileSystemId,
    passphrase,
    supportedFeatureBits: SUPPORTED_FEATURE_BITS,
  });
}

async function directoryAt({ root, path, create }: {
  create: boolean;
  path: readonly string[];
  root: StorageDirectoryHandle;
}): Promise<StorageDirectoryHandle> {
  let directory = root;
  for (const name of path) directory = await directory.getDirectoryHandle({ create, name });
  return directory;
}

async function applyOperation({ operation, root }: {
  operation: HizoFSV1FormatScenarioOperation;
  root: StorageDirectoryHandle;
}): Promise<void> {
  switch (operation.type) {
  case "mkdir": {
    const { path, type: _type, ...unhandled } = operation;
    unhandled satisfies Record<PropertyKey, never>;
    const parent = await directoryAt({ create: false, path: path.slice(0, -1), root });
    const name = path.at(-1);
    if (name === undefined) throw new TypeError("mkdir scenario path must not be empty");
    await parent.getDirectoryHandle({ create: true, name });
    return;
  }
  case "create_file": {
    const { path, type: _type, ...unhandled } = operation;
    unhandled satisfies Record<PropertyKey, never>;
    const parent = await directoryAt({ create: false, path: path.slice(0, -1), root });
    const name = path.at(-1);
    if (name === undefined) throw new TypeError("create-file scenario path must not be empty");
    await parent.getFileHandle({ create: true, name });
    return;
  }
  case "write_file": {
    const { bytes, path, type: _type, ...unhandled } = operation;
    unhandled satisfies Record<PropertyKey, never>;
    const parent = await directoryAt({ create: false, path: path.slice(0, -1), root });
    const name = path.at(-1);
    if (name === undefined) throw new TypeError("write scenario path must not be empty");
    const file = await parent.getFileHandle({ create: true, name });
    const writable = await file.createWritable({ keepExistingData: false });
    try {
      await writable.write({ data: bytes, position: 0 });
      await writable.close();
    } catch (cause: unknown) {
      await writable.abort({ reason: cause });
      throw cause;
    }
    return;
  }
  case "create_symlink": {
    const { path, target, type: _type, ...unhandled } = operation;
    unhandled satisfies Record<PropertyKey, never>;
    const parent = await directoryAt({ create: false, path: path.slice(0, -1), root });
    const name = path.at(-1);
    if (name === undefined) throw new TypeError("symlink scenario path must not be empty");
    await parent.createSymlink({ name, target });
    return;
  }
  case "write_file_at": {
    const { bytes, offset, path, type: _type, ...unhandled } = operation;
    unhandled satisfies Record<PropertyKey, never>;
    const parent = await directoryAt({ create: false, path: path.slice(0, -1), root });
    const name = path.at(-1);
    if (name === undefined) throw new TypeError("write-at scenario path must not be empty");
    const file = await parent.getFileHandle({ create: false, name });
    const writable = await file.createWritable({ keepExistingData: true });
    try {
      await writable.write({ data: bytes, position: offset });
      await writable.close();
    } catch (cause: unknown) {
      await writable.abort({ reason: cause });
      throw cause;
    }
    return;
  }
  case "truncate_file": {
    const { path, size, type: _type, ...unhandled } = operation;
    unhandled satisfies Record<PropertyKey, never>;
    const parent = await directoryAt({ create: false, path: path.slice(0, -1), root });
    const name = path.at(-1);
    if (name === undefined) throw new TypeError("truncate scenario path must not be empty");
    const file = await parent.getFileHandle({ create: false, name });
    const writable = await file.createWritable({ keepExistingData: true });
    try {
      await writable.truncate({ size });
      await writable.close();
    } catch (cause: unknown) {
      await writable.abort({ reason: cause });
      throw cause;
    }
    return;
  }
  case "clone_file": {
    const { from, replace, to, type: _type, ...unhandled } = operation;
    unhandled satisfies Record<PropertyKey, never>;
    const sourceParent = await directoryAt({ create: false, path: from.slice(0, -1), root });
    const destination = await directoryAt({ create: false, path: to.slice(0, -1), root });
    const name = from.at(-1);
    const newName = to.at(-1);
    if (name === undefined || newName === undefined) throw new TypeError("clone scenario paths must not be empty");
    await sourceParent.cloneFile({ destination, name, newName, replace });
    return;
  }
  case "move_entry": {
    const { from, replace, to, type: _type, ...unhandled } = operation;
    unhandled satisfies Record<PropertyKey, never>;
    const sourceParent = await directoryAt({ create: false, path: from.slice(0, -1), root });
    const destination = await directoryAt({ create: false, path: to.slice(0, -1), root });
    const name = from.at(-1);
    const newName = to.at(-1);
    if (name === undefined || newName === undefined) throw new TypeError("move scenario paths must not be empty");
    await sourceParent.moveEntry({ destination, name, newName, replace });
    return;
  }
  case "remove_entry": {
    const { path, recursive, type: _type, ...unhandled } = operation;
    unhandled satisfies Record<PropertyKey, never>;
    const parent = await directoryAt({ create: false, path: path.slice(0, -1), root });
    const name = path.at(-1);
    if (name === undefined) throw new TypeError("remove scenario path must not be empty");
    await parent.removeEntry({ name, recursive });
    return;
  }
  default: return operation satisfies never;
  }
}

export async function applyScenario({ scenario, session }: {
  scenario: HizoFSV1FormatScenario;
  session: StorageFileSystemSession;
}): Promise<void> {
  for (const operation of scenario.operations) await applyOperation({ operation, root: session.root });
}

function pathLabel({ path }: { path: readonly string[] }): string {
  return `/${path.join("/")}`;
}

function bytesHex({ bytes }: { bytes: Uint8Array }): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

async function observeDirectory({ directory, output, path }: {
  directory: StorageDirectoryHandle;
  output: HizoFSV1ObservableEntry[];
  path: readonly string[];
}): Promise<void> {
  const children: { handle: Awaited<ReturnType<StorageDirectoryHandle["getEntryHandle"]>>; name: string }[] = [];
  for await (const [name, handle] of directory.entries()) children.push({ handle, name });
  children.sort((left, right) => compareObservableNamesByUtf8({ left: left.name, right: right.name }));
  for (const { handle, name } of children) {
    const childPath = [...path, name];
    switch (handle.kind) {
    case "directory":
      output.push(exactObject<HizoFSV1ObservableEntry>()({ kind: "directory", path: pathLabel({ path: childPath }) }));
      await observeDirectory({ directory: handle, output, path: childPath });
      break;
    case "file": {
      const stat = await handle.stat();
      const readable = await handle.openReadable({ mimeType: "application/octet-stream" });
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await new Response(readable.stream({ end: undefined, signal: undefined, start: 0 })).arrayBuffer());
      } finally {
        await readable.close();
      }
      output.push(exactObject<HizoFSV1ObservableEntry>()({
        bytesHex: bytesHex({ bytes }),
        kind: "file",
        path: pathLabel({ path: childPath }),
        size: stat.size,
      }));
      break;
    }
    case "symlink":
      output.push(exactObject<HizoFSV1ObservableEntry>()({
        kind: "symlink",
        path: pathLabel({ path: childPath }),
        target: await handle.readTarget(),
      }));
      break;
    default: return handle satisfies never;
    }
  }
}

export async function observeObservableState({ session }: {
  session: StorageFileSystemSession;
}): Promise<HizoFSV1ObservableState> {
  const entries: HizoFSV1ObservableEntry[] = [];
  await observeDirectory({ directory: session.root, output: entries, path: [] });
  return exactObject<HizoFSV1ObservableState>()({ entries: Object.freeze(entries) });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
