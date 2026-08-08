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
import type {
  ContainerRuntimeAcceptedMutationAdmission,
  ContainerRuntimeAuthenticatedApplicationGeneration,
  ContainerRuntimeImmediateMutationAdmission,
  ContainerRuntimeSelectedCandidatePublisher,
} from "@/00-storage/service/hizofs/runtime/container-runtime";
import { WorkingGenerationCoordinatorError } from "@/00-storage/service/hizofs/runtime/working-generation-coordinator";
import {
  createAuthenticatedApplicationGenerationDescriptor,
  createAuthenticatedDurableApplicationGenerationAuthority,
  createAuthenticatedStagedApplicationGenerationDescriptor,
  type AuthenticatedApplicationGenerationDescriptor,
  type AuthenticatedDurableApplicationGenerationAuthority,
  type AuthenticatedStagedApplicationGenerationDescriptor,
  type AuthenticatedWorkingApplicationGenerationDescriptor,
} from "@/00-storage/service/hizofs/runtime/authenticated-application-generation";
import {
  createDurableGenerationIdentity,
  createSuccessorWorkingGenerationIdentity,
  createWorkingGenerationIdentity,
  sameDurableGenerationIdentity,
  sameWorkingGenerationIdentity,
  type DurableGenerationIdentity,
  type WorkingGenerationIdentity,
} from "@/00-storage/service/hizofs/runtime/application-generation-identity";
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
  createFileSystemCommitPayload,
  createSubvolumeId,
  createTimestampMilliseconds,
  createUnlockSequence,
  encodeFileSystemCommitPayload,
  encodeHomeRecordReference,
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
import { AuthenticatedSegmentWriterOwner } from "@/00-storage/service/hizofs/authenticated-store/active-segment-writer-owner";
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
  type AuthenticatedMutationResourceUsage,
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
import { DecodedInodeLeafPageIndexCache } from "@/00-storage/service/hizofs/filesystem/decoded-inode-leaf-page-index-cache";
import { ReadOnlyNamespaceValidationCache } from "@/00-storage/service/hizofs/filesystem/namespace-validation-cache";
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
import type { DecodedInodeIndexPageCacheDiagnosticsPort } from "@/00-storage/service/hizofs/diagnostics/decoded-inode-index-page-cache-diagnostics";
import type { ImmutableBTreeDiagnosticsPort } from "@/00-storage/service/hizofs/diagnostics/immutable-btree-diagnostics";
import type { ContainerCoordinationKey } from "@/00-storage/service/hizofs/filesystem/container-coordination-key";
import { createFileExtentTreePageStore } from "@/00-storage/service/hizofs/filesystem/mutation/file-extent-tree";
import {
  materializeStagedMutationCommitCandidateThroughPort,
  prepareDeferredMutationCommitPublication,
  prepareStagedMutationCommit,
  publishPreparedMutationCommit,
  publishPreparedMutationCommitCandidateThroughPort,
  type DeferredPreparedMutationCommitPublication,
  type DetachablePreparedMutationCommitPublicationPort,
  type PreparedMutationCommitCandidate,
  STAGED_MUTATION_COMMIT_MATERIALIZATION_FRAME_BYTES,
  type PublishedPreparedMutationCommit,
  type StagedPreparedMutationCommit,
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
  cloneFileSystemRootKey,
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
import type { AuthenticatedStoreDiagnosticsPort } from "@/00-storage/service/hizofs/diagnostics/authenticated-store-diagnostics";
import {
  hasCrashDurableWritableSemantics,
  type HizoFSCrashDurableWritableBackend,
  type HizoFSDevelopmentWritableBackend,
  type HizoFSPhysicalWriteBackend,
  type HizoFSReadableBackend,
  type HizoFSWritableBackend,
  type HizoFSWritableFile,
} from "@/00-storage/service/hizofs/physical-store/backend";
import {
  OpfsWritableBackend,
  type OpfsWritableBackendFileHandleCacheDiagnosticsPort,
  type OpfsWritableBackendFileHandleCachePolicy,
} from "@/00-storage/service/hizofs/physical-store/opfs/opfs-writable-backend";
import { HizoFSRuntimeDiagnosticsAccumulator, type HizoFSRuntimeDiagnosticPhase, type HizoFSRuntimeDiagnosticsSnapshot } from "@/00-storage/service/hizofs/diagnostics/runtime-diagnostics";
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
import type { StorageFileSystemSyncDurability } from "@/00-storage/service/storage-file-system/sync-error";
import { DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY, type HizoFSRuntimePolicy } from "@/00-storage/service/hizofs/runtime/runtime-policy";
import type { TransitionTargetEndpointSession } from "@/00-storage/service/naidan-persistence-control/transition/transition-provider-adapter";

import {
  createBrowserHizoFSWorkerRuntimeHost,
  HizoFSWorkerRuntimeHost,
} from "@/00-storage/service/hizofs/worker/runtime-host";
import type { HizoFSRuntimeOwnerOpenPolicy } from "@/00-storage/service/hizofs/runtime/runtime-owner-coordinator";
export type { HizoFSRuntimeOwnerOpenPolicy } from "@/00-storage/service/hizofs/runtime/runtime-owner-coordinator";
import { HizoFSRuntimeHostRegistry } from "@/00-storage/service/hizofs/worker/runtime-host-registry";

export { DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY };
export { createBrowserHizoFSWorkerRuntimeHost, HizoFSWorkerRuntimeHost };
export { HizoFSRuntimeHostRegistry, HizoFSRuntimeHostRegistryError } from "@/00-storage/service/hizofs/worker/runtime-host-registry";

export type AuthenticatedApplicationReadSessionResources = Readonly<{
  namespace: HizoFSApplicationSessionNamespace;
  releaseResources: () => Promise<void>;
  syncDurability: StorageFileSystemSyncDurability;
}>;


const WORKER_MOUNT_GRANT_POLICY: HizoFSRuntimePolicy = Object.freeze({
  lazyDurability: DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY,
  maxDirectoryIteratorEntries: 4_096,
  maxHeldLockNames: 1_024,
  maxMaintenanceRootRegistrations: 1_024,
  maxReaderPins: 256,
  maxSegmentReferences: 4_096,
});

type BrowserWorkerMountRuntimeHostRegistry = Pick<
  HizoFSRuntimeHostRegistry<LockManager, HizoFSWorkerRuntimeHost>,
  "getOrCreate"
>;

const browserWorkerMountRuntimeHostRegistry = new HizoFSRuntimeHostRegistry<
  LockManager,
  HizoFSWorkerRuntimeHost
>();

const APPLICATION_METADATA_RECORD_CACHE_POLICY = Object.freeze({
  maximumBytes: 8 * 1024 * 1024,
  maximumEntries: 16 * 1024,
});

export const DEFAULT_HIZOFS_BACKING_FILE_HANDLE_CACHE_ENTRY_LIMIT = 1_024;

function createHizoFSOpfsFileHandleCachePolicy({ diagnostics, maximumEntries }: {
  diagnostics: HizoFSRuntimeDiagnosticsAccumulator | undefined;
  maximumEntries: number;
}): OpfsWritableBackendFileHandleCachePolicy {
  const segmentPrefix = `${HIZOFS_V1_FORMAT_CONSTANTS.container.segmentDirectoryName}/`;
  const cacheDiagnostics: OpfsWritableBackendFileHandleCacheDiagnosticsPort | undefined = diagnostics === undefined
    ? undefined
    : Object.freeze({
      recordEvent: ({ event }) => diagnostics.recordCacheEvent({
        cache: "backingFileHandle",
        event,
      }),
      setUsage: ({ entries }) => diagnostics.setCacheUsage({
        bytes: 0,
        cache: "backingFileHandle",
        entries,
      }),
    });
  return Object.freeze({
    diagnostics: cacheDiagnostics,
    maximumEntries,
    // WHY: authenticated Segment IDs bind immutable segment paths and HizoFS
    // never reuses them. Authority files such as Superblocks and Unlock
    // Envelopes remain uncached so every authority observation reacquires the
    // live OPFS entry rather than trusting a retained file capability.
    shouldCache: ({ path }) => path.startsWith(segmentPrefix),
  });
}

function createHizoFSOpfsWritableBackend({ diagnostics, fileHandleCacheEntryLimit, root }: {
  diagnostics: HizoFSRuntimeDiagnosticsAccumulator | undefined;
  fileHandleCacheEntryLimit: number;
  root: FileSystemDirectoryHandle;
}): OpfsWritableBackend<AuthenticatedHizoFSPhysicalBytes> {
  return new OpfsWritableBackend<AuthenticatedHizoFSPhysicalBytes>({
    fileHandleCachePolicy: createHizoFSOpfsFileHandleCachePolicy({
      diagnostics,
      maximumEntries: fileHandleCacheEntryLimit,
    }),
    root,
  });
}

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
  decodedInodeIndexPageCacheDiagnostics,
  indexDiagnostics,
  passphrase,
  recordDiagnostics,
  supportedFeatureBits,
  verifyProofAuthority,
}: {
  backend: HizoFSReadableBackend;
  decodedInodeIndexPageCacheDiagnostics?: DecodedInodeIndexPageCacheDiagnosticsPort;
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
    return { backend, decodedInodeIndexPageCacheDiagnostics, indexDiagnostics, opened, recordDiagnostics };
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
  readonly managementGenerationAdopter: AuthenticatedManagementCleanGenerationAdopter;
  readonly managementRuntimeHost: Pick<
    import("@/00-storage/service/hizofs/worker/runtime-host").HizoFSWorkerRuntimeHost,
    "openManagementCleanHeadBarrier"
  >;
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

async function runCredentialPublicationOperation<Value>({
  managementRuntimeHost,
  operation,
  runtimeSession,
}: {
  managementRuntimeHost: Pick<
    import("@/00-storage/service/hizofs/worker/runtime-host").HizoFSWorkerRuntimeHost,
    "openManagementCleanHeadBarrier"
  >;
  operation: ({ authority }: { authority: SessionOperationAuthority }) => Promise<Value>;
  runtimeSession: HizoFSApplicationRuntimeSession;
}): Promise<Value> {
  // Acquire the writer before closing mutation admission. A prepared writable
  // may already own the foreground writer and must be allowed to finish before
  // the management barrier captures and publishes its accepted generation.
  const writer = await runtimeSession.acquireWriter();
  const barrier = managementRuntimeHost.openManagementCleanHeadBarrier({ writerOwnership: "caller_owned" });
  const failures: unknown[] = [];
  let value: Value | undefined;
  try {
    await barrier.flushAndCaptureCleanGeneration();
    value = await writer.runPublication({ operation });
  } catch (cause: unknown) {
    failures.push(cause);
  }
  try {
    barrier.release();
  } catch (cause: unknown) {
    // A failed clean-head flush deliberately leaves mutation admission fenced.
    // Silently reopening it could let a management authority change race a
    // still-dirty or outcome-unknown generation.
    failures.push(cause);
  }
  try {
    await writer.close();
  } catch (cause: unknown) {
    failures.push(cause);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "credential publication ownership cleanup failed");
  }
  return value as Value;
}

function wrapDevelopmentWritableCredentialSession({ state }: {
  state: DevelopmentWritableCredentialSessionState;
}): StorageFileSystemSession {
  const { underlyingSession } = state;
  const wrapped: StorageFileSystemSession = {
    capabilities: underlyingSession.capabilities,
    root: underlyingSession.root,
    sync: async () => await underlyingSession.sync(),
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
      managementRuntimeHost: state.managementRuntimeHost,
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
  decodedInodeIndexPageCacheDiagnostics,
  indexDiagnostics,
  passphrase,
  recordDiagnostics,
  verifyProofAuthority,
}: {
  backend: HizoFSDevelopmentWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  decodedInodeIndexPageCacheDiagnostics?: DecodedInodeIndexPageCacheDiagnosticsPort;
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
      decodedInodeIndexPageCacheDiagnostics,
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
  backingFileHandleCacheEntryLimit,
  containerRoot,
  passphrase,
  runtimeDiagnostics,
  verifyProofAuthority,
}: {
  backingFileHandleCacheEntryLimit: number;
  containerRoot: FileSystemDirectoryHandle;
  passphrase: string;
  runtimeDiagnostics?: HizoFSRuntimeDiagnosticsAccumulator;
  verifyProofAuthority: ({ fileSystemId, rootKeyProof }: {
    fileSystemId: FileSystemId;
    rootKeyProof: FileSystemRootKeyProofDerivationCapability;
  }) => Promise<void>;
}): Promise<AuthenticatedDevelopmentWritableContainerCapabilityOpenResult> {
  const backend = createHizoFSOpfsWritableBackend({
    diagnostics: runtimeDiagnostics,
    fileHandleCacheEntryLimit: backingFileHandleCacheEntryLimit,
    root: containerRoot,
  });
  return await openAuthenticatedDevelopmentWritableContainerCapability({
    backend: runtimeDiagnostics === undefined
      ? backend
      : instrumentHizoFSWritableBackend({ backend, diagnostics: runtimeDiagnostics }),
    decodedInodeIndexPageCacheDiagnostics: runtimeDiagnostics,
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
  const backend = createHizoFSOpfsWritableBackend({
    diagnostics: undefined,
    fileHandleCacheEntryLimit: DEFAULT_HIZOFS_BACKING_FILE_HANDLE_CACHE_ENTRY_LIMIT,
    root: containerRoot,
  });
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
  indexDiagnostics,
  opened,
  recordDiagnostics,
}: AuthenticatedOpenedApplicationAuthority): AuthenticatedApplicationReadSessionResources {
  let released = false;
  const namespace = createAuthenticatedReadOnlyNamespace({
    commit: opened.commit,
    indexDiagnostics,
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
    syncDurability: "not-demonstrated",
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
/**
 * Carries logical roots from the latest accepted working generation while
 * anchoring persisted candidate sequencing to the durable authority. Every
 * candidate in one dirty epoch therefore writes durable Sequence + 1 even
 * when several accepted generations supersede one another in memory.
 */
function createMutationCandidatePlanningBaseCommit({ base }: {
  base: AuthenticatedWorkingApplicationGenerationDescriptor;
}): FileSystemCommitPayload {
  return createFileSystemCommitPayload({ payload: {
    ...base.commit,
    commitSequence: base.durableAuthority.commit.commitSequence,
    mutationId: base.durableAuthority.commit.mutationId,
  } });
}

function assertDeferredSuccessor({
  base,
  deferred,
  successor,
}: {
  base: AuthenticatedApplicationGenerationDescriptor;
  deferred: DeferredPreparedMutationCommitPublication;
  successor: AuthenticatedApplicationGenerationDescriptor;
}): void {
  if (!sameDurableGenerationIdentity({
    left: base.durableAuthority.identity,
    right: successor.durableAuthority.identity,
  })) {
    throw new TypeError("deferred mutation successor must retain its durable base authority");
  }
  if (
    successor.workingIdentity.authorityEpoch !== base.workingIdentity.authorityEpoch
    || successor.workingIdentity.generationNumber !== base.workingIdentity.generationNumber + 1n
  ) {
    throw new TypeError("deferred mutation successor is not the exact next working generation");
  }
  if (!bytesEqual({
    left: encodeHomeRecordReference({ reference: deferred.candidate.commitHomeRef }),
    right: encodeHomeRecordReference({ reference: successor.commitReference }),
  })) {
    throw new TypeError("deferred mutation candidate reference does not match its working successor");
  }
  if (!bytesEqual({
    left: encodeFileSystemCommitPayload({ payload: deferred.candidate.commitPayload }),
    right: encodeFileSystemCommitPayload({ payload: successor.commit }),
  })) {
    throw new TypeError("deferred mutation candidate payload does not match its working successor");
  }
}

function refreshedBaseAuthority({
  base,
  superblock,
}: {
  base: AuthenticatedApplicationGenerationDescriptor;
  superblock: Parameters<typeof createAuthenticatedDurableApplicationGenerationAuthority>[0]["superblock"];
}): AuthenticatedDurableApplicationGenerationAuthority {
  return createAuthenticatedDurableApplicationGenerationAuthority({
    commit: base.durableAuthority.commit,
    commitReference: base.durableAuthority.commitReference,
    superblock,
  });
}

function publishedSuccessor({
  successor,
  superblock,
}: {
  successor: AuthenticatedApplicationGenerationDescriptor;
  superblock: Parameters<typeof createAuthenticatedDurableApplicationGenerationAuthority>[0]["superblock"];
}): AuthenticatedApplicationGenerationDescriptor {
  return createAuthenticatedApplicationGenerationDescriptor({
    commit: successor.commit,
    commitReference: successor.commitReference,
    durableAuthority: createAuthenticatedDurableApplicationGenerationAuthority({
      commit: successor.commit,
      commitReference: successor.commitReference,
      superblock,
    }),
    workingIdentity: successor.workingIdentity,
  });
}

/**
 * Adapts one detached authenticated Commit authority to the runtime-owned
 * selected-candidate publisher. The application operation no longer owns the
 * publication assertion: the supplied gate must recheck current runtime
 * authority immediately before the first Superblock authority write.
 */
function createPreparedMutationSelectedCandidatePublisher({
  assertRuntimePublicationAllowed,
  base,
  deferred,
  successor,
}: {
  assertRuntimePublicationAllowed: () => void;
  base: AuthenticatedApplicationGenerationDescriptor;
  deferred: DeferredPreparedMutationCommitPublication;
  successor: AuthenticatedApplicationGenerationDescriptor;
}): ContainerRuntimeSelectedCandidatePublisher {
  assertDeferredSuccessor({ base, deferred, successor });
  return Object.freeze({
    abandon: () => deferred.publicationPort.abandon(),
    completeOutcomeUnknownResolution: ({ outcome }) => {
      switch (outcome) {
      case "confirmed_not_published":
        deferred.publicationPort.completeExternallyResolvedPublication({ outcome: "not_published" });
        return;
      case "confirmed_published":
        deferred.publicationPort.completeExternallyResolvedPublication({ outcome: "published" });
        return;
      default: return outcome satisfies never;
      }
    },
    publish: async ({ onCandidateMaterialized }) => {
      onCandidateMaterialized({
        candidateDurableIdentity: createDurableGenerationIdentity({
          commitReference: deferred.candidate.commitHomeRef,
          commitSequence: deferred.candidate.commitPayload.commitSequence,
          mutationId: deferred.candidate.commitPayload.mutationId,
        }),
      });
      try {
        const publication = await publishPreparedMutationCommitCandidateThroughPort({
          assertPublicationAllowed: assertRuntimePublicationAllowed,
          base: base.durableAuthority.superblock,
          candidate: deferred.candidate,
          publicationPort: deferred.publicationPort,
        });
        return Object.freeze({
          durableSuccessor: publishedSuccessor({
            successor,
            superblock: publication.superblock,
          }),
          type: "published" as const,
        });
      } catch (cause: unknown) {
        if (!(cause instanceof PreparedMutationCommitPublicationError)) {
          return Object.freeze({
            cause,
            refreshedDurableAuthority: base.durableAuthority,
            type: "not_published" as const,
          });
        }
        switch (cause.outcome) {
        case "not_published": return Object.freeze({
          cause,
          refreshedDurableAuthority: base.durableAuthority,
          type: "not_published" as const,
        });
        case "committed_redundancy_degraded":
        case "outcome_resolution_required":
        case undefined: break;
        default: return cause.outcome satisfies never;
        }

        let resolution;
        try {
          resolution = await deferred.publicationPort.resolvePublication({
            base: base.durableAuthority.superblock,
            intendedLogicalState: cause.intendedLogicalState,
          });
        } catch (resolutionCause: unknown) {
          return Object.freeze({
            cause: new AggregateError(
              [cause, resolutionCause],
              "deferred mutation publication outcome could not be resolved",
            ),
            type: "outcome_unknown" as const,
          });
        }
        switch (resolution.type) {
        case "not_published": return Object.freeze({
          cause,
          refreshedDurableAuthority: refreshedBaseAuthority({ base, superblock: resolution.superblock }),
          type: "not_published" as const,
        });
        case "publication_conflict": return Object.freeze({
          cause: new AggregateError(
            [cause],
            "deferred mutation publication resolved to a conflicting durable authority",
          ),
          type: "outcome_unknown" as const,
        });
        case "published":
          switch (resolution.superblock.copyState) {
          case "normal": return Object.freeze({
            durableSuccessor: publishedSuccessor({ successor, superblock: resolution.superblock }),
            type: "published" as const,
          });
          case "superblock_redundancy_degraded": return Object.freeze({
            cause: new AggregateError(
              [cause],
              "deferred mutation committed without converged Superblock copies",
            ),
            type: "outcome_unknown" as const,
          });
          default: return resolution.superblock.copyState satisfies never;
          }
        default: return resolution satisfies never;
        }
      }
    },
  });
}


type StagedMutationCommitMaterializationAuthority =
  DetachablePreparedMutationCommitPublicationPort & Readonly<{
    abandon: () => void;
  }>;

function createPublishedStagedSuccessor({ candidate, stagedSuccessor, superblock }: {
  candidate: PreparedMutationCommitCandidate;
  stagedSuccessor: AuthenticatedStagedApplicationGenerationDescriptor;
  superblock: Parameters<typeof createAuthenticatedDurableApplicationGenerationAuthority>[0]["superblock"];
}): AuthenticatedApplicationGenerationDescriptor {
  if (!bytesEqual({
    left: encodeFileSystemCommitPayload({ payload: candidate.commitPayload }),
    right: encodeFileSystemCommitPayload({ payload: stagedSuccessor.commit }),
  })) {
    throw new TypeError("materialized staged Commit does not match its accepted working payload");
  }
  return createAuthenticatedApplicationGenerationDescriptor({
    commit: stagedSuccessor.commit,
    commitReference: candidate.commitHomeRef,
    durableAuthority: createAuthenticatedDurableApplicationGenerationAuthority({
      commit: stagedSuccessor.commit,
      commitReference: candidate.commitHomeRef,
      superblock,
    }),
    workingIdentity: stagedSuccessor.workingIdentity,
  });
}

/**
 * Owns a Commit payload that is already accepted as the latest working
 * generation but has no physical Commit frame yet. Materialization happens at
 * flush time under a fresh short-lived metadata writer authority. The runtime
 * receives the exact physical candidate identity before the first Superblock
 * authority write so maintenance roots and outcome-unknown handling never
 * invent or guess a Commit reference.
 */
function createStagedMutationSelectedCandidatePublisher({
  assertRuntimePublicationAllowed,
  baseDurableAuthority,
  createMaterializationAuthority,
  releasePublicationResources = () => undefined,
  staged,
  stagedSuccessor,
}: {
  assertRuntimePublicationAllowed: () => void;
  baseDurableAuthority: AuthenticatedDurableApplicationGenerationAuthority;
  createMaterializationAuthority: () => Promise<StagedMutationCommitMaterializationAuthority>;
  releasePublicationResources?: () => void;
  staged: StagedPreparedMutationCommit;
  stagedSuccessor: AuthenticatedStagedApplicationGenerationDescriptor;
}): ContainerRuntimeSelectedCandidatePublisher {
  if (!sameDurableGenerationIdentity({
    left: stagedSuccessor.durableAuthority.identity,
    right: baseDurableAuthority.identity,
  })) {
    throw new TypeError("staged mutation successor does not retain its durable publication base");
  }
  if (!bytesEqual({
    left: encodeFileSystemCommitPayload({ payload: staged.commitPayload }),
    right: encodeFileSystemCommitPayload({ payload: stagedSuccessor.commit }),
  })) {
    throw new TypeError("staged mutation publisher payload does not match its working successor");
  }
  let deferred: DeferredPreparedMutationCommitPublication | undefined;
  let closed = false;
  let publicationResourcesReleased = false;
  const releaseRetainedPublicationResources = (): void => {
    if (publicationResourcesReleased) return;
    publicationResourcesReleased = true;
    releasePublicationResources();
  };

  const candidateDurableIdentity = ({ candidate }: {
    candidate: PreparedMutationCommitCandidate;
  }): DurableGenerationIdentity => createDurableGenerationIdentity({
    commitReference: candidate.commitHomeRef,
    commitSequence: candidate.commitPayload.commitSequence,
    mutationId: candidate.commitPayload.mutationId,
  });

  const abandonDeferred = ({ value }: {
    value: DeferredPreparedMutationCommitPublication;
  }): void => value.publicationPort.abandon();

  return Object.freeze({
    abandon: () => {
      if (closed) return;
      closed = true;
      const current = deferred;
      deferred = undefined;
      try {
        if (current !== undefined) abandonDeferred({ value: current });
      } finally {
        releaseRetainedPublicationResources();
      }
    },
    completeOutcomeUnknownResolution: ({ outcome }) => {
      const current = deferred;
      if (current === undefined) {
        throw new TypeError("staged mutation has no materialized publication authority to resolve");
      }
      try {
        switch (outcome) {
        case "confirmed_not_published":
          current.publicationPort.completeExternallyResolvedPublication({ outcome: "not_published" });
          break;
        case "confirmed_published":
          current.publicationPort.completeExternallyResolvedPublication({ outcome: "published" });
          break;
        default: outcome satisfies never;
        }
      } finally {
        closed = true;
        deferred = undefined;
        releaseRetainedPublicationResources();
      }
    },
    publish: async ({ onCandidateMaterialized, onMaterializationAppendAttempt }) => {
      if (closed) throw new TypeError("staged mutation selected-candidate publisher is closed");
      let current = deferred;
      if (current === undefined) {
        let materializationAuthority: StagedMutationCommitMaterializationAuthority | undefined;
        let materializationResourceAttempt: ReturnType<typeof onMaterializationAppendAttempt> | undefined;
        try {
          materializationAuthority = await createMaterializationAuthority();
          const candidate = await materializeStagedMutationCommitCandidateThroughPort({
            assertPublicationAllowed: assertRuntimePublicationAllowed,
            base: baseDurableAuthority.superblock,
            beforeAppendAttempt: () => {
              if (materializationResourceAttempt !== undefined) {
                throw new TypeError("staged Commit materialization append attempt was already opened");
              }
              materializationResourceAttempt = onMaterializationAppendAttempt({
                frameBytes: STAGED_MUTATION_COMMIT_MATERIALIZATION_FRAME_BYTES,
              });
            },
            publicationPort: materializationAuthority,
            staged,
          });
          const detachedPublicationPort = materializationAuthority.detachPreparedCandidatePublication({ candidate });
          detachedPublicationPort.completeWorkingAcceptance();
          const materialized = Object.freeze({ candidate, publicationPort: detachedPublicationPort });
          try {
            onCandidateMaterialized({ candidateDurableIdentity: candidateDurableIdentity({ candidate }) });
            materializationResourceAttempt?.completeReusableCandidate();
            materializationResourceAttempt = undefined;
          } catch (cause: unknown) {
            const failures: unknown[] = [cause];
            try {
              materializationResourceAttempt?.fail();
              materializationResourceAttempt = undefined;
            } catch (cleanupCause: unknown) {
              failures.push(cleanupCause);
            }
            try {
              detachedPublicationPort.abandon();
            } catch (cleanupCause: unknown) {
              failures.push(cleanupCause);
            }
            return Object.freeze({
              cause: failures.length === 1
                ? cause
                : new AggregateError(failures, "staged Commit materialization binding cleanup failed"),
              refreshedDurableAuthority: baseDurableAuthority,
              type: "not_published" as const,
            });
          }
          deferred = materialized;
          current = materialized;
        } catch (cause: unknown) {
          const failures: unknown[] = [cause];
          try {
            materializationResourceAttempt?.fail();
          } catch (cleanupCause: unknown) {
            failures.push(cleanupCause);
          }
          try {
            materializationAuthority?.abandon();
          } catch (cleanupCause: unknown) {
            failures.push(cleanupCause);
          }
          return Object.freeze({
            cause: failures.length === 1
              ? cause
              : new AggregateError(failures, "staged Commit materialization and authority cleanup both failed"),
            refreshedDurableAuthority: baseDurableAuthority,
            type: "not_published" as const,
          });
        }
      } else {
        onCandidateMaterialized({
          candidateDurableIdentity: candidateDurableIdentity({ candidate: current.candidate }),
        });
      }

      try {
        const publication = await publishPreparedMutationCommitCandidateThroughPort({
          assertPublicationAllowed: assertRuntimePublicationAllowed,
          base: baseDurableAuthority.superblock,
          candidate: current.candidate,
          publicationPort: current.publicationPort,
        });
        return Object.freeze({
          durableSuccessor: createPublishedStagedSuccessor({
            candidate: current.candidate,
            stagedSuccessor,
            superblock: publication.superblock,
          }),
          type: "published" as const,
        });
      } catch (cause: unknown) {
        if (!(cause instanceof PreparedMutationCommitPublicationError)) {
          return Object.freeze({
            cause,
            refreshedDurableAuthority: baseDurableAuthority,
            type: "not_published" as const,
          });
        }
        switch (cause.outcome) {
        case "not_published": return Object.freeze({
          cause,
          refreshedDurableAuthority: baseDurableAuthority,
          type: "not_published" as const,
        });
        case "committed_redundancy_degraded":
        case "outcome_resolution_required":
        case undefined: break;
        default: return cause.outcome satisfies never;
        }

        let resolution;
        try {
          resolution = await current.publicationPort.resolvePublication({
            base: baseDurableAuthority.superblock,
            intendedLogicalState: cause.intendedLogicalState,
          });
        } catch (resolutionCause: unknown) {
          return Object.freeze({
            cause: new AggregateError(
              [cause, resolutionCause],
              "staged mutation publication outcome could not be resolved",
            ),
            type: "outcome_unknown" as const,
          });
        }
        switch (resolution.type) {
        case "not_published": return Object.freeze({
          cause,
          refreshedDurableAuthority: createAuthenticatedDurableApplicationGenerationAuthority({
            commit: baseDurableAuthority.commit,
            commitReference: baseDurableAuthority.commitReference,
            superblock: resolution.superblock,
          }),
          type: "not_published" as const,
        });
        case "publication_conflict": return Object.freeze({
          cause: new AggregateError([cause], "staged mutation publication resolved to a conflicting durable authority"),
          type: "outcome_unknown" as const,
        });
        case "published":
          switch (resolution.superblock.copyState) {
          case "normal": return Object.freeze({
            durableSuccessor: createPublishedStagedSuccessor({
              candidate: current.candidate,
              stagedSuccessor,
              superblock: resolution.superblock,
            }),
            type: "published" as const,
          });
          case "superblock_redundancy_degraded": return Object.freeze({
            cause: new AggregateError(
              [cause],
              "staged mutation committed without converged Superblock copies",
            ),
            type: "outcome_unknown" as const,
          });
          default: return resolution.superblock.copyState satisfies never;
          }
        default: return resolution satisfies never;
        }
      }
    },
  });
}


/**
 * Transfers one exact detached candidate into runtime ownership. A rejected
 * admission leaves the publisher owned by the caller; a successful call makes
 * the runtime solely responsible for publication or terminal abandonment.
 */
function installPreparedMutationSelectedCandidate({
  admission,
  assertRuntimePublicationAllowed,
  base,
  deferred,
  resourceUsage,
  successor,
}: {
  admission: ContainerRuntimeAcceptedMutationAdmission;
  assertRuntimePublicationAllowed: () => void;
  base: AuthenticatedApplicationGenerationDescriptor;
  deferred: DeferredPreparedMutationCommitPublication;
  resourceUsage: AuthenticatedMutationResourceUsage;
  successor: AuthenticatedApplicationGenerationDescriptor;
}): ContainerRuntimeSelectedCandidatePublisher {
  admission.replaceResourceReservation({
    dirtyMetadataBytes: resourceUsage.appendedMetadataFrameBytes,
    unpublishedPhysicalBytes: resourceUsage.unpublishedPhysicalBytes,
  });
  const publisher = createPreparedMutationSelectedCandidatePublisher({
    assertRuntimePublicationAllowed,
    base,
    deferred,
    successor,
  });
  admission.commitAcceptedSuccessor({ publisher, successor });
  deferred.publicationPort.completeWorkingAcceptance();
  return publisher;
}

function prepareAndInstallStagedMutationSelectedCandidate({
  admission,
  assertCandidatePreparationAllowed,
  assertRuntimePublicationAllowed,
  base,
  commitPayload,
  createMaterializationAuthority,
  prepareWorkingAcceptance,
  releasePublicationResources = () => undefined,
  resourceUsage,
}: {
  admission: ContainerRuntimeAcceptedMutationAdmission;
  assertCandidatePreparationAllowed: () => void;
  assertRuntimePublicationAllowed: () => void;
  base: AuthenticatedWorkingApplicationGenerationDescriptor;
  commitPayload: FileSystemCommitPayload;
  createMaterializationAuthority: () => Promise<StagedMutationCommitMaterializationAuthority>;
  prepareWorkingAcceptance: () => void;
  releasePublicationResources?: () => void;
  resourceUsage: AuthenticatedMutationResourceUsage;
}): Readonly<{
  publisher: ContainerRuntimeSelectedCandidatePublisher;
  successor: AuthenticatedStagedApplicationGenerationDescriptor;
}> {
  let publisher: ContainerRuntimeSelectedCandidatePublisher | undefined;
  try {
    const staged = prepareStagedMutationCommit({
      assertPublicationAllowed: assertCandidatePreparationAllowed,
      base: base.durableAuthority.superblock,
      commitPayload,
    });
    const successor = createAuthenticatedStagedApplicationGenerationDescriptor({
      commit: staged.commitPayload,
      durableAuthority: base.durableAuthority,
      workingIdentity: createSuccessorWorkingGenerationIdentity({
        mutationId: staged.commitPayload.mutationId,
        previous: base.workingIdentity,
      }),
    });
    publisher = createStagedMutationSelectedCandidatePublisher({
      assertRuntimePublicationAllowed,
      baseDurableAuthority: base.durableAuthority,
      createMaterializationAuthority,
      releasePublicationResources,
      staged,
      stagedSuccessor: successor,
    });
    admission.replaceResourceReservation({
      dirtyMetadataBytes: resourceUsage.appendedMetadataFrameBytes,
      unpublishedPhysicalBytes: resourceUsage.unpublishedPhysicalBytes,
    });
    admission.reserveStagedCommitMaterializationHeadroom({
      bytes: STAGED_MUTATION_COMMIT_MATERIALIZATION_FRAME_BYTES,
    });
    prepareWorkingAcceptance();
    admission.commitAcceptedStagedSuccessor({ publisher, successor });
    return Object.freeze({ publisher, successor });
  } catch (cause: unknown) {
    const failures: unknown[] = [cause];
    try {
      if (publisher === undefined) releasePublicationResources();
      else publisher.abandon();
    } catch (cleanupCause: unknown) {
      failures.push(cleanupCause);
    }
    try {
      admission.rollback();
    } catch (cleanupCause: unknown) {
      failures.push(cleanupCause);
    }
    if (failures.length === 1) throw cause;
    throw new AggregateError(failures, "staged mutation admission cleanup failed");
  }
}

async function prepareAndInstallDeferredMutationSelectedCandidate({
  admission,
  assertCandidatePreparationAllowed,
  assertRuntimePublicationAllowed,
  base,
  commitPayload,
  createSuccessor,
  publicationPort,
  resourceUsage,
}: {
  admission: ContainerRuntimeAcceptedMutationAdmission;
  assertCandidatePreparationAllowed: () => void;
  assertRuntimePublicationAllowed: () => void;
  base: AuthenticatedApplicationGenerationDescriptor;
  commitPayload: FileSystemCommitPayload;
  createSuccessor: ({ candidate }: {
    candidate: PreparedMutationCommitCandidate;
  }) => AuthenticatedApplicationGenerationDescriptor;
  publicationPort: Parameters<typeof prepareDeferredMutationCommitPublication>[0]["publicationPort"];
  resourceUsage: AuthenticatedMutationResourceUsage;
}): Promise<Readonly<{
  publisher: ContainerRuntimeSelectedCandidatePublisher;
  successor: AuthenticatedApplicationGenerationDescriptor;
}>> {
  const deferred = await prepareDeferredMutationCommitPublication({
    assertPublicationAllowed: assertCandidatePreparationAllowed,
    base: base.durableAuthority.superblock,
    commitPayload,
    onCandidatePrepared: undefined,
    publicationPort,
  });
  const closeUnacceptedPreparation = ({ cause }: { cause: unknown }): never => {
    const cleanupFailures: unknown[] = [];
    try {
      deferred.publicationPort.abandon();
    } catch (cleanupCause: unknown) {
      cleanupFailures.push(cleanupCause);
    }
    try {
      admission.rollback();
    } catch (cleanupCause: unknown) {
      cleanupFailures.push(cleanupCause);
    }
    if (cleanupFailures.length === 0) throw cause;
    throw new AggregateError(
      [cause, ...cleanupFailures],
      "deferred candidate preparation and runtime admission cleanup both failed",
    );
  };
  let successor: AuthenticatedApplicationGenerationDescriptor;
  try {
    successor = createSuccessor({ candidate: deferred.candidate });
  } catch (cause: unknown) {
    return closeUnacceptedPreparation({ cause });
  }
  try {
    const publisher = installPreparedMutationSelectedCandidate({
      admission,
      assertRuntimePublicationAllowed,
      base,
      deferred,
      resourceUsage,
      successor,
    });
    return Object.freeze({ publisher, successor });
  } catch (cause: unknown) {
    return closeUnacceptedPreparation({ cause });
  }
}

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

function assertAuthenticatedMetadataMutationPreparationAllowed({
  assertPublicationAllowed,
  baseCommit,
  baseSuperblock,
}: {
  assertPublicationAllowed: () => void;
  baseCommit: FileSystemCommitPayload;
  baseSuperblock: OpenedSuperblockCopies;
}): void {
  if (
    baseCommit.commitSequence !== baseSuperblock.logicalState.activeCommitSequence
    || !bytesEqual({ left: baseCommit.mutationId, right: baseSuperblock.logicalState.activeMutationId })
  ) {
    throw new TypeError("metadata mutation base Commit does not match the selected Superblock authority");
  }
  assertPublicationAllowed();
}

export type PublishedExplicitBulkCommit = Readonly<{
  commitPayload: FileSystemCommitPayload;
  publication: PublishedPreparedMutationCommit;
}>;

type MutationCandidatePreparedObserver = ({ candidate, commitPayload }: {
  candidate: PreparedMutationCommitCandidate;
  commitPayload: FileSystemCommitPayload;
}) => PreparedMutationCommitCandidate;

type AuthenticatedMetadataMutationPreparationMode =
  | "build"
  | "update";

function createAuthenticatedMetadataMutationPreparationStores({
  authority,
  indexDiagnostics,
  mode,
}: {
  authority: AuthenticatedMetadataMutationAuthority;
  indexDiagnostics: ImmutableBTreeDiagnosticsPort | undefined;
  mode: AuthenticatedMetadataMutationPreparationMode;
}) {
  const operationDiagnostics = (() => {
    switch (mode) {
    case "build": return indexBuildOperationDiagnostics({ diagnostics: indexDiagnostics });
    case "update": return indexUpdateOperationDiagnostics({ diagnostics: indexDiagnostics });
    default: return mode satisfies never;
    }
  })();
  return Object.freeze({
    directoryPageStore: createDirectoryPageTreePageStore({ pagePort: {
      operationDiagnostics,
      readPage: async ({ isRoot, reference }) => await authority.readDirectoryPage({ isRoot, reference }),
      writePage: async ({ isRoot, page }) => await authority.writeDirectoryPage({ isRoot, page }),
    } }),
    inodeTablePageStore: createRootInodeTablePageStore({ pagePort: {
      operationDiagnostics,
      readPage: async ({ isRoot, reference }) => await authority.readInodeTablePage({ isRoot, reference }),
      writePage: async ({ isRoot, page }) => await authority.writeInodeTablePage({ isRoot, page }),
    } }),
  });
}

async function withAuthenticatedMetadataMutationPreparation<T>({
  assertPublicationAllowed,
  authority,
  baseCommit,
  baseSuperblock,
  indexDiagnostics,
  mode,
  prepare,
}: {
  assertPublicationAllowed: () => void;
  authority: AuthenticatedMetadataMutationAuthority;
  baseCommit: FileSystemCommitPayload;
  baseSuperblock: OpenedSuperblockCopies;
  indexDiagnostics: ImmutableBTreeDiagnosticsPort | undefined;
  mode: AuthenticatedMetadataMutationPreparationMode;
  prepare: ({ directoryPageStore, inodeTablePageStore }: ReturnType<
    typeof createAuthenticatedMetadataMutationPreparationStores
  >) => Promise<T>;
}): Promise<T> {
  try {
    assertAuthenticatedMetadataMutationPreparationAllowed({
      assertPublicationAllowed,
      baseCommit,
      baseSuperblock,
    });
    return await prepare(createAuthenticatedMetadataMutationPreparationStores({
      authority,
      indexDiagnostics,
      mode,
    }));
  } catch (cause: unknown) {
    authority.abandon();
    throw cause;
  }
}

async function prepareAuthenticatedExplicitBulkCommit({
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
}>): Promise<Readonly<{ commitPayload: FileSystemCommitPayload }>> {
  return Object.freeze({
    commitPayload: await withAuthenticatedMetadataMutationPreparation({
      assertPublicationAllowed,
      authority,
      baseCommit,
      baseSuperblock,
      indexDiagnostics,
      mode: "build",
      prepare: async ({ directoryPageStore, inodeTablePageStore }) => await prepareExplicitBulkCommit({
        baseCommit,
        candidate,
        directoryImportLimits,
        directoryPageStore,
        inodeTablePageStore,
        mutationId,
      }),
    }),
  });
}

async function prepareAuthenticatedOrdinaryEntryCreate({
  assertPublicationAllowed,
  authority,
  baseCommit,
  baseSuperblock,
  indexDiagnostics,
  knownInodeNumbers,
  mutationId,
  operationTimestamp,
  parent,
  request,
  target,
}: Readonly<{
  assertPublicationAllowed: () => void;
  authority: AuthenticatedMetadataMutationAuthority;
  baseCommit: FileSystemCommitPayload;
  baseSuperblock: OpenedSuperblockCopies;
  indexDiagnostics: ImmutableBTreeDiagnosticsPort | undefined;
  knownInodeNumbers: readonly InodeNumber[];
  mutationId: MutationId;
  operationTimestamp: TimestampMilliseconds;
  parent: DirectoryInodeEntry;
  request: OrdinaryEntryCreateRequest;
  target: OrdinaryEntryCreateTarget;
}>): Promise<PreparedOrdinaryEntryCreateCommit> {
  return await withAuthenticatedMetadataMutationPreparation({
    assertPublicationAllowed,
    authority,
    baseCommit,
    baseSuperblock,
    indexDiagnostics,
    mode: "update",
    prepare: async ({ directoryPageStore, inodeTablePageStore }) => await prepareOrdinaryEntryCreateCommit({
      baseCommit,
      directoryPageStore,
      inodeTablePageStore,
      knownInodeNumbers,
      mutationId,
      operationTimestamp,
      parent,
      request,
      target,
    }),
  });
}

async function prepareAuthenticatedOrdinaryEntryMove({
  assertPublicationAllowed,
  authority,
  baseCommit,
  baseSuperblock,
  destinationParent,
  indexDiagnostics,
  mutationId,
  operationTimestamp,
  plan,
  sourceParent,
}: Readonly<{
  assertPublicationAllowed: () => void;
  authority: AuthenticatedMetadataMutationAuthority;
  baseCommit: FileSystemCommitPayload;
  baseSuperblock: OpenedSuperblockCopies;
  destinationParent: DirectoryInodeEntry;
  indexDiagnostics: ImmutableBTreeDiagnosticsPort | undefined;
  mutationId: MutationId;
  operationTimestamp: TimestampMilliseconds;
  plan: OrdinaryEntryMovePlan;
  sourceParent: DirectoryInodeEntry;
}>): Promise<PreparedOrdinaryEntryMoveCommit> {
  return await withAuthenticatedMetadataMutationPreparation({
    assertPublicationAllowed,
    authority,
    baseCommit,
    baseSuperblock,
    indexDiagnostics,
    mode: "update",
    prepare: async ({ directoryPageStore, inodeTablePageStore }) => await prepareOrdinaryEntryMoveCommit({
      baseCommit,
      destinationParent,
      directoryPageStore,
      inodeTablePageStore,
      mutationId,
      operationTimestamp,
      plan,
      sourceParent,
    }),
  });
}

async function prepareAuthenticatedWholeFileReflink({
  assertPublicationAllowed,
  authority,
  baseCommit,
  baseSuperblock,
  destinationParent,
  indexDiagnostics,
  knownInodeNumbers,
  mutationId,
  operationTimestamp,
  source,
  target,
}: Readonly<{
  assertPublicationAllowed: () => void;
  authority: AuthenticatedMetadataMutationAuthority;
  baseCommit: FileSystemCommitPayload;
  baseSuperblock: OpenedSuperblockCopies;
  destinationParent: DirectoryInodeEntry;
  indexDiagnostics: ImmutableBTreeDiagnosticsPort | undefined;
  knownInodeNumbers: readonly InodeNumber[];
  mutationId: MutationId;
  operationTimestamp: TimestampMilliseconds;
  source: WholeFileReflinkSource;
  target: WholeFileReflinkTarget;
}>): Promise<PreparedWholeFileReflinkCommit> {
  return await withAuthenticatedMetadataMutationPreparation({
    assertPublicationAllowed,
    authority,
    baseCommit,
    baseSuperblock,
    indexDiagnostics,
    mode: "update",
    prepare: async ({ directoryPageStore, inodeTablePageStore }) => await prepareWholeFileReflinkCommit({
      baseCommit,
      destinationParent,
      directoryPageStore,
      inodeTablePageStore,
      knownInodeNumbers,
      mutationId,
      operationTimestamp,
      source,
      target,
    }),
  });
}

async function prepareAuthenticatedOrdinaryEntryRemoval({
  assertPublicationAllowed,
  authority,
  baseCommit,
  baseSuperblock,
  indexDiagnostics,
  mutationId,
  operationTimestamp,
  parent,
  plan,
}: Readonly<{
  assertPublicationAllowed: () => void;
  authority: AuthenticatedMetadataMutationAuthority;
  baseCommit: FileSystemCommitPayload;
  baseSuperblock: OpenedSuperblockCopies;
  indexDiagnostics: ImmutableBTreeDiagnosticsPort | undefined;
  mutationId: MutationId;
  operationTimestamp: TimestampMilliseconds;
  parent: DirectoryInodeEntry;
  plan: OrdinaryEntryRemovalPlan;
}>): Promise<PreparedOrdinaryEntryRemovalCommit> {
  return await withAuthenticatedMetadataMutationPreparation({
    assertPublicationAllowed,
    authority,
    baseCommit,
    baseSuperblock,
    indexDiagnostics,
    mode: "update",
    prepare: async ({ directoryPageStore, inodeTablePageStore }) => await prepareOrdinaryEntryRemovalCommit({
      baseCommit,
      directoryPageStore,
      inodeTablePageStore,
      mutationId,
      operationTimestamp,
      parent,
      plan,
    }),
  });
}

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
  onCandidatePrepared,
}: Readonly<{
  assertPublicationAllowed: () => void;
  authority: AuthenticatedMetadataMutationAuthority;
  baseCommit: FileSystemCommitPayload;
  baseSuperblock: OpenedSuperblockCopies;
  candidate: SealedExplicitBulkCandidate;
  directoryImportLimits: StreamingDirectoryImportLimits;
  indexDiagnostics: ImmutableBTreeDiagnosticsPort | undefined;
  mutationId: MutationId;
  onCandidatePrepared: MutationCandidatePreparedObserver | undefined;
}>): Promise<PublishedExplicitBulkCommit> {
  try {
    const { commitPayload } = await prepareAuthenticatedExplicitBulkCommit({
      assertPublicationAllowed,
      authority,
      baseCommit,
      baseSuperblock,
      candidate,
      directoryImportLimits,
      indexDiagnostics,
      mutationId,
    });
    const publication = await publishPreparedMutationCommit({
      assertPublicationAllowed,
      base: baseSuperblock,
      commitPayload,
      onCandidatePrepared: onCandidatePrepared === undefined
        ? undefined
        : ({ candidate: preparedCandidate }) => onCandidatePrepared({
          candidate: preparedCandidate,
          commitPayload,
        }),
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
  onCandidatePrepared,
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
  onCandidatePrepared: MutationCandidatePreparedObserver | undefined;
  operationTimestamp: TimestampMilliseconds;
  parent: DirectoryInodeEntry;
  request: OrdinaryEntryCreateRequest;
  target: OrdinaryEntryCreateTarget;
}>): Promise<PublishedOrdinaryEntryCreate> {
  try {
    const prepared = await prepareAuthenticatedOrdinaryEntryCreate({
      assertPublicationAllowed,
      authority,
      baseCommit,
      baseSuperblock,
      indexDiagnostics,
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
      onCandidatePrepared: onCandidatePrepared === undefined
        ? undefined
        : ({ candidate }) => onCandidatePrepared({ candidate, commitPayload: prepared.commitPayload }),
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
  onCandidatePrepared,
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
  onCandidatePrepared: MutationCandidatePreparedObserver | undefined;
  operationTimestamp: TimestampMilliseconds;
  plan: OrdinaryEntryMovePlan;
  sourceParent: DirectoryInodeEntry;
}>): Promise<PublishedOrdinaryEntryMove> {
  try {
    const prepared = await prepareAuthenticatedOrdinaryEntryMove({
      assertPublicationAllowed,
      authority,
      baseCommit,
      baseSuperblock,
      destinationParent,
      indexDiagnostics,
      mutationId,
      operationTimestamp,
      plan,
      sourceParent,
    });
    const publication = await publishPreparedMutationCommit({
      assertPublicationAllowed,
      base: baseSuperblock,
      commitPayload: prepared.commitPayload,
      onCandidatePrepared: onCandidatePrepared === undefined
        ? undefined
        : ({ candidate }) => onCandidatePrepared({ candidate, commitPayload: prepared.commitPayload }),
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
  onCandidatePrepared,
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
  onCandidatePrepared: MutationCandidatePreparedObserver | undefined;
  operationTimestamp: TimestampMilliseconds;
  source: WholeFileReflinkSource;
  target: WholeFileReflinkTarget;
}>): Promise<PublishedWholeFileReflink> {
  try {
    const prepared = await prepareAuthenticatedWholeFileReflink({
      assertPublicationAllowed,
      authority,
      baseCommit,
      baseSuperblock,
      destinationParent,
      indexDiagnostics,
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
      onCandidatePrepared: onCandidatePrepared === undefined
        ? undefined
        : ({ candidate }) => onCandidatePrepared({ candidate, commitPayload: prepared.commitPayload }),
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
  onCandidatePrepared,
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
  onCandidatePrepared: MutationCandidatePreparedObserver | undefined;
  operationTimestamp: TimestampMilliseconds;
  parent: DirectoryInodeEntry;
  plan: OrdinaryEntryRemovalPlan;
}>): Promise<PublishedOrdinaryEntryRemoval> {
  try {
    const prepared = await prepareAuthenticatedOrdinaryEntryRemoval({
      assertPublicationAllowed,
      authority,
      baseCommit,
      baseSuperblock,
      indexDiagnostics,
      mutationId,
      operationTimestamp,
      parent,
      plan,
    });
    const publication = await publishPreparedMutationCommit({
      assertPublicationAllowed,
      base: baseSuperblock,
      commitPayload: prepared.commitPayload,
      onCandidatePrepared: onCandidatePrepared === undefined
        ? undefined
        : ({ candidate }) => onCandidatePrepared({ candidate, commitPayload: prepared.commitPayload }),
      publicationPort: authority,
    });
    return { ...prepared, publication };
  } catch (cause: unknown) {
    authority.abandon();
    throw cause;
  }
}

type AuthenticatedWritableApplicationGeneration =
  AuthenticatedWorkingApplicationGenerationDescriptor & Readonly<{
    resolver: ReadOnlyNamespaceResolver;
  }>;

type MaterializedAuthenticatedWritableApplicationGeneration =
  AuthenticatedApplicationGenerationDescriptor & Readonly<{
    resolver: ReadOnlyNamespaceResolver;
  }>;

function requireMaterializedWritableGeneration({ generation }: {
  generation: AuthenticatedWritableApplicationGeneration;
}): MaterializedAuthenticatedWritableApplicationGeneration {
  if ("commitReference" in generation) return generation;
  throw new TypeError("operation requires a materialized writable application generation");
}

type AuthenticatedCredentialAuthorityUpdate = Readonly<{
  superblock: OpenedSuperblockCopies;
  unlockingSlotId: import("@/00-storage/service/hizofs/00-format").CredentialSlotId;
  unlockSequence: import("@/00-storage/service/hizofs/00-format").UnlockSequence;
}>;

type AuthenticatedCredentialAuthorityUpdater = ({ update }: {
  update: AuthenticatedCredentialAuthorityUpdate;
}) => void;

type AuthenticatedManagementCleanGenerationAdopter = ({ descriptor }: {
  descriptor: AuthenticatedApplicationGenerationDescriptor;
}) => void;

function syncDurabilityForWritableProfile({ writableProfile }: {
  writableProfile: AuthenticatedOpenedWritableApplicationAuthority["writableProfile"];
}): StorageFileSystemSyncDurability {
  switch (writableProfile) {
  case "development-unverified": return "not-demonstrated";
  case "release-qualified": return "demonstrated";
  default: return writableProfile satisfies never;
  }
}

export type AuthenticatedApplicationReadWriteSessionResources = Readonly<{
  adoptManagementCleanGeneration: AuthenticatedManagementCleanGenerationAdopter;
  createReadSnapshotResources: () => Readonly<{
    commitReference: HomeRecordReference;
    mutationPort: import("@/00-storage/service/hizofs/api").HizoFSApplicationMutationPort;
    namespace: HizoFSApplicationSessionNamespace;
    releasePreparation?: () => void;
  }> | Promise<Readonly<{
    commitReference: HomeRecordReference;
    mutationPort: import("@/00-storage/service/hizofs/api").HizoFSApplicationMutationPort;
    namespace: HizoFSApplicationSessionNamespace;
    releasePreparation?: () => void;
  }>>;
  mutationPort: import("@/00-storage/service/hizofs/api").HizoFSApplicationMutationPort;
  namespace: HizoFSApplicationSessionNamespace;
  releaseResources: () => Promise<void>;
  syncDurability: StorageFileSystemSyncDurability;
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
  decodedInodeIndexPageCacheDiagnostics?: DecodedInodeIndexPageCacheDiagnosticsPort;
  decodedInodeIndexPageCacheEntryLimit?: number;
  operationTimestamp: () => TimestampMilliseconds;
  indexDiagnostics?: ImmutableBTreeDiagnosticsPort;
  randomSource?: RandomByteSource;
  recordDiagnostics?: AuthenticatedStoreDiagnosticsPort;
  removalLimits: Readonly<{ deleteBatchSize: number; maxVisitedInodes: number }>;
  recheckDurableGenerationAuthority: ({ commit, superblock }: {
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

function openAcceptedApplicationMutationAdmission({
  authenticatedGeneration,
  dirtyMetadataBytes,
  expectedBase,
  unpublishedPhysicalBytes,
}: {
  authenticatedGeneration: ContainerRuntimeAuthenticatedApplicationGeneration;
  dirtyMetadataBytes: number;
  expectedBase: AuthenticatedWorkingApplicationGenerationDescriptor;
  unpublishedPhysicalBytes: number;
}): ContainerRuntimeAcceptedMutationAdmission {
  try {
    return authenticatedGeneration.openAcceptedMutationAdmission({
      dirtyMetadataBytes,
      expectedBase,
      unpublishedPhysicalBytes,
    });
  } catch (cause: unknown) {
    if (
      cause instanceof WorkingGenerationCoordinatorError
      && cause.code === "durability_stalled"
    ) {
      throw new HizoFSApplicationMutationSessionPoisonedError({ cause });
    }
    throw cause;
  }
}

async function openStableAcceptedApplicationMutationAdmission({
  authenticatedGeneration,
  dirtyMetadataBytes,
  expectedBase,
  unpublishedPhysicalBytes,
}: {
  authenticatedGeneration: ContainerRuntimeAuthenticatedApplicationGeneration;
  dirtyMetadataBytes: number;
  expectedBase: AuthenticatedWorkingApplicationGenerationDescriptor;
  unpublishedPhysicalBytes: number;
}): Promise<Readonly<{
  admission: ContainerRuntimeAcceptedMutationAdmission;
  base: AuthenticatedWorkingApplicationGenerationDescriptor;
}>> {
  try {
    return {
      admission: openAcceptedApplicationMutationAdmission({
        authenticatedGeneration,
        dirtyMetadataBytes,
        expectedBase,
        unpublishedPhysicalBytes,
      }),
      base: expectedBase,
    };
  } catch (cause: unknown) {
    if (!(cause instanceof WorkingGenerationCoordinatorError) || cause.code !== "working_authority_busy") {
      throw cause;
    }
    const waited = await authenticatedGeneration.waitForInFlightPublication();
    if (!waited) throw cause;
    const refreshed = authenticatedGeneration.capture();
    if (!sameWorkingGenerationIdentity({
      left: refreshed.workingIdentity,
      right: expectedBase.workingIdentity,
    })) {
      throw new TypeError("runtime publication changed the mutation working generation", { cause });
    }
    return {
      admission: openAcceptedApplicationMutationAdmission({
        authenticatedGeneration,
        dirtyMetadataBytes,
        expectedBase: refreshed,
        unpublishedPhysicalBytes,
      }),
      base: refreshed,
    };
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

function writableGeneration({
  backend,
  commit,
  commitReference,
  decodedInodeLeafPageIndexCache,
  durableAuthority,
  fileSystemId,
  indexDiagnostics,
  metadataRecordCache,
  namespaceValidationCache,
  recordDiagnostics,
  rootKey,
  workingIdentity,
}: {
  backend: HizoFSReadableBackend;
  commit: FileSystemCommitPayload;
  commitReference: HomeRecordReference;
  decodedInodeLeafPageIndexCache: DecodedInodeLeafPageIndexCache;
  durableAuthority: AuthenticatedDurableApplicationGenerationAuthority;
  fileSystemId: OpenedEmptyEncryptedContainer["fileSystemId"];
  indexDiagnostics?: ImmutableBTreeDiagnosticsPort;
  metadataRecordCache: AuthenticatedMetadataRecordCache;
  namespaceValidationCache: ReadOnlyNamespaceValidationCache;
  recordDiagnostics?: AuthenticatedStoreDiagnosticsPort;
  rootKey: OpenedEmptyEncryptedContainer["rootKey"];
  workingIdentity: WorkingGenerationIdentity;
}): AuthenticatedWritableApplicationGeneration {
  const descriptor = createAuthenticatedApplicationGenerationDescriptor({
    commit,
    commitReference,
    durableAuthority,
    workingIdentity,
  });
  return Object.freeze({
    ...descriptor,
    resolver: createAuthenticatedReadOnlyNamespaceResolver({
      commit: descriptor.commit,
      decodedInodeLeafPageIndexCache,
      indexDiagnostics,
      recordSource: createAuthenticatedNamespaceRecordSource({
        backend,
        diagnostics: recordDiagnostics,
        fileSystemId,
        metadataRecordCache,
        relocationIndexRootPhysicalRef: descriptor.superblock.logicalState.relocationIndexRootPhysicalRef,
        rootKey,
      }),
      validationCache: namespaceValidationCache,
    }),
  });
}

function writableGenerationFromDescriptor({
  backend,
  decodedInodeLeafPageIndexCache,
  descriptor,
  fileSystemId,
  indexDiagnostics,
  metadataRecordCache,
  namespaceValidationCache,
  recordDiagnostics,
  rootKey,
}: {
  backend: HizoFSReadableBackend;
  decodedInodeLeafPageIndexCache: DecodedInodeLeafPageIndexCache;
  descriptor: AuthenticatedWorkingApplicationGenerationDescriptor;
  fileSystemId: OpenedEmptyEncryptedContainer["fileSystemId"];
  indexDiagnostics?: ImmutableBTreeDiagnosticsPort;
  metadataRecordCache: AuthenticatedMetadataRecordCache;
  namespaceValidationCache: ReadOnlyNamespaceValidationCache;
  recordDiagnostics?: AuthenticatedStoreDiagnosticsPort;
  rootKey: OpenedEmptyEncryptedContainer["rootKey"];
}): AuthenticatedWritableApplicationGeneration {
  return Object.freeze({
    ...descriptor,
    resolver: createAuthenticatedReadOnlyNamespaceResolver({
      commit: descriptor.commit,
      decodedInodeLeafPageIndexCache,
      indexDiagnostics,
      recordSource: createAuthenticatedNamespaceRecordSource({
        backend,
        diagnostics: recordDiagnostics,
        fileSystemId,
        metadataRecordCache,
        relocationIndexRootPhysicalRef: descriptor.superblock.logicalState.relocationIndexRootPhysicalRef,
        rootKey,
      }),
      validationCache: namespaceValidationCache,
    }),
  });
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
 * lease and rechecks external authority before admitting a working generation.
 * Runtime-owned background publication or an explicit durability barrier later
 * advances that accepted generation to the durable Superblock authority.
 */
function acquireWorkingGenerationRootDependency({ generation, runtimeHost }: {
  generation: AuthenticatedWorkingApplicationGenerationDescriptor;
  runtimeHost: Pick<
    import("@/00-storage/service/hizofs/worker/runtime-host").HizoFSWorkerRuntimeHost,
    "acquireWriterDependencyRoot" | "acquireWriterWorkingPageRoot"
  >;
}): Readonly<{ release: () => void }> {
  switch (generation.workingRootAuthority.type) {
  case "materialized_commit":
    return runtimeHost.acquireWriterDependencyRoot({
      commitReference: generation.workingRootAuthority.commitReference,
    });
  case "direct_working_pages": {
    const registrations = [
      runtimeHost.acquireWriterWorkingPageRoot({
        pageReference: generation.workingRootAuthority.rootInodeTableRootHomeRef,
      }),
      ...(generation.workingRootAuthority.nestedSubvolumeTableRootHomeRef === null
        ? []
        : [runtimeHost.acquireWriterWorkingPageRoot({
          pageReference: generation.workingRootAuthority.nestedSubvolumeTableRootHomeRef,
        })]),
    ];
    let active = true;
    return Object.freeze({
      release: () => {
        if (!active) return;
        active = false;
        const failures: unknown[] = [];
        for (const registration of registrations) {
          try {
            registration.release();
          } catch (cause: unknown) {
            failures.push(cause);
          }
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
          throw new AggregateError(failures, "working generation root dependency cleanup failed");
        }
      },
    });
  }
  default: return generation.workingRootAuthority satisfies never;
  }
}

export function createAuthenticatedApplicationReadWriteSessionResources({
  authenticatedGeneration,
  backend,
  canonicalBackingLocation,
  decodedInodeIndexPageCacheDiagnostics,
  decodedInodeIndexPageCacheEntryLimit,
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
  recheckDurableGenerationAuthority,
  rootSubvolumeId,
  runtimeHost,
  supportedFeatureBits,
  writableProfile,
}: AuthenticatedOpenedWritableApplicationAuthority & Readonly<{
  authenticatedGeneration: ContainerRuntimeAuthenticatedApplicationGeneration;
  registerCredentialAuthorityUpdater?: ({ updater }: {
    updater: AuthenticatedCredentialAuthorityUpdater;
  }) => void;
  metadataRecordCachePolicy?: AuthenticatedMetadataRecordCachePolicy;
  runtimeHost: Pick<
    import("@/00-storage/service/hizofs/worker/runtime-host").HizoFSWorkerRuntimeHost,
    "acquireWriterDependencyRoot" | "acquireWriterWorkingPageRoot" | "openManagementCleanHeadBarrier"
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
  const metadataWriterOwner = new AuthenticatedSegmentWriterOwner({
    backend,
    diagnostics: recordDiagnostics,
    fileSystemId: opened.fileSystemId,
    randomSource,
    rootKey: opened.rootKey,
    segmentClass: "metadata",
  });
  const namespaceValidationCache = new ReadOnlyNamespaceValidationCache({ maximumEntries: 256 });
  const decodedInodeLeafPageIndexCache = new DecodedInodeLeafPageIndexCache({
    diagnostics: decodedInodeIndexPageCacheDiagnostics,
    maximumEntries: decodedInodeIndexPageCacheEntryLimit ?? 128,
  });
  const inheritValidatedInodeTableSuccessor = ({ base, successor }: {
    base: FileSystemCommitPayload;
    successor: FileSystemCommitPayload;
  }): void => {
    namespaceValidationCache.inheritValidatedSuccessor({
      baseReference: base.rootInodeTableRootHomeRef,
      kind: "inode_table",
      successorReference: successor.rootInodeTableRootHomeRef,
    });
  };
  const inheritValidatedDirectoryTreeSuccessor = ({ base, successor }: {
    base: DirectoryInodeEntry;
    successor: DirectoryInodeEntry;
  }): void => {
    if (base.content.type !== "tree" || successor.content.type !== "tree") return;
    namespaceValidationCache.inheritValidatedSuccessor({
      baseReference: base.content.directoryTreeRootHomeRef,
      kind: "directory_tree",
      successorReference: successor.content.directoryTreeRootHomeRef,
    });
  };
  const createDurableAuthority = ({ commit, commitReference, superblock }: {
    commit: FileSystemCommitPayload;
    commitReference: HomeRecordReference;
    superblock: OpenedSuperblockCopies;
  }): AuthenticatedDurableApplicationGenerationAuthority =>
    createAuthenticatedDurableApplicationGenerationAuthority({ commit, commitReference, superblock });
  const createGeneration = ({ commit, commitReference, durableAuthority, workingIdentity }: {
    commit: FileSystemCommitPayload;
    commitReference: HomeRecordReference;
    durableAuthority: AuthenticatedDurableApplicationGenerationAuthority;
    workingIdentity: WorkingGenerationIdentity;
  }): AuthenticatedWritableApplicationGeneration => writableGeneration({
    backend,
    commit,
    commitReference,
    decodedInodeLeafPageIndexCache,
    durableAuthority,
    fileSystemId: opened.fileSystemId,
    indexDiagnostics,
    metadataRecordCache,
    namespaceValidationCache,
    recordDiagnostics,
    rootKey: opened.rootKey,
    workingIdentity,
  });
  const generationFromDescriptor = ({ descriptor }: {
    descriptor: AuthenticatedWorkingApplicationGenerationDescriptor;
  }): AuthenticatedWritableApplicationGeneration => writableGenerationFromDescriptor({
    backend,
    decodedInodeLeafPageIndexCache,
    descriptor,
    fileSystemId: opened.fileSystemId,
    indexDiagnostics,
    metadataRecordCache,
    namespaceValidationCache,
    recordDiagnostics,
    rootKey: opened.rootKey,
  });
  let generationDescriptor = authenticatedGeneration.capture();
  let generation = generationFromDescriptor({ descriptor: generationDescriptor });
  const usedMutationIds = new Set<string>([
    mutationIdentity({ mutationId: generationDescriptor.commit.mutationId }),
  ]);
  const adoptGenerationDescriptor = ({ descriptor }: {
    descriptor: AuthenticatedWorkingApplicationGenerationDescriptor;
  }): AuthenticatedWritableApplicationGeneration => {
    generationDescriptor = descriptor;
    usedMutationIds.add(mutationIdentity({ mutationId: descriptor.commit.mutationId }));
    generation = generationFromDescriptor({ descriptor });
    return generation;
  };
  const currentGeneration = (): AuthenticatedWritableApplicationGeneration => {
    const currentDescriptor = authenticatedGeneration.capture();
    if (currentDescriptor !== generationDescriptor) {
      adoptGenerationDescriptor({ descriptor: currentDescriptor });
    }
    return generation;
  };
  const descriptorFromGeneration = ({ value }: {
    value: AuthenticatedWritableApplicationGeneration;
  }): AuthenticatedWorkingApplicationGenerationDescriptor => value;
  const materializedDescriptorFromGeneration = ({ value }: {
    value: AuthenticatedWritableApplicationGeneration;
  }): AuthenticatedApplicationGenerationDescriptor => {
    const materialized = requireMaterializedWritableGeneration({ generation: value });
    return createAuthenticatedApplicationGenerationDescriptor({
      commit: materialized.commit,
      commitReference: materialized.commitReference,
      durableAuthority: materialized.durableAuthority,
      workingIdentity: materialized.workingIdentity,
    });
  };
  const openRuntimeMutationAdmission = ({ base }: {
    base: AuthenticatedWritableApplicationGeneration;
  }): ContainerRuntimeImmediateMutationAdmission<PreparedMutationCommitCandidate> => (
    authenticatedGeneration.openImmediateMutationAdmission<PreparedMutationCommitCandidate>({
    // The admission reserves exclusive mutation authority and one mutation
    // slot before record append. Exact encrypted frame usage is transferred
    // atomically after candidate append and before candidate acceptance or
    // Superblock publication.
      dirtyMetadataBytes: 0,
      expectedBase: materializedDescriptorFromGeneration({ value: base }),
      unpublishedPhysicalBytes: 0,
    })
  );
  const transferMeasuredMutationResources = ({ admission, usage }: {
    admission: ContainerRuntimeImmediateMutationAdmission<PreparedMutationCommitCandidate>;
    usage: AuthenticatedMutationResourceUsage;
  }): void => admission.replaceResourceReservation({
    dirtyMetadataBytes: usage.appendedMetadataFrameBytes,
    unpublishedPhysicalBytes: usage.unpublishedPhysicalBytes,
  });
  const commitRuntimeDurableSuccessor = ({ admission, successor }: {
    admission: ContainerRuntimeImmediateMutationAdmission<PreparedMutationCommitCandidate>;
    successor: AuthenticatedWritableApplicationGeneration;
  }): AuthenticatedWritableApplicationGeneration => {
    const descriptor = materializedDescriptorFromGeneration({ value: successor });
    admission.commitDurableSuccessor({ successor: descriptor });
    return adoptGenerationDescriptor({ descriptor: authenticatedGeneration.capture() });
  };
  const refreshRuntimeDurableAuthority = ({ current, refreshed }: {
    current: AuthenticatedWritableApplicationGeneration;
    refreshed: AuthenticatedWritableApplicationGeneration;
  }): AuthenticatedWritableApplicationGeneration => adoptGenerationDescriptor({
    descriptor: authenticatedGeneration.refreshDurableAuthority({
      durableAuthority: refreshed.durableAuthority,
      expectedWorkingIdentity: current.workingIdentity,
    }),
  });

  const createPublishedSuccessorGeneration = ({ base, commit, commitReference, superblock }: {
    base: AuthenticatedWritableApplicationGeneration;
    commit: FileSystemCommitPayload;
    commitReference: HomeRecordReference;
    superblock: OpenedSuperblockCopies;
  }): AuthenticatedWritableApplicationGeneration => createGeneration({
    commit,
    commitReference,
    durableAuthority: createDurableAuthority({ commit, commitReference, superblock }),
    workingIdentity: createSuccessorWorkingGenerationIdentity({
      mutationId: commit.mutationId,
      previous: base.workingIdentity,
    }),
  });
  const createWorkingCandidateSuccessorGeneration = ({ base, candidate, commitPayload }: {
    base: AuthenticatedWritableApplicationGeneration;
    candidate: PreparedMutationCommitCandidate;
    commitPayload: FileSystemCommitPayload;
  }): AuthenticatedWritableApplicationGeneration => createGeneration({
    commit: commitPayload,
    commitReference: candidate.commitHomeRef,
    durableAuthority: base.durableAuthority,
    workingIdentity: createSuccessorWorkingGenerationIdentity({
      mutationId: commitPayload.mutationId,
      previous: base.workingIdentity,
    }),
  });
  const promoteWorkingCandidateGeneration = ({ candidate, publication }: {
    candidate: AuthenticatedWritableApplicationGeneration;
    publication: PublishedPreparedMutationCommit;
  }): AuthenticatedWritableApplicationGeneration => {
    const materialized = requireMaterializedWritableGeneration({ generation: candidate });
    return createGeneration({
      commit: materialized.commit,
      commitReference: materialized.commitReference,
      durableAuthority: createDurableAuthority({
        commit: materialized.commit,
        commitReference: materialized.commitReference,
        superblock: publication.superblock,
      }),
      workingIdentity: materialized.workingIdentity,
    });
  };
  const createInstalledWorkingCandidateSlot = ({ base, operationLabel, runtimeAdmission }: {
    base: AuthenticatedWritableApplicationGeneration;
    operationLabel: string;
    runtimeAdmission: ContainerRuntimeImmediateMutationAdmission<PreparedMutationCommitCandidate>;
  }): Readonly<{
    install: ({ candidate, commitPayload }: {
      candidate: PreparedMutationCommitCandidate;
      commitPayload: FileSystemCommitPayload;
    }) => void;
    matchesCurrentGeneration: () => boolean;
    release: () => void;
    requireGeneration: () => AuthenticatedWritableApplicationGeneration;
    retain: ({ cause }: { cause: unknown }) => void;
    selectCandidateForPublication: () => PreparedMutationCommitCandidate;
  }> => {
    let candidateGeneration: AuthenticatedWritableApplicationGeneration | undefined;
    let resolved = false;
    const requireCandidateGeneration = (): AuthenticatedWritableApplicationGeneration => {
      if (candidateGeneration === undefined) {
        throw new TypeError(`${operationLabel} did not install its working candidate`);
      }
      return candidateGeneration;
    };
    return Object.freeze({
      install: ({ candidate, commitPayload }) => {
        if (candidateGeneration !== undefined) {
          throw new TypeError(`${operationLabel} cannot replace its working candidate generation`);
        }
        assertCurrentWorkingGeneration({
          captured: base.workingIdentity,
          operationLabel: `${operationLabel} candidate installation`,
        });
        const created = createWorkingCandidateSuccessorGeneration({
          base,
          candidate,
          commitPayload,
        });
        runtimeAdmission.installSelectedCandidate({
          candidate,
          successor: materializedDescriptorFromGeneration({ value: created }),
        });
        candidateGeneration = created;
      },
      matchesCurrentGeneration: () => {
        if (candidateGeneration === undefined) return false;
        return sameWorkingGenerationIdentity({
          left: currentGeneration().workingIdentity,
          right: candidateGeneration.workingIdentity,
        });
      },
      release: () => {
        if (resolved) return;
        resolved = true;
        if (candidateGeneration === undefined) {
          runtimeAdmission.rollback();
          return;
        }
        if (sameWorkingGenerationIdentity({
          left: currentGeneration().workingIdentity,
          right: candidateGeneration.workingIdentity,
        })) {
          runtimeAdmission.releasePublishedCandidate();
        } else {
          runtimeAdmission.rollback();
        }
        candidateGeneration = undefined;
      },
      requireGeneration: requireCandidateGeneration,
      retain: ({ cause }) => {
        if (resolved) return;
        requireCandidateGeneration();
        resolved = true;
        runtimeAdmission.retainSelectedCandidateOutcomeUnknown({ cause });
        candidateGeneration = undefined;
      },
      selectCandidateForPublication: () => {
        requireCandidateGeneration();
        return runtimeAdmission.selectCandidateForPublication();
      },
    });
  };

  const refreshDurableAuthoritySuperblock = ({ current, superblock }: {
    current: AuthenticatedWritableApplicationGeneration;
    superblock: OpenedSuperblockCopies;
  }): AuthenticatedWritableApplicationGeneration => {
    const materialized = requireMaterializedWritableGeneration({ generation: current });
    return createGeneration({
      commit: materialized.commit,
      commitReference: materialized.commitReference,
      durableAuthority: createDurableAuthority({
        commit: materialized.durableAuthority.commit,
        commitReference: materialized.durableAuthority.commitReference,
        superblock,
      }),
      workingIdentity: materialized.workingIdentity,
    });
  };
  const assertCurrentWorkingGeneration = ({ captured, operationLabel }: {
    captured: WorkingGenerationIdentity;
    operationLabel: string;
  }): void => {
    if (!sameWorkingGenerationIdentity({ left: currentGeneration().workingIdentity, right: captured })) {
      throw new TypeError(`${operationLabel} base working generation changed`);
    }
  };

  const captureRecheckedWorkingGeneration = async ({ operationLabel }: {
    operationLabel: string;
  }): Promise<AuthenticatedWritableApplicationGeneration> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const captured = currentGeneration();
      try {
        await recheckDurableGenerationAuthority({
          commit: captured.durableAuthority.commit,
          superblock: captured.durableAuthority.superblock,
        });
      } catch (cause: unknown) {
        // The runtime publishes its descriptor immediately before it releases
        // the working-generation flush authority. Waiting for the tracked
        // publication closes that narrow interval before a new admission can
        // observe the promoted descriptor while the coordinator is still busy.
        await authenticatedGeneration.waitForInFlightPublication();
        const refreshed = currentGeneration();
        const runtimePublishedCapturedWorkingGeneration = (
          sameWorkingGenerationIdentity({
            left: captured.workingIdentity,
            right: refreshed.workingIdentity,
          })
          && !sameDurableGenerationIdentity({
            left: captured.durableAuthority.identity,
            right: refreshed.durableAuthority.identity,
          })
        );
        if (attempt === 0 && runtimePublishedCapturedWorkingGeneration) continue;
        throw cause;
      }
      assertCurrentWorkingGeneration({
        captured: captured.workingIdentity,
        operationLabel,
      });
      return captured;
    }
    throw new TypeError(`${operationLabel} generation authority could not be stabilized`);
  };
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
      const current = currentGeneration();
      if (!sameSuperblockLogicalStateExceptMinimumUnlockSequence({
        left: current.superblock.logicalState,
        right: update.superblock.logicalState,
      })) {
        throw new TypeError("credential authority update changed filesystem generation state");
      }
      if (update.unlockSequence !== update.superblock.logicalState.minimumUnlockSequence
        || update.unlockSequence <= activeUnlockSequence) {
        throw new TypeError("credential authority update did not advance the active Unlock Sequence");
      }
      refreshRuntimeDurableAuthority({
        current,
        refreshed: refreshDurableAuthoritySuperblock({
          current,
          superblock: update.superblock,
        }),
      });
      activeUnlockingSlotId = update.unlockingSlotId;
      activeUnlockSequence = update.unlockSequence;
    },
  });
  type FreshExplicitBulkTarget = Readonly<{
    directory: Pick<DirectoryInodeEntry, "inodeNumber" | "inodeRevision" | "timestamps">;
    targetIdentity: string;
    workingGeneration: WorkingGenerationIdentity;
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
    abandon: AuthenticatedMetadataMutationAuthority["abandon"];
    resolvePublication: AuthenticatedMetadataMutationAuthority["resolvePublication"];
  }>;

  const resolveFailedPublication = async ({
    applicationAuthority,
    authority,
    base,
    cause,
    operationLabel,
    runtimeAdmission,
  }: {
    applicationAuthority: import("@/00-storage/service/hizofs/api").HizoFSApplicationPublicationAuthority;
    authority: PublicationResolutionAuthority;
    base: AuthenticatedWritableApplicationGeneration;
    cause: PreparedMutationCommitPublicationError;
    operationLabel: string;
    runtimeAdmission: ContainerRuntimeImmediateMutationAdmission<PreparedMutationCommitCandidate>;
  }): Promise<void> => {
    let resolution: Awaited<ReturnType<PublicationResolutionAuthority["resolvePublication"]>>;
    switch (cause.outcome) {
    case "not_published":
      resolution = Object.freeze({ superblock: base.superblock, type: "not_published" as const });
      break;
    case "committed_redundancy_degraded":
    case "outcome_resolution_required":
    case undefined:
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
      break;
    default: return cause.outcome satisfies never;
    }

    switch (resolution.type) {
    case "not_published":
      switch (resolution.superblock.copyState) {
      case "normal": break;
      case "superblock_redundancy_degraded": mutationPoison = cause; break;
      default: return resolution.superblock.copyState satisfies never;
      }
      authority.abandon();
      runtimeAdmission.rollback();
      refreshRuntimeDurableAuthority({
        current: base,
        refreshed: refreshDurableAuthoritySuperblock({
          current: base,
          superblock: resolution.superblock,
        }),
      });
      throw cause;
    case "publication_conflict":
      runtimeAdmission.rollback();
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
      inheritValidatedInodeTableSuccessor({ base: base.commit, successor: reopened.commit });
      commitRuntimeDurableSuccessor({
        admission: runtimeAdmission,
        successor: createPublishedSuccessorGeneration({
          base,
          commit: reopened.commit,
          commitReference: cause.commitHomeRef,
          superblock: resolution.superblock,
        }),
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

  type PreparedAuthenticatedMetadataMutation = Readonly<{
    commitPayload: FileSystemCommitPayload;
  }>;

  const cleanupMetadataMutationAuthorityAfterFailure = ({
    authority,
    cause,
  }: {
    authority: AuthenticatedMetadataMutationAuthority;
    cause: unknown;
  }): never => {
    const state = authority.state();
    switch (state) {
    case "active":
    case "candidate_prepared": authority.abandon(); break;
    case "closed": break;
    case "publishing": {
      const unresolved = new AggregateError(
        [cause],
        "mutation preparation failed while publication outcome remained unresolved",
      );
      mutationPoison = unresolved;
      throw unresolved;
    }
    default: return state satisfies never;
    }
    throw cause;
  };

  const runMutation = async <Prepared extends PreparedAuthenticatedMetadataMutation>({
    applicationAuthority,
    prepare,
  }: {
    applicationAuthority: import("@/00-storage/service/hizofs/api").HizoFSApplicationPublicationAuthority;
    prepare: ({ base, candidateBaseCommit, metadataAuthority, mutationId, operationTimestamp }: {
      base: AuthenticatedWritableApplicationGeneration;
      candidateBaseCommit: FileSystemCommitPayload;
      metadataAuthority: AuthenticatedMetadataMutationAuthority;
      mutationId: MutationId;
      operationTimestamp: TimestampMilliseconds;
    }) => Promise<Prepared | null>;
  }): Promise<void> => {
    invalidateFreshExplicitBulkTarget();
    if (mutationPoison !== undefined) {
      throw new HizoFSApplicationMutationSessionPoisonedError({ cause: mutationPoison });
    }
    applicationAuthority.assertPublicationAllowed();
    const base = await captureRecheckedWorkingGeneration({ operationLabel: "mutation" });
    const baseDescriptor = descriptorFromGeneration({ value: base });
    applicationAuthority.assertPublicationAllowed();

    // The captured working candidate Commit must remain reachable until this
    // writer has either transferred a successor into runtime ownership or
    // settled without mutation. The root intentionally follows the working
    // generation rather than only the durable Superblock authority.
    const writerDependency = acquireWorkingGenerationRootDependency({ generation: base, runtimeHost });
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
        writerOwner: metadataWriterOwner,
      });
      const publicationMode = authenticatedGeneration.publicationModeApplied();
      switch (publicationMode) {
      case "immediate_publication_requested":
      case "immediate_publication_unqualified": {
        const runtimeAdmission = openRuntimeMutationAdmission({ base });
        const candidateSlot = createInstalledWorkingCandidateSlot({
          base,
          operationLabel: "mutation",
          runtimeAdmission,
        });
        try {
          const prepared = await prepare({
            base,
            candidateBaseCommit: base.commit,
            metadataAuthority,
            mutationId,
            operationTimestamp: operationTimestamp(),
          });
          if (prepared === null) {
            metadataAuthority.abandon();
            candidateSlot.release();
            applicationAuthority.markNoChangeResolved();
            return;
          }
          const publication = await publishPreparedMutationCommit({
            assertPublicationAllowed: applicationAuthority.assertPublicationAllowed,
            base: base.superblock,
            commitPayload: prepared.commitPayload,
            onCandidatePrepared: ({ candidate }) => {
              transferMeasuredMutationResources({
                admission: runtimeAdmission,
                usage: metadataAuthority.resourceUsage(),
              });
              candidateSlot.install({ candidate, commitPayload: prepared.commitPayload });
              applicationAuthority.markCandidateAccepted();
              return candidateSlot.selectCandidateForPublication();
            },
            publicationPort: metadataAuthority,
          });
          const candidate = candidateSlot.requireGeneration();
          inheritValidatedInodeTableSuccessor({ base: base.commit, successor: prepared.commitPayload });
          const expectedPublishedIdentity = createWorkingGenerationIdentity({
            authorityEpoch: candidate.workingIdentity.authorityEpoch,
            generationNumber: candidate.workingIdentity.generationNumber,
            mutationId: prepared.commitPayload.mutationId,
          });
          if (
            !sameCommitPayload({ left: candidate.commit, right: prepared.commitPayload })
            || !sameWorkingGenerationIdentity({
              left: candidate.workingIdentity,
              right: expectedPublishedIdentity,
            })
          ) {
            throw new TypeError("published mutation does not match its installed working candidate");
          }
          const nextGeneration = promoteWorkingCandidateGeneration({ candidate, publication });
          try {
            commitRuntimeDurableSuccessor({ admission: runtimeAdmission, successor: nextGeneration });
          } catch (runtimeCause: unknown) {
            mutationPoison = runtimeCause;
            candidateSlot.retain({ cause: runtimeCause });
            throw runtimeCause;
          }
          applicationAuthority.markCommitPointCrossed();
          candidateSlot.release();
        } catch (cause: unknown) {
          if (!(cause instanceof PreparedMutationCommitPublicationError)) {
            candidateSlot.release();
            return cleanupMetadataMutationAuthorityAfterFailure({ authority: metadataAuthority, cause });
          }
          try {
            await resolveFailedPublication({
              applicationAuthority,
              authority: metadataAuthority,
              base,
              cause,
              operationLabel: "mutation",
              runtimeAdmission,
            });
            candidateSlot.release();
          } catch (resolutionCause: unknown) {
            if (mutationPoison === undefined || candidateSlot.matchesCurrentGeneration()) {
              candidateSlot.release();
            } else {
              candidateSlot.retain({ cause: mutationPoison ?? resolutionCause });
            }
            throw resolutionCause;
          }
        } finally {
          runtimeAdmission.rollback();
        }
        return;
      }
      case "lazy_publication_development":
      case "lazy_publication_strict": {
        let admission: ContainerRuntimeAcceptedMutationAdmission;
        let admittedBaseDescriptor: AuthenticatedWorkingApplicationGenerationDescriptor;
        try {
          ({ admission, base: admittedBaseDescriptor } = await openStableAcceptedApplicationMutationAdmission({
            authenticatedGeneration,
            dirtyMetadataBytes: 0,
            expectedBase: baseDescriptor,
            unpublishedPhysicalBytes: 0,
          }));
        } catch (cause: unknown) {
          return cleanupMetadataMutationAuthorityAfterFailure({ authority: metadataAuthority, cause });
        }
        const admittedBase = generationFromDescriptor({ descriptor: admittedBaseDescriptor });
        let accepted = false;
        try {
          const candidateBaseCommit = createMutationCandidatePlanningBaseCommit({ base: admittedBaseDescriptor });
          const prepared = await prepare({
            base: admittedBase,
            candidateBaseCommit,
            metadataAuthority,
            mutationId,
            operationTimestamp: operationTimestamp(),
          });
          if (prepared === null) {
            metadataAuthority.abandon();
            admission.rollback();
            applicationAuthority.markNoChangeResolved();
            return;
          }
          const publicationRootKey = cloneFileSystemRootKey({ rootKey: opened.rootKey });
          const installed = prepareAndInstallStagedMutationSelectedCandidate({
            admission,
            assertCandidatePreparationAllowed: () => {
              assertCurrentWorkingGeneration({
                captured: base.workingIdentity,
                operationLabel: "staged mutation candidate preparation",
              });
              applicationAuthority.assertPublicationAllowed();
            },
            assertRuntimePublicationAllowed: () => {
              if (publicationRootKey.isDestroyed()) {
                throw new TypeError("released staged publication resources cannot publish a working candidate");
              }
            },
            base: admittedBaseDescriptor,
            commitPayload: prepared.commitPayload,
            createMaterializationAuthority: async () => await createAuthenticatedMetadataMutationAuthority({
              backend,
              diagnostics: recordDiagnostics,
              fileSystemId: opened.fileSystemId,
              mutationScopeDiagnostics: "suppress",
              randomSource,
              relocationIndexRootPhysicalRef:
                admittedBaseDescriptor.durableAuthority.superblock.logicalState.relocationIndexRootPhysicalRef,
              rootKey: publicationRootKey,
              supportedFeatureBits,
            }),
            prepareWorkingAcceptance: () => metadataAuthority.prepareWorkingAcceptanceWithoutCandidate(),
            releasePublicationResources: () => publicationRootKey.destroy(),
            resourceUsage: metadataAuthority.resourceUsage(),
          });
          accepted = true;
          metadataAuthority.completeWorkingAcceptanceWithoutCandidate();
          inheritValidatedInodeTableSuccessor({ base: base.commit, successor: prepared.commitPayload });
          const captured = authenticatedGeneration.capture();
          if (!sameWorkingGenerationIdentity({
            left: captured.workingIdentity,
            right: installed.successor.workingIdentity,
          })) {
            const cause = new TypeError("runtime did not expose the accepted mutation successor");
            mutationPoison = cause;
            throw cause;
          }
          adoptGenerationDescriptor({ descriptor: captured });
          applicationAuthority.markCandidateAccepted();
        } catch (cause: unknown) {
          if (accepted) {
            mutationPoison ??= cause;
            throw cause;
          }
          return cleanupMetadataMutationAuthorityAfterFailure({ authority: metadataAuthority, cause });
        } finally {
          admission.rollback();
        }
        return;
      }
      default: return publicationMode satisfies never;
      }
    };

    let operationFailure: unknown | undefined;
    try {
      await performMutation();
    } catch (cause: unknown) {
      operationFailure = cause;
    }
    let releaseFailure: unknown | undefined;
    try {
      writerDependency.release();
    } catch (cause: unknown) {
      releaseFailure = cause;
    }
    if (operationFailure !== undefined) {
      if (releaseFailure !== undefined) {
        throw new AggregateError(
          [operationFailure, releaseFailure],
          "mutation operation and writer dependency release both failed",
        );
      }
      throw operationFailure;
    }
    if (releaseFailure !== undefined) throw releaseFailure;
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
    prepare: async ({ base, candidateBaseCommit, metadataAuthority, mutationId, operationTimestamp: timestamp }) => {
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
      const prepared = await prepareAuthenticatedWholeFileReflink({
        assertPublicationAllowed: authority.assertPublicationAllowed,
        authority: metadataAuthority,
        indexDiagnostics,
        baseCommit: candidateBaseCommit,
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
      inheritValidatedDirectoryTreeSuccessor({
        base: destinationParent,
        successor: prepared.mutation.updatedDestinationParent,
      });
      return prepared;
    },
  });


  const createEntry = async ({ authority, name, path, request }: {
    authority: import("@/00-storage/service/hizofs/api").HizoFSApplicationPublicationAuthority;
    name: string;
    path: readonly string[];
    request: OrdinaryEntryCreateRequest;
  }): Promise<void> => {
    let freshDirectory: Pick<FreshExplicitBulkTarget, "directory"> | undefined;
    await runMutation({
      applicationAuthority: authority,
      prepare: async ({ base, candidateBaseCommit, metadataAuthority, mutationId, operationTimestamp: timestamp }) => {
        const parent = requireWritableParentDirectory({
          inode: await base.resolver.resolveInode({ pathComponents: [...path] }),
        });
        const destination = await base.resolver.lookupDirectoryEntry({ directory: parent, name });
        const knownInodeNumbers = await base.resolver.knownInodeNumbers();
        const prepared = await prepareAuthenticatedOrdinaryEntryCreate({
          assertPublicationAllowed: authority.assertPublicationAllowed,
          authority: metadataAuthority,
          indexDiagnostics,
          baseCommit: candidateBaseCommit,
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
        inheritValidatedDirectoryTreeSuccessor({ base: parent, successor: prepared.updatedParent });
        switch (request.type) {
        case "directory": {
          const inode = prepared.plan.inode;
          switch (inode.inodeKind) {
          case "directory":
            freshDirectory = {
              directory: {
                inodeNumber: inode.inodeNumber,
                inodeRevision: inode.inodeRevision,
                timestamps: { ...inode.timestamps },
              },
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
        return prepared;
      },
    });
    if (freshDirectory !== undefined) {
      freshExplicitBulkTarget = {
        ...freshDirectory,
        targetIdentity: explicitBulkTargetIdentity({ path: [...path, name] }),
        workingGeneration: currentGeneration().workingIdentity,
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
    prepare: async ({ base, candidateBaseCommit, metadataAuthority, mutationId, operationTimestamp: timestamp }) => {
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
      const prepared = await prepareAuthenticatedOrdinaryEntryMove({
        assertPublicationAllowed: authority.assertPublicationAllowed,
        authority: metadataAuthority,
        indexDiagnostics,
        baseCommit: candidateBaseCommit,
        baseSuperblock: base.superblock,
        destinationParent,
        mutationId,
        operationTimestamp: timestamp,
        plan,
        sourceParent,
      });
      inheritValidatedDirectoryTreeSuccessor({
        base: sourceParent,
        successor: prepared.mutation.updatedSourceParent,
      });
      if (destinationParent.inodeNumber !== sourceParent.inodeNumber) {
        inheritValidatedDirectoryTreeSuccessor({
          base: destinationParent,
          successor: prepared.mutation.updatedDestinationParent,
        });
      }
      return prepared;
    },
  });

  const removeEntry = async ({ authority, name, path, recursive }: {
    authority: import("@/00-storage/service/hizofs/api").HizoFSApplicationPublicationAuthority;
    name: string;
    path: readonly string[];
    recursive: boolean;
  }): Promise<void> => await runMutation({
    applicationAuthority: authority,
    prepare: async ({ base, candidateBaseCommit, metadataAuthority, mutationId, operationTimestamp: timestamp }) => {
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
      const prepared = await prepareAuthenticatedOrdinaryEntryRemoval({
        assertPublicationAllowed: authority.assertPublicationAllowed,
        authority: metadataAuthority,
        indexDiagnostics,
        baseCommit: candidateBaseCommit,
        baseSuperblock: base.superblock,
        mutationId,
        operationTimestamp: timestamp,
        parent,
        plan,
      });
      inheritValidatedDirectoryTreeSuccessor({ base: parent, successor: prepared.mutation.updatedParent });
      return prepared;
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

    const base = await captureRecheckedWorkingGeneration({ operationLabel: "explicit bulk open" });
    if (!sameWorkingGenerationIdentity({
      left: base.workingIdentity,
      right: freshTarget.workingGeneration,
    })) {
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
    const writerDependency = acquireWorkingGenerationRootDependency({ generation: base, runtimeHost });
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
              if (!sameWorkingGenerationIdentity({
                left: currentGeneration().workingIdentity,
                right: freshTarget.workingGeneration,
              })) {
                throw new TypeError("explicit bulk base generation changed while its writer capability was held");
              }
              await runMutation({
                applicationAuthority: authority,
                prepare: async ({
                  base: currentBase,
                  candidateBaseCommit,
                  metadataAuthority,
                  mutationId,
                }) => await prepareAuthenticatedExplicitBulkCommit({
                  assertPublicationAllowed: authority.assertPublicationAllowed,
                  authority: metadataAuthority,
                  baseCommit: candidateBaseCommit,
                  baseSuperblock: currentBase.superblock,
                  candidate,
                  directoryImportLimits: explicitBulkLimits.directoryImport,
                  indexDiagnostics,
                  mutationId,
                }),
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
    const base = await captureRecheckedWorkingGeneration({ operationLabel: "writable open" });
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
      writerOwner: metadataWriterOwner,
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
        applicationAuthority.assertPublicationAllowed();
        const checkedBase = await captureRecheckedWorkingGeneration({ operationLabel: "file mutation" });
        if (!sameWorkingGenerationIdentity({
          left: checkedBase.workingIdentity,
          right: base.workingIdentity,
        })) {
          throw new TypeError("prepared file mutation base generation changed");
        }
        applicationAuthority.assertPublicationAllowed();
        const mutationId = await generateMutationId({
          isUsed: async ({ id }) => usedMutationIds.has(mutationIdentity({ mutationId: id })),
          randomSource,
        });
        usedMutationIds.add(mutationIdentity({ mutationId }));
        const publicationMode = authenticatedGeneration.publicationModeApplied();
        const baseDescriptor = descriptorFromGeneration({ value: checkedBase });
        const prepareCommitPayload = async ({ candidateBaseCommit }: {
          candidateBaseCommit: FileSystemCommitPayload;
        }): Promise<FileSystemCommitPayload> => {
          const prepared = await prepareRootInodeTableMutation({
            baseCommit: candidateBaseCommit,
            changes: [{ entry: staged, type: "set" }],
            mutationId,
            pageStore: inodeTablePageStore,
          });
          switch (prepared.type) {
          case "prepared": return prepared.commitPayload;
          case "unchanged": throw new Error(
            "changed prepared writable unexpectedly produced no Inode Table mutation",
          );
          default: return prepared satisfies never;
          }
        };

        switch (publicationMode) {
        case "immediate_publication_requested":
        case "immediate_publication_unqualified": {
          let commitPayload: FileSystemCommitPayload;
          try {
            commitPayload = await prepareCommitPayload({ candidateBaseCommit: base.commit });
          } catch (cause: unknown) {
            fileAuthority.abandon();
            state = "closed";
            throw cause;
          }
          const runtimeAdmission = openRuntimeMutationAdmission({ base });
          const candidateSlot = createInstalledWorkingCandidateSlot({
            base,
            operationLabel: "file mutation",
            runtimeAdmission,
          });
          try {
            const publication = await publishPreparedMutationCommit({
              assertPublicationAllowed: applicationAuthority.assertPublicationAllowed,
              base: base.superblock,
              commitPayload,
              onCandidatePrepared: ({ candidate }) => {
                transferMeasuredMutationResources({
                  admission: runtimeAdmission,
                  usage: fileAuthority.resourceUsage(),
                });
                candidateSlot.install({ candidate, commitPayload });
                applicationAuthority.markCandidateAccepted();
                return candidateSlot.selectCandidateForPublication();
              },
              publicationPort: fileAuthority,
            });
            const installedCandidate = candidateSlot.requireGeneration();
            const expectedPublishedIdentity = createWorkingGenerationIdentity({
              authorityEpoch: installedCandidate.workingIdentity.authorityEpoch,
              generationNumber: installedCandidate.workingIdentity.generationNumber,
              mutationId: commitPayload.mutationId,
            });
            if (
              !sameCommitPayload({ left: installedCandidate.commit, right: commitPayload })
              || !sameWorkingGenerationIdentity({
                left: installedCandidate.workingIdentity,
                right: expectedPublishedIdentity,
              })
            ) {
              throw new TypeError("published file mutation does not match its installed working candidate");
            }
            inheritValidatedInodeTableSuccessor({ base: base.commit, successor: commitPayload });
            try {
              commitRuntimeDurableSuccessor({
                admission: runtimeAdmission,
                successor: promoteWorkingCandidateGeneration({
                  candidate: installedCandidate,
                  publication,
                }),
              });
            } catch (runtimeCause: unknown) {
              mutationPoison = runtimeCause;
              candidateSlot.retain({ cause: runtimeCause });
              throw runtimeCause;
            }
            applicationAuthority.markCommitPointCrossed();
            candidateSlot.release();
            state = "closed";
          } catch (cause: unknown) {
            if (!(cause instanceof PreparedMutationCommitPublicationError)) {
              candidateSlot.release();
              const authorityState = fileAuthority.state();
              switch (authorityState) {
              case "active":
              case "candidate_prepared": fileAuthority.abandon(); break;
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
            try {
              await resolveFailedPublication({
                applicationAuthority,
                authority: fileAuthority,
                base,
                cause,
                operationLabel: "file mutation",
                runtimeAdmission,
              });
              candidateSlot.release();
            } catch (resolutionCause: unknown) {
              if (mutationPoison === undefined || candidateSlot.matchesCurrentGeneration()) {
                candidateSlot.release();
              } else {
                candidateSlot.retain({ cause: mutationPoison ?? resolutionCause });
              }
              throw resolutionCause;
            }
          } finally {
            runtimeAdmission.rollback();
          }
          return;
        }
        case "lazy_publication_development":
        case "lazy_publication_strict": {
          let admission: ContainerRuntimeAcceptedMutationAdmission;
          let admittedBaseDescriptor: AuthenticatedWorkingApplicationGenerationDescriptor;
          try {
            ({ admission, base: admittedBaseDescriptor } = await openStableAcceptedApplicationMutationAdmission({
              authenticatedGeneration,
              dirtyMetadataBytes: 0,
              expectedBase: baseDescriptor,
              unpublishedPhysicalBytes: 0,
            }));
          } catch (cause: unknown) {
            state = "closed";
            fileAuthority.abandon();
            throw cause;
          }
          let commitPayload: FileSystemCommitPayload;
          try {
            commitPayload = await prepareCommitPayload({
              candidateBaseCommit: createMutationCandidatePlanningBaseCommit({ base: admittedBaseDescriptor }),
            });
          } catch (cause: unknown) {
            admission.rollback();
            fileAuthority.abandon();
            state = "closed";
            throw cause;
          }
          let accepted = false;
          try {
            const publicationRootKey = cloneFileSystemRootKey({ rootKey: opened.rootKey });
            const installed = prepareAndInstallStagedMutationSelectedCandidate({
              admission,
              assertCandidatePreparationAllowed: () => {
                assertCurrentWorkingGeneration({
                  captured: base.workingIdentity,
                  operationLabel: "staged file mutation candidate preparation",
                });
                applicationAuthority.assertPublicationAllowed();
              },
              assertRuntimePublicationAllowed: () => {
                if (publicationRootKey.isDestroyed()) {
                  throw new TypeError("released staged publication resources cannot publish a working candidate");
                }
              },
              base: admittedBaseDescriptor,
              commitPayload,
              createMaterializationAuthority: async () => await createAuthenticatedMetadataMutationAuthority({
                backend,
                diagnostics: recordDiagnostics,
                fileSystemId: opened.fileSystemId,
                mutationScopeDiagnostics: "suppress",
                randomSource,
                relocationIndexRootPhysicalRef:
                  admittedBaseDescriptor.durableAuthority.superblock.logicalState.relocationIndexRootPhysicalRef,
                rootKey: publicationRootKey,
                supportedFeatureBits,
              }),
              prepareWorkingAcceptance: () => fileAuthority.prepareWorkingAcceptanceWithoutCandidate(),
              releasePublicationResources: () => publicationRootKey.destroy(),
              resourceUsage: fileAuthority.resourceUsage(),
            });
            accepted = true;
            fileAuthority.completeWorkingAcceptanceWithoutCandidate();
            inheritValidatedInodeTableSuccessor({ base: base.commit, successor: commitPayload });
            const captured = authenticatedGeneration.capture();
            if (!sameWorkingGenerationIdentity({
              left: captured.workingIdentity,
              right: installed.successor.workingIdentity,
            })) {
              const cause = new TypeError("runtime did not expose the accepted file mutation successor");
              mutationPoison = cause;
              throw cause;
            }
            adoptGenerationDescriptor({ descriptor: captured });
            applicationAuthority.markCandidateAccepted();
            state = "closed";
          } catch (cause: unknown) {
            state = "closed";
            if (accepted) {
              mutationPoison ??= cause;
              throw cause;
            }
            const authorityState = fileAuthority.state();
            switch (authorityState) {
            case "active":
            case "candidate_prepared": fileAuthority.abandon(); break;
            case "closed": break;
            case "publishing": {
              const unresolved = new AggregateError(
                [cause],
                "deferred file mutation preparation failed while publication outcome remained unresolved",
              );
              mutationPoison = unresolved;
              throw unresolved;
            }
            default: return authorityState satisfies never;
            }
            throw cause;
          } finally {
            admission.rollback();
          }
          return;
        }
        default: return publicationMode satisfies never;
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
    let writerDependency: Readonly<{ release: () => void }>;
    try {
      writerDependency = acquireWorkingGenerationRootDependency({ generation: base, runtimeHost });
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

  const namespace = stableGenerationNamespace({ current: currentGeneration });
  const adoptManagementCleanGeneration: AuthenticatedManagementCleanGenerationAdopter = ({ descriptor }) => {
    const current = currentGeneration();
    if (!sameWorkingGenerationIdentity({
      left: current.workingIdentity,
      right: descriptor.workingIdentity,
    })) {
      throw new TypeError("management clean generation does not match the application working generation");
    }
    adoptGenerationDescriptor({ descriptor });
  };
  return {
    adoptManagementCleanGeneration,
    createReadSnapshotResources: async () => {
      let captured = currentGeneration();
      if ("commitReference" in captured) {
        return {
          commitReference: captured.commitReference,
          mutationPort: readOnlyMutationPort(),
          namespace: stableGenerationNamespace({ current: () => captured }),
        };
      }

      const barrier = runtimeHost.openManagementCleanHeadBarrier({});
      let released = false;
      const releasePreparation = (): void => {
        if (released) return;
        barrier.release();
        released = true;
      };
      try {
        // WHY: cross-realm reader pins are encoded as physical Commit
        // references. A staged working generation therefore must become the
        // exact clean materialized head while mutation admission is fenced;
        // the runtime host keeps this barrier until the reader pin is held.
        const descriptor = await barrier.flushAndCaptureCleanGeneration();
        adoptManagementCleanGeneration({ descriptor });
        captured = currentGeneration();
        const materialized = requireMaterializedWritableGeneration({ generation: captured });
        return {
          commitReference: materialized.commitReference,
          mutationPort: readOnlyMutationPort(),
          namespace: stableGenerationNamespace({ current: () => materialized }),
          releasePreparation,
        };
      } catch (cause: unknown) {
        try {
          releasePreparation();
        } catch (cleanupCause: unknown) {
          throw new AggregateError(
            [cause, cleanupCause],
            "HizoFS staged read-snapshot preparation and clean-head barrier release both failed",
          );
        }
        throw cause;
      }
    },
    mutationPort,
    namespace,
    releaseResources: async () => {
      if (released) return;
      released = true;
      const failures: unknown[] = [];
      try {
        await metadataWriterOwner.close();
      } catch (cause: unknown) {
        failures.push(cause);
      }
      try {
        decodedInodeLeafPageIndexCache.dispose();
      } catch (cause: unknown) {
        failures.push(cause);
      }
      try {
        metadataRecordCache.dispose();
      } catch (cause: unknown) {
        failures.push(cause);
      }
      try {
        namespaceValidationCache.clear();
      } catch (cause: unknown) {
        failures.push(cause);
      }
      try {
        opened.rootKey.destroy();
      } catch (cause: unknown) {
        failures.push(cause);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, "HizoFS application session resource release failed");
      }
    },
    syncDurability: syncDurabilityForWritableProfile({ writableProfile }),
    workerMountGrantIssuer: async ({ accessMode, path }) => {
      const barrier = runtimeHost.openManagementCleanHeadBarrier({});
      let operationFailure: unknown;
      let grant: StorageDirectoryWorkerMountGrant | undefined;
      try {
        // WHY: a Worker grant is opened by an independent runtime that can
        // observe only persisted authority. Seal the inode identity only after
        // the issuing runtime has a clean durable head, and keep mutation
        // admission blocked until the grant payload is complete.
        const descriptor = await barrier.flushAndCaptureCleanGeneration();
        adoptManagementCleanGeneration({ descriptor });
        grant = await issueHizoFSWorkerMountGrant({
          accessMode,
          canonicalBackingLocation,
          currentResolver: () => currentGeneration().resolver,
          fileSystemId: opened.fileSystemId,
          path,
          rootKey: opened.rootKey,
          unlockingSlotId: activeUnlockingSlotId,
          unlockSequence: activeUnlockSequence,
        });
      } catch (cause: unknown) {
        operationFailure = cause;
      }
      try {
        barrier.release();
      } catch (releaseFailure: unknown) {
        if (operationFailure !== undefined) {
          throw new AggregateError(
            [operationFailure, releaseFailure],
            "Worker mount grant issuance and clean-head barrier release both failed",
          );
        }
        throw releaseFailure;
      }
      if (operationFailure !== undefined) throw operationFailure;
      if (grant === undefined) throw new TypeError("Worker mount grant issuance completed without a grant");
      return grant;
    },
  };
}

function durableGenerationIdentityFromOpenedContainer({ opened }: {
  opened: OpenedEmptyEncryptedContainer;
}): DurableGenerationIdentity {
  return createDurableGenerationIdentity({
    commitReference: opened.superblock.logicalState.activeCommitHomeRef,
    commitSequence: opened.commit.commitSequence,
    mutationId: opened.commit.mutationId,
  });
}

export async function openAuthenticatedReadWriteApplicationSession<Captured>({
  assertOperationAllowed,
  captureAuthority,
  recheckAuthority,
  registerCredentialAuthorityUpdater,
  metadataRecordCachePolicy,
  registerManagementGenerationAdopter,
  registerRuntimeSession,
  rootName,
  rootPath,
  runtimeHost,
  runtimeOwnerPolicy = "wait",
  verifyCapturedAuthority,
}: {
  assertOperationAllowed?: () => void;
  captureAuthority: () => Promise<Captured>;
  recheckAuthority: ({ captured }: { captured: Captured }) => Promise<void>;
  registerCredentialAuthorityUpdater?: ({ updater }: {
    updater: AuthenticatedCredentialAuthorityUpdater;
  }) => void;
  metadataRecordCachePolicy?: AuthenticatedMetadataRecordCachePolicy;
  registerManagementGenerationAdopter?: ({ adopter }: {
    adopter: AuthenticatedManagementCleanGenerationAdopter;
  }) => void;
  registerRuntimeSession?: ({ runtimeSession }: {
    runtimeSession: HizoFSApplicationRuntimeSession;
  }) => void;
  rootName?: string;
  rootPath?: readonly string[];
  runtimeHost: import("@/00-storage/service/hizofs/worker/runtime-host").HizoFSWorkerRuntimeHost;
  runtimeOwnerPolicy?: HizoFSRuntimeOwnerOpenPolicy;
  verifyCapturedAuthority: ({ captured }: { captured: Captured }) => Promise<AuthenticatedOpenedWritableApplicationAuthority>;
}): Promise<import("@/00-storage/service/storage-file-system/types").StorageFileSystemSession> {
  return await runtimeHost.openApplicationSession({
    ...(assertOperationAllowed === undefined ? {} : { assertOperationAllowed }),
    captureAuthority,
    createApplicationSessionResources: ({
      authenticatedGeneration,
      verified,
    }) => {
      if (authenticatedGeneration === undefined) {
        throw new TypeError("writable application session requires runtime-owned generation authority");
      }
      const resources = createAuthenticatedApplicationReadWriteSessionResources({
        ...verified,
        authenticatedGeneration,
        registerCredentialAuthorityUpdater,
        metadataRecordCachePolicy,
        runtimeHost,
      });
      registerManagementGenerationAdopter?.({
        adopter: resources.adoptManagementCleanGeneration,
      });
      return resources;
    },
    observeAuthenticatedDurableAuthority: ({ verified }) => (
      createAuthenticatedDurableApplicationGenerationAuthority({
        commit: verified.opened.commit,
        commitReference: verified.opened.superblock.logicalState.activeCommitHomeRef,
        superblock: verified.opened.superblock,
      })
    ),
    observeWritableDurabilityProfile: ({ verified }) => verified.writableProfile,
    recheckAuthority,
    ...(registerRuntimeSession === undefined ? {} : { registerRuntimeSession }),
    rootName,
    rootPath,
    runtimeOwnerPolicy,
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
  decodedInodeIndexPageCacheDiagnostics?: DecodedInodeIndexPageCacheDiagnosticsPort;
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
  decodedInodeIndexPageCacheEntryLimit,
  metadataRecordCachePolicy,
  recheckAuthority,
  rootName,
  runtimeHost,
  runtimeOwnerPolicy = "wait",
}: {
  authority: AuthenticatedDevelopmentWritableContainerCapability;
  canonicalBackingLocation: string;
  decodedInodeIndexPageCacheEntryLimit?: number;
  metadataRecordCachePolicy?: AuthenticatedMetadataRecordCachePolicy;
  recheckAuthority: () => Promise<void>;
  rootName?: string;
  runtimeHost: import("@/00-storage/service/hizofs/worker/runtime-host").HizoFSWorkerRuntimeHost;
  runtimeOwnerPolicy?: HizoFSRuntimeOwnerOpenPolicy;
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
    let managementGenerationAdopter: AuthenticatedManagementCleanGenerationAdopter | undefined;
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
      registerManagementGenerationAdopter: ({ adopter }) => {
        if (managementGenerationAdopter !== undefined) {
          throw new TypeError("application session registered more than one management generation adopter");
        }
        managementGenerationAdopter = adopter;
      },
      registerRuntimeSession: ({ runtimeSession: registered }) => {
        if (runtimeSession !== undefined) {
          throw new TypeError("application session registered more than one runtime session");
        }
        runtimeSession = registered;
      },
      rootName,
      runtimeHost,
      runtimeOwnerPolicy,
      verifyCapturedAuthority: async ({ captured }) => {
        if (captured !== authority) throw new TypeError("runtime authority verification does not match the transferred capability");
        return {
          backend,
          canonicalBackingLocation,
          decodedInodeIndexPageCacheDiagnostics: openedAuthority.decodedInodeIndexPageCacheDiagnostics,
          decodedInodeIndexPageCacheEntryLimit,
          explicitBulkLimits: DEFAULT_EXPLICIT_BULK_LIMITS,
          fileMutationLimits: { maximumExtentMutationsPerBatch: 64 },
          indexDiagnostics: openedAuthority.indexDiagnostics,
          opened: openedAuthority.opened,
          operationTimestamp: () => createTimestampMilliseconds({ value: BigInt(Date.now()) }),
          randomSource: undefined,
          recordDiagnostics: openedAuthority.recordDiagnostics,
          removalLimits: { deleteBatchSize: 64, maxVisitedInodes: 100_000 },
          recheckDurableGenerationAuthority: async ({ commit, superblock }) => {
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
    if (managementGenerationAdopter === undefined) {
      await underlyingSession.close();
      throw new Error("writable application session did not register its management generation adopter");
    }
    return wrapDevelopmentWritableCredentialSession({
      state: {
        backend,
        credentialAuthorityUpdater,
        lifecycle: "open",
        managementGenerationAdopter,
        managementRuntimeHost: runtimeHost,
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
  runtimeOwnerPolicy = "wait",
}: {
  authority: AuthenticatedReadOnlyContainerCapability;
  recheckAuthority: () => Promise<void>;
  rootName?: string;
  runtimeHost: import("@/00-storage/service/hizofs/worker/runtime-host").HizoFSWorkerRuntimeHost;
  runtimeOwnerPolicy?: HizoFSRuntimeOwnerOpenPolicy;
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
      runtimeOwnerPolicy,
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
  runtimeOwnerPolicy = "wait",
  verifyCapturedAuthority,
}: {
  captureAuthority: () => Promise<Captured>;
  recheckAuthority: ({ captured }: { captured: Captured }) => Promise<void>;
  rootName?: string;
  rootPath?: readonly string[];
  runtimeHost: import("@/00-storage/service/hizofs/worker/runtime-host").HizoFSWorkerRuntimeHost;
  runtimeOwnerPolicy?: HizoFSRuntimeOwnerOpenPolicy;
  verifyCapturedAuthority: ({ captured }: { captured: Captured }) => Promise<AuthenticatedOpenedApplicationAuthority>;
}): Promise<import("@/00-storage/service/storage-file-system/types").StorageFileSystemSession> {
  return await runtimeHost.openApplicationSession({
    captureAuthority,
    createApplicationSessionResources: ({ verified }) => ({
      ...createAuthenticatedApplicationReadSessionResources(verified),
      mutationPort: readOnlyMutationPort(),
    }),
    observeAuthenticatedDurableIdentity: ({ verified }) => (
      durableGenerationIdentityFromOpenedContainer({ opened: verified.opened })
    ),
    recheckAuthority,
    rootName,
    rootPath,
    runtimeOwnerPolicy,
    verifyCapturedAuthority,
  });
}



export async function openHizoFSWorkerMountGrant({
  grant,
  resolveBackingDirectory,
  runtimeHostRegistry = browserWorkerMountRuntimeHostRegistry,
  runtimeOwnerPolicy = "wait",
}: {
  grant: StorageDirectoryWorkerMountGrant;
  resolveBackingDirectory: ({ canonicalBackingLocation, fileSystemId }: {
    canonicalBackingLocation: string;
    fileSystemId: FileSystemId;
  }) => Promise<FileSystemDirectoryHandle>;
  runtimeHostRegistry?: BrowserWorkerMountRuntimeHostRegistry;
  runtimeOwnerPolicy?: HizoFSRuntimeOwnerOpenPolicy;
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
    const backend = createHizoFSOpfsWritableBackend({
      diagnostics: undefined,
      fileHandleCacheEntryLimit: DEFAULT_HIZOFS_BACKING_FILE_HANDLE_CACHE_ENTRY_LIMIT,
      root: backingDirectory,
    });
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
    const runtimeHost = runtimeHostRegistry.getOrCreate({
      createHost: createBrowserHizoFSWorkerRuntimeHost,
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
        runtimeOwnerPolicy,
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
        runtimeOwnerPolicy,
        verifyCapturedAuthority: async () => ({
          backend,
          canonicalBackingLocation: plaintext.canonicalBackingLocation,
          explicitBulkLimits: DEFAULT_EXPLICIT_BULK_LIMITS,
          fileMutationLimits: { maximumExtentMutationsPerBatch: 64 },
          opened,
          operationTimestamp: () => createTimestampMilliseconds({ value: BigInt(Date.now()) }),
          randomSource: undefined,
          removalLimits: { deleteBatchSize: 64, maxVisitedInodes: 100_000 },
          recheckDurableGenerationAuthority: async ({ commit, superblock }) => {
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
  const provisionDirectoryHierarchy = backend.provisionDirectoryHierarchy;
  const readExactPairWithFileSize = backend.readExactPairWithFileSize;
  const syncFileDirectoryEntry = backend.syncFileDirectoryEntry;
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
    ...(provisionDirectoryHierarchy === undefined ? {} : {
      provisionDirectoryHierarchy: async ({ path }) => await measured({
        operation: async () => await provisionDirectoryHierarchy.call(backend, { path }),
        phase: "physical_provision_directory_hierarchy",
      }),
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
    readExactWithFileSize: async ({ length, offset, path }) => {
      diagnostics.recordPhysicalAccess({
        identity: `${String(path)}\u0000${offset.toString()}\u0000${length.toString()}`,
        operation: "read_exact",
      });
      return await measured({
        operation: async () => await backend.readExactWithFileSize({ length, offset, path }),
        phase: "physical_read_exact",
      });
    },
    ...(readExactPairWithFileSize === undefined ? {} : {
      readExactPairWithFileSize: async ({ first, path, second }) => {
        diagnostics.recordPhysicalAccess({
          identity: `${String(path)}\u0000${first.offset.toString()}\u0000${first.length.toString()}`,
          operation: "read_exact",
        });
        diagnostics.recordPhysicalAccess({
          identity: `${String(path)}\u0000${second.offset.toString()}\u0000${second.length.toString()}`,
          operation: "read_exact",
        });
        return await measured({
          operation: async () => await readExactPairWithFileSize.call(backend, {
            first,
            path,
            second,
          }),
          phase: "physical_read_exact",
        });
      },
    }),
    readFileBounded: async ({ maximumByteLength, path }) => await measured({
      operation: async () => await backend.readFileBounded({ maximumByteLength, path }),
      phase: "physical_read_file_bounded",
    }),
    removeFile: async ({ path }) => await measured({
      operation: async () => await backend.removeFile({ path }),
      phase: "physical_remove_file",
    }),
    ...(syncFileDirectoryEntry === undefined ? {} : {
      syncFileDirectoryEntry: async ({ path }) => await measured({
        operation: async () => await syncFileDirectoryEntry.call(backend, { path }),
        phase: "physical_sync_directory_entries",
      }),
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
  // The benchmark measures the same automatic lazy-publication path used by
  // ordinary development sessions. Each public case ends with a product-owned
  // clean-head settlement barrier, so durability cost remains visible instead
  // of being shifted into later lifecycle cleanup.
  lazyDurability: Object.freeze({
    ...DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY,
    publicationModeRequest: "automatic",
  }),
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
  const backend = createHizoFSOpfsWritableBackend({
    diagnostics: undefined,
    fileHandleCacheEntryLimit: DEFAULT_HIZOFS_BACKING_FILE_HANDLE_CACHE_ENTRY_LIMIT,
    root: containerRoot,
  });
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
  const backend = createHizoFSOpfsWritableBackend({
    diagnostics: undefined,
    fileHandleCacheEntryLimit: DEFAULT_HIZOFS_BACKING_FILE_HANDLE_CACHE_ENTRY_LIMIT,
    root: containerRoot,
  });
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
    const publicationPort = authority;
    try {
      await publishPreparedMutationCommit({
        assertPublicationAllowed,
        base: opened.superblock,
        commitPayload,
        onCandidatePrepared: undefined,
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
      case "active":
      case "candidate_prepared": authority.abandon(); break;
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
  const backend = createHizoFSOpfsWritableBackend({
    diagnostics: undefined,
    fileHandleCacheEntryLimit: DEFAULT_HIZOFS_BACKING_FILE_HANDLE_CACHE_ENTRY_LIMIT,
    root: containerRoot,
  });
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
      const backend = createHizoFSOpfsWritableBackend({
        diagnostics: undefined,
        fileHandleCacheEntryLimit: DEFAULT_HIZOFS_BACKING_FILE_HANDLE_CACHE_ENTRY_LIMIT,
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
  settleAcceptedGeneration(): Promise<void>;
  reopen(): Promise<StorageFileSystemSession>;
  resetRuntimeDiagnosticsHighWaterMarks(): void;
  snapshotRuntimeDiagnostics(): HizoFSRuntimeDiagnosticsSnapshot;
}>;

async function settleBenchmarkAcceptedGeneration({ session }: {
  session: StorageFileSystemSession;
}): Promise<void> {
  const state = developmentWritableCredentialStateBySession.get(session);
  if (state === undefined) throw new TypeError("HizoFS benchmark session is foreign");
  const barrier = state.managementRuntimeHost.openManagementCleanHeadBarrier({});
  let operationFailure: unknown;
  try {
    const descriptor = await barrier.flushAndCaptureCleanGeneration();
    state.managementGenerationAdopter({ descriptor });
  } catch (cause: unknown) {
    operationFailure = cause;
  }
  try {
    barrier.release();
  } catch (releaseFailure: unknown) {
    if (operationFailure !== undefined) {
      throw new AggregateError(
        [operationFailure, releaseFailure],
        "benchmark clean-head settlement and barrier release both failed",
      );
    }
    throw releaseFailure;
  }
  if (operationFailure !== undefined) throw operationFailure;
}

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
  backingFileHandleCacheEntryLimit = DEFAULT_HIZOFS_BACKING_FILE_HANDLE_CACHE_ENTRY_LIMIT,
  decodedInodeIndexPageCacheEntryLimit,
  metadataRecordCachePolicy,
}: {
  readonly backingDirectory: FileSystemDirectoryHandle;
  readonly backingFileHandleCacheEntryLimit?: number;
  readonly decodedInodeIndexPageCacheEntryLimit?: number;
  readonly metadataRecordCachePolicy?: AuthenticatedMetadataRecordCachePolicy;
}): Promise<BrowserHizoFSBenchmarkApplicationRuntime> {
  const runtimeDiagnostics = new HizoFSRuntimeDiagnosticsAccumulator();
  const backend = instrumentHizoFSWritableBackend({
    backend: createHizoFSOpfsWritableBackend({
      diagnostics: runtimeDiagnostics,
      fileHandleCacheEntryLimit: backingFileHandleCacheEntryLimit,
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
      backingFileHandleCacheEntryLimit,
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
          decodedInodeIndexPageCacheEntryLimit,
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
    async settleAcceptedGeneration() {
      if (closed) throw new TypeError("cannot settle a closed HizoFS benchmark runtime");
      await settleBenchmarkAcceptedGeneration({ session });
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
  "beginCleanHeadMaintenanceRootCapture"
>;

type MaintenanceSweepHost = Pick<
  HizoFSWorkerRuntimeHost,
  "beginCleanHeadMaintenanceRootCapture" | "beginSegmentDeletion"
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
  const runtimeCapture = await runtimeHost.beginCleanHeadMaintenanceRootCapture();
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
          writerWorkingPageRoots: runtimeCapture.writerWorkingPageRoots,
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
  createMutationCandidatePlanningBaseCommit,
  createPreparedMutationSelectedCandidatePublisher,
  createStagedMutationSelectedCandidatePublisher,
  installPreparedMutationSelectedCandidate,
  instrumentHizoFSWritableBackend,
  prepareAndInstallDeferredMutationSelectedCandidate,
  prepareAndInstallStagedMutationSelectedCandidate,
  releaseBenchmarkCapabilityAfterSessionOpenFailure,
  settleRootCapture,
  settleTransitionEndpointClose,
  validateAndPrepareAuthenticatedMaintenanceSweepWithReader,
};
