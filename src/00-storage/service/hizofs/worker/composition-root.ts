import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  parseCredentialSlotId,
  parseFileSystemId,
} from "@/00-storage/service/hizofs/00-format";
import {
  createContainerCoordinationScope,
  parseContainerCoordinationScopeToken,
  type ContainerCoordinationScope,
} from "@/00-storage/service/hizofs/runtime/container-coordination-scope";
import {
  HizoFSStorageFileSystemSession,
  type HizoFSApplicationPreparedExplicitBulk,
  type HizoFSApplicationPreparedWritable,
  type HizoFSApplicationRuntimeSession,
  type HizoFSApplicationSessionNamespace,
  type HizoFSTransitionImportStatePort,
  type HizoFSWorkerMountGrantIssuer,
} from "@/00-storage/service/hizofs/api";
import { createHizoFSTransitionNamespaceSource } from "@/00-storage/service/hizofs/api/transition-namespace-source";
import {
  createFeatureBits,
  createFileOffset,
  createSubvolumeId,
  createTimestampMilliseconds,
  createUnlockSequence,
  encodeFileSystemCommitPayload,
  sameSuperblockLogicalStateExceptMinimumUnlockSequence,
  type DirectoryInodeEntry,
  type DirectoryLeafEntry,
  type FileSystemCommitPayload,
  type FeatureBits,
  type FileInodeEntry,
  type FileSystemId,
  type HomeRecordReference,
  type InodeNumber,
  type MutationId,
  type OpenedSuperblockCopies,
  type PhysicalRecordReference,
  type SubvolumeId,
  type TimestampMilliseconds,
} from "@/00-storage/service/hizofs/00-format";
import { createAuthenticatedFileContentMutationAuthority } from "@/00-storage/service/hizofs/authenticated-store/file-content-mutation-authority";
import {
  createEmptyEncryptedContainer,
  createEmptyEncryptedContainerWithPassphrases,
  openEmptyEncryptedContainer,
  openEmptyEncryptedContainerWithRootKey,
  type OpenedEmptyEncryptedContainer,
} from "@/00-storage/service/hizofs/authenticated-store/empty-container-store";
import { AuthenticatedStoreError } from "@/00-storage/service/hizofs/authenticated-store/errors";
import {
  openAuthenticatedUnlockEnvelopeAuthority,
  openUnlockEnvelopeCopies,
  proveRetainedPassphraseCredentialSlots,
  type ProvenRetainedPassphraseCredential,
  type RetainedPassphraseCredentialProof,
} from "@/00-storage/service/hizofs/authenticated-store/unlock-envelope-store";
import {
  CredentialUpdatePublicationError,
  replaceUnlockingCredentialPassphrase,
  resolveCredentialUpdatePublication,
} from "@/00-storage/service/hizofs/authenticated-store/credential-update-coordinator";
import {
  createAuthenticatedMetadataMutationAuthority,
  type AuthenticatedMetadataMutationAuthority,
} from "@/00-storage/service/hizofs/authenticated-store/metadata-mutation-authority";
import {
  AuthenticatedMetadataRecordCache,
  type AuthenticatedMetadataRecordCachePolicy,
} from "@/00-storage/service/hizofs/authenticated-store/metadata-record-cache";
import { createAuthenticatedNamespaceRecordSource } from "@/00-storage/service/hizofs/authenticated-store/namespace-record-source";
import { openSuperblockCopies } from "@/00-storage/service/hizofs/authenticated-store/superblock-store";
import { readBootstrapRoot } from "@/00-storage/service/hizofs/authenticated-store/bootstrap-segment-store";
import { PreparedMutationCommitPublicationError } from "@/00-storage/service/hizofs/authenticated-store/prepared-mutation-commit-store";
import {
  createAuthenticatedReadOnlyNamespace,
  createAuthenticatedReadOnlyNamespaceResolver,
} from "@/00-storage/service/hizofs/filesystem/authenticated-read-only-namespace";
import {
  StreamingNamespaceImport,
  type SealedStreamingNamespaceImport,
  type StreamingNamespaceImportLimits,
  validateSealedStreamingNamespaceImport,
} from "@/00-storage/service/hizofs/filesystem/bulk/streaming-namespace-import";
import { ExplicitBulkBuilder } from "@/00-storage/service/hizofs/filesystem/bulk/explicit-bulk-builder";
import { prepareExplicitBulkCommit } from "@/00-storage/service/hizofs/filesystem/bulk/explicit-bulk-commit";
import type { SealedExplicitBulkCandidate } from "@/00-storage/service/hizofs/filesystem/bulk/explicit-bulk-candidate";
import type { StreamingDirectoryImportLimits } from "@/00-storage/service/hizofs/filesystem/bulk/streaming-directory-import";
import { prepareTransitionImportCommit } from "@/00-storage/service/hizofs/filesystem/bulk/transition-import-commit";
import { StreamingNamespaceImportTargetSession } from "@/00-storage/service/hizofs/filesystem/bulk/streaming-namespace-import-target-session";
import {
  prepareFileTruncateMutation,
  prepareFileWriteMutation,
  type FileContentMutationLimits,
} from "@/00-storage/service/hizofs/filesystem/file/file-content-mutation";
import { prepareFileTruncatePlan } from "@/00-storage/service/hizofs/filesystem/file/file-truncate-plan";
import { prepareFileWritePlan } from "@/00-storage/service/hizofs/filesystem/file/file-write-plan";
import { createDirectoryPageTreePageStore } from "@/00-storage/service/hizofs/filesystem/mutation/directory-page-tree";
import type { ImmutableBTreeDiagnosticsPort } from "@/00-storage/service/hizofs/indexes/runtime-diagnostics-port";
import type { ContainerCoordinationKey } from "@/00-storage/service/hizofs/filesystem/container-coordination-key";
import { createFileExtentTreePageStore } from "@/00-storage/service/hizofs/filesystem/mutation/file-extent-tree";
import {
  publishPreparedMutationCommit,
  type PublishedPreparedMutationCommit,
} from "@/00-storage/service/hizofs/filesystem/mutation/prepared-mutation-commit-publisher";
import {
  createRootInodeTablePageStore,
  prepareRootInodeTableMutation,
} from "@/00-storage/service/hizofs/filesystem/mutation/root-inode-table-mutation";
import {
  prepareOrdinaryEntryCreateCommit,
  type PreparedOrdinaryEntryCreateCommit,
} from "@/00-storage/service/hizofs/filesystem/namespace/ordinary-entry-create-commit";
import type {
  OrdinaryEntryCreateRequest,
  OrdinaryEntryCreateTarget,
} from "@/00-storage/service/hizofs/filesystem/namespace/ordinary-entry-create-plan";
import {
  prepareOrdinaryEntryMoveCommit,
  type PreparedOrdinaryEntryMoveCommit,
} from "@/00-storage/service/hizofs/filesystem/namespace/ordinary-entry-move-commit";
import {
  prepareOrdinaryEntryMovePlan,
  type OrdinaryEntryMovePlan,
} from "@/00-storage/service/hizofs/filesystem/namespace/ordinary-entry-move-plan";
import {
  prepareOrdinaryEntryRemovalCommit,
  type PreparedOrdinaryEntryRemovalCommit,
} from "@/00-storage/service/hizofs/filesystem/namespace/ordinary-entry-removal-commit";
import {
  prepareOrdinaryEntryRemovalPlan,
  type OrdinaryEntryRemovalPlan,
} from "@/00-storage/service/hizofs/filesystem/namespace/ordinary-entry-removal-plan";
import {
  prepareWholeFileReflinkCommit,
  type PreparedWholeFileReflinkCommit,
} from "@/00-storage/service/hizofs/filesystem/reflink/whole-file-reflink-commit";
import type {
  WholeFileReflinkSource,
  WholeFileReflinkTarget,
} from "@/00-storage/service/hizofs/filesystem/reflink/whole-file-reflink-plan";
import {
  FileSystemRootKey,
  deriveContainerCoordinationScopeTokenValue,
  generateFileSystemId,
  generateBenchmarkSecret,
  generateMutationId,
  issueHizoFSWorkerMountGrantPayload,
  openHizoFSWorkerMountGrantPayload,
  withFileSystemRootKeyProofDerivationCapability,
  type FileSystemRootKeyProofDerivationCapability,
  type RandomByteSource,
} from "@/00-storage/service/hizofs/01-crypto";
import type {
  ReadOnlyNamespace,
  ReadOnlyNamespaceResolver,
} from "@/00-storage/service/hizofs/filesystem/read-only-namespace";
import type { AuthenticatedHizoFSPhysicalBytes } from "@/00-storage/service/hizofs/authenticated-store/physical-bytes";
import type { AuthenticatedStoreDiagnosticsPort } from "@/00-storage/service/hizofs/authenticated-store/runtime-diagnostics-port";
import {
  hasCrashDurableWritableSemantics,
  type HizoFSCrashDurableWritableBackend,
  type HizoFSDevelopmentWritableBackend,
  type HizoFSPhysicalWriteBackend,
  type HizoFSReadableBackend,
  type HizoFSWritableBackend,
  type HizoFSWritableFile,
} from "@/00-storage/service/hizofs/physical-store/backend";
import { OpfsWritableBackend } from "@/00-storage/service/hizofs/physical-store/opfs/opfs-writable-backend";
import { HizoFSRuntimeDiagnosticsAccumulator, type HizoFSRuntimeDiagnosticPhase, type HizoFSRuntimeDiagnosticsSnapshot } from "@/00-storage/service/hizofs/runtime/runtime-diagnostics";
import type { ContainerRuntimeMaintenanceRootCapture } from "@/00-storage/service/hizofs/runtime/container-runtime";
import type { SessionOperationAuthority } from "@/00-storage/service/hizofs/runtime/session-lifecycle";
import {
  captureCompleteMaintenanceRoots,
  type CompleteMaintenanceRootCapture,
} from "@/00-storage/service/hizofs/maintenance/maintenance-root-capture";
import type { CandidateSegmentPlanEntry } from "@/00-storage/service/hizofs/maintenance/candidate-segment-batch";
import {
  validateMaintenanceRootSnapshot,
  type MaintenanceRootSnapshot,
} from "@/00-storage/service/hizofs/maintenance/maintenance-root-snapshot";
import type { ValidatedGarbageCollectionSweepAuthority } from "@/00-storage/service/hizofs/maintenance/sliced-garbage-collection-cycle";
import type { HizoFSMaintenancePolicy } from "@/00-storage/service/hizofs/maintenance/maintenance-policy";
import type { PreparedMaintenanceCandidateSnapshot } from "@/00-storage/service/hizofs/maintenance/prepared-maintenance-candidate-snapshot";
import type {
  StorageDirectoryHandle,
  StorageDirectoryWorkerMountAccessMode,
  StorageDirectoryWorkerMountGrant,
  StorageFileSystemSession,
} from "@/00-storage/service/storage-file-system/types";
import type { HizoFSRuntimePolicy } from "@/00-storage/service/hizofs/runtime/runtime-policy";
import type { TransitionTargetEndpointSession } from "@/00-storage/service/naidan-persistence-control/transition/transition-provider-adapter";

import {
  createBrowserHizoFSWorkerRuntimeHost,
  HizoFSWorkerRuntimeHost,
} from "@/00-storage/service/hizofs/worker/runtime-host";

export { createBrowserHizoFSWorkerRuntimeHost, HizoFSWorkerRuntimeHost };

export type AuthenticatedApplicationReadSessionResources = Readonly<{
  namespace: HizoFSApplicationSessionNamespace;
  releaseResources: () => Promise<void>;
}>;


const WORKER_MOUNT_GRANT_POLICY: HizoFSRuntimePolicy = Object.freeze({
  maxDirectoryIteratorEntries: 4_096,
  maxHeldLockNames: 1_024,
  maxMaintenanceRootRegistrations: 1_024,
  maxReaderPins: 256,
  maxSegmentReferences: 4_096,
});

const APPLICATION_METADATA_RECORD_CACHE_POLICY = Object.freeze({
  maximumBytes: 8 * 1024 * 1024,
  maximumEntries: 16 * 1024,
});

async function issueHizoFSWorkerMountGrant({
  accessMode,
  canonicalBackingLocation,
  currentResolver,
  fileSystemId,
  path,
  rootKey,
  unlockingSlotId,
  unlockSequence,
}: {
  accessMode: StorageDirectoryWorkerMountAccessMode;
  canonicalBackingLocation: string;
  currentResolver: () => ReadOnlyNamespaceResolver;
  fileSystemId: FileSystemId;
  path: readonly string[];
  rootKey: FileSystemRootKey;
  unlockingSlotId: import("@/00-storage/service/hizofs/00-format").CredentialSlotId;
  unlockSequence: import("@/00-storage/service/hizofs/00-format").UnlockSequence;
}): Promise<StorageDirectoryWorkerMountGrant> {
  const stat = await currentResolver().stat({ pathComponents: [...path] });
  switch (stat.kind) {
  case "directory": break;
  case "file":
  case "symlink": throw new TypeError("Worker mount scope must be a directory");
  default: {
    const _ex: never = stat.kind;
    throw new Error(`Unhandled Worker mount scope: ${String(_ex)}`);
  }
  }
  const issued = await issueHizoFSWorkerMountGrantPayload({
    accessMode,
    canonicalBackingLocation,
    fileSystemId,
    inodeNumber: stat.inodeNumber,
    rootKey,
    scopePath: path,
    unlockingSlotId,
    unlockSequence,
  });
  return {
    accessMode,
    grantId: issued.grantId,
    implementation: "hizofs",
    opaquePayload: issued.opaquePayload,
    type: "storage_directory_worker_mount_grant",
    version: 1,
  };
}

/**
 * Derives the runtime-only cross-realm scope from the canonical backend location.
 *
 * The backing path is intentionally hashed rather than persisted or reused as a
 * File System ID. Two byte-identical containers at different OPFS locations must
 * therefore receive independent writer/pin namespaces.
 */
export async function createBrowserContainerCoordinationScope({
  canonicalBackingLocation,
}: {
  canonicalBackingLocation: string;
}): Promise<ContainerCoordinationScope> {
  return createContainerCoordinationScope({
    token: parseContainerCoordinationScopeToken({
      value: await deriveContainerCoordinationScopeTokenValue({ canonicalBackingLocation }),
    }),
  });
}

export async function openAuthenticatedReadOnlyContainerAuthority({
  backend,
  indexDiagnostics,
  passphrase,
  recordDiagnostics,
  supportedFeatureBits,
  verifyProofAuthority,
}: {
  backend: HizoFSReadableBackend;
  indexDiagnostics?: ImmutableBTreeDiagnosticsPort;
  passphrase: string;
  recordDiagnostics?: AuthenticatedStoreDiagnosticsPort;
  supportedFeatureBits: FeatureBits;
  verifyProofAuthority: ({ fileSystemId, rootKeyProof }: {
    fileSystemId: FileSystemId;
    rootKeyProof: FileSystemRootKeyProofDerivationCapability;
  }) => Promise<void>;
}): Promise<AuthenticatedOpenedApplicationAuthority> {
  const opened = await openEmptyEncryptedContainer({
    backend,
    diagnostics: recordDiagnostics,
    passphrase,
    supportedFeatureBits,
  });
  try {
    await withFileSystemRootKeyProofDerivationCapability({
      rootKey: opened.rootKey,
      useCapability: async ({ capability }) => await verifyProofAuthority({
        fileSystemId: opened.fileSystemId,
        rootKeyProof: capability,
      }),
    });
    return { backend, indexDiagnostics, opened, recordDiagnostics };
  } catch (cause: unknown) {
    opened.rootKey.destroy();
    throw cause;
  }
}


declare const authenticatedReadOnlyContainerCapabilityBrand: unique symbol;

/** Opaque runtime capability; secret-bearing opened state remains module-private. */
export type AuthenticatedReadOnlyContainerCapability = Readonly<{
  [authenticatedReadOnlyContainerCapabilityBrand]: true;
}>;

export type AuthenticatedReadOnlyContainerCapabilityOpenResult =
  | { readonly type: "credential_rejected" }
  | {
      readonly authority: AuthenticatedReadOnlyContainerCapability;
      readonly releaseResources: () => Promise<void>;
      readonly type: "opened";
    };

type PrivateReadOnlyContainerAuthority =
  | { readonly authority: AuthenticatedOpenedApplicationAuthority; readonly type: "normal_read" }
  | { readonly rootKey: import("@/00-storage/service/hizofs/01-crypto").FileSystemRootKey; readonly type: "root_key_proof" };

type PrivateReadOnlyContainerCapabilityState =
  | { readonly state: "owned"; readonly value: PrivateReadOnlyContainerAuthority }
  | { readonly state: "released" | "transferred" };

const openedReadOnlyAuthorityByCapability = new WeakMap<object, PrivateReadOnlyContainerCapabilityState>();

function releasePrivateReadOnlyContainerAuthority({ value }: {
  value: PrivateReadOnlyContainerAuthority;
}): void {
  switch (value.type) {
  case "normal_read": value.authority.opened.rootKey.destroy(); return;
  case "root_key_proof": value.rootKey.destroy(); return;
  default: return value satisfies never;
  }
}

function releaseAuthenticatedReadOnlyContainerCapability({ authority }: {
  authority: AuthenticatedReadOnlyContainerCapability;
}): void {
  const lifecycle = openedReadOnlyAuthorityByCapability.get(authority);
  if (lifecycle === undefined) {
    throw new TypeError("authenticated read-only container capability is foreign");
  }
  switch (lifecycle.state) {
  case "released":
  case "transferred": return;
  case "owned":
    openedReadOnlyAuthorityByCapability.set(authority, { state: "released" });
    releasePrivateReadOnlyContainerAuthority({ value: lifecycle.value });
    return;
  default: return lifecycle satisfies never;
  }
}

/**
 * Opens one candidate without exposing its root key, backend, or opened state.
 *
 * Credential rejection is the only downgraded error. Corruption, unsupported
 * features, physical I/O failures, and proof verification failures remain
 * distinguishable infrastructure or authority failures.
 */
export async function openAuthenticatedReadOnlyContainerCapability({
  backend,
  passphrase,
  verifyProofAuthority,
}: {
  backend: HizoFSReadableBackend;
  passphrase: string;
  verifyProofAuthority: ({ fileSystemId, rootKeyProof }: {
    fileSystemId: FileSystemId;
    rootKeyProof: FileSystemRootKeyProofDerivationCapability;
  }) => Promise<void>;
}): Promise<AuthenticatedReadOnlyContainerCapabilityOpenResult> {
  let openedAuthority: AuthenticatedOpenedApplicationAuthority;
  try {
    openedAuthority = await openAuthenticatedReadOnlyContainerAuthority({
      backend,
      passphrase,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
      verifyProofAuthority,
    });
  } catch (cause: unknown) {
    if (cause instanceof AuthenticatedStoreError && cause.code === "credential_rejected") {
      return { type: "credential_rejected" };
    }
    throw cause;
  }

  const authority = Object.freeze({}) as AuthenticatedReadOnlyContainerCapability;
  openedReadOnlyAuthorityByCapability.set(authority, {
    state: "owned",
    value: { authority: openedAuthority, type: "normal_read" },
  });
  let released = false;
  return {
    authority,
    releaseResources: async () => {
      if (released) return;
      released = true;
      releaseAuthenticatedReadOnlyContainerCapability({ authority });
    },
    type: "opened",
  };
}

/** Opens only the credential/root-key plane for an incomplete transition target. */
export async function openAuthenticatedRootKeyProofContainerCapability({
  backend,
  passphrase,
  verifyProofAuthority,
}: {
  backend: HizoFSReadableBackend;
  passphrase: string;
  verifyProofAuthority: ({ fileSystemId, rootKeyProof }: {
    fileSystemId: FileSystemId;
    rootKeyProof: FileSystemRootKeyProofDerivationCapability;
  }) => Promise<void>;
}): Promise<AuthenticatedReadOnlyContainerCapabilityOpenResult> {
  let unlocked: Awaited<ReturnType<typeof openUnlockEnvelopeCopies>>;
  try {
    unlocked = await openUnlockEnvelopeCopies({
      backend,
      minimumUnlockSequence: createUnlockSequence({ value: 1n }),
      passphrase,
    });
  } catch (cause: unknown) {
    if (cause instanceof AuthenticatedStoreError && cause.code === "credential_rejected") {
      return { type: "credential_rejected" };
    }
    throw cause;
  }
  try {
    await withFileSystemRootKeyProofDerivationCapability({
      rootKey: unlocked.rootKey,
      useCapability: async ({ capability }) => await verifyProofAuthority({
        fileSystemId: unlocked.fileSystemId,
        rootKeyProof: capability,
      }),
    });
  } catch (cause: unknown) {
    unlocked.rootKey.destroy();
    throw cause;
  }

  const authority = Object.freeze({}) as AuthenticatedReadOnlyContainerCapability;
  openedReadOnlyAuthorityByCapability.set(authority, {
    state: "owned",
    value: { rootKey: unlocked.rootKey, type: "root_key_proof" },
  });
  let released = false;
  return {
    authority,
    releaseResources: async () => {
      if (released) return;
      released = true;
      releaseAuthenticatedReadOnlyContainerCapability({ authority });
    },
    type: "opened",
  };
}

/**
 * Builds the native OPFS reader inside the exact HizoFS composition boundary.
 * The caller receives only the opaque capability returned by the generic open.
 */
declare const authenticatedDevelopmentWritableContainerCapabilityBrand: unique symbol;

/** Opaque capability for unreleased writable integration; it carries no crash-durability claim. */
export type AuthenticatedDevelopmentWritableContainerCapability = Readonly<{
  [authenticatedDevelopmentWritableContainerCapabilityBrand]: true;
}>;

export type AuthenticatedDevelopmentWritableContainerCapabilityOpenResult =
  | { readonly type: "credential_rejected" }
  | {
      readonly authority: AuthenticatedDevelopmentWritableContainerCapability;
      readonly releaseResources: () => Promise<void>;
      readonly type: "opened";
    };

type PrivateDevelopmentWritableCapabilityState =
  | {
      readonly authority: AuthenticatedOpenedApplicationAuthority;
      readonly backend: HizoFSDevelopmentWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
      readonly state: "owned";
    }
  | { readonly state: "released" | "transferred" };

const openedDevelopmentWritableAuthorityByCapability = new WeakMap<object, PrivateDevelopmentWritableCapabilityState>();

type DevelopmentWritableCredentialSessionState = {
  readonly credentialAuthorityUpdater: AuthenticatedCredentialAuthorityUpdater;
  readonly backend: HizoFSDevelopmentWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  readonly operationGate: DevelopmentWritableCredentialOperationGate;
  readonly opened: OpenedEmptyEncryptedContainer;
  readonly recordDiagnostics?: AuthenticatedStoreDiagnosticsPort;
  readonly runtimeSession: HizoFSApplicationRuntimeSession;
  readonly underlyingSession: StorageFileSystemSession;
  closePromise?: Promise<void>;
  lifecycle: "closed" | "closing" | "open" | "proving" | "recovery_required" | "reencrypting" | "updating";
  unlockingSlotId: import("@/00-storage/service/hizofs/00-format").CredentialSlotId;
};

const developmentWritableCredentialStateBySession = new WeakMap<StorageFileSystemSession, DevelopmentWritableCredentialSessionState>();

export class HizoFSCredentialUpdateRecoveryRequiredError extends Error {
  readonly code = "recovery_required";

  public constructor({ cause, outcome }: { cause: unknown; outcome: string }) {
    super(`HizoFS credential update requires recovery: ${outcome}`, { cause });
    this.name = "HizoFSCredentialUpdateRecoveryRequiredError";
  }
}

type DevelopmentWritableCredentialOperationGate = {
  cause: unknown;
  outcome: string;
  recoveryRequired: boolean;
};

function assertCredentialSessionOperationAllowed({ gate }: {
  gate: DevelopmentWritableCredentialOperationGate;
}): void {
  if (!gate.recoveryRequired) return;
  throw new HizoFSCredentialUpdateRecoveryRequiredError({
    cause: gate.cause,
    outcome: gate.outcome,
  });
}

function requireCredentialSessionRecovery({ cause, outcome, state }: {
  cause: unknown;
  outcome: string;
  state: DevelopmentWritableCredentialSessionState;
}): void {
  state.lifecycle = "recovery_required";
  state.operationGate.cause = cause;
  state.operationGate.outcome = outcome;
  state.operationGate.recoveryRequired = true;
}

function restoreCredentialSessionOperation({ state }: {
  state: DevelopmentWritableCredentialSessionState;
}): void {
  state.operationGate.cause = undefined;
  state.operationGate.outcome = "session_reopen_required";
  state.operationGate.recoveryRequired = false;
  state.lifecycle = "open";
}

async function runCredentialPublicationOperation<Value>({ operation, runtimeSession }: {
  operation: ({ authority }: { authority: SessionOperationAuthority }) => Promise<Value>;
  runtimeSession: HizoFSApplicationRuntimeSession;
}): Promise<Value> {
  const writer = await runtimeSession.acquireWriter();
  let failed = false;
  let failure: unknown | undefined;
  let value: Value | undefined;
  try {
    value = await writer.runPublication({ operation });
  } catch (cause: unknown) {
    failed = true;
    failure = cause;
  }
  try {
    await writer.close();
  } catch (closeCause: unknown) {
    if (failed) {
      throw new AggregateError([failure, closeCause], "credential publication and writer cleanup both failed");
    }
    throw closeCause;
  }
  if (failed) throw failure;
  return value as Value;
}

function wrapDevelopmentWritableCredentialSession({ state }: {
  state: DevelopmentWritableCredentialSessionState;
}): StorageFileSystemSession {
  const { underlyingSession } = state;
  const wrapped: StorageFileSystemSession = {
    capabilities: underlyingSession.capabilities,
    root: underlyingSession.root,
    close: async () => {
      switch (state.lifecycle) {
      case "closed": return;
      case "closing": return await state.closePromise;
      case "proving": throw new TypeError("cannot close HizoFS session while a root-key proof operation is active");
      case "reencrypting": throw new TypeError("cannot close HizoFS session while a re-encryption credential proof operation is active");
      case "updating": throw new TypeError("cannot close HizoFS session while a credential update is active");
      case "open":
      case "recovery_required": break;
      default: return state.lifecycle satisfies never;
      }
      const previousLifecycle = state.lifecycle;
      state.lifecycle = "closing";
      const closePromise = underlyingSession.close();
      state.closePromise = closePromise;
      try {
        await closePromise;
        state.lifecycle = "closed";
      } catch (cause: unknown) {
        state.closePromise = undefined;
        state.lifecycle = previousLifecycle;
        throw cause;
      }
    },
    ...(underlyingSession.createReadSnapshot === undefined ? {} : {
      createReadSnapshot: async () => await underlyingSession.createReadSnapshot!(),
    }),
  };
  developmentWritableCredentialStateBySession.set(wrapped, state);
  return wrapped;
}

function replacementSlotId({ previousSlotIds, slots }: {
  previousSlotIds: ReadonlySet<string>;
  slots: readonly import("@/00-storage/service/hizofs/00-format").CredentialSlotV1[];
}): import("@/00-storage/service/hizofs/00-format").CredentialSlotId {
  const replacements = slots.filter(slot => !previousSlotIds.has(slot.slotId));
  if (replacements.length !== 1 || replacements[0] === undefined) {
    throw new TypeError("credential publication did not identify exactly one replacement Slot ID");
  }
  return replacements[0].slotId;
}

export async function withAuthenticatedDevelopmentWritableSessionRootKeyProof<T>({
  operation,
  session,
}: {
  operation: ({ fileSystemId, rootKeyProof }: {
    fileSystemId: FileSystemId;
    rootKeyProof: FileSystemRootKeyProofDerivationCapability;
  }) => Promise<T>;
  session: StorageFileSystemSession;
}): Promise<T> {
  const state = developmentWritableCredentialStateBySession.get(session);
  if (state === undefined) throw new TypeError("HizoFS root-key proof session is foreign");
  switch (state.lifecycle) {
  case "open": state.lifecycle = "proving"; break;
  case "closed": throw new TypeError("HizoFS root-key proof session is closed");
  case "closing": throw new TypeError("HizoFS root-key proof session is closing");
  case "proving": throw new TypeError("HizoFS root-key proof operation is already active");
  case "recovery_required": throw new TypeError("HizoFS root-key proof session requires recovery");
  case "reencrypting": throw new TypeError("HizoFS root-key proof session is proving re-encryption credentials");
  case "updating": throw new TypeError("HizoFS root-key proof session is updating credentials");
  default: return state.lifecycle satisfies never;
  }
  try {
    return await withFileSystemRootKeyProofDerivationCapability({
      rootKey: state.opened.rootKey,
      useCapability: async ({ capability }) => await operation({
        fileSystemId: state.opened.fileSystemId,
        rootKeyProof: capability,
      }),
    });
  } finally {
    if (state.lifecycle === "proving") state.lifecycle = "open";
  }
}

export async function withAuthenticatedDevelopmentWritableSessionRetainedCredentials<T>({
  operation,
  recheckAuthority,
  retainedCredentials,
  session,
}: {
  operation: ({ credentialSlotCount, fileSystemId, retainedCredentials }: {
    credentialSlotCount: number;
    fileSystemId: FileSystemId;
    retainedCredentials: readonly ProvenRetainedPassphraseCredential[];
    rootKeyProof: FileSystemRootKeyProofDerivationCapability;
  }) => Promise<T>;
  recheckAuthority: () => Promise<void>;
  retainedCredentials: readonly RetainedPassphraseCredentialProof[];
  session: StorageFileSystemSession;
}): Promise<T> {
  const state = developmentWritableCredentialStateBySession.get(session);
  if (state === undefined) throw new TypeError("HizoFS re-encryption credential proof session is foreign");
  switch (state.lifecycle) {
  case "open": state.lifecycle = "reencrypting"; break;
  case "closed": throw new TypeError("HizoFS re-encryption credential proof session is closed");
  case "closing": throw new TypeError("HizoFS re-encryption credential proof session is closing");
  case "proving": throw new TypeError("HizoFS re-encryption credential proof session is performing a root-key proof operation");
  case "recovery_required": throw new TypeError("HizoFS re-encryption credential proof session requires recovery");
  case "reencrypting": throw new TypeError("HizoFS re-encryption credential proof operation is already active");
  case "updating": throw new TypeError("HizoFS re-encryption credential proof session is updating credentials");
  default: return state.lifecycle satisfies never;
  }

  const supportedFeatureBits = createFeatureBits({ value: 0n });
  try {
    await recheckAuthority();
    const superblock = await openSuperblockCopies({
      backend: state.backend,
      diagnostics: state.recordDiagnostics,
      fileSystemId: state.opened.fileSystemId,
      rootKey: state.opened.rootKey,
      supportedFeatureBits,
    });
    const credentialAuthority = await openAuthenticatedUnlockEnvelopeAuthority({
      backend: state.backend,
      diagnostics: state.recordDiagnostics,
      fileSystemId: state.opened.fileSystemId,
      minimumUnlockSequence: superblock.logicalState.minimumUnlockSequence,
      rootKey: state.opened.rootKey,
    });
    const provenRetainedCredentials = await proveRetainedPassphraseCredentialSlots({
      authority: credentialAuthority,
      diagnostics: state.recordDiagnostics,
      retainedCredentials,
    });
    await recheckAuthority();
    return await withFileSystemRootKeyProofDerivationCapability({
      rootKey: state.opened.rootKey,
      useCapability: async ({ capability }) => await operation({
        credentialSlotCount: credentialAuthority.credentialSlots.length,
        fileSystemId: state.opened.fileSystemId,
        retainedCredentials: provenRetainedCredentials,
        rootKeyProof: capability,
      }),
    });
  } finally {
    if (state.lifecycle === "reencrypting") state.lifecycle = "open";
  }
}

export async function replaceAuthenticatedDevelopmentWritableSessionPassphrase({
  recheckAuthority,
  replacementPassphrase,
  session,
}: {
  recheckAuthority: () => Promise<void>;
  replacementPassphrase: string;
  session: StorageFileSystemSession;
}): Promise<StorageFileSystemSession> {
  const state = developmentWritableCredentialStateBySession.get(session);
  if (state === undefined) throw new TypeError("HizoFS credential update session is foreign");
  switch (state.lifecycle) {
  case "open": state.lifecycle = "updating"; break;
  case "closed": throw new TypeError("HizoFS credential update session is closed");
  case "closing": throw new TypeError("HizoFS credential update session is closing");
  case "proving": throw new TypeError("HizoFS credential update session is performing a root-key proof operation");
  case "recovery_required": throw new TypeError("HizoFS credential update session requires recovery");
  case "reencrypting": throw new TypeError("HizoFS credential update session is proving re-encryption credentials");
  case "updating": throw new TypeError("HizoFS credential update is already active");
  default: return state.lifecycle satisfies never;
  }

  const supportedFeatureBits = createFeatureBits({ value: 0n });
  try {
    return await runCredentialPublicationOperation({
      operation: async ({ authority }) => {
        try {
          await recheckAuthority();
          const superblock = await openSuperblockCopies({
            backend: state.backend,
            diagnostics: state.recordDiagnostics,
            fileSystemId: state.opened.fileSystemId,
            rootKey: state.opened.rootKey,
            supportedFeatureBits,
          });
          const credentialAuthority = await openAuthenticatedUnlockEnvelopeAuthority({
            backend: state.backend,
            diagnostics: state.recordDiagnostics,
            fileSystemId: state.opened.fileSystemId,
            minimumUnlockSequence: superblock.logicalState.minimumUnlockSequence,
            rootKey: state.opened.rootKey,
          });
          const previousSlotIds = new Set(credentialAuthority.credentialSlots.map(slot => slot.slotId));
          try {
            const published = await replaceUnlockingCredentialPassphrase({
              backend: state.backend,
              beforeFirstAuthorityWrite: authority.markCommitPointCrossed,
              credentialAuthority,
              diagnostics: state.recordDiagnostics,
              replacementPassphrase,
              rootKey: state.opened.rootKey,
              superblock,
              supportedFeatureBits,
              unlockingSlotId: state.unlockingSlotId,
            });
            requireCredentialSessionRecovery({
              cause: new Error("credential publication requires authority recheck"),
              outcome: "post_publication_authority_recheck",
              state,
            });
            await recheckAuthority();
            state.credentialAuthorityUpdater({
              update: {
                superblock: published.superblock,
                unlockingSlotId: published.unlockingSlotId,
                unlockSequence: published.credentialAuthority.unlockSequence,
              },
            });
            state.unlockingSlotId = published.unlockingSlotId;
            restoreCredentialSessionOperation({ state });
            return session;
          } catch (cause: unknown) {
            if (!(cause instanceof CredentialUpdatePublicationError)) throw cause;
            requireCredentialSessionRecovery({
              cause,
              outcome: "publication_outcome_resolution",
              state,
            });
            const resolution = await resolveCredentialUpdatePublication({
              backend: state.backend,
              diagnostics: state.recordDiagnostics,
              failure: cause,
              rootKey: state.opened.rootKey,
              supportedFeatureBits,
            });
            switch (resolution.type) {
            case "not_published":
              restoreCredentialSessionOperation({ state });
              throw cause;
            case "published": {
              const unlockingSlotId = replacementSlotId({
                previousSlotIds,
                slots: resolution.credentialAuthority.credentialSlots,
              });
              await recheckAuthority();
              state.credentialAuthorityUpdater({
                update: {
                  superblock: resolution.superblock,
                  unlockingSlotId,
                  unlockSequence: resolution.credentialAuthority.unlockSequence,
                },
              });
              state.unlockingSlotId = unlockingSlotId;
              restoreCredentialSessionOperation({ state });
              return session;
            }
            case "credential_published_floor_pending":
            case "publication_conflict":
            case "published_redundancy_degraded":
              requireCredentialSessionRecovery({ cause, outcome: resolution.type, state });
              throw new HizoFSCredentialUpdateRecoveryRequiredError({ cause, outcome: resolution.type });
            default: return resolution satisfies never;
            }
          }
        } catch (cause: unknown) {
          if (authority.commitPointCrossed() && state.lifecycle === "updating") {
            requireCredentialSessionRecovery({ cause, outcome: "publication_outcome_unknown", state });
          }
          throw cause;
        }
      },
      runtimeSession: state.runtimeSession,
    });
  } catch (cause: unknown) {
    if (state.lifecycle === "updating") state.lifecycle = "open";
    if (state.operationGate.recoveryRequired) state.operationGate.cause = cause;
    throw cause;
  }
}

function releaseAuthenticatedDevelopmentWritableContainerCapability({ authority }: {
  authority: AuthenticatedDevelopmentWritableContainerCapability;
}): void {
  const lifecycle = openedDevelopmentWritableAuthorityByCapability.get(authority);
  if (lifecycle === undefined) throw new TypeError("authenticated development writable capability is foreign");
  switch (lifecycle.state) {
  case "released":
  case "transferred": return;
  case "owned":
    openedDevelopmentWritableAuthorityByCapability.set(authority, { state: "released" });
    lifecycle.authority.opened.rootKey.destroy();
    return;
  default: return lifecycle satisfies never;
  }
}

export async function openAuthenticatedDevelopmentWritableContainerCapability({
  backend,
  indexDiagnostics,
  passphrase,
  recordDiagnostics,
  verifyProofAuthority,
}: {
  backend: HizoFSDevelopmentWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  indexDiagnostics?: ImmutableBTreeDiagnosticsPort;
  passphrase: string;
  recordDiagnostics?: AuthenticatedStoreDiagnosticsPort;
  verifyProofAuthority: ({ fileSystemId, rootKeyProof }: {
    fileSystemId: FileSystemId;
    rootKeyProof: FileSystemRootKeyProofDerivationCapability;
  }) => Promise<void>;
}): Promise<AuthenticatedDevelopmentWritableContainerCapabilityOpenResult> {
  let openedAuthority: AuthenticatedOpenedApplicationAuthority;
  try {
    openedAuthority = await openAuthenticatedReadOnlyContainerAuthority({
      backend,
      indexDiagnostics,
      passphrase,
      recordDiagnostics,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
      verifyProofAuthority,
    });
  } catch (cause: unknown) {
    if (cause instanceof AuthenticatedStoreError && cause.code === "credential_rejected") {
      return { type: "credential_rejected" };
    }
    throw cause;
  }

  const authority = Object.freeze({}) as AuthenticatedDevelopmentWritableContainerCapability;
  openedDevelopmentWritableAuthorityByCapability.set(authority, {
    authority: openedAuthority,
    backend,
    state: "owned",
  });
  let released = false;
  return {
    authority,
    releaseResources: async () => {
      if (released) return;
      released = true;
      releaseAuthenticatedDevelopmentWritableContainerCapability({ authority });
    },
    type: "opened",
  };
}

/**
 * Resolves the browser container handle inside the exact composition boundary,
 * then delegates to the backend-independent authenticated capability open.
 */
export async function openBrowserAuthenticatedDevelopmentWritableContainerCapability({
  containerRoot,
  passphrase,
  runtimeDiagnostics,
  verifyProofAuthority,
}: {
  containerRoot: FileSystemDirectoryHandle;
  passphrase: string;
  runtimeDiagnostics?: HizoFSRuntimeDiagnosticsAccumulator;
  verifyProofAuthority: ({ fileSystemId, rootKeyProof }: {
    fileSystemId: FileSystemId;
    rootKeyProof: FileSystemRootKeyProofDerivationCapability;
  }) => Promise<void>;
}): Promise<AuthenticatedDevelopmentWritableContainerCapabilityOpenResult> {
  const backend = new OpfsWritableBackend<AuthenticatedHizoFSPhysicalBytes>({ root: containerRoot });
  return await openAuthenticatedDevelopmentWritableContainerCapability({
    backend: runtimeDiagnostics === undefined
      ? backend
      : instrumentHizoFSWritableBackend({ backend, diagnostics: runtimeDiagnostics }),
    indexDiagnostics: runtimeDiagnostics,
    passphrase,
    recordDiagnostics: runtimeDiagnostics,
    verifyProofAuthority,
  });
}

export async function openBrowserAuthenticatedReadOnlyContainerCapability({
  containerRoot,
  openProfile,
  passphrase,
  verifyProofAuthority,
}: {
  containerRoot: FileSystemDirectoryHandle;
  openProfile: "normal_read" | "root_key_proof";
  passphrase: string;
  verifyProofAuthority: ({ fileSystemId, rootKeyProof }: {
    fileSystemId: FileSystemId;
    rootKeyProof: FileSystemRootKeyProofDerivationCapability;
  }) => Promise<void>;
}): Promise<AuthenticatedReadOnlyContainerCapabilityOpenResult> {
  const backend = new OpfsWritableBackend<AuthenticatedHizoFSPhysicalBytes>({ root: containerRoot });
  switch (openProfile) {
  case "normal_read":
    return await openAuthenticatedReadOnlyContainerCapability({ backend, passphrase, verifyProofAuthority });
  case "root_key_proof":
    return await openAuthenticatedRootKeyProofContainerCapability({ backend, passphrase, verifyProofAuthority });
  default: return openProfile satisfies never;
  }
}

/**
 * This exact worker composition root is the only production wiring layer that
 * may join secret-bearing authenticated-store authority to logical runtime/API
 * capabilities. The returned resource surface contains no root key, backend,
 * relocation authority, or physical read primitive.
 */
export function createAuthenticatedApplicationReadSessionResources({
  backend,
  opened,
  recordDiagnostics,
}: AuthenticatedOpenedApplicationAuthority): AuthenticatedApplicationReadSessionResources {
  let released = false;
  const namespace = createAuthenticatedReadOnlyNamespace({
    commit: opened.commit,
    recordSource: createAuthenticatedNamespaceRecordSource({
      backend,
      diagnostics: recordDiagnostics,
      fileSystemId: opened.fileSystemId,
      relocationIndexRootPhysicalRef: opened.superblockLogicalState.relocationIndexRootPhysicalRef,
      rootKey: opened.rootKey,
    }),
  });
  return {
    namespace,
    releaseResources: async () => {
      if (released) return;
      released = true;
      opened.rootKey.destroy();
    },
  };
}

export type PublishedOrdinaryEntryCreate = PreparedOrdinaryEntryCreateCommit & Readonly<{
  publication: PublishedPreparedMutationCommit;
}>;

export type PublishedOrdinaryEntryRemoval = PreparedOrdinaryEntryRemovalCommit & Readonly<{
  publication: PublishedPreparedMutationCommit;
}>;

export type PublishedOrdinaryEntryMove = PreparedOrdinaryEntryMoveCommit & Readonly<{
  publication: PublishedPreparedMutationCommit;
}>;

export type PublishedWholeFileReflink = PreparedWholeFileReflinkCommit & Readonly<{
  publication: PublishedPreparedMutationCommit;
}>;

function bytesEqual({ left, right }: { left: Uint8Array; right: Uint8Array }): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

/**
 * Joins logical ordinary-entry planning to authenticated metadata writes and
 * converged Superblock publication. Keeping this join in the exact composition
 * root prevents filesystem code from acquiring root-key, backend, relocation,
 * or authority-publication ownership.
 */
function indexUpdateOperationDiagnostics({ diagnostics }: {
  diagnostics: ImmutableBTreeDiagnosticsPort | undefined;
}) {
  return diagnostics === undefined
    ? undefined
    : { operation: "update" as const, port: diagnostics };
}

function indexBuildOperationDiagnostics({ diagnostics }: {
  diagnostics: ImmutableBTreeDiagnosticsPort | undefined;
}) {
  return diagnostics === undefined
    ? undefined
    : { operation: "build" as const, port: diagnostics };
}

export type PublishedExplicitBulkCommit = Readonly<{
  commitPayload: FileSystemCommitPayload;
  publication: PublishedPreparedMutationCommit;
}>;

/**
 * Joins one already validated private explicit-bulk candidate to authenticated
 * metadata writes and one converged Commit publication. Target freshness and
 * owner lifecycle remain caller obligations; this boundary owns only the
 * secret-bearing page and authority composition.
 */
export async function publishAuthenticatedExplicitBulkCommit({
  assertPublicationAllowed,
  authority,
  baseCommit,
  baseSuperblock,
  candidate,
  directoryImportLimits,
  indexDiagnostics,
  mutationId,
}: Readonly<{
  assertPublicationAllowed: () => void;
  authority: AuthenticatedMetadataMutationAuthority;
  baseCommit: FileSystemCommitPayload;
  baseSuperblock: OpenedSuperblockCopies;
  candidate: SealedExplicitBulkCandidate;
  directoryImportLimits: StreamingDirectoryImportLimits;
  indexDiagnostics: ImmutableBTreeDiagnosticsPort | undefined;
  mutationId: MutationId;
}>): Promise<PublishedExplicitBulkCommit> {
  if (
    baseCommit.commitSequence !== baseSuperblock.logicalState.activeCommitSequence
    || !bytesEqual({ left: baseCommit.mutationId, right: baseSuperblock.logicalState.activeMutationId })
  ) {
    authority.abandon();
    throw new TypeError("explicit bulk base Commit does not match the selected Superblock authority");
  }
  try {
    assertPublicationAllowed();
    const commitPayload = await prepareExplicitBulkCommit({
      baseCommit,
      candidate,
      directoryImportLimits,
      directoryPageStore: createDirectoryPageTreePageStore({ pagePort: {
        operationDiagnostics: indexBuildOperationDiagnostics({ diagnostics: indexDiagnostics }),
        readPage: async ({ isRoot, reference }) => await authority.readDirectoryPage({ isRoot, reference }),
        writePage: async ({ isRoot, page }) => await authority.writeDirectoryPage({ isRoot, page }),
      } }),
      inodeTablePageStore: createRootInodeTablePageStore({ pagePort: {
        operationDiagnostics: indexBuildOperationDiagnostics({ diagnostics: indexDiagnostics }),
        readPage: async ({ isRoot, reference }) => await authority.readInodeTablePage({ isRoot, reference }),
        writePage: async ({ isRoot, page }) => await authority.writeInodeTablePage({ isRoot, page }),
      } }),
      mutationId,
    });
    const publication = await publishPreparedMutationCommit({
      assertPublicationAllowed,
      base: baseSuperblock,
      commitPayload,
      publicationPort: authority,
    });
    return { commitPayload, publication };
  } catch (cause: unknown) {
    authority.abandon();
    throw cause;
  }
}

export async function publishAuthenticatedOrdinaryEntryCreate({
  assertPublicationAllowed,
  authority,
  indexDiagnostics,
  baseCommit,
  baseSuperblock,
  knownInodeNumbers,
  mutationId,
  operationTimestamp,
  parent,
  request,
  target,
}: Readonly<{
  assertPublicationAllowed: () => void;
  authority: AuthenticatedMetadataMutationAuthority;
  indexDiagnostics: ImmutableBTreeDiagnosticsPort | undefined;
  baseCommit: FileSystemCommitPayload;
  baseSuperblock: OpenedSuperblockCopies;
  knownInodeNumbers: readonly InodeNumber[];
  mutationId: MutationId;
  operationTimestamp: TimestampMilliseconds;
  parent: DirectoryInodeEntry;
  request: OrdinaryEntryCreateRequest;
  target: OrdinaryEntryCreateTarget;
}>): Promise<PublishedOrdinaryEntryCreate> {
  if (
    baseCommit.commitSequence !== baseSuperblock.logicalState.activeCommitSequence
    || !bytesEqual({ left: baseCommit.mutationId, right: baseSuperblock.logicalState.activeMutationId })
  ) {
    authority.abandon();
    throw new TypeError("ordinary entry creation base Commit does not match the selected Superblock authority");
  }
  try {
    assertPublicationAllowed();
    const prepared = await prepareOrdinaryEntryCreateCommit({
      baseCommit,
      directoryPageStore: createDirectoryPageTreePageStore({ pagePort: {
        operationDiagnostics: indexUpdateOperationDiagnostics({ diagnostics: indexDiagnostics }),
        readPage: async ({ isRoot, reference }) => await authority.readDirectoryPage({ isRoot, reference }),
        writePage: async ({ isRoot, page }) => await authority.writeDirectoryPage({ isRoot, page }),
      } }),
      inodeTablePageStore: createRootInodeTablePageStore({ pagePort: {
        operationDiagnostics: indexUpdateOperationDiagnostics({ diagnostics: indexDiagnostics }),
        readPage: async ({ isRoot, reference }) => await authority.readInodeTablePage({ isRoot, reference }),
        writePage: async ({ isRoot, page }) => await authority.writeInodeTablePage({ isRoot, page }),
      } }),
      knownInodeNumbers,
      mutationId,
      operationTimestamp,
      parent,
      request,
      target,
    });
    const publication = await publishPreparedMutationCommit({
      assertPublicationAllowed,
      base: baseSuperblock,
      commitPayload: prepared.commitPayload,
      publicationPort: authority,
    });
    return { ...prepared, publication };
  } catch (cause: unknown) {
    authority.abandon();
    throw cause;
  }
}

/**
 * Publishes one already validated ordinary move. Source removal, destination
 * insertion, optional replacement deletion, and both parent revisions share
 * one prepared Commit and therefore one atomic namespace generation.
 */
export async function publishAuthenticatedOrdinaryEntryMove({
  assertPublicationAllowed,
  authority,
  indexDiagnostics,
  baseCommit,
  baseSuperblock,
  destinationParent,
  mutationId,
  operationTimestamp,
  plan,
  sourceParent,
}: Readonly<{
  assertPublicationAllowed: () => void;
  authority: AuthenticatedMetadataMutationAuthority;
  indexDiagnostics: ImmutableBTreeDiagnosticsPort | undefined;
  baseCommit: FileSystemCommitPayload;
  baseSuperblock: OpenedSuperblockCopies;
  destinationParent: DirectoryInodeEntry;
  mutationId: MutationId;
  operationTimestamp: TimestampMilliseconds;
  plan: OrdinaryEntryMovePlan;
  sourceParent: DirectoryInodeEntry;
}>): Promise<PublishedOrdinaryEntryMove> {
  if (
    baseCommit.commitSequence !== baseSuperblock.logicalState.activeCommitSequence
    || !bytesEqual({ left: baseCommit.mutationId, right: baseSuperblock.logicalState.activeMutationId })
  ) {
    authority.abandon();
    throw new TypeError("ordinary entry move base Commit does not match the selected Superblock authority");
  }
  try {
    assertPublicationAllowed();
    const prepared = await prepareOrdinaryEntryMoveCommit({
      baseCommit,
      destinationParent,
      directoryPageStore: createDirectoryPageTreePageStore({ pagePort: {
        operationDiagnostics: indexUpdateOperationDiagnostics({ diagnostics: indexDiagnostics }),
        readPage: async ({ isRoot, reference }) => await authority.readDirectoryPage({ isRoot, reference }),
        writePage: async ({ isRoot, page }) => await authority.writeDirectoryPage({ isRoot, page }),
      } }),
      inodeTablePageStore: createRootInodeTablePageStore({ pagePort: {
        operationDiagnostics: indexUpdateOperationDiagnostics({ diagnostics: indexDiagnostics }),
        readPage: async ({ isRoot, reference }) => await authority.readInodeTablePage({ isRoot, reference }),
        writePage: async ({ isRoot, page }) => await authority.writeInodeTablePage({ isRoot, page }),
      } }),
      mutationId,
      operationTimestamp,
      plan,
      sourceParent,
    });
    const publication = await publishPreparedMutationCommit({
      assertPublicationAllowed,
      base: baseSuperblock,
      commitPayload: prepared.commitPayload,
      publicationPort: authority,
    });
    return { ...prepared, publication };
  } catch (cause: unknown) {
    authority.abandon();
    throw cause;
  }
}


/**
 * Publishes one whole-file reflink without copying extent-backed content. The
 * fresh inode, destination binding, optional replacement deletion, allocator
 * advance, and destination-parent revision share one File System Commit.
 */
export async function publishAuthenticatedWholeFileReflink({
  assertPublicationAllowed,
  authority,
  indexDiagnostics,
  baseCommit,
  baseSuperblock,
  destinationParent,
  knownInodeNumbers,
  mutationId,
  operationTimestamp,
  source,
  target,
}: Readonly<{
  assertPublicationAllowed: () => void;
  authority: AuthenticatedMetadataMutationAuthority;
  indexDiagnostics: ImmutableBTreeDiagnosticsPort | undefined;
  baseCommit: FileSystemCommitPayload;
  baseSuperblock: OpenedSuperblockCopies;
  destinationParent: DirectoryInodeEntry;
  knownInodeNumbers: readonly InodeNumber[];
  mutationId: MutationId;
  operationTimestamp: TimestampMilliseconds;
  source: WholeFileReflinkSource;
  target: WholeFileReflinkTarget;
}>): Promise<PublishedWholeFileReflink> {
  if (
    baseCommit.commitSequence !== baseSuperblock.logicalState.activeCommitSequence
    || !bytesEqual({ left: baseCommit.mutationId, right: baseSuperblock.logicalState.activeMutationId })
  ) {
    authority.abandon();
    throw new TypeError("whole-file reflink base Commit does not match the selected Superblock authority");
  }
  try {
    assertPublicationAllowed();
    const prepared = await prepareWholeFileReflinkCommit({
      baseCommit,
      destinationParent,
      directoryPageStore: createDirectoryPageTreePageStore({ pagePort: {
        operationDiagnostics: indexUpdateOperationDiagnostics({ diagnostics: indexDiagnostics }),
        readPage: async ({ isRoot, reference }) => await authority.readDirectoryPage({ isRoot, reference }),
        writePage: async ({ isRoot, page }) => await authority.writeDirectoryPage({ isRoot, page }),
      } }),
      inodeTablePageStore: createRootInodeTablePageStore({ pagePort: {
        operationDiagnostics: indexUpdateOperationDiagnostics({ diagnostics: indexDiagnostics }),
        readPage: async ({ isRoot, reference }) => await authority.readInodeTablePage({ isRoot, reference }),
        writePage: async ({ isRoot, page }) => await authority.writeInodeTablePage({ isRoot, page }),
      } }),
      knownInodeNumbers,
      mutationId,
      operationTimestamp,
      source,
      target,
    });
    const publication = await publishPreparedMutationCommit({
      assertPublicationAllowed,
      base: baseSuperblock,
      commitPayload: prepared.commitPayload,
      publicationPort: authority,
    });
    return { ...prepared, publication };
  } catch (cause: unknown) {
    authority.abandon();
    throw cause;
  }
}

/**
 * Publishes one already validated ordinary-entry removal without exposing
 * authenticated metadata or Superblock authority to filesystem code.
 */
export async function publishAuthenticatedOrdinaryEntryRemoval({
  assertPublicationAllowed,
  authority,
  indexDiagnostics,
  baseCommit,
  baseSuperblock,
  mutationId,
  operationTimestamp,
  parent,
  plan,
}: Readonly<{
  assertPublicationAllowed: () => void;
  authority: AuthenticatedMetadataMutationAuthority;
  indexDiagnostics: ImmutableBTreeDiagnosticsPort | undefined;
  baseCommit: FileSystemCommitPayload;
  baseSuperblock: OpenedSuperblockCopies;
  mutationId: MutationId;
  operationTimestamp: TimestampMilliseconds;
  parent: DirectoryInodeEntry;
  plan: OrdinaryEntryRemovalPlan;
}>): Promise<PublishedOrdinaryEntryRemoval> {
  if (
    baseCommit.commitSequence !== baseSuperblock.logicalState.activeCommitSequence
    || !bytesEqual({ left: baseCommit.mutationId, right: baseSuperblock.logicalState.activeMutationId })
  ) {
    authority.abandon();
    throw new TypeError("ordinary entry removal base Commit does not match the selected Superblock authority");
  }
  try {
    assertPublicationAllowed();
    const prepared = await prepareOrdinaryEntryRemovalCommit({
      baseCommit,
      directoryPageStore: createDirectoryPageTreePageStore({ pagePort: {
        operationDiagnostics: indexUpdateOperationDiagnostics({ diagnostics: indexDiagnostics }),
        readPage: async ({ isRoot, reference }) => await authority.readDirectoryPage({ isRoot, reference }),
        writePage: async ({ isRoot, page }) => await authority.writeDirectoryPage({ isRoot, page }),
      } }),
      inodeTablePageStore: createRootInodeTablePageStore({ pagePort: {
        operationDiagnostics: indexUpdateOperationDiagnostics({ diagnostics: indexDiagnostics }),
        readPage: async ({ isRoot, reference }) => await authority.readInodeTablePage({ isRoot, reference }),
        writePage: async ({ isRoot, page }) => await authority.writeInodeTablePage({ isRoot, page }),
      } }),
      mutationId,
      operationTimestamp,
      parent,
      plan,
    });
    const publication = await publishPreparedMutationCommit({
      assertPublicationAllowed,
      base: baseSuperblock,
      commitPayload: prepared.commitPayload,
      publicationPort: authority,
    });
    return { ...prepared, publication };
  } catch (cause: unknown) {
    authority.abandon();
    throw cause;
  }
}

type AuthenticatedWritableApplicationGeneration = Readonly<{
  commit: FileSystemCommitPayload;
  resolver: ReadOnlyNamespaceResolver;
  superblock: OpenedSuperblockCopies;
}>;

type AuthenticatedCredentialAuthorityUpdate = Readonly<{
  superblock: OpenedSuperblockCopies;
  unlockingSlotId: import("@/00-storage/service/hizofs/00-format").CredentialSlotId;
  unlockSequence: import("@/00-storage/service/hizofs/00-format").UnlockSequence;
}>;

type AuthenticatedCredentialAuthorityUpdater = ({ update }: {
  update: AuthenticatedCredentialAuthorityUpdate;
}) => void;

export type AuthenticatedApplicationReadWriteSessionResources = Readonly<{
  createReadSnapshotResources: () => Readonly<{
    commitReference: HomeRecordReference;
    mutationPort: import("@/00-storage/service/hizofs/api").HizoFSApplicationMutationPort;
    namespace: HizoFSApplicationSessionNamespace;
  }>;
  mutationPort: import("@/00-storage/service/hizofs/api").HizoFSApplicationMutationPort;
  namespace: HizoFSApplicationSessionNamespace;
  releaseResources: () => Promise<void>;
  workerMountGrantIssuer: HizoFSWorkerMountGrantIssuer;
}>;

const DEFAULT_EXPLICIT_BULK_LIMITS = Object.freeze({
  candidate: Object.freeze({ maxEntries: 100_000, maxInlineFileBytesTotal: 16 * 1024 * 1024 }),
  directoryImport: Object.freeze({ maximumEntryMutationsPerBatch: 64 }),
});

type AuthenticatedOpenedWritableApplicationAuthorityCommon = Readonly<{
  canonicalBackingLocation: string;
  opened: OpenedEmptyEncryptedContainer;
  explicitBulkLimits: Readonly<{
    candidate: Readonly<{ maxEntries: number; maxInlineFileBytesTotal: number }>;
    directoryImport: StreamingDirectoryImportLimits;
  }>;
  fileMutationLimits: FileContentMutationLimits;
  operationTimestamp: () => TimestampMilliseconds;
  indexDiagnostics?: ImmutableBTreeDiagnosticsPort;
  randomSource?: RandomByteSource;
  recordDiagnostics?: AuthenticatedStoreDiagnosticsPort;
  removalLimits: Readonly<{ deleteBatchSize: number; maxVisitedInodes: number }>;
  recheckGenerationAuthority: ({ commit, superblock }: {
    commit: FileSystemCommitPayload;
    superblock: OpenedSuperblockCopies;
  }) => Promise<void>;
  rootSubvolumeId: SubvolumeId;
  supportedFeatureBits: FeatureBits;
}>;

export type AuthenticatedOpenedWritableApplicationAuthority =
  AuthenticatedOpenedWritableApplicationAuthorityCommon & (
    | Readonly<{
        backend: HizoFSDevelopmentWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
        writableProfile: "development-unverified";
      }>
    | Readonly<{
        backend: HizoFSCrashDurableWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
        writableProfile: "release-qualified";
      }>
  );

export class HizoFSApplicationMutationCommittedDegradedError extends Error {
  constructor({ cause }: { cause: unknown }) {
    super("HizoFS mutation committed but Superblock redundancy did not converge", { cause });
    this.name = "HizoFSApplicationMutationCommittedDegradedError";
  }
}

export class HizoFSApplicationMutationSessionPoisonedError extends Error {
  constructor({ cause }: { cause: unknown }) {
    super("HizoFS writable application generation requires close and reopen", { cause });
    this.name = "HizoFSApplicationMutationSessionPoisonedError";
  }
}

function mutationIdentity({ mutationId }: { mutationId: MutationId }): string {
  let identity = "";
  for (const byte of mutationId) identity += byte.toString(16).padStart(2, "0");
  return identity;
}

function sameCommitPayload({ left, right }: {
  left: FileSystemCommitPayload;
  right: FileSystemCommitPayload;
}): boolean {
  return bytesEqual({
    left: encodeFileSystemCommitPayload({ payload: left }),
    right: encodeFileSystemCommitPayload({ payload: right }),
  });
}

function writableGeneration({ backend, commit, fileSystemId, metadataRecordCache, recordDiagnostics, rootKey, superblock }: {
  backend: HizoFSReadableBackend;
  commit: FileSystemCommitPayload;
  fileSystemId: OpenedEmptyEncryptedContainer["fileSystemId"];
  metadataRecordCache: AuthenticatedMetadataRecordCache;
  recordDiagnostics?: AuthenticatedStoreDiagnosticsPort;
  rootKey: OpenedEmptyEncryptedContainer["rootKey"];
  superblock: OpenedSuperblockCopies;
}): AuthenticatedWritableApplicationGeneration {
  if (
    commit.commitSequence !== superblock.logicalState.activeCommitSequence
    || !bytesEqual({ left: commit.mutationId, right: superblock.logicalState.activeMutationId })
  ) {
    throw new TypeError("application generation Commit does not match its Superblock authority");
  }
  return {
    commit,
    resolver: createAuthenticatedReadOnlyNamespaceResolver({
      commit,
      recordSource: createAuthenticatedNamespaceRecordSource({
        backend,
        diagnostics: recordDiagnostics,
        fileSystemId,
        metadataRecordCache,
        relocationIndexRootPhysicalRef: superblock.logicalState.relocationIndexRootPhysicalRef,
        rootKey,
      }),
    }),
    superblock,
  };
}

function stableGenerationNamespace({ current }: {
  current: () => AuthenticatedWritableApplicationGeneration;
}): ReadOnlyNamespace {
  return {
    list: async ({ pathComponents }) => {
      const resolver = current().resolver;
      return await resolver.list({ pathComponents: [...pathComponents] });
    },
    listBounded: async ({ maximumEntries, pathComponents }) => {
      const resolver = current().resolver;
      return await resolver.listBounded({ maximumEntries, pathComponents: [...pathComponents] });
    },
    readFile: async ({ length, offset, pathComponents }) => {
      const resolver = current().resolver;
      return await resolver.readFile({ length, offset, pathComponents: [...pathComponents] });
    },
    readlink: async ({ pathComponents }) => {
      const resolver = current().resolver;
      return await resolver.readlink({ pathComponents: [...pathComponents] });
    },
    stat: async ({ pathComponents }) => {
      const resolver = current().resolver;
      return await resolver.stat({ pathComponents: [...pathComponents] });
    },
  };
}

function requireWritableParentDirectory({ inode }: {
  inode: Awaited<ReturnType<ReadOnlyNamespaceResolver["resolveInode"]>>;
}): DirectoryInodeEntry {
  switch (inode.inodeKind) {
  case "directory": return inode;
  case "file":
  case "symlink": throw new TypeError("ordinary entry creation parent is not a directory");
  default: return inode satisfies never;
  }
}

function requireWritableFile({ inode }: {
  inode: Awaited<ReturnType<ReadOnlyNamespaceResolver["resolveInode"]>>;
}): FileInodeEntry {
  switch (inode.inodeKind) {
  case "file": return inode;
  case "directory":
  case "symlink": throw new TypeError("writable target is not a file");
  default: return inode satisfies never;
  }
}

/**
 * Owns one mutable application generation without exposing its root key,
 * physical backend, authenticated writer, or Superblock authority. Every read
 * captures one immutable resolver. Every mutation runs under the runtime writer
 * lease, rechecks external authority, publishes a converged Commit, and only
 * then swaps the generation visible to later reads.
 */
export function createAuthenticatedApplicationReadWriteSessionResources({
  backend,
  canonicalBackingLocation,
  explicitBulkLimits,
  fileMutationLimits,
  indexDiagnostics,
  opened,
  operationTimestamp,
  randomSource,
  recordDiagnostics,
  registerCredentialAuthorityUpdater,
  metadataRecordCachePolicy,
  removalLimits,
  recheckGenerationAuthority,
  rootSubvolumeId,
  runtimeHost,
  supportedFeatureBits,
  writableProfile,
}: AuthenticatedOpenedWritableApplicationAuthority & Readonly<{
  registerCredentialAuthorityUpdater?: ({ updater }: {
    updater: AuthenticatedCredentialAuthorityUpdater;
  }) => void;
  metadataRecordCachePolicy?: AuthenticatedMetadataRecordCachePolicy;
  runtimeHost: Pick<
    import("@/00-storage/service/hizofs/worker/runtime-host").HizoFSWorkerRuntimeHost,
    "acquireWriterDependencyRoot"
  >;
}>): AuthenticatedApplicationReadWriteSessionResources {
  switch (writableProfile) {
  case "development-unverified":
    if (
      backend.capabilities.fileDataDurability !== "not-demonstrated"
      || backend.capabilities.directoryEntryDurability !== "not-demonstrated"
    ) {
      throw new TypeError("development-unverified profile must preserve not-demonstrated durability claims");
    }
    break;
  case "release-qualified":
    if (!hasCrashDurableWritableSemantics(backend)) {
      throw new TypeError("release-qualified profile requires demonstrated crash-durable backend capabilities");
    }
    break;
  default: return writableProfile satisfies never;
  }
  switch (opened.dataOpenMode) {
  case "normal": break;
  case "fallback_read_only": throw new TypeError("fallback HizoFS generation cannot open a writable application session");
  default: return opened.dataOpenMode satisfies never;
  }
  switch (opened.superblock.copyState) {
  case "normal": break;
  case "superblock_redundancy_degraded":
    throw new TypeError("writable application session requires converged Superblock copies");
  default: return opened.superblock.copyState satisfies never;
  }

  let released = false;
  let mutationPoison: unknown | undefined;
  const metadataRecordCache = new AuthenticatedMetadataRecordCache({
    diagnostics: recordDiagnostics,
    policy: metadataRecordCachePolicy ?? APPLICATION_METADATA_RECORD_CACHE_POLICY,
  });
  const createGeneration = ({ commit, superblock }: {
    commit: FileSystemCommitPayload;
    superblock: OpenedSuperblockCopies;
  }): AuthenticatedWritableApplicationGeneration => writableGeneration({
    backend,
    commit,
    fileSystemId: opened.fileSystemId,
    metadataRecordCache,
    recordDiagnostics,
    rootKey: opened.rootKey,
    superblock,
  });
  let generation = createGeneration({
    commit: opened.commit,
    superblock: opened.superblock,
  });
  let activeUnlockingSlotId = opened.unlockingSlotId;
  let activeUnlockSequence = opened.unlockSequence;
  registerCredentialAuthorityUpdater?.({
    updater: ({ update }) => {
      if (released) throw new TypeError("cannot update credential authority for a released application session");
      switch (update.superblock.copyState) {
      case "normal": break;
      case "superblock_redundancy_degraded":
        throw new TypeError("application session credential authority update requires converged Superblock copies");
      default: return update.superblock.copyState satisfies never;
      }
      if (!sameSuperblockLogicalStateExceptMinimumUnlockSequence({
        left: generation.superblock.logicalState,
        right: update.superblock.logicalState,
      })) {
        throw new TypeError("credential authority update changed filesystem generation state");
      }
      if (update.unlockSequence !== update.superblock.logicalState.minimumUnlockSequence
        || update.unlockSequence <= activeUnlockSequence) {
        throw new TypeError("credential authority update did not advance the active Unlock Sequence");
      }
      generation = createGeneration({
        commit: generation.commit,
        superblock: update.superblock,
      });
      activeUnlockingSlotId = update.unlockingSlotId;
      activeUnlockSequence = update.unlockSequence;
    },
  });
  const usedMutationIds = new Set<string>([
    mutationIdentity({ mutationId: generation.commit.mutationId }),
  ]);
  type FreshExplicitBulkTarget = Readonly<{
    commitSequence: FileSystemCommitPayload["commitSequence"];
    directory: Pick<DirectoryInodeEntry, "inodeNumber" | "inodeRevision" | "timestamps">;
    mutationIdentity: string;
    targetIdentity: string;
  }>;
  // Directory emptiness is observable state, not provenance. Only a successful
  // create in this session may mint the single-use capability used by bulk open.
  let freshExplicitBulkTarget: FreshExplicitBulkTarget | undefined;
  const explicitBulkTargetIdentity = ({ path }: { path: readonly string[] }): string => JSON.stringify(path);
  const invalidateFreshExplicitBulkTarget = (): void => {
    freshExplicitBulkTarget = undefined;
  };
  const containerCoordinationKey = Object.freeze({}) as ContainerCoordinationKey;

  type PublicationResolutionAuthority = Readonly<{
    resolvePublication: AuthenticatedMetadataMutationAuthority["resolvePublication"];
  }>;

  const resolveFailedPublication = async ({
    applicationAuthority,
    authority,
    base,
    cause,
    operationLabel,
  }: {
    applicationAuthority: import("@/00-storage/service/hizofs/api").HizoFSApplicationPublicationAuthority;
    authority: PublicationResolutionAuthority;
    base: AuthenticatedWritableApplicationGeneration;
    cause: PreparedMutationCommitPublicationError;
    operationLabel: string;
  }): Promise<void> => {
    let resolution: Awaited<ReturnType<PublicationResolutionAuthority["resolvePublication"]>>;
    try {
      resolution = await authority.resolvePublication({
        base: base.superblock,
        intendedLogicalState: cause.intendedLogicalState,
      });
    } catch (resolutionCause: unknown) {
      mutationPoison = resolutionCause;
      throw new AggregateError(
        [cause, resolutionCause],
        `${operationLabel} publication failed and authoritative outcome resolution also failed`,
      );
    }

    switch (resolution.type) {
    case "not_published":
      switch (resolution.superblock.copyState) {
      case "normal": break;
      case "superblock_redundancy_degraded": mutationPoison = cause; break;
      default: return resolution.superblock.copyState satisfies never;
      }
      generation = createGeneration({
        commit: base.commit,
        superblock: resolution.superblock,
      });
      throw cause;
    case "publication_conflict":
      mutationPoison = cause;
      throw new HizoFSApplicationMutationSessionPoisonedError({ cause });
    case "published": {
      let reopened: Awaited<ReturnType<typeof readBootstrapRoot>>;
      try {
        reopened = await readBootstrapRoot({
          authority: {
            commitHomeRef: cause.commitHomeRef,
            commitSequence: cause.commitPayload.commitSequence,
            mutationId: cause.commitPayload.mutationId,
            type: "active",
          },
          backend,
          fileSystemId: opened.fileSystemId,
          relocationIndexRootPhysicalRef: resolution.superblock.logicalState.relocationIndexRootPhysicalRef,
          rootKey: opened.rootKey,
        });
      } catch (verificationCause: unknown) {
        mutationPoison = verificationCause;
        throw new AggregateError(
          [cause, verificationCause],
          `published ${operationLabel} authority could not be verified`,
        );
      }
      if (!sameCommitPayload({ left: reopened.commit, right: cause.commitPayload })) {
        const mismatch = new TypeError(
          `published ${operationLabel} Commit payload does not match the prepared mutation`,
        );
        mutationPoison = mismatch;
        throw mismatch;
      }
      generation = createGeneration({
        commit: reopened.commit,
        superblock: resolution.superblock,
      });
      applicationAuthority.markCommitPointCrossed();
      switch (resolution.superblock.copyState) {
      case "normal": return;
      case "superblock_redundancy_degraded":
        mutationPoison = cause;
        throw new HizoFSApplicationMutationCommittedDegradedError({ cause });
      default: return resolution.superblock.copyState satisfies never;
      }
    }
    default: return resolution satisfies never;
    }
  };

  const collectOrdinarySubtree = async ({ resolver, sourceEntry }: {
    resolver: ReadOnlyNamespaceResolver;
    sourceEntry: DirectoryLeafEntry | undefined;
  }): Promise<Readonly<{
    directoryEntries: ReadonlyMap<InodeNumber, readonly DirectoryLeafEntry[]>;
    visitedInodeNumbers: readonly InodeNumber[];
  }>> => {
    const directoryEntries = new Map<InodeNumber, readonly DirectoryLeafEntry[]>();
    if (sourceEntry === undefined) return { directoryEntries, visitedInodeNumbers: [] };

    const visited = new Set<InodeNumber>();
    const pending: DirectoryLeafEntry[] = [sourceEntry];
    while (pending.length > 0) {
      const entry = pending.pop();
      if (entry === undefined) throw new Error("ordinary subtree traversal stack became inconsistent");
      switch (entry.targetType) {
      case "subvolume": continue;
      case "inode": break;
      default: entry satisfies never;
      }
      if (visited.has(entry.inodeNumber)) continue;
      if (visited.size >= removalLimits.maxVisitedInodes) {
        throw new RangeError("ordinary subtree traversal exceeded its configured inode budget");
      }
      visited.add(entry.inodeNumber);

      const inode = await resolver.resolveInodeByNumber({ inodeNumber: entry.inodeNumber });
      if (inode.inodeKind !== entry.inodeKind) {
        throw new TypeError("ordinary subtree directory entry disagrees with the Inode Table");
      }
      switch (inode.inodeKind) {
      case "file":
      case "symlink": break;
      case "directory": {
        const remainingBudget = removalLimits.maxVisitedInodes - visited.size - pending.length;
        if (remainingBudget < 0) {
          throw new RangeError("ordinary subtree traversal exceeded its configured inode budget");
        }
        const listing = await resolver.listDirectoryEntriesBounded({
          inode,
          maximumEntries: remainingBudget + 1,
        });
        if (listing.truncated || listing.entries.length > remainingBudget) {
          throw new RangeError("ordinary subtree traversal exceeded its configured inode budget");
        }
        directoryEntries.set(inode.inodeNumber, listing.entries);
        for (let index = listing.entries.length - 1; index >= 0; index -= 1) {
          const child = listing.entries[index];
          if (child === undefined) throw new Error("ordinary subtree directory index became inconsistent");
          pending.push(child);
        }
        break;
      }
      default: inode satisfies never;
      }
    }
    return { directoryEntries, visitedInodeNumbers: [...visited] };
  };

  const inspectMoveDestination = async ({ entry, resolver }: {
    entry: DirectoryLeafEntry | undefined;
    resolver: ReadOnlyNamespaceResolver;
  }): Promise<Readonly<{
    directoryContainsSubvolumeMount: boolean;
    directoryEmpty: boolean;
  }>> => {
    if (entry === undefined) {
      return { directoryContainsSubvolumeMount: false, directoryEmpty: true };
    }
    switch (entry.targetType) {
    case "subvolume": return { directoryContainsSubvolumeMount: true, directoryEmpty: false };
    case "inode": break;
    default: return entry satisfies never;
    }
    const inode = await resolver.resolveInodeByNumber({ inodeNumber: entry.inodeNumber });
    if (inode.inodeKind !== entry.inodeKind) {
      throw new TypeError("ordinary move destination binding disagrees with the Inode Table");
    }
    switch (inode.inodeKind) {
    case "file":
    case "symlink": return { directoryContainsSubvolumeMount: false, directoryEmpty: true };
    case "directory": {
      const listing = await resolver.listDirectoryEntriesBounded({ inode, maximumEntries: 1 });
      return {
        directoryContainsSubvolumeMount: listing.entries.some(child => child.targetType === "subvolume"),
        directoryEmpty: listing.entries.length === 0,
      };
    }
    default: return inode satisfies never;
    }
  };

  const runMutation = async ({ applicationAuthority, prepare }: {
    applicationAuthority: import("@/00-storage/service/hizofs/api").HizoFSApplicationPublicationAuthority;
    prepare: ({ base, metadataAuthority, mutationId, operationTimestamp }: {
      base: AuthenticatedWritableApplicationGeneration;
      metadataAuthority: AuthenticatedMetadataMutationAuthority;
      mutationId: MutationId;
      operationTimestamp: TimestampMilliseconds;
    }) => Promise<Readonly<{
      commitPayload: FileSystemCommitPayload;
      publication: PublishedPreparedMutationCommit;
    }> | null>;
  }): Promise<void> => {
    invalidateFreshExplicitBulkTarget();
    if (mutationPoison !== undefined) {
      throw new HizoFSApplicationMutationSessionPoisonedError({ cause: mutationPoison });
    }
    applicationAuthority.assertPublicationAllowed();
    const base = generation;
    await recheckGenerationAuthority({ commit: base.commit, superblock: base.superblock });
    applicationAuthority.assertPublicationAllowed();

    // The captured base Commit must remain reachable until this writer has
    // either published a successor generation or settled without publication.
    const writerDependency = runtimeHost.acquireWriterDependencyRoot({
      commitReference: base.superblock.logicalState.activeCommitHomeRef,
    });
    const performMutation = async (): Promise<void> => {
      const mutationId = await generateMutationId({
        isUsed: async ({ id }) => usedMutationIds.has(mutationIdentity({ mutationId: id })),
        randomSource,
      });
      usedMutationIds.add(mutationIdentity({ mutationId }));
      const metadataAuthority = await createAuthenticatedMetadataMutationAuthority({
        backend,
        diagnostics: recordDiagnostics,
        fileSystemId: opened.fileSystemId,
        randomSource,
        relocationIndexRootPhysicalRef: base.superblock.logicalState.relocationIndexRootPhysicalRef,
        rootKey: opened.rootKey,
        sharedMetadataRecordCache: metadataRecordCache,
        supportedFeatureBits,
      });
      try {
        const result = await prepare({
          base,
          metadataAuthority,
          mutationId,
          operationTimestamp: operationTimestamp(),
        });
        if (result === null) {
          metadataAuthority.abandon();
          applicationAuthority.markNoChangeResolved();
          return;
        }
        const nextGeneration = createGeneration({
          commit: result.commitPayload,
          superblock: result.publication.superblock,
        });
        applicationAuthority.markCommitPointCrossed();
        generation = nextGeneration;
      } catch (cause: unknown) {
        if (!(cause instanceof PreparedMutationCommitPublicationError)) {
          const metadataAuthorityState = metadataAuthority.state();
          switch (metadataAuthorityState) {
          case "active": metadataAuthority.abandon(); break;
          case "closed": break;
          case "publishing": {
            const unresolved = new AggregateError(
              [cause],
              "mutation preparation failed while publication outcome remained unresolved",
            );
            mutationPoison = unresolved;
            throw unresolved;
          }
          default: return metadataAuthorityState satisfies never;
          }
          throw cause;
        }

        await resolveFailedPublication({
          applicationAuthority,
          authority: metadataAuthority,
          base,
          cause,
          operationLabel: "mutation",
        });
      }
    };
    let operationFailed = false;
    let operationFailure: unknown;
    try {
      await performMutation();
    } catch (cause: unknown) {
      operationFailed = true;
      operationFailure = cause;
    }
    let releaseFailed = false;
    let releaseFailure: unknown;
    try {
      writerDependency.release();
    } catch (cause: unknown) {
      releaseFailed = true;
      releaseFailure = cause;
    }
    if (operationFailed) {
      if (releaseFailed) {
        throw new AggregateError(
          [operationFailure, releaseFailure],
          "mutation operation and writer dependency release both failed",
        );
      }
      throw operationFailure;
    }
    if (releaseFailed) throw releaseFailure;
  };


  const cloneFile = async ({ authority, destinationPath, name, newName, path, replace }: {
    authority: import("@/00-storage/service/hizofs/api").HizoFSApplicationPublicationAuthority;
    destinationPath: readonly string[];
    name: string;
    newName: string;
    path: readonly string[];
    replace: boolean;
  }): Promise<void> => await runMutation({
    applicationAuthority: authority,
    prepare: async ({ base, metadataAuthority, mutationId, operationTimestamp: timestamp }) => {
      const sourceParent = requireWritableParentDirectory({
        inode: await base.resolver.resolveInode({ pathComponents: [...path] }),
      });
      const destinationParent = requireWritableParentDirectory({
        inode: await base.resolver.resolveInode({ pathComponents: [...destinationPath] }),
      });
      const sourceEntry = await base.resolver.lookupDirectoryEntry({ directory: sourceParent, name });
      const sourceInode = await (async () => {
        if (sourceEntry === undefined) return null;
        switch (sourceEntry.targetType) {
        case "subvolume": return null;
        case "inode": {
          const inode = await base.resolver.resolveInodeByNumber({ inodeNumber: sourceEntry.inodeNumber });
          if (inode.inodeKind !== sourceEntry.inodeKind) {
            throw new TypeError("whole-file reflink source binding disagrees with the Inode Table");
          }
          return inode;
        }
        default: return sourceEntry satisfies never;
        }
      })();
      const destinationEntry = await base.resolver.lookupDirectoryEntry({
        directory: destinationParent,
        name: newName,
      });
      const knownInodeNumbers = await base.resolver.knownInodeNumbers();
      return await publishAuthenticatedWholeFileReflink({
        assertPublicationAllowed: authority.assertPublicationAllowed,
        authority: metadataAuthority,
        indexDiagnostics,
        baseCommit: base.commit,
        baseSuperblock: base.superblock,
        destinationParent,
        knownInodeNumbers,
        mutationId,
        operationTimestamp: timestamp,
        source: {
          containerCoordinationKey,
          inode: sourceInode,
          reachable: sourceEntry !== undefined,
        },
        target: {
          containerCoordinationKey,
          destinationIsSource: sourceParent.inodeNumber === destinationParent.inodeNumber && name === newName,
          entryName: newName,
          existingEntry: destinationEntry ?? null,
          parentAccess: "read_write",
          parentDirectoryInodeNumber: destinationParent.inodeNumber,
          replace,
        },
      });
    },
  });

  const createEntry = async ({ authority, name, path, request }: {
    authority: import("@/00-storage/service/hizofs/api").HizoFSApplicationPublicationAuthority;
    name: string;
    path: readonly string[];
    request: OrdinaryEntryCreateRequest;
  }): Promise<void> => {
    let freshDirectory: Omit<FreshExplicitBulkTarget, "targetIdentity"> | undefined;
    await runMutation({
      applicationAuthority: authority,
      prepare: async ({ base, metadataAuthority, mutationId, operationTimestamp: timestamp }) => {
        const parent = requireWritableParentDirectory({
          inode: await base.resolver.resolveInode({ pathComponents: [...path] }),
        });
        const destination = await base.resolver.lookupDirectoryEntry({ directory: parent, name });
        const knownInodeNumbers = await base.resolver.knownInodeNumbers();
        const published = await publishAuthenticatedOrdinaryEntryCreate({
          assertPublicationAllowed: authority.assertPublicationAllowed,
          authority: metadataAuthority,
          indexDiagnostics,
          baseCommit: base.commit,
          baseSuperblock: base.superblock,
          knownInodeNumbers,
          mutationId,
          operationTimestamp: timestamp,
          parent,
          request,
          target: {
            destinationExists: destination !== undefined,
            entryName: name,
            parentAccess: "read_write",
            parentDirectoryInodeNumber: parent.inodeNumber,
            parentSubvolumeId: rootSubvolumeId,
          },
        });
        switch (request.type) {
        case "directory": {
          const inode = published.plan.inode;
          switch (inode.inodeKind) {
          case "directory":
            freshDirectory = {
              commitSequence: published.commitPayload.commitSequence,
              directory: {
                inodeNumber: inode.inodeNumber,
                inodeRevision: inode.inodeRevision,
                timestamps: { ...inode.timestamps },
              },
              mutationIdentity: mutationIdentity({ mutationId: published.commitPayload.mutationId }),
            };
            break;
          case "file":
          case "symlink": throw new TypeError("directory creation produced a non-directory inode");
          default: return inode satisfies never;
          }
          break;
        }
        case "file":
        case "symlink": break;
        default: return request satisfies never;
        }
        return published;
      },
    });
    if (freshDirectory !== undefined) {
      freshExplicitBulkTarget = {
        ...freshDirectory,
        targetIdentity: explicitBulkTargetIdentity({ path: [...path, name] }),
      };
    }
  };

  const moveEntry = async ({ authority, destinationPath, name, newName, path, replace }: {
    authority: import("@/00-storage/service/hizofs/api").HizoFSApplicationPublicationAuthority;
    destinationPath: readonly string[];
    name: string;
    newName: string;
    path: readonly string[];
    replace: boolean;
  }): Promise<void> => await runMutation({
    applicationAuthority: authority,
    prepare: async ({ base, metadataAuthority, mutationId, operationTimestamp: timestamp }) => {
      const sourceParent = requireWritableParentDirectory({
        inode: await base.resolver.resolveInode({ pathComponents: [...path] }),
      });
      const destinationParent = requireWritableParentDirectory({
        inode: await base.resolver.resolveInode({ pathComponents: [...destinationPath] }),
      });
      const sourceEntry = await base.resolver.lookupDirectoryEntry({ directory: sourceParent, name });
      const destinationEntry = await base.resolver.lookupDirectoryEntry({ directory: destinationParent, name: newName });
      const subtree = await collectOrdinarySubtree({ resolver: base.resolver, sourceEntry });
      const destinationState = await inspectMoveDestination({ entry: destinationEntry, resolver: base.resolver });
      const sourceInodeNumber = (() => {
        if (sourceEntry === undefined) return undefined;
        switch (sourceEntry.targetType) {
        case "inode": return sourceEntry.inodeNumber;
        case "subvolume": return undefined;
        default: return sourceEntry satisfies never;
        }
      })();
      const plan = prepareOrdinaryEntryMovePlan({
        destination: {
          ...destinationState,
          entry: destinationEntry ?? null,
          parentAccess: "read_write",
          parentDirectoryInodeNumber: destinationParent.inodeNumber,
          parentSubvolumeId: rootSubvolumeId,
        },
        destinationName: newName,
        replace,
        source: {
          directoryDescendantInodeNumbers: subtree.visitedInodeNumbers.filter(
            inodeNumber => inodeNumber !== sourceInodeNumber,
          ),
          entry: sourceEntry ?? null,
          parentAccess: "read_write",
          parentDirectoryInodeNumber: sourceParent.inodeNumber,
          parentSubvolumeId: rootSubvolumeId,
        },
      });
      if (plan === null) return null;
      return await publishAuthenticatedOrdinaryEntryMove({
        assertPublicationAllowed: authority.assertPublicationAllowed,
        authority: metadataAuthority,
        indexDiagnostics,
        baseCommit: base.commit,
        baseSuperblock: base.superblock,
        destinationParent,
        mutationId,
        operationTimestamp: timestamp,
        plan,
        sourceParent,
      });
    },
  });

  const removeEntry = async ({ authority, name, path, recursive }: {
    authority: import("@/00-storage/service/hizofs/api").HizoFSApplicationPublicationAuthority;
    name: string;
    path: readonly string[];
    recursive: boolean;
  }): Promise<void> => await runMutation({
    applicationAuthority: authority,
    prepare: async ({ base, metadataAuthority, mutationId, operationTimestamp: timestamp }) => {
      const parent = requireWritableParentDirectory({
        inode: await base.resolver.resolveInode({ pathComponents: [...path] }),
      });
      const sourceEntry = await base.resolver.lookupDirectoryEntry({ directory: parent, name });
      const subtree = await collectOrdinarySubtree({
        resolver: base.resolver,
        sourceEntry,
      });
      const plan = prepareOrdinaryEntryRemovalPlan({
        directoryEntries: subtree.directoryEntries,
        limits: removalLimits,
        parentAccess: "read_write",
        parentDirectoryInodeNumber: parent.inodeNumber,
        parentSubvolumeId: rootSubvolumeId,
        recursive,
        sourceEntry: sourceEntry ?? null,
      });
      return await publishAuthenticatedOrdinaryEntryRemoval({
        assertPublicationAllowed: authority.assertPublicationAllowed,
        authority: metadataAuthority,
        indexDiagnostics,
        baseCommit: base.commit,
        baseSuperblock: base.superblock,
        mutationId,
        operationTimestamp: timestamp,
        parent,
        plan,
      });
    },
  });


  const openExplicitBulk = async ({ path }: {
    path: readonly string[];
  }): Promise<HizoFSApplicationPreparedExplicitBulk> => {
    if (mutationPoison !== undefined) {
      throw new HizoFSApplicationMutationSessionPoisonedError({ cause: mutationPoison });
    }
    const targetIdentity = explicitBulkTargetIdentity({ path });
    const freshTarget = freshExplicitBulkTarget;
    // A failed or misdirected open consumes the capability so callers cannot
    // probe paths and later reuse an authority whose generation may be stale.
    invalidateFreshExplicitBulkTarget();
    if (freshTarget === undefined || freshTarget.targetIdentity !== targetIdentity) {
      throw new TypeError("explicit bulk target was not freshly created by this application session");
    }

    const base = generation;
    await recheckGenerationAuthority({ commit: base.commit, superblock: base.superblock });
    if (
      base.commit.commitSequence !== freshTarget.commitSequence
      || mutationIdentity({ mutationId: base.commit.mutationId }) !== freshTarget.mutationIdentity
    ) {
      throw new TypeError("explicit bulk target freshness capability does not match the current generation");
    }
    const targetDirectory = requireWritableParentDirectory({
      inode: await base.resolver.resolveInode({ pathComponents: [...path] }),
    });
    if (
      targetDirectory.inodeNumber !== freshTarget.directory.inodeNumber
      || targetDirectory.inodeRevision !== freshTarget.directory.inodeRevision
    ) {
      throw new TypeError("explicit bulk target identity changed after its fresh-directory publication");
    }
    const listing = await base.resolver.listDirectoryEntriesBounded({
      inode: targetDirectory,
      maximumEntries: 1,
    });
    if (listing.entries.length !== 0) {
      throw new TypeError("explicit bulk target is no longer empty");
    }

    const builder = new ExplicitBulkBuilder({
      candidate: {
        limits: explicitBulkLimits.candidate,
        nextInodeNumber: base.commit.nextInodeNumber,
        rootDirectory: {
          inodeNumber: targetDirectory.inodeNumber,
          inodeRevision: targetDirectory.inodeRevision,
          timestamps: { ...targetDirectory.timestamps },
        },
      },
      ownerView: "mutable_live",
      target: { empty: true, fresh: true },
    });
    const writerDependency = runtimeHost.acquireWriterDependencyRoot({
      commitReference: base.superblock.logicalState.activeCommitHomeRef,
    });
    let writerDependencyActive = true;
    const releaseWriterDependency = (): void => {
      if (!writerDependencyActive) return;
      writerDependencyActive = false;
      writerDependency.release();
    };
    const settle = async ({ message, operation }: {
      message: string;
      operation: () => Promise<void>;
    }): Promise<void> => {
      let primary: unknown | undefined;
      try {
        await operation();
      } catch (cause: unknown) {
        primary = cause;
      }
      try {
        releaseWriterDependency();
      } catch (releaseCause: unknown) {
        if (primary !== undefined) throw new AggregateError([primary, releaseCause], message);
        throw releaseCause;
      }
      if (primary !== undefined) throw primary;
    };

    return {
      abort: async () => await settle({
        message: "explicit bulk abort and writer dependency release both failed",
        operation: async () => builder.abort(),
      }),
      commit: async ({ authority }) => await settle({
        message: "explicit bulk commit and writer dependency release both failed",
        operation: async () => {
          await builder.commit({
            prepare: async ({ candidate }) => candidate,
            publish: async ({ candidate }) => {
              if (
                generation.commit.commitSequence !== freshTarget.commitSequence
                || mutationIdentity({ mutationId: generation.commit.mutationId }) !== freshTarget.mutationIdentity
              ) {
                throw new TypeError("explicit bulk base generation changed while its writer capability was held");
              }
              await runMutation({
                applicationAuthority: authority,
                prepare: async ({ base: currentBase, metadataAuthority, mutationId }) => (
                  await publishAuthenticatedExplicitBulkCommit({
                    assertPublicationAllowed: authority.assertPublicationAllowed,
                    authority: metadataAuthority,
                    baseCommit: currentBase.commit,
                    baseSuperblock: currentBase.superblock,
                    candidate,
                    directoryImportLimits: explicitBulkLimits.directoryImport,
                    indexDiagnostics,
                    mutationId,
                  })
                ),
              });
            },
          });
        },
      }),
      createEmptyFile: async ({ name }) => {
        await builder.createEmptyFile({
          name,
          parentDirectoryInodeNumber: targetDirectory.inodeNumber,
          timestamp: operationTimestamp(),
        });
      },
    };
  };

  const openWritable = async ({ keepExistingData, path }: {
    keepExistingData: boolean;
    path: readonly string[];
  }): Promise<HizoFSApplicationPreparedWritable> => {
    invalidateFreshExplicitBulkTarget();
    if (mutationPoison !== undefined) {
      throw new HizoFSApplicationMutationSessionPoisonedError({ cause: mutationPoison });
    }
    const base = generation;
    await recheckGenerationAuthority({ commit: base.commit, superblock: base.superblock });
    const source = requireWritableFile({
      inode: await base.resolver.resolveInode({ pathComponents: [...path] }),
    });
    const fileAuthority = await createAuthenticatedFileContentMutationAuthority({
      backend,
      diagnostics: recordDiagnostics,
      fileSystemId: opened.fileSystemId,
      randomSource,
      relocationIndexRootPhysicalRef: base.superblock.logicalState.relocationIndexRootPhysicalRef,
      rootKey: opened.rootKey,
      sharedMetadataRecordCache: metadataRecordCache,
      supportedFeatureBits,
    });
    const contentPort = {
      extentPageStore: createFileExtentTreePageStore({ pagePort: {
        operationDiagnostics: indexUpdateOperationDiagnostics({ diagnostics: indexDiagnostics }),
        readPage: async ({ isRoot, reference }) => await fileAuthority.readFileExtentPage({ isRoot, reference }),
        writePage: async ({ isRoot, page }) => await fileAuthority.writeFileExtentPage({ isRoot, page }),
      } }),
      writeFileData: async ({ bytes }: { bytes: Uint8Array }) => await fileAuthority.writeFileData({ bytes }),
    };
    const inodeTablePageStore = createRootInodeTablePageStore({ pagePort: {
      operationDiagnostics: indexUpdateOperationDiagnostics({ diagnostics: indexDiagnostics }),
      readPage: async ({ isRoot, reference }) => await fileAuthority.readInodeTablePage({ isRoot, reference }),
      writePage: async ({ isRoot, page }) => await fileAuthority.writeInodeTablePage({ isRoot, page }),
    } });
    let changed = false;
    let operationFailure: unknown | undefined;
    let activeOperation: Promise<void> | undefined;
    let staged = source;
    let state: "closed" | "open" = "open";

    const requireOpen = (): void => {
      switch (state) {
      case "open": break;
      case "closed": throw new Error("prepared HizoFS writable is closed");
      default: state satisfies never;
      }
      if (operationFailure !== undefined) {
        throw new HizoFSApplicationMutationSessionPoisonedError({ cause: operationFailure });
      }
      if (activeOperation !== undefined) throw new Error("prepared HizoFS writable operation already in progress");
    };

    const stage = async ({ operation }: { operation: () => Promise<void> }): Promise<void> => {
      requireOpen();
      const running = (async () => {
        try {
          await operation();
        } catch (cause: unknown) {
          operationFailure = cause;
          throw cause;
        }
      })();
      activeOperation = running;
      try {
        await running;
      } finally {
        if (activeOperation === running) activeOperation = undefined;
      }
    };

    const stageTruncate = async ({ size }: { size: bigint }): Promise<void> => await stage({
      operation: async () => {
        const plan = prepareFileTruncatePlan({
          operationTimestamp: operationTimestamp(),
          source: staged,
          targetFileSize: createFileOffset({ value: size }),
        });
        if (plan === null) return;
        try {
          staged = await prepareFileTruncateMutation({
            limits: fileMutationLimits,
            plan,
            port: contentPort,
            source: staged,
          });
          changed = true;
        } finally {
          switch (plan.action) {
          case "promote_inline_to_extent": plan.inlinePrefixBytes.fill(0); break;
          case "reuse_extent_tree":
          case "trim_extent_tree":
          case "write_inline": break;
          default: plan satisfies never;
          }
        }
      },
    });

    try {
      if (!keepExistingData) await stageTruncate({ size: 0n });
    } catch (cause: unknown) {
      fileAuthority.abandon();
      state = "closed";
      throw cause;
    }

    const preparedWritable: HizoFSApplicationPreparedWritable = {
      abort: async () => {
        if (activeOperation !== undefined) {
          try {
            await activeOperation;
          } catch {
            // The staged failure remains recorded; abort still owns cleanup.
          }
        }
        switch (state) {
        case "closed": return;
        case "open":
          fileAuthority.abandon();
          state = "closed";
          return;
        default: return state satisfies never;
        }
      },
      commit: async ({ authority: applicationAuthority }) => {
        if (activeOperation !== undefined) {
          try {
            await activeOperation;
          } catch {
            // The exact staged failure is rethrown below after cleanup.
          }
        }
        switch (state) {
        case "open": break;
        case "closed": throw new Error("prepared HizoFS writable is closed");
        default: state satisfies never;
        }
        if (operationFailure !== undefined) {
          fileAuthority.abandon();
          state = "closed";
          throw new HizoFSApplicationMutationSessionPoisonedError({ cause: operationFailure });
        }
        if (!changed) {
          fileAuthority.abandon();
          state = "closed";
          applicationAuthority.markNoChangeResolved();
          return;
        }
        try {
          applicationAuthority.assertPublicationAllowed();
          await recheckGenerationAuthority({ commit: base.commit, superblock: base.superblock });
          applicationAuthority.assertPublicationAllowed();
          const mutationId = await generateMutationId({
            isUsed: async ({ id }) => usedMutationIds.has(mutationIdentity({ mutationId: id })),
            randomSource,
          });
          usedMutationIds.add(mutationIdentity({ mutationId }));
          const prepared = await prepareRootInodeTableMutation({
            baseCommit: base.commit,
            changes: [{ entry: staged, type: "set" }],
            mutationId,
            pageStore: inodeTablePageStore,
          });
          const commitPayload = (() => {
            switch (prepared.type) {
            case "prepared": return prepared.commitPayload;
            case "unchanged": throw new Error(
              "changed prepared writable unexpectedly produced no Inode Table mutation",
            );
            default: return prepared satisfies never;
            }
          })();
          const publication = await publishPreparedMutationCommit({
            assertPublicationAllowed: applicationAuthority.assertPublicationAllowed,
            base: base.superblock,
            commitPayload,
            publicationPort: fileAuthority,
          });
          generation = createGeneration({
            commit: commitPayload,
            superblock: publication.superblock,
          });
          applicationAuthority.markCommitPointCrossed();
          state = "closed";
        } catch (cause: unknown) {
          if (!(cause instanceof PreparedMutationCommitPublicationError)) {
            const authorityState = fileAuthority.state();
            switch (authorityState) {
            case "active": fileAuthority.abandon(); break;
            case "closed": break;
            case "publishing": {
              const unresolved = new AggregateError(
                [cause],
                "file publication preparation failed while publication outcome remained unresolved",
              );
              mutationPoison = unresolved;
              state = "closed";
              throw unresolved;
            }
            default: return authorityState satisfies never;
            }
            state = "closed";
            throw cause;
          }

          state = "closed";
          await resolveFailedPublication({
            applicationAuthority,
            authority: fileAuthority,
            base,
            cause,
            operationLabel: "file mutation",
          });
        }
      },
      truncate: stageTruncate,
      write: async ({ data, position }) => await stage({
        operation: async () => {
          const plan = prepareFileWritePlan({
            bytes: data,
            operationTimestamp: operationTimestamp(),
            position: createFileOffset({ value: position }),
            source: staged,
          });
          data.fill(0);
          if (plan === null) return;
          try {
            staged = await prepareFileWriteMutation({
              limits: fileMutationLimits,
              plan,
              port: contentPort,
              source: staged,
            });
            changed = true;
          } finally {
            plan.writeBytes.fill(0);
            switch (plan.action) {
            case "promote_inline_to_extent": plan.sourceInlineBytes.fill(0); break;
            case "write_inline": plan.bytes.fill(0); break;
            case "copy_on_write_extent_range": break;
            default: plan satisfies never;
            }
          }
        },
      }),
    };
    let writerDependency: ReturnType<typeof runtimeHost.acquireWriterDependencyRoot>;
    try {
      writerDependency = runtimeHost.acquireWriterDependencyRoot({
        commitReference: base.superblock.logicalState.activeCommitHomeRef,
      });
    } catch (cause: unknown) {
      try {
        fileAuthority.abandon();
        state = "closed";
      } catch (cleanupCause: unknown) {
        throw new AggregateError(
          [cause, cleanupCause],
          "prepared writable root registration and authority cleanup both failed",
        );
      }
      throw cause;
    }
    let writerDependencyActive = true;
    const releaseWriterDependency = (): void => {
      if (!writerDependencyActive) return;
      writerDependencyActive = false;
      writerDependency.release();
    };
    const settleWithWriterDependencyRelease = async ({ message, operation }: {
      message: string;
      operation: () => Promise<void>;
    }): Promise<void> => {
      let operationFailed = false;
      let operationFailure: unknown;
      try {
        await operation();
      } catch (cause: unknown) {
        operationFailed = true;
        operationFailure = cause;
      }
      let releaseFailed = false;
      let releaseFailure: unknown;
      try {
        releaseWriterDependency();
      } catch (cause: unknown) {
        releaseFailed = true;
        releaseFailure = cause;
      }
      if (operationFailed) {
        if (releaseFailed) throw new AggregateError([operationFailure, releaseFailure], message);
        throw operationFailure;
      }
      if (releaseFailed) throw releaseFailure;
    };
    return {
      abort: async ({ reason }) => await settleWithWriterDependencyRelease({
        message: "prepared writable abort and writer dependency release both failed",
        operation: async () => await preparedWritable.abort({ reason }),
      }),
      commit: async ({ authority }) => await settleWithWriterDependencyRelease({
        message: "prepared writable commit and writer dependency release both failed",
        operation: async () => await preparedWritable.commit({ authority }),
      }),
      truncate: preparedWritable.truncate,
      write: preparedWritable.write,
    };
  };


  const mutationPort: import("@/00-storage/service/hizofs/api").HizoFSApplicationMutationPort = {
    cloneFile: async ({ authority, destinationPath, name, newName, path, replace }) => await cloneFile({
      authority,
      destinationPath,
      name,
      newName,
      path,
      replace,
    }),
    createDirectory: async ({ authority, name, path }) => await createEntry({
      authority,
      name,
      path,
      request: { type: "directory" },
    }),
    createFile: async ({ authority, name, path }) => await createEntry({
      authority,
      name,
      path,
      request: { type: "file" },
    }),
    createSymlink: async ({ authority, name, path, target }) => await createEntry({
      authority,
      name,
      path,
      request: { target, type: "symlink" },
    }),
    moveEntry: async ({ authority, destinationPath, name, newName, path, replace }) => await moveEntry({
      authority,
      destinationPath,
      name,
      newName,
      path,
      replace,
    }),
    openExplicitBulk,
    openWritable,
    removeEntry: async ({ authority, name, path, recursive }) => await removeEntry({
      authority,
      name,
      path,
      recursive,
    }),
  };

  const namespace = stableGenerationNamespace({ current: () => generation });
  return {
    createReadSnapshotResources: () => {
      const captured = generation;
      return {
        commitReference: captured.superblock.logicalState.activeCommitHomeRef,
        mutationPort: readOnlyMutationPort(),
        namespace: stableGenerationNamespace({ current: () => captured }),
      };
    },
    mutationPort,
    namespace,
    releaseResources: async () => {
      if (released) return;
      released = true;
      metadataRecordCache.dispose();
      opened.rootKey.destroy();
    },
    workerMountGrantIssuer: async ({ accessMode, path }) => await issueHizoFSWorkerMountGrant({
      accessMode,
      canonicalBackingLocation,
      currentResolver: () => generation.resolver,
      fileSystemId: opened.fileSystemId,
      path,
      rootKey: opened.rootKey,
      unlockingSlotId: activeUnlockingSlotId,
      unlockSequence: activeUnlockSequence,
    }),
  };
}

export async function openAuthenticatedReadWriteApplicationSession<Captured>({
  assertOperationAllowed,
  captureAuthority,
  recheckAuthority,
  registerCredentialAuthorityUpdater,
  metadataRecordCachePolicy,
  registerRuntimeSession,
  rootName,
  rootPath,
  runtimeHost,
  verifyCapturedAuthority,
}: {
  assertOperationAllowed?: () => void;
  captureAuthority: () => Promise<Captured>;
  recheckAuthority: ({ captured }: { captured: Captured }) => Promise<void>;
  registerCredentialAuthorityUpdater?: ({ updater }: {
    updater: AuthenticatedCredentialAuthorityUpdater;
  }) => void;
  metadataRecordCachePolicy?: AuthenticatedMetadataRecordCachePolicy;
  registerRuntimeSession?: ({ runtimeSession }: {
    runtimeSession: HizoFSApplicationRuntimeSession;
  }) => void;
  rootName?: string;
  rootPath?: readonly string[];
  runtimeHost: import("@/00-storage/service/hizofs/worker/runtime-host").HizoFSWorkerRuntimeHost;
  verifyCapturedAuthority: ({ captured }: { captured: Captured }) => Promise<AuthenticatedOpenedWritableApplicationAuthority>;
}): Promise<import("@/00-storage/service/storage-file-system/types").StorageFileSystemSession> {
  return await runtimeHost.openApplicationSession({
    ...(assertOperationAllowed === undefined ? {} : { assertOperationAllowed }),
    captureAuthority,
    createApplicationSessionResources: ({ verified }) => (
      createAuthenticatedApplicationReadWriteSessionResources({
        ...verified,
        registerCredentialAuthorityUpdater,
        metadataRecordCachePolicy,
        runtimeHost,
      })
    ),
    recheckAuthority,
    ...(registerRuntimeSession === undefined ? {} : { registerRuntimeSession }),
    rootName,
    rootPath,
    verifyCapturedAuthority,
  });
}

export class HizoFSReadOnlyGenerationError extends Error {
  constructor({ operation }: { operation: string }) {
    super(`cannot ${operation}: HizoFS generation is read-only`);
    this.name = "HizoFSReadOnlyGenerationError";
  }
}

function readOnlyMutationPort(): import("@/00-storage/service/hizofs/api").HizoFSApplicationMutationPort {
  const reject = async ({ operation }: { operation: string }): Promise<never> => {
    throw new HizoFSReadOnlyGenerationError({ operation });
  };
  return {
    cloneFile: async () => await reject({ operation: "clone a file" }),
    createDirectory: async () => await reject({ operation: "create a directory" }),
    createFile: async () => await reject({ operation: "create a file" }),
    createSymlink: async () => await reject({ operation: "create a symbolic link" }),
    moveEntry: async () => await reject({ operation: "move an entry" }),
    openWritable: async () => await reject({ operation: "open a writable file" }),
    removeEntry: async () => await reject({ operation: "remove an entry" }),
  };
}

export type AuthenticatedOpenedApplicationAuthority = Readonly<{
  backend: HizoFSReadableBackend;
  indexDiagnostics?: ImmutableBTreeDiagnosticsPort;
  opened: OpenedEmptyEncryptedContainer;
  recordDiagnostics?: AuthenticatedStoreDiagnosticsPort;
}>;

/**
 * Transfers one normal-read opaque capability into a runtime-bound session.
 *
 * The capability remains secret-opaque to the caller and is consumed exactly
 * once. The supplied recheck runs inside the runtime authority lease, after
 * the expensive container open but before session resources become visible.
 * Root-key-proof-only capabilities can authenticate transition control but can
 * never be promoted into an application namespace.
 */
export async function openAuthenticatedDevelopmentWritableApplicationSessionFromCapability({
  authority,
  canonicalBackingLocation,
  metadataRecordCachePolicy,
  recheckAuthority,
  rootName,
  runtimeHost,
}: {
  authority: AuthenticatedDevelopmentWritableContainerCapability;
  canonicalBackingLocation: string;
  metadataRecordCachePolicy?: AuthenticatedMetadataRecordCachePolicy;
  recheckAuthority: () => Promise<void>;
  rootName?: string;
  runtimeHost: import("@/00-storage/service/hizofs/worker/runtime-host").HizoFSWorkerRuntimeHost;
}): Promise<import("@/00-storage/service/storage-file-system/types").StorageFileSystemSession> {
  const lifecycle = openedDevelopmentWritableAuthorityByCapability.get(authority);
  if (lifecycle === undefined) throw new TypeError("authenticated development writable capability is foreign");
  switch (lifecycle.state) {
  case "released": throw new TypeError("authenticated development writable capability has been released");
  case "transferred": throw new TypeError("authenticated development writable capability was already transferred");
  case "owned": break;
  default: return lifecycle satisfies never;
  }

  openedDevelopmentWritableAuthorityByCapability.set(authority, { state: "transferred" });
  const { authority: openedAuthority, backend } = lifecycle;
  const supportedFeatureBits = createFeatureBits({ value: 0n });
  try {
    let credentialAuthorityUpdater: AuthenticatedCredentialAuthorityUpdater | undefined;
    let runtimeSession: HizoFSApplicationRuntimeSession | undefined;
    const operationGate: DevelopmentWritableCredentialOperationGate = {
      cause: undefined,
      outcome: "session_reopen_required",
      recoveryRequired: false,
    };
    const underlyingSession = await openAuthenticatedReadWriteApplicationSession({
      assertOperationAllowed: () => assertCredentialSessionOperationAllowed({ gate: operationGate }),
      captureAuthority: async () => authority,
      recheckAuthority: async ({ captured }) => {
        if (captured !== authority) throw new TypeError("runtime authority capture does not match the transferred capability");
        await recheckAuthority();
      },
      metadataRecordCachePolicy,
      registerCredentialAuthorityUpdater: ({ updater }) => {
        if (credentialAuthorityUpdater !== undefined) {
          throw new TypeError("application session registered more than one credential authority updater");
        }
        credentialAuthorityUpdater = updater;
      },
      registerRuntimeSession: ({ runtimeSession: registered }) => {
        if (runtimeSession !== undefined) {
          throw new TypeError("application session registered more than one runtime session");
        }
        runtimeSession = registered;
      },
      rootName,
      runtimeHost,
      verifyCapturedAuthority: async ({ captured }) => {
        if (captured !== authority) throw new TypeError("runtime authority verification does not match the transferred capability");
        return {
          backend,
          canonicalBackingLocation,
          explicitBulkLimits: DEFAULT_EXPLICIT_BULK_LIMITS,
          fileMutationLimits: { maximumExtentMutationsPerBatch: 64 },
          indexDiagnostics: openedAuthority.indexDiagnostics,
          opened: openedAuthority.opened,
          operationTimestamp: () => createTimestampMilliseconds({ value: BigInt(Date.now()) }),
          randomSource: undefined,
          recordDiagnostics: openedAuthority.recordDiagnostics,
          removalLimits: { deleteBatchSize: 64, maxVisitedInodes: 100_000 },
          recheckGenerationAuthority: async ({ commit, superblock }) => {
            const current = await openSuperblockCopies({
              backend,
              fileSystemId: openedAuthority.opened.fileSystemId,
              rootKey: openedAuthority.opened.rootKey,
              supportedFeatureBits,
            });
            if (
              current.logicalState.activeCommitSequence !== commit.commitSequence
              || !bytesEqual({ left: current.logicalState.activeMutationId, right: commit.mutationId })
              || current.logicalState.activeCommitSequence !== superblock.logicalState.activeCommitSequence
              || !bytesEqual({ left: current.logicalState.activeMutationId, right: superblock.logicalState.activeMutationId })
            ) {
              throw new Error("HizoFS generation authority changed outside the active development session");
            }
          },
          rootSubvolumeId: createSubvolumeId({ value: 1n }),
          supportedFeatureBits,
          writableProfile: "development-unverified",
        };
      },
    });
    if (credentialAuthorityUpdater === undefined) {
      await underlyingSession.close();
      throw new Error("writable application session did not register its credential authority updater");
    }
    if (runtimeSession === undefined) {
      await underlyingSession.close();
      throw new Error("writable application session did not register its runtime session");
    }
    return wrapDevelopmentWritableCredentialSession({
      state: {
        backend,
        credentialAuthorityUpdater,
        lifecycle: "open",
        operationGate,
        opened: openedAuthority.opened,
        recordDiagnostics: openedAuthority.recordDiagnostics,
        runtimeSession,
        underlyingSession,
        unlockingSlotId: openedAuthority.opened.unlockingSlotId,
      },
    });
  } catch (cause: unknown) {
    openedAuthority.opened.rootKey.destroy();
    throw cause;
  }
}

export async function openAuthenticatedReadOnlyApplicationSessionFromCapability({
  authority,
  recheckAuthority,
  rootName,
  runtimeHost,
}: {
  authority: AuthenticatedReadOnlyContainerCapability;
  recheckAuthority: () => Promise<void>;
  rootName?: string;
  runtimeHost: import("@/00-storage/service/hizofs/worker/runtime-host").HizoFSWorkerRuntimeHost;
}): Promise<import("@/00-storage/service/storage-file-system/types").StorageFileSystemSession> {
  const lifecycle = openedReadOnlyAuthorityByCapability.get(authority);
  if (lifecycle === undefined) {
    throw new TypeError("authenticated read-only container capability is foreign");
  }
  switch (lifecycle.state) {
  case "released": throw new TypeError("authenticated read-only container capability has been released");
  case "transferred": throw new TypeError("authenticated read-only container capability was already transferred");
  case "owned": break;
  default: return lifecycle satisfies never;
  }
  switch (lifecycle.value.type) {
  case "root_key_proof":
    throw new TypeError("root-key-proof-only capability cannot open an application session");
  case "normal_read": break;
  default: return lifecycle.value satisfies never;
  }

  const openedAuthority = lifecycle.value.authority;
  openedReadOnlyAuthorityByCapability.set(authority, { state: "transferred" });
  try {
    return await openAuthenticatedReadOnlyApplicationSession({
      captureAuthority: async () => authority,
      recheckAuthority: async ({ captured }) => {
        if (captured !== authority) {
          throw new TypeError("runtime authority capture does not match the transferred capability");
        }
        await recheckAuthority();
      },
      rootName,
      runtimeHost,
      verifyCapturedAuthority: async ({ captured }) => {
        if (captured !== authority) {
          throw new TypeError("runtime authority verification does not match the transferred capability");
        }
        return openedAuthority;
      },
    });
  } catch (cause: unknown) {
    // The runtime owns the same root key once resources are created. Destroy is
    // idempotent, so this also closes the pre-resource failure path without a
    // secret-bearing ownership gap.
    openedAuthority.opened.rootKey.destroy();
    throw cause;
  }
}

export async function openAuthenticatedReadOnlyApplicationSession<Captured>({
  captureAuthority,
  recheckAuthority,
  rootName,
  rootPath,
  runtimeHost,
  verifyCapturedAuthority,
}: {
  captureAuthority: () => Promise<Captured>;
  recheckAuthority: ({ captured }: { captured: Captured }) => Promise<void>;
  rootName?: string;
  rootPath?: readonly string[];
  runtimeHost: import("@/00-storage/service/hizofs/worker/runtime-host").HizoFSWorkerRuntimeHost;
  verifyCapturedAuthority: ({ captured }: { captured: Captured }) => Promise<AuthenticatedOpenedApplicationAuthority>;
}): Promise<import("@/00-storage/service/storage-file-system/types").StorageFileSystemSession> {
  return await runtimeHost.openApplicationSession({
    captureAuthority,
    createApplicationSessionResources: ({ verified }) => ({
      ...createAuthenticatedApplicationReadSessionResources(verified),
      mutationPort: readOnlyMutationPort(),
    }),
    recheckAuthority,
    rootName,
    rootPath,
    verifyCapturedAuthority,
  });
}



export async function openHizoFSWorkerMountGrant({ grant, resolveBackingDirectory }: {
  grant: StorageDirectoryWorkerMountGrant;
  resolveBackingDirectory: ({ canonicalBackingLocation, fileSystemId }: {
    canonicalBackingLocation: string;
    fileSystemId: FileSystemId;
  }) => Promise<FileSystemDirectoryHandle>;
}): Promise<StorageFileSystemSession> {
  if (grant.type !== "storage_directory_worker_mount_grant"
    || grant.version !== 1
    || grant.implementation !== "hizofs") {
    throw new TypeError("unsupported HizoFS Worker mount grant envelope");
  }
  const openedGrant = await openHizoFSWorkerMountGrantPayload({
    accessMode: grant.accessMode,
    grantId: grant.grantId,
    opaquePayload: grant.opaquePayload,
  });
  const plaintext = openedGrant.metadata;
  const rootKey = openedGrant.rootKey;
  let rootKeyToDestroy: FileSystemRootKey | undefined = rootKey;
  try {
    const fileSystemId = parseFileSystemId({ value: plaintext.fileSystemId });
    const unlockingSlotId = parseCredentialSlotId({ value: plaintext.unlockingSlotId });
    const expectedUnlockSequence = createUnlockSequence({ value: BigInt(plaintext.unlockSequence) });
    const backingDirectory = await resolveBackingDirectory({
      canonicalBackingLocation: plaintext.canonicalBackingLocation,
      fileSystemId,
    });
    const backend = new OpfsWritableBackend<AuthenticatedHizoFSPhysicalBytes>({ root: backingDirectory });
    const opened = await openEmptyEncryptedContainerWithRootKey({
      backend,
      expectedUnlockSequence,
      fileSystemId,
      rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
      unlockingSlotId,
    });
    const namespace = createAuthenticatedReadOnlyNamespace({
      commit: opened.commit,
      recordSource: createAuthenticatedNamespaceRecordSource({
        backend,
        fileSystemId,
        relocationIndexRootPhysicalRef: opened.superblockLogicalState.relocationIndexRootPhysicalRef,
        rootKey: opened.rootKey,
      }),
    });
    const scopeStat = await namespace.stat({ pathComponents: plaintext.scopePath });
    if (scopeStat.kind !== "directory" || scopeStat.inodeNumber.toString() !== plaintext.inodeNumber) {
      throw new TypeError("HizoFS Worker mount grant scope is stale or was replaced");
    }
    const scope = await createBrowserContainerCoordinationScope({
      canonicalBackingLocation: plaintext.canonicalBackingLocation,
    });
    const runtimeHost = createBrowserHizoFSWorkerRuntimeHost({
      lockManager: navigator.locks,
      policy: WORKER_MOUNT_GRANT_POLICY,
      scope,
    });
    const rootName = plaintext.scopePath.at(-1) ?? "";
    const recheckAuthority = async (): Promise<void> => {
      const current = await openSuperblockCopies({
        backend,
        fileSystemId,
        rootKey: opened.rootKey,
        supportedFeatureBits: createFeatureBits({ value: 0n }),
      });
      if (current.logicalState.activeCommitSequence !== opened.commit.commitSequence
        || !bytesEqual({ left: current.logicalState.activeMutationId, right: opened.commit.mutationId })) {
        throw new Error("HizoFS Worker mount authority changed during reopen");
      }
      const currentNamespace = createAuthenticatedReadOnlyNamespace({
        commit: opened.commit,
        recordSource: createAuthenticatedNamespaceRecordSource({
          backend,
          fileSystemId,
          relocationIndexRootPhysicalRef: current.logicalState.relocationIndexRootPhysicalRef,
          rootKey: opened.rootKey,
        }),
      });
      const currentStat = await currentNamespace.stat({ pathComponents: plaintext.scopePath });
      if (currentStat.kind !== "directory" || currentStat.inodeNumber.toString() !== plaintext.inodeNumber) {
        throw new TypeError("HizoFS Worker mount scope changed during reopen");
      }
    };
    let session: StorageFileSystemSession;
    switch (grant.accessMode) {
    case "read":
      session = await openAuthenticatedReadOnlyApplicationSession({
        captureAuthority: async () => grant.grantId,
        recheckAuthority: async () => await recheckAuthority(),
        rootName,
        rootPath: plaintext.scopePath,
        runtimeHost,
        verifyCapturedAuthority: async () => ({ backend, opened }),
      });
      break;
    case "read_write":
      session = await openAuthenticatedReadWriteApplicationSession({
        captureAuthority: async () => grant.grantId,
        recheckAuthority: async () => await recheckAuthority(),
        rootName,
        rootPath: plaintext.scopePath,
        runtimeHost,
        verifyCapturedAuthority: async () => ({
          backend,
          canonicalBackingLocation: plaintext.canonicalBackingLocation,
          explicitBulkLimits: DEFAULT_EXPLICIT_BULK_LIMITS,
          fileMutationLimits: { maximumExtentMutationsPerBatch: 64 },
          opened,
          operationTimestamp: () => createTimestampMilliseconds({ value: BigInt(Date.now()) }),
          randomSource: undefined,
          removalLimits: { deleteBatchSize: 64, maxVisitedInodes: 100_000 },
          recheckGenerationAuthority: async ({ commit, superblock }) => {
            const current = await openSuperblockCopies({
              backend,
              fileSystemId,
              rootKey: opened.rootKey,
              supportedFeatureBits: createFeatureBits({ value: 0n }),
            });
            if (current.logicalState.activeCommitSequence !== commit.commitSequence
              || !bytesEqual({ left: current.logicalState.activeMutationId, right: commit.mutationId })
              || current.logicalState.activeCommitSequence !== superblock.logicalState.activeCommitSequence) {
              throw new Error("HizoFS Worker mount generation authority changed outside the active session");
            }
          },
          rootSubvolumeId: createSubvolumeId({ value: 1n }),
          supportedFeatureBits: createFeatureBits({ value: 0n }),
          writableProfile: "development-unverified",
        }),
      });
      break;
    default: {
      const _ex: never = grant.accessMode;
      throw new TypeError(`unsupported HizoFS Worker mount access mode: ${String(_ex)}`);
    }
    }
    // The runtime session now owns the root key through its release callback.
    // Keeping local cleanup armed after this point would prematurely revoke the
    // capability; clearing it before return makes the ownership transfer exact.
    rootKeyToDestroy = undefined;
    return session;
  } finally {
    rootKeyToDestroy?.destroy();
  }
}

type PhysicalDiagnosticPhase = Extract<HizoFSRuntimeDiagnosticPhase, `physical_${string}`>;
type RuntimePhaseRecorder = Pick<
  HizoFSRuntimeDiagnosticsAccumulator,
  "recordPhase" | "recordPhysicalAccess"
>;
type MonotonicClock = () => number;

async function measurePhysicalOperation<T>({ clock, diagnostics, operation, phase }: {
  clock: MonotonicClock;
  diagnostics: RuntimePhaseRecorder;
  operation: () => Promise<T>;
  phase: PhysicalDiagnosticPhase;
}): Promise<T> {
  const startedAt = clock();
  try {
    return await operation();
  } finally {
    diagnostics.recordPhase({ durationMs: Math.max(0, clock() - startedAt), phase });
  }
}

/**
 * Measures the exact physical-store contract at the composition boundary.
 * Failed operations remain measured attempts, while backend results and
 * durability capability claims pass through unchanged.
 */
function instrumentHizoFSWritableBackend<AuthenticatedPhysicalBytes extends Uint8Array>(options: {
  backend: HizoFSCrashDurableWritableBackend<AuthenticatedPhysicalBytes>;
  clock?: MonotonicClock;
  diagnostics: RuntimePhaseRecorder;
}): HizoFSCrashDurableWritableBackend<AuthenticatedPhysicalBytes>;
function instrumentHizoFSWritableBackend<AuthenticatedPhysicalBytes extends Uint8Array>(options: {
  backend: HizoFSDevelopmentWritableBackend<AuthenticatedPhysicalBytes>;
  clock?: MonotonicClock;
  diagnostics: RuntimePhaseRecorder;
}): HizoFSDevelopmentWritableBackend<AuthenticatedPhysicalBytes>;
function instrumentHizoFSWritableBackend<AuthenticatedPhysicalBytes extends Uint8Array>({
  backend,
  clock = () => globalThis.performance.now(),
  diagnostics,
}: {
  backend: HizoFSWritableBackend<AuthenticatedPhysicalBytes>;
  clock?: MonotonicClock;
  diagnostics: RuntimePhaseRecorder;
}): HizoFSPhysicalWriteBackend<AuthenticatedPhysicalBytes> {
  const measured = <T>({ operation, phase }: {
    operation: () => Promise<T>;
    phase: PhysicalDiagnosticPhase;
  }): Promise<T> => measurePhysicalOperation({ clock, diagnostics, operation, phase });
  return {
    capabilities: backend.capabilities,
    closeFile: async ({ file }: { file: HizoFSWritableFile }) => await measured({
      operation: async () => await backend.closeFile({ file }),
      phase: "physical_close_file",
    }),
    createDirectoryExclusive: async ({ path }) => await measured({
      operation: async () => await backend.createDirectoryExclusive({ path }),
      phase: "physical_create_directory_exclusive",
    }),
    createFileExclusive: async ({ path }) => await measured({
      operation: async () => await backend.createFileExclusive({ path }),
      phase: "physical_create_file_exclusive",
    }),
    getFileSize: async ({ path }) => {
      diagnostics.recordPhysicalAccess({
        identity: String(path),
        operation: "get_file_size",
      });
      return await measured({
        operation: async () => await backend.getFileSize({ path }),
        phase: "physical_get_file_size",
      });
    },
    list: async ({ directory }) => await measured({
      operation: async () => await backend.list({ directory }),
      phase: "physical_list",
    }),
    openFileForUpdate: async ({ path }) => await measured({
      operation: async () => await backend.openFileForUpdate({ path }),
      phase: "physical_open_file_for_update",
    }),
    readExact: async ({ length, offset, path }) => {
      diagnostics.recordPhysicalAccess({
        identity: `${String(path)}\u0000${offset.toString()}\u0000${length.toString()}`,
        operation: "read_exact",
      });
      return await measured({
        operation: async () => await backend.readExact({ length, offset, path }),
        phase: "physical_read_exact",
      });
    },
    readFileBounded: async ({ maximumByteLength, path }) => await measured({
      operation: async () => await backend.readFileBounded({ maximumByteLength, path }),
      phase: "physical_read_file_bounded",
    }),
    removeFile: async ({ path }) => await measured({
      operation: async () => await backend.removeFile({ path }),
      phase: "physical_remove_file",
    }),
    syncDirectoryEntries: async ({ parent }) => await measured({
      operation: async () => await backend.syncDirectoryEntries({ parent }),
      phase: "physical_sync_directory_entries",
    }),
    syncFileData: async ({ file }) => await measured({
      operation: async () => await backend.syncFileData({ file }),
      phase: "physical_sync_file_data",
    }),
    truncate: async ({ file, length }) => await measured({
      operation: async () => await backend.truncate({ file, length }),
      phase: "physical_truncate",
    }),
    writeAt: async ({ bytes, file, offset }) => await measured({
      operation: async () => await backend.writeAt({ bytes, file, offset }),
      phase: "physical_write_at",
    }),
  };
}

const BROWSER_BENCHMARK_RUNTIME_POLICY: HizoFSRuntimePolicy = Object.freeze({
  maxDirectoryIteratorEntries: 16_384,
  maxHeldLockNames: 4_096,
  maxMaintenanceRootRegistrations: 4_096,
  maxReaderPins: 512,
  maxSegmentReferences: 16_384,
});

export async function openBrowserHizoFSTransitionTargetEndpointSession({
  authorityIdentity,
  containerRoot,
  limits,
  operationIdentity,
  passphrase,
  runtimeStatePort,
  verifyProofAuthority,
}: {
  authorityIdentity: string;
  containerRoot: FileSystemDirectoryHandle;
  limits: StreamingNamespaceImportLimits;
  operationIdentity: string;
  passphrase: string;
  runtimeStatePort: HizoFSTransitionImportStatePort;
  verifyProofAuthority: ({ fileSystemId, rootKeyProof }: {
    fileSystemId: FileSystemId;
    rootKeyProof: FileSystemRootKeyProofDerivationCapability;
  }) => Promise<void>;
}): Promise<TransitionTargetEndpointSession> {
  const backend = new OpfsWritableBackend<AuthenticatedHizoFSPhysicalBytes>({ root: containerRoot });
  const opened = await openEmptyEncryptedContainer({
    backend,
    passphrase,
    supportedFeatureBits: createFeatureBits({ value: 0n }),
  });
  let fileAuthority: Awaited<ReturnType<typeof createAuthenticatedFileContentMutationAuthority>> | undefined;
  try {
    await withFileSystemRootKeyProofDerivationCapability({
      rootKey: opened.rootKey,
      useCapability: async ({ capability }) => await verifyProofAuthority({
        fileSystemId: opened.fileSystemId,
        rootKeyProof: capability,
      }),
    });
    fileAuthority = await createAuthenticatedFileContentMutationAuthority({
      backend,
      fileSystemId: opened.fileSystemId,
      relocationIndexRootPhysicalRef: opened.superblockLogicalState.relocationIndexRootPhysicalRef,
      rootKey: opened.rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    const authority = fileAuthority;
    const port = {
      directoryPageStore: createDirectoryPageTreePageStore({ pagePort: {
        readPage: async ({ isRoot, reference }) => await authority.readDirectoryPage({ isRoot, reference }),
        writePage: async ({ isRoot, page }) => await authority.writeDirectoryPage({ isRoot, page }),
      } }),
      fileContentPort: {
        extentPageStore: createFileExtentTreePageStore({ pagePort: {
          readPage: async ({ isRoot, reference }) => await authority.readFileExtentPage({ isRoot, reference }),
          writePage: async ({ isRoot, page }) => await authority.writeFileExtentPage({ isRoot, page }),
        } }),
        writeFileData: async ({ bytes }: { bytes: Uint8Array }) => await authority.writeFileData({ bytes }),
      },
      rootInodeTablePageStore: createRootInodeTablePageStore({ pagePort: {
        readPage: async ({ isRoot, reference }) => await authority.readInodeTablePage({ isRoot, reference }),
        writePage: async ({ isRoot, page }) => await authority.writeInodeTablePage({ isRoot, page }),
      } }),
    };
    const targetSession = await StreamingNamespaceImportTargetSession.open({
      createImport: ({ rootMetadata }) => new StreamingNamespaceImport({
        limits,
        nextInodeNumber: opened.commit.nextInodeNumber,
        port,
        rootDirectory: {
          inodeNumber: opened.commit.rootDirectoryInodeNumber,
          timestamps: {
            createdAt: rootMetadata.createdAt === undefined
              ? null
              : createTimestampMilliseconds({ value: rootMetadata.createdAt }),
            modifiedAt: rootMetadata.modifiedAt === undefined
              ? null
              : createTimestampMilliseconds({ value: rootMetadata.modifiedAt }),
          },
        },
        rootInodeTableRootHomeRef: opened.commit.rootInodeTableRootHomeRef,
      }),
      operationIdentity,
      restoreImport: ({ checkpoint }) => StreamingNamespaceImport.restore({ checkpoint, limits, port }),
      runtimeStatePort,
    });
    let privateSource: ReturnType<typeof createHizoFSTransitionNamespaceSource> | undefined;
    const source = (): ReturnType<typeof createHizoFSTransitionNamespaceSource> => {
      if (privateSource !== undefined) return privateSource;
      const sealed = targetSession.sealedCandidate();
      const commit: FileSystemCommitPayload = {
        ...opened.commit,
        nextInodeNumber: sealed.nextInodeNumber,
        rootDirectoryInodeNumber: sealed.rootDirectoryInodeNumber,
        rootInodeTableRootHomeRef: sealed.rootInodeTableRootHomeRef,
      };
      privateSource = createHizoFSTransitionNamespaceSource({
        resolver: createAuthenticatedReadOnlyNamespaceResolver({
          commit,
          recordSource: createAuthenticatedNamespaceRecordSource({
            backend,
            fileSystemId: opened.fileSystemId,
            relocationIndexRootPhysicalRef: opened.superblockLogicalState.relocationIndexRootPhysicalRef,
            rootKey: opened.rootKey,
          }),
        }),
      });
      return privateSource;
    };
    let closed = false;
    return {
      authorityIdentity,
      close: async () => {
        if (closed) return;
        closed = true;
        await settleTransitionEndpointClose({
          abandonAuthority: () => authority.abandon(),
          closeTarget: async () => await targetSession.close(),
          destroyRootKey: () => opened.rootKey.destroy(),
        });
      },
      source: {
        listDirectory: async ({ afterName, maximumEntries, path }) => await source().listDirectory({
          afterName,
          maximumEntries,
          path,
        }),
        readFileChunk: async ({ maximumBytes, offset, path }) => await source().readFileChunk({
          maximumBytes,
          offset,
          path,
        }),
        readRootMetadata: async () => await source().readRootMetadata(),
        readSymlink: async ({ path }) => await source().readSymlink({ path }),
      },
      target: targetSession.target,
    };
  } catch (cause: unknown) {
    const authorityToAbandon = fileAuthority;
    return abandonTransitionEndpointAfterOpenFailure({
      abandonAuthority: authorityToAbandon === undefined ? undefined : () => authorityToAbandon.abandon(),
      cause,
      destroyRootKey: () => opened.rootKey.destroy(),
    });
  }
}

async function settleTransitionEndpointClose({
  abandonAuthority,
  closeTarget,
  destroyRootKey,
}: {
  abandonAuthority: () => void;
  closeTarget: () => Promise<void>;
  destroyRootKey: () => void;
}): Promise<void> {
  const failures: unknown[] = [];
  try {
    await closeTarget();
  } catch (cause: unknown) {
    failures.push(cause);
  }
  try {
    abandonAuthority();
  } catch (cause: unknown) {
    failures.push(cause);
  }
  try {
    destroyRootKey();
  } catch (cause: unknown) {
    failures.push(cause);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "transition endpoint resource cleanup failed");
  }
}

function abandonTransitionEndpointAfterOpenFailure({
  abandonAuthority,
  cause,
  destroyRootKey,
}: {
  abandonAuthority: (() => void) | undefined;
  cause: unknown;
  destroyRootKey: () => void;
}): never {
  const failures = [cause];
  try {
    abandonAuthority?.();
  } catch (cleanupFailure: unknown) {
    failures.push(cleanupFailure);
  }
  try {
    destroyRootKey();
  } catch (cleanupFailure: unknown) {
    failures.push(cleanupFailure);
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "transition endpoint open and resource cleanup failed");
  }
  throw cause;
}

function commitMatchesSealedTransitionImport({ commit, sealed }: {
  commit: FileSystemCommitPayload;
  sealed: SealedStreamingNamespaceImport;
}): boolean {
  return commit.nextInodeNumber === sealed.nextInodeNumber
    && commit.rootDirectoryInodeNumber === sealed.rootDirectoryInodeNumber
    && bytesEqual({
      left: encodeFileSystemCommitPayload({ payload: {
        ...commit,
        rootInodeTableRootHomeRef: sealed.rootInodeTableRootHomeRef,
      } }),
      right: encodeFileSystemCommitPayload({ payload: commit }),
    });
}

export type PublishedBrowserHizoFSTransitionTarget = Readonly<{
  commitSequence: bigint;
  fileSystemId: FileSystemId;
}>;

/**
 * Publishes one verified private namespace as the target's only active Commit.
 *
 * The sealed runtime candidate remains available until Naidan Persistence
 * Control switches authority. A same-invocation retry first compares the
 * authenticated active Commit with the sealed root, so a lost publication
 * response cannot append a second Commit.
 */
export async function publishBrowserHizoFSTransitionTargetCandidate({
  assertPublicationAllowed,
  containerRoot,
  operationIdentity,
  passphrase,
  randomSource,
  runtimeStatePort,
  verifyProofAuthority,
}: {
  assertPublicationAllowed: () => void;
  containerRoot: FileSystemDirectoryHandle;
  operationIdentity: string;
  passphrase: string;
  randomSource?: RandomByteSource;
  runtimeStatePort: HizoFSTransitionImportStatePort;
  verifyProofAuthority: ({ fileSystemId, rootKeyProof }: {
    fileSystemId: FileSystemId;
    rootKeyProof: FileSystemRootKeyProofDerivationCapability;
  }) => Promise<void>;
}): Promise<PublishedBrowserHizoFSTransitionTarget> {
  const backend = new OpfsWritableBackend<AuthenticatedHizoFSPhysicalBytes>({ root: containerRoot });
  const opened = await openEmptyEncryptedContainer({
    backend,
    passphrase,
    supportedFeatureBits: createFeatureBits({ value: 0n }),
  });
  let authority: Awaited<ReturnType<typeof createAuthenticatedFileContentMutationAuthority>> | undefined;
  try {
    switch (opened.dataOpenMode) {
    case "normal": break;
    case "fallback_read_only": throw new TypeError(
      "transition target publication requires the normal active generation",
    );
    default: return opened.dataOpenMode satisfies never;
    }
    await withFileSystemRootKeyProofDerivationCapability({
      rootKey: opened.rootKey,
      useCapability: async ({ capability }) => await verifyProofAuthority({
        fileSystemId: opened.fileSystemId,
        rootKeyProof: capability,
      }),
    });
    const candidate = await runtimeStatePort.loadCandidate({ operationIdentity });
    const sealed = (() => {
      switch (candidate?.type) {
      case "sealed": return candidate.sealed;
      case "active": throw new TypeError("transition target cannot publish an active import checkpoint");
      case undefined: throw new TypeError("transition target has no sealed import checkpoint");
      default: return candidate satisfies never;
      }
    })();
    validateSealedStreamingNamespaceImport({ sealed });
    if (commitMatchesSealedTransitionImport({ commit: opened.commit, sealed })) {
      return { commitSequence: opened.commit.commitSequence, fileSystemId: opened.fileSystemId };
    }

    assertPublicationAllowed();
    const mutationId = await generateMutationId({
      isUsed: async ({ id }) => bytesEqual({ left: id, right: opened.commit.mutationId }),
      randomSource,
    });
    const commitPayload = prepareTransitionImportCommit({
      baseCommit: opened.commit,
      mutationId,
      sealed,
    });
    authority = await createAuthenticatedFileContentMutationAuthority({
      backend,
      fileSystemId: opened.fileSystemId,
      randomSource,
      relocationIndexRootPhysicalRef: opened.superblockLogicalState.relocationIndexRootPhysicalRef,
      rootKey: opened.rootKey,
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    const publicationAuthority = authority;
    const publicationPort = {
      publish: async ({
        base,
        beforeFirstAuthorityWrite,
        commitPayload: payload,
        firstPublicationSequence,
        secondPublicationSequence,
      }: Parameters<typeof publicationAuthority.publish>[0]) => await publicationAuthority.publish({
        base,
        beforeFirstAuthorityWrite,
        commitPayload: payload,
        firstPublicationSequence,
        secondPublicationSequence,
      }),
    };
    try {
      await publishPreparedMutationCommit({
        assertPublicationAllowed,
        base: opened.superblock,
        commitPayload,
        publicationPort,
      });
    } catch (cause: unknown) {
      if (!(cause instanceof PreparedMutationCommitPublicationError)) throw cause;
      const resolution = await authority.resolvePublication({
        base: opened.superblock,
        intendedLogicalState: cause.intendedLogicalState,
      });
      switch (resolution.type) {
      case "not_published": throw cause;
      case "publication_conflict": throw new AggregateError(
        [cause],
        "transition target publication conflicted with another authenticated generation",
      );
      case "published": {
        const reopened = await readBootstrapRoot({
          authority: {
            commitHomeRef: cause.commitHomeRef,
            commitSequence: cause.commitPayload.commitSequence,
            mutationId: cause.commitPayload.mutationId,
            type: "active",
          },
          backend,
          fileSystemId: opened.fileSystemId,
          relocationIndexRootPhysicalRef: resolution.superblock.logicalState.relocationIndexRootPhysicalRef,
          rootKey: opened.rootKey,
        });
        if (!sameCommitPayload({ left: reopened.commit, right: cause.commitPayload })) {
          throw new AggregateError(
            [cause],
            "published transition target Commit does not match the sealed candidate",
          );
        }
        switch (resolution.superblock.copyState) {
        case "normal": break;
        case "superblock_redundancy_degraded": throw new AggregateError(
          [cause],
          "transition target publication committed without A/B convergence",
        );
        default: return resolution.superblock.copyState satisfies never;
        }
        break;
      }
      default: return resolution satisfies never;
      }
    }
    return { commitSequence: commitPayload.commitSequence, fileSystemId: opened.fileSystemId };
  } finally {
    if (authority !== undefined) {
      const state = authority.state();
      switch (state) {
      case "active": authority.abandon(); break;
      case "closed":
      case "publishing": break;
      default: state satisfies never;
      }
    }
    opened.rootKey.destroy();
  }
}

export async function verifyBrowserHizoFSTransitionTargetNormalOpen({
  containerRoot,
  expectedFileSystemId,
  passphrase,
  verifyProofAuthority,
}: {
  containerRoot: FileSystemDirectoryHandle;
  expectedFileSystemId: FileSystemId;
  passphrase: string;
  verifyProofAuthority: ({ fileSystemId, rootKeyProof }: {
    fileSystemId: FileSystemId;
    rootKeyProof: FileSystemRootKeyProofDerivationCapability;
  }) => Promise<void>;
}): Promise<Readonly<{ credentialSlotCount: number }>> {
  const backend = new OpfsWritableBackend<AuthenticatedHizoFSPhysicalBytes>({ root: containerRoot });
  const authority = await openAuthenticatedReadOnlyContainerAuthority({
    backend,
    passphrase,
    supportedFeatureBits: createFeatureBits({ value: 0n }),
    verifyProofAuthority,
  });
  try {
    if (authority.opened.fileSystemId !== expectedFileSystemId) {
      throw new TypeError("normal-open transition target identity changed");
    }
    const resolver = createAuthenticatedReadOnlyNamespaceResolver({
      commit: authority.opened.commit,
      recordSource: createAuthenticatedNamespaceRecordSource({
        backend,
        fileSystemId: authority.opened.fileSystemId,
        relocationIndexRootPhysicalRef: authority.opened.superblockLogicalState.relocationIndexRootPhysicalRef,
        rootKey: authority.opened.rootKey,
      }),
    });
    const root = await resolver.stat({ pathComponents: [] });
    switch (root.kind) {
    case "directory": break;
    case "file":
    case "symlink": throw new TypeError("normal-open transition target root is not a directory");
    default: return root.kind satisfies never;
    }
    const credentialAuthority = await openAuthenticatedUnlockEnvelopeAuthority({
      backend,
      fileSystemId: authority.opened.fileSystemId,
      minimumUnlockSequence: authority.opened.superblockLogicalState.minimumUnlockSequence,
      rootKey: authority.opened.rootKey,
    });
    return { credentialSlotCount: credentialAuthority.credentialSlots.length };
  } finally {
    authority.opened.rootKey.destroy();
  }
}

export type BrowserHizoFSTransitionTargetReservation =
  | Readonly<{ type: "collision" }>
  | Readonly<{
      cleanup(): Promise<void>;
      containerRoot: FileSystemDirectoryHandle;
      type: "reserved";
    }>;

/**
 * Reserves one path-addressable File System ID before container creation.
 *
 * The HizoFS owner generates and validates the persisted identity, while the
 * Naidan adapter owns path reservation. A collision retries with another ID;
 * any creation failure removes only the directory reserved by this attempt.
 */
export async function createBrowserHizoFSTransitionTargetContainer({
  passphrases,
  randomSource,
  reserveContainerRoot,
}: {
  passphrases: readonly string[];
  randomSource?: RandomByteSource;
  reserveContainerRoot: ({ fileSystemId }: {
    fileSystemId: FileSystemId;
  }) => Promise<BrowserHizoFSTransitionTargetReservation>;
}): Promise<FileSystemId> {
  const attempted = new Set<FileSystemId>();
  for (
    let attempt = 0;
    attempt < HIZOFS_V1_FORMAT_CONSTANTS.limits.randomIdentityGenerationAttempts;
    attempt += 1
  ) {
    const fileSystemId = await generateFileSystemId({
      isUsed: async ({ id }) => attempted.has(id),
      randomSource,
    });
    attempted.add(fileSystemId);
    const reservation = await reserveContainerRoot({ fileSystemId });
    switch (reservation.type) {
    case "collision": continue;
    case "reserved": {
      const backend = new OpfsWritableBackend<AuthenticatedHizoFSPhysicalBytes>({
        root: reservation.containerRoot,
      });
      try {
        const created = await createEmptyEncryptedContainerWithPassphrases({
          backend,
          fileSystemId,
          passphrases,
          randomSource,
          supportedFeatureBits: createFeatureBits({ value: 0n }),
        });
        if (created.fileSystemId !== fileSystemId) {
          throw new TypeError("reserved transition target identity changed during creation");
        }
        return fileSystemId;
      } catch (cause: unknown) {
        try {
          await reservation.cleanup();
        } catch (cleanupCause: unknown) {
          throw new AggregateError(
            [cause, cleanupCause],
            "transition target creation and reserved-directory cleanup both failed",
          );
        }
        throw cause;
      }
    }
    default: return reservation satisfies never;
    }
  }
  throw new Error("transition target File System ID reservation exhausted the collision retry bound");
}

export type BrowserHizoFSBenchmarkBulkBuilder = Readonly<{
  readonly targetDirectory: StorageDirectoryHandle;
  abort({ reason }: { readonly reason: unknown }): Promise<void>;
  commit(): Promise<void>;
  createEmptyFile({ name }: { readonly name: string }): Promise<void>;
}>;

export type BrowserHizoFSBenchmarkApplicationRuntime = Readonly<{
  readonly session: StorageFileSystemSession;
  close(): Promise<void>;
  createBulkBuilder(): Promise<BrowserHizoFSBenchmarkBulkBuilder>;
  reopen(): Promise<StorageFileSystemSession>;
  resetRuntimeDiagnosticsHighWaterMarks(): void;
  snapshotRuntimeDiagnostics(): HizoFSRuntimeDiagnosticsSnapshot;
}>;

async function releaseBenchmarkCapabilityAfterSessionOpenFailure({ cause, releaseResources }: {
  cause: unknown;
  releaseResources: () => Promise<void>;
}): Promise<never> {
  try {
    await releaseResources();
  } catch (cleanupFailure: unknown) {
    throw new AggregateError(
      [cause, cleanupFailure],
      "benchmark session open and capability cleanup both failed",
    );
  }
  throw cause;
}

async function createBenchmarkExplicitBulkBuilder({ session, targetName }: {
  readonly session: StorageFileSystemSession;
  readonly targetName: string;
}): Promise<BrowserHizoFSBenchmarkBulkBuilder> {
  const state = developmentWritableCredentialStateBySession.get(session);
  if (state === undefined) throw new TypeError("HizoFS benchmark session is foreign");
  switch (state.lifecycle) {
  case "open": break;
  case "closed":
  case "closing":
  case "proving":
  case "recovery_required":
  case "reencrypting":
  case "updating": throw new TypeError(`cannot open HizoFS benchmark bulk target while session is ${state.lifecycle}`);
  default: return state.lifecycle satisfies never;
  }
  const underlyingSession = state.underlyingSession;
  if (!(underlyingSession instanceof HizoFSStorageFileSystemSession)) {
    throw new TypeError("HizoFS benchmark session does not own the production application port");
  }
  const openExplicitBulk = underlyingSession.port.openExplicitBulk;
  if (openExplicitBulk === undefined) {
    throw new TypeError("production HizoFS explicit bulk is unavailable");
  }

  // Directory emptiness alone is not freshness provenance. The ordinary
  // create publication mints the session-local capability consumed by the
  // immediately following explicit-bulk open. Setup completes before the
  // benchmark starts timing the one-Commit bulk publication itself.
  const targetDirectory = await session.root.getDirectoryHandle({
    create: true,
    name: targetName,
  });
  const builder = await underlyingSession.runOperation({
    operation: async () => await openExplicitBulk({ path: [targetName] }),
  });
  return {
    targetDirectory,
    abort: async ({ reason }) => await builder.abort({ reason }),
    commit: async () => await builder.commit(),
    createEmptyFile: async ({ name }) => await builder.createEmptyFile({ name }),
  };
}

/**
 * Owns one disposable browser benchmark container and all secret-bearing
 * capabilities required to open it. Reopen authenticates through the normal
 * writable capability boundary; callers receive only an application session.
 */
export async function createBrowserHizoFSBenchmarkApplicationRuntime({
  backingDirectory,
  metadataRecordCachePolicy,
}: {
  readonly backingDirectory: FileSystemDirectoryHandle;
  readonly metadataRecordCachePolicy?: AuthenticatedMetadataRecordCachePolicy;
}): Promise<BrowserHizoFSBenchmarkApplicationRuntime> {
  const runtimeDiagnostics = new HizoFSRuntimeDiagnosticsAccumulator();
  const backend = instrumentHizoFSWritableBackend({
    backend: new OpfsWritableBackend<AuthenticatedHizoFSPhysicalBytes>({
      root: backingDirectory,
    }),
    diagnostics: runtimeDiagnostics,
  });
  let passphrase: string | undefined = generateBenchmarkSecret({ byteLength: 32 });
  const canonicalBackingLocation = `hizofs-benchmark:${generateBenchmarkSecret({ byteLength: 16 })}`;
  const supportedFeatureBits = createFeatureBits({ value: 0n });
  const created = await createEmptyEncryptedContainer({
    backend,
    diagnostics: runtimeDiagnostics,
    passphrase,
    supportedFeatureBits,
  });
  const expectedFileSystemId = created.fileSystemId;
  created.rootKey.destroy();

  const scope = await createBrowserContainerCoordinationScope({
    canonicalBackingLocation,
  });
  const runtimeHost = createBrowserHizoFSWorkerRuntimeHost({
    lockManager: navigator.locks,
    policy: BROWSER_BENCHMARK_RUNTIME_POLICY,
    scope,
  });

  const openSession = async (): Promise<StorageFileSystemSession> => {
    const currentPassphrase = passphrase;
    if (currentPassphrase === undefined) {
      throw new TypeError("cannot reopen a closed HizoFS benchmark runtime");
    }
    const opened = await openBrowserAuthenticatedDevelopmentWritableContainerCapability({
      containerRoot: backingDirectory,
      passphrase: currentPassphrase,
      runtimeDiagnostics,
      verifyProofAuthority: async ({ fileSystemId }) => {
        if (fileSystemId !== expectedFileSystemId) {
          throw new TypeError("HizoFS benchmark container identity changed");
        }
      },
    });
    switch (opened.type) {
    case "credential_rejected":
      throw new TypeError("HizoFS benchmark credential was rejected after creation");
    case "opened": {
      try {
        return await openAuthenticatedDevelopmentWritableApplicationSessionFromCapability({
          authority: opened.authority,
          canonicalBackingLocation,
          metadataRecordCachePolicy,
          recheckAuthority: async () => undefined,
          rootName: "benchmark.hizofs",
          runtimeHost,
        });
      } catch (cause: unknown) {
        return await releaseBenchmarkCapabilityAfterSessionOpenFailure({
          cause,
          releaseResources: opened.releaseResources,
        });
      }
    }
    default: return opened satisfies never;
    }
  };

  let session = await openSession();
  let bulkTargetSequence = 0;
  let closed = false;
  return {
    get session() {
      return session;
    },
    async reopen() {
      if (closed) throw new TypeError("cannot reopen a closed HizoFS benchmark runtime");
      await session.close();
      session = await openSession();
      return session;
    },
    async createBulkBuilder() {
      if (closed) throw new TypeError("cannot create a bulk target in a closed HizoFS benchmark runtime");
      const targetName = `bulk-target-${bulkTargetSequence}`;
      bulkTargetSequence += 1;
      return await createBenchmarkExplicitBulkBuilder({ session, targetName });
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        await session.close();
      } finally {
        passphrase = undefined;
      }
    },
    resetRuntimeDiagnosticsHighWaterMarks() {
      runtimeDiagnostics.resetHighWaterMarks();
    },
    snapshotRuntimeDiagnostics: () => runtimeDiagnostics.snapshot(),
  };
}

export type AuthenticatedMaintenanceRootAuthority = Readonly<{
  backend: HizoFSReadableBackend;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSystemId: FileSystemId;
  rootKey: FileSystemRootKey;
  supportedFeatureBits: FeatureBits;
}>;

type CurrentMaintenanceAuthorityRoots = Readonly<{
  activeCommitRoots: readonly HomeRecordReference[];
  fallbackCommitRoots: readonly HomeRecordReference[];
  historicalRootFeatureState: OpenedSuperblockCopies["historicalRootFeatureState"];
  relocationIndexRoots: readonly PhysicalRecordReference[];
}>;

function maintenanceAuthorityRootsFromSuperblock({ superblock }: {
  superblock: OpenedSuperblockCopies;
}): CurrentMaintenanceAuthorityRoots {
  return Object.freeze({
    activeCommitRoots: Object.freeze(superblock.authenticatedLogicalStates.map(state => state.activeCommitHomeRef)),
    fallbackCommitRoots: Object.freeze(superblock.authenticatedLogicalStates.flatMap(state =>
      state.fallbackCommitHomeRef === null ? [] : [state.fallbackCommitHomeRef])),
    historicalRootFeatureState: superblock.historicalRootFeatureState,
    relocationIndexRoots: Object.freeze(superblock.authenticatedLogicalStates.flatMap(state =>
      state.relocationIndexRootPhysicalRef === null ? [] : [state.relocationIndexRootPhysicalRef])),
  });
}

type MaintenanceRootCaptureHost = Pick<
  HizoFSWorkerRuntimeHost,
  "beginMaintenanceRootCapture"
>;

type MaintenanceSweepHost = Pick<
  HizoFSWorkerRuntimeHost,
  "beginMaintenanceRootCapture" | "beginSegmentDeletion"
>;

async function settleRootCapture<T>({ capture, operation }: {
  capture: ContainerRuntimeMaintenanceRootCapture;
  operation: () => Promise<T>;
}): Promise<T> {
  let outcome: Readonly<{ cause: unknown; type: "failure" }> | Readonly<{ type: "success"; value: T }>;
  try {
    outcome = { type: "success", value: await operation() };
  } catch (cause: unknown) {
    outcome = { cause, type: "failure" };
  }

  const cleanupFailures: unknown[] = [];
  try {
    capture.release();
  } catch (cause: unknown) {
    cleanupFailures.push(cause);
  }
  try {
    await capture.released;
  } catch (cause: unknown) {
    cleanupFailures.push(cause);
  }

  switch (outcome.type) {
  case "failure":
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [outcome.cause, ...cleanupFailures],
        "maintenance root capture and gate cleanup both failed",
      );
    }
    throw outcome.cause;
  case "success":
    if (cleanupFailures.length === 1) throw cleanupFailures[0];
    if (cleanupFailures.length > 1) {
      throw new AggregateError(cleanupFailures, "maintenance root gate cleanup failed");
    }
    return outcome.value;
  default:
    return outcome satisfies never;
  }
}

async function captureAuthenticatedMaintenanceRootsWithReader<Authority>({
  authority,
  candidateSnapshot,
  policy,
  readCurrentRoots,
  runtimeHost,
}: {
  authority: Authority;
  candidateSnapshot: PreparedMaintenanceCandidateSnapshot;
  policy: HizoFSMaintenancePolicy;
  readCurrentRoots: ({ authority }: { authority: Authority }) => Promise<CurrentMaintenanceAuthorityRoots>;
  runtimeHost: MaintenanceRootCaptureHost;
}): Promise<CompleteMaintenanceRootCapture> {
  const runtimeCapture = await runtimeHost.beginMaintenanceRootCapture();
  return await settleRootCapture({
    capture: runtimeCapture,
    operation: async () => {
      // The gate contains only one bounded Superblock authority read and the
      // synchronous detached snapshot. Inventory and Segment authentication
      // completed before this function received candidateSnapshot.
      const current = await readCurrentRoots({ authority });
      // Unknown historical semantics cannot be traversed safely. Retaining all
      // candidate segments is safer than pretending that known roots are complete.
      switch (current.historicalRootFeatureState) {
      case "supported_or_absent": break;
      case "unsupported":
        throw new TypeError("maintenance is unavailable while an authenticated historical root requires unsupported features");
      default: return current.historicalRootFeatureState satisfies never;
      }
      if (runtimeCapture.sourceSegmentPinnedRoots.length > 0) {
        throw new TypeError("maintenance cannot translate legacy logical source-Segment pins into physical use authority");
      }
      return captureCompleteMaintenanceRoots({
        candidateSnapshot,
        maintenanceRootEpoch: runtimeCapture.maintenanceRootEpoch,
        policy,
        rootSets: {
          activeCommitRoots: current.activeCommitRoots,
          fallbackCommitRoots: current.fallbackCommitRoots,
          inspectorPinnedRoots: runtimeCapture.inspectorPinnedRoots,
          readerPinnedRoots: runtimeCapture.readerPinnedRoots,
          relocationIndexRoots: current.relocationIndexRoots,
          unknownFeatureRoots: runtimeCapture.unknownFeatureRoots,
          writerDependencyRoots: runtimeCapture.writerDependencyRoots,
        },
      });
    },
  });
}

async function validateAndPrepareAuthenticatedMaintenanceSweepWithReader<Authority>({
  authority,
  capturedSnapshot,
  currentCandidateSnapshot,
  policy,
  readCurrentRoots,
  runtimeHost,
}: {
  authority: Authority;
  capturedSnapshot: MaintenanceRootSnapshot;
  currentCandidateSnapshot: PreparedMaintenanceCandidateSnapshot;
  policy: HizoFSMaintenancePolicy;
  readCurrentRoots: ({ authority }: { authority: Authority }) => Promise<CurrentMaintenanceAuthorityRoots>;
  runtimeHost: MaintenanceSweepHost;
}): Promise<ValidatedGarbageCollectionSweepAuthority> {
  const current = await captureAuthenticatedMaintenanceRootsWithReader({
    authority,
    candidateSnapshot: currentCandidateSnapshot,
    policy,
    readCurrentRoots,
    runtimeHost,
  });
  const validation = validateMaintenanceRootSnapshot({ captured: capturedSnapshot, current: current.snapshot });
  if (!validation.valid) return validation;
  return Object.freeze({
    beginDeletion: async ({ plan }: { plan: CandidateSegmentPlanEntry }) => {
      // Root and candidate authority are accepted before exposing the lease
      // factory. The runtime deletion gate then waits for existing physical
      // references and blocks new references to this exact Segment ID.
      return await runtimeHost.beginSegmentDeletion({ segmentId: plan.segmentId });
    },
    valid: true as const,
  });
}

export async function validateAndPrepareAuthenticatedMaintenanceSweep({
  authority,
  capturedSnapshot,
  currentCandidateSnapshot,
  policy,
  runtimeHost,
}: {
  authority: AuthenticatedMaintenanceRootAuthority;
  capturedSnapshot: MaintenanceRootSnapshot;
  currentCandidateSnapshot: PreparedMaintenanceCandidateSnapshot;
  policy: HizoFSMaintenancePolicy;
  runtimeHost: MaintenanceSweepHost;
}): Promise<ValidatedGarbageCollectionSweepAuthority> {
  return await validateAndPrepareAuthenticatedMaintenanceSweepWithReader({
    authority,
    capturedSnapshot,
    currentCandidateSnapshot,
    policy,
    readCurrentRoots: async ({ authority: currentAuthority }) => {
      const superblock = await openSuperblockCopies({
        backend: currentAuthority.backend,
        diagnostics: currentAuthority.diagnostics,
        fileSystemId: currentAuthority.fileSystemId,
        rootKey: currentAuthority.rootKey,
        supportedFeatureBits: currentAuthority.supportedFeatureBits,
      });
      return maintenanceAuthorityRootsFromSuperblock({ superblock });
    },
    runtimeHost,
  });
}

export async function captureAuthenticatedMaintenanceRoots({
  authority,
  candidateSnapshot,
  policy,
  runtimeHost,
}: {
  authority: AuthenticatedMaintenanceRootAuthority;
  candidateSnapshot: PreparedMaintenanceCandidateSnapshot;
  policy: HizoFSMaintenancePolicy;
  runtimeHost: MaintenanceRootCaptureHost;
}): Promise<CompleteMaintenanceRootCapture> {
  return await captureAuthenticatedMaintenanceRootsWithReader({
    authority,
    candidateSnapshot,
    policy,
    readCurrentRoots: async ({ authority: currentAuthority }) => {
      const superblock = await openSuperblockCopies({
        backend: currentAuthority.backend,
        diagnostics: currentAuthority.diagnostics,
        fileSystemId: currentAuthority.fileSystemId,
        rootKey: currentAuthority.rootKey,
        supportedFeatureBits: currentAuthority.supportedFeatureBits,
      });
      return maintenanceAuthorityRootsFromSuperblock({ superblock });
    },
    runtimeHost,
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  abandonTransitionEndpointAfterOpenFailure,
  captureAuthenticatedMaintenanceRootsWithReader,
  instrumentHizoFSWritableBackend,
  releaseBenchmarkCapabilityAfterSessionOpenFailure,
  settleRootCapture,
  settleTransitionEndpointClose,
  validateAndPrepareAuthenticatedMaintenanceSweepWithReader,
};
