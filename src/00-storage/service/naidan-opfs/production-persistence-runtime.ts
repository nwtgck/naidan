import { nanoid } from 'nanoid';
import {
  encodePersistenceEndpoint,
  parseTransitionOperationId,
  persistenceControlAuthenticationFileSystemId,
  PersistenceControlSelectionError,
  selectPersistenceControlAuthority,
  type NaidanPersistenceControlV1,
  type NaidanPersistenceModeV1,
  type NaidanPersistenceEndpointV1,
  type PersistenceControlCandidate,
  type SelectedPersistenceControlAuthority,
  type TransitionOperationId,
} from '@/00-storage/service/naidan-persistence-control/00-format';
import { inspectPersistenceControl } from '@/00-storage/service/naidan-persistence-control/inspection';
import {
  openPersistenceControl,
  readPersistenceControlCandidates,
  type PersistenceControlPhysicalPort,
  type PersistenceControlProofAuthority,
  type PersistenceControlReadablePhysicalPort,
} from '@/00-storage/service/naidan-persistence-control/store';
import type { PersistenceControlRootKeyDerivationCapability } from '@/00-storage/service/naidan-persistence-control/crypto';
import {
  createBrowserContainerCoordinationScope,
  createBrowserHizoFSTransitionTargetContainer,
  openBrowserHizoFSTransitionTargetEndpointSession,
  publishBrowserHizoFSTransitionTargetCandidate,
  verifyBrowserHizoFSTransitionTargetNormalOpen,
  createBrowserHizoFSWorkerRuntimeHost,
  openAuthenticatedDevelopmentWritableApplicationSessionFromCapability,
  openBrowserAuthenticatedDevelopmentWritableContainerCapability,
  openAuthenticatedReadOnlyApplicationSessionFromCapability,
  replaceAuthenticatedDevelopmentWritableSessionPassphrase,
  withAuthenticatedDevelopmentWritableSessionRetainedCredentials,
  withAuthenticatedDevelopmentWritableSessionRootKeyProof,
  openBrowserAuthenticatedReadOnlyContainerCapability,
  type AuthenticatedDevelopmentWritableContainerCapability,
  type AuthenticatedReadOnlyContainerCapability,
} from '@/00-storage/service/hizofs/worker-entry';
import {
  capturePersistenceControlAuthority,
  createCapturedPersistenceControlReadablePhysicalPort,
  recheckPersistenceControlAuthority,
  type CapturedPersistenceControlAuthority,
} from '@/00-storage/service/naidan-persistence-control/store/persistence-control-authority-handshake';
import { authoritativeTransitionEndpoint } from '@/00-storage/service/naidan-persistence-control/transition/transition-state-machine';
import {
  TransitionProviderAdapter,
  type TransitionEndpointDriver,
  type TransitionSourceEndpointSession,
  type TransitionTargetOperationBinding,
} from '@/00-storage/service/naidan-persistence-control/transition/transition-provider-adapter';
import {
  advancePersistenceTransition,
  convergeInterruptedPersistenceTransition,
  startPersistenceTransition,
  type TransitionAdvanceResult,
  type TransitionConvergenceResult,
  type TransitionControlPort,
  type TransitionCoordinatorPolicy,
  type TransitionSemanticState,
} from '@/00-storage/service/naidan-persistence-control/transition/transition-coordinator';
import { createPersistenceControlTransitionPort } from '@/00-storage/service/naidan-persistence-control/transition/persistence-control-transition-port';
import { createStorageFileSystemTransitionSource } from '@/00-storage/service/naidan-persistence-control/transition/storage-file-system-transition-source';
import type { TransitionEndpointReadiness } from '@/00-storage/service/naidan-persistence-control/transition/transition-endpoint-readiness';
import { createNativeOpfsFileSystemSession } from '@/00-storage/service/storage-file-system/native-opfs';
import type { StorageFileSystemSession } from '@/00-storage/service/storage-file-system/types';
import type {
  OpfsEncryptionInspection,
  OpfsPersistenceRetainedCredential,
  OpfsPersistenceUnlockedMaintenanceResult,
  OpfsPersistenceUnlockedSession,
} from './persistence-runtime-contract';
import { projectPersistenceRuntimeInspection } from './persistence-runtime-inspection';
import {
  NAIDAN_OPFS_STORAGE_DIRECTORY_NAME,
  naidanOpfsContainerOriginRelativePath,
  openNaidanOpfsContainerDirectory,
  removeNaidanOpfsContainerDirectory,
  reserveNaidanOpfsContainerDirectory,
} from './opfs-storage-location';
import {
  validatePhaseSpecificPersistenceEndpointReadiness,
  type OpenedAuthenticationEndpoint,
  type PersistenceEndpointOpenProfile,
  type PhaseSpecificEndpointInspectionPort,
} from './native-persistence-endpoint-readiness';


import {
  createBrowserNaidanPersistenceControlExclusiveGate,
  type NaidanPersistenceControlExclusiveGate,
} from './persistence-control-exclusive-gate';
import { cleanupRetiredLocalTransitionProgress } from './retired-local-transition-progress-cleanup';
import { createOpfsPersistenceControlPhysicalPort } from './opfs-persistence-control-readable-port';
import {
  createNativePlainDisableTransitionDriver,
  NATIVE_PLAIN_DISABLE_AUTHORITY_IDENTITY,
} from './native-plain-disable-transition-driver';
import { NativePlainTransitionRuntimeState } from './native-plain-transition-runtime-state';
import { RuntimeHizoFSTransitionImportState } from './runtime-hizofs-transition-import-state';
import { projectNativePlainTransitionSource } from './native-plain-transition-namespace';
import {
  createNativePlainEnableTransitionDriver,
  NATIVE_PLAIN_ENABLE_AUTHORITY_IDENTITY,
} from './native-plain-enable-transition-driver';
import {
  cleanupNativePlainApplicationNamespaceWithReport,
  isNativePlainApplicationNamespaceEmpty,
  listNativePlainApplicationNamespaceEntryNames,
} from './native-plain-application-namespace';
import {
  runWithExclusiveOpfsPlainNamespaceFence,
  runWithOpportunisticExclusiveOpfsPlainNamespaceFence,
} from '@/00-storage/service/opfs/opfs-storage-session-lock';
import {
  reportHizoFSTrialDebug,
  reportHizoFSTrialFailure,
  reportRetiredPlainCleanupFailure,
  type NativeDisableTrialStage,
  type NativeEnableTrialStage,
} from './trial-debug';
import type { OpfsEncryptionTransitionProgressListener } from './transition-progress';


type HizoFSMode = Extract<NaidanPersistenceControlV1['mode'], { readonly type: 'hizofs' }>;
type FileSystemId = HizoFSMode['activeFileSystemId'];

interface NativeHizoFSRootKeyProofScope {
  withRootKeyProof<T>({ fileSystemId, operation }: {
    fileSystemId: FileSystemId;
    operation: ({ rootKey }: {
      rootKey: PersistenceControlRootKeyDerivationCapability;
    }) => Promise<T>;
  }): Promise<T>;
}

function reportNativeEnableTrialFailure({ cause, fileSystemId, operationId, stage }: {
  cause: unknown;
  fileSystemId: FileSystemId;
  operationId: TransitionOperationId;
  stage: NativeEnableTrialStage;
}): void {
  reportHizoFSTrialFailure({
    cause,
    detail: { event: 'native_enable_failure', fileSystemId, operationId, stage },
  });
}

export type CredentialCandidateOpenProfile = 'normal_read' | 'root_key_proof';

export type CredentialCandidateOpenResult<Authority> =
  | { readonly type: 'credential_rejected' }
  | {
      readonly authority: Authority;
      readonly releaseResources: () => Promise<void>;
      readonly type: 'opened';
    };

export type CredentialBoundPersistenceControlOpenResult<Authority> =
  | { readonly type: 'credential_rejected' }
  | {
      readonly authority: Authority;
      readonly fileSystemId: FileSystemId;
      readonly releaseResources: () => Promise<void>;
      readonly selected: SelectedPersistenceControlAuthority;
      readonly type: 'opened';
    };

export type CredentialBoundApplicationSessionOpenResult =
  | { readonly type: 'credential_rejected' }
  | {
      readonly authoritativeEndpoint: NaidanPersistenceEndpointV1;
      readonly fileSystemId: FileSystemId;
      readonly fileSystemSession: StorageFileSystemSession;
      readonly selected: SelectedPersistenceControlAuthority;
      readonly type: 'opened';
    };

type BrowserHizoFSRuntimeHostOptions = Parameters<typeof createBrowserHizoFSWorkerRuntimeHost>[0];

type NativeHizoFSTransitionTargetCreationPort = Readonly<{
  createTargetContainer: typeof createBrowserHizoFSTransitionTargetContainer;
}>;

const browserNativeHizoFSTransitionTargetCreationPort: NativeHizoFSTransitionTargetCreationPort = Object.freeze({
  createTargetContainer: createBrowserHizoFSTransitionTargetContainer,
});

async function createNativeHizoFSTransitionTargetWith({
  exclusiveGate,
  passphrases,
  runtime,
  storageRoot,
}: {
  exclusiveGate: NaidanPersistenceControlExclusiveGate;
  passphrases: readonly string[];
  runtime: NativeHizoFSTransitionTargetCreationPort;
  storageRoot: FileSystemDirectoryHandle;
}): Promise<FileSystemId> {
  return await runtime.createTargetContainer({
    passphrases,
    reserveContainerRoot: async ({ fileSystemId }) => await reserveNaidanOpfsContainerDirectory({
      exclusiveGate,
      fileSystemId,
      storageRoot,
    }),
  });
}

async function createNativeHizoFSEnableTransitionTargetWith({
  exclusiveGate,
  passphrase,
  runtime,
  storageRoot,
}: {
  exclusiveGate: NaidanPersistenceControlExclusiveGate;
  passphrase: string;
  runtime: NativeHizoFSTransitionTargetCreationPort;
  storageRoot: FileSystemDirectoryHandle;
}): Promise<FileSystemId> {
  return await createNativeHizoFSTransitionTargetWith({
    exclusiveGate,
    passphrases: [passphrase],
    runtime,
    storageRoot,
  });
}

/** Creates one unreferenced HizoFS target before Persistence Control starts an enable transition. */
export async function createNativeHizoFSEnableTransitionTarget({
  exclusiveGate,
  passphrase,
  storageRoot,
}: {
  exclusiveGate: NaidanPersistenceControlExclusiveGate;
  passphrase: string;
  storageRoot: FileSystemDirectoryHandle;
}): Promise<FileSystemId> {
  return await createNativeHizoFSEnableTransitionTargetWith({
    exclusiveGate,
    passphrase,
    runtime: browserNativeHizoFSTransitionTargetCreationPort,
    storageRoot,
  });
}

type NativeHizoFSEnableTargetSessionOpener = typeof openBrowserHizoFSTransitionTargetEndpointSession;
type NativeHizoFSEnableTargetPublisher = typeof publishBrowserHizoFSTransitionTargetCandidate;
type NativeHizoFSEnableTargetNormalOpenVerifier = typeof verifyBrowserHizoFSTransitionTargetNormalOpen;
type NativeHizoFSEnableTargetImportStatePort = Parameters<NativeHizoFSEnableTargetSessionOpener>[0]['runtimeStatePort'];
type NativeHizoFSEnableTargetLimits = Parameters<NativeHizoFSEnableTargetSessionOpener>[0]['limits'];
type NativeHizoFSEnableTargetProofVerifier = Parameters<NativeHizoFSEnableTargetSessionOpener>[0]['verifyProofAuthority'];

type NativeHizoFSEnableTransitionDriverRuntime = Readonly<{
  openContainerRoot: typeof openNaidanOpfsContainerDirectory;
  openTargetSession: NativeHizoFSEnableTargetSessionOpener;
  publishTarget: NativeHizoFSEnableTargetPublisher;
  removeContainerRoot: typeof removeNaidanOpfsContainerDirectory;
  verifyNormalOpen: NativeHizoFSEnableTargetNormalOpenVerifier;
}>;

const browserNativeHizoFSEnableTransitionDriverRuntime: NativeHizoFSEnableTransitionDriverRuntime = Object.freeze({
  openContainerRoot: openNaidanOpfsContainerDirectory,
  openTargetSession: openBrowserHizoFSTransitionTargetEndpointSession,
  publishTarget: publishBrowserHizoFSTransitionTargetCandidate,
  removeContainerRoot: removeNaidanOpfsContainerDirectory,
  verifyNormalOpen: verifyBrowserHizoFSTransitionTargetNormalOpen,
});

function sameTransitionTargetBinding({ actual, expected }: {
  actual: TransitionTargetOperationBinding;
  expected: TransitionTargetOperationBinding;
}): boolean {
  return actual.operationId === expected.operationId
    && encodePersistenceEndpoint({ endpoint: actual.source }) === encodePersistenceEndpoint({ endpoint: expected.source })
    && encodePersistenceEndpoint({ endpoint: actual.target }) === encodePersistenceEndpoint({ endpoint: expected.target });
}

function sameTransitionEndpoint({ actual, expected }: {
  actual: NaidanPersistenceEndpointV1;
  expected: NaidanPersistenceEndpointV1;
}): boolean {
  return encodePersistenceEndpoint({ endpoint: actual }) === encodePersistenceEndpoint({ endpoint: expected });
}

function createNativeHizoFSEnableTransitionDriverWith({
  recheckPublicationAllowed,
  authorityIdentity,
  binding,
  exclusiveGate,
  initialOpenProfile,
  importStatePort,
  inspectTarget,
  limits,
  normalOpenVerificationPassphrases,
  operationPassphrase,
  runtime,
  storageRoot,
  verifyProofAuthority,
}: {
  recheckPublicationAllowed: () => Promise<void>;
  authorityIdentity: string;
  binding: TransitionTargetOperationBinding;
  exclusiveGate: NaidanPersistenceControlExclusiveGate;
  initialOpenProfile: CredentialCandidateOpenProfile;
  importStatePort: NativeHizoFSEnableTargetImportStatePort;
  inspectTarget: ({ openProfile }: {
    openProfile: CredentialCandidateOpenProfile;
  }) => Promise<TransitionEndpointReadiness>;
  limits: NativeHizoFSEnableTargetLimits;
  normalOpenVerificationPassphrases: readonly string[];
  operationPassphrase: string;
  runtime: NativeHizoFSEnableTransitionDriverRuntime;
  storageRoot: FileSystemDirectoryHandle;
  verifyProofAuthority: NativeHizoFSEnableTargetProofVerifier;
}): TransitionEndpointDriver {
  let activeOpenProfile = initialOpenProfile;
  const fileSystemId = (() => {
    switch (binding.target.type) {
    case 'hizofs': return binding.target.fileSystemId;
    case 'plain': throw new TypeError('native HizoFS enable target driver requires a HizoFS target');
    default: return binding.target satisfies never;
    }
  })();

  const requireBinding = ({ actual }: { actual: TransitionTargetOperationBinding }): void => {
    if (!sameTransitionTargetBinding({ actual, expected: binding })) {
      throw new TypeError('native HizoFS enable target driver belongs to another transition binding');
    }
  };
  const requireEndpoint = ({ endpoint }: { endpoint: NaidanPersistenceEndpointV1 }): void => {
    if (!sameTransitionEndpoint({ actual: endpoint, expected: binding.target })) {
      throw new TypeError('native HizoFS enable target driver belongs to another endpoint');
    }
  };
  const containerRoot = async (): Promise<FileSystemDirectoryHandle> => await runtime.openContainerRoot({
    fileSystemId,
    storageRoot,
  });

  return {
    cleanupEndpoint: async ({ endpoint }) => {
      requireEndpoint({ endpoint });
      await runtime.removeContainerRoot({ exclusiveGate, fileSystemId, storageRoot });
    },
    finalizeTarget: async ({ binding: actual }) => {
      requireBinding({ actual });
      await recheckPublicationAllowed();
      const publicationPermit = Object.freeze({});
      let activePublicationPermit: object | undefined = publicationPermit;
      let publicationGuardChecks = 0;
      try {
        await runtime.publishTarget({
          assertPublicationAllowed: () => {
            // The HizoFS Commit publisher intentionally checks the same owner
            // authority before preparation and again immediately before the
            // first authority write. One exact Persistence Control recheck
            // authorizes this single publishTarget invocation; it is not a
            // one-shot token consumed by the first internal guard.
            if (activePublicationPermit !== publicationPermit) {
              throw new Error('transition target publication is outside its exact Persistence Control recheck scope');
            }
            publicationGuardChecks += 1;
          },
          containerRoot: await containerRoot(),
          operationIdentity: binding.operationId,
          passphrase: operationPassphrase,
          runtimeStatePort: importStatePort,
          verifyProofAuthority,
        });
        if (publicationGuardChecks === 0) {
          throw new Error('transition target publication did not check its Persistence Control permit');
        }
        activeOpenProfile = 'normal_read';
      } finally {
        activePublicationPermit = undefined;
      }
    },
    inspectEndpoint: async ({ endpoint }) => {
      requireEndpoint({ endpoint });
      return await inspectTarget({ openProfile: activeOpenProfile });
    },
    openSourceEndpoint: async () => {
      throw new TypeError('native HizoFS enable target driver cannot open a source endpoint');
    },
    openTargetEndpoint: async ({ binding: actual }) => {
      requireBinding({ actual });
      return await runtime.openTargetSession({
        authorityIdentity,
        containerRoot: await containerRoot(),
        limits,
        operationIdentity: binding.operationId,
        passphrase: operationPassphrase,
        runtimeStatePort: importStatePort,
        verifyProofAuthority,
      });
    },
    prepareTarget: async ({ binding: actual }) => {
      requireBinding({ actual });
      const readiness = await inspectTarget({ openProfile: activeOpenProfile });
      switch (readiness) {
      case 'fully_verified':
      case 'root_key_ready': return;
      case 'absent': throw new TypeError('native HizoFS enable target is absent');
      case 'invalid': throw new TypeError('native HizoFS enable target is invalid');
      default: return readiness satisfies never;
      }
    },
    verifyNormalOpen: async ({ binding: actual }) => {
      requireBinding({ actual });
      if (normalOpenVerificationPassphrases.length < 1) {
        throw new RangeError('native HizoFS target requires at least one normal-open verification passphrase');
      }
      let credentialSlotCount: number | undefined;
      for (const passphrase of normalOpenVerificationPassphrases) {
        const verified = await runtime.verifyNormalOpen({
          containerRoot: await containerRoot(),
          expectedFileSystemId: fileSystemId,
          passphrase,
          verifyProofAuthority,
        });
        if (credentialSlotCount !== undefined && credentialSlotCount !== verified.credentialSlotCount) {
          throw new TypeError('native HizoFS target normal-open proofs observed different Credential Slot sets');
        }
        credentialSlotCount = verified.credentialSlotCount;
      }
      if (credentialSlotCount !== normalOpenVerificationPassphrases.length) {
        throw new RangeError('native HizoFS target Credential Slot set does not exactly match the retained credentials');
      }
    },
  };
}

export function createNativeHizoFSEnableTransitionDriver({
  recheckPublicationAllowed,
  authorityIdentity,
  binding,
  exclusiveGate,
  initialOpenProfile,
  importStatePort,
  inspectTarget,
  limits,
  passphrase,
  storageRoot,
  verifyProofAuthority,
}: Omit<Parameters<typeof createNativeHizoFSEnableTransitionDriverWith>[0],
  'normalOpenVerificationPassphrases' | 'operationPassphrase' | 'runtime'> & {
  passphrase: string;
}): TransitionEndpointDriver {
  return createNativeHizoFSEnableTransitionDriverWith({
    recheckPublicationAllowed,
    authorityIdentity,
    binding,
    exclusiveGate,
    initialOpenProfile,
    importStatePort,
    inspectTarget,
    limits,
    normalOpenVerificationPassphrases: [passphrase],
    operationPassphrase: passphrase,
    runtime: browserNativeHizoFSEnableTransitionDriverRuntime,
    storageRoot,
    verifyProofAuthority,
  });
}


const NATIVE_ENABLE_TRANSITION_POLICY: TransitionCoordinatorPolicy = Object.freeze({
  copy: Object.freeze({
    maximumBytesPerSlice: 1024 * 1024,
    maximumDirectoryEntriesPerRead: 256,
    maximumOperationsPerSlice: 512,
    maximumPathComponents: 1024,
  }),
  verification: Object.freeze({
    maximumBytesPerSlice: 1024 * 1024,
    maximumDirectoryEntriesPerRead: 256,
    maximumOperationsPerSlice: 512,
    maximumPathComponents: 1024,
  }),
});

const NATIVE_ENABLE_TARGET_IMPORT_LIMITS: NativeHizoFSEnableTargetLimits = Object.freeze({
  directory: Object.freeze({ maximumEntryMutationsPerBatch: 128 }),
  file: Object.freeze({ maximumExtentMutationsPerBatch: 128 }),
});

function nativeEnableTargetAuthorityIdentity({ fileSystemId }: { fileSystemId: FileSystemId }): string {
  return `hizofs-enable-target:${fileSystemId}`;
}

function nativeDisableSourceAuthorityIdentity({ fileSystemId }: { fileSystemId: FileSystemId }): string {
  return `hizofs-disable-source:${fileSystemId}`;
}

function nativeReencryptSourceAuthorityIdentity({ fileSystemId }: { fileSystemId: FileSystemId }): string {
  return `hizofs-reencrypt-source:${fileSystemId}`;
}

function nativeReencryptTargetAuthorityIdentity({ fileSystemId }: { fileSystemId: FileSystemId }): string {
  return `hizofs-reencrypt-target:${fileSystemId}`;
}

type NativeHizoFSSourceTransitionDriver = Readonly<{
  driver: TransitionEndpointDriver;
  markAuthoritySwitched(): void;
}>;

function createNativeHizoFSSourceTransitionDriver({ authorityIdentity, binding, exclusiveGate, nativeNamespaceRoot, session, targetType }: {
  authorityIdentity: string;
  binding: TransitionTargetOperationBinding;
  exclusiveGate: NaidanPersistenceControlExclusiveGate;
  nativeNamespaceRoot: FileSystemDirectoryHandle;
  session: StorageFileSystemSession | undefined;
  targetType: NaidanPersistenceEndpointV1['type'];
}): NativeHizoFSSourceTransitionDriver {
  const sourceFileSystemId = (() => {
    switch (binding.source.type) {
    case 'hizofs': return binding.source.fileSystemId;
    case 'plain': throw new TypeError('native HizoFS source transition driver requires a HizoFS source');
    default: return binding.source satisfies never;
    }
  })();
  if (binding.target.type !== targetType) {
    throw new TypeError(`native HizoFS source transition driver requires a ${targetType} target`);
  }
  let readiness: TransitionEndpointReadiness = 'fully_verified';
  const requireSourceEndpoint = ({ endpoint }: { endpoint: NaidanPersistenceEndpointV1 }): void => {
    if (!sameTransitionEndpoint({ actual: endpoint, expected: binding.source })) {
      throw new TypeError('native HizoFS source transition driver belongs to another endpoint');
    }
  };
  const requireBinding = ({ actual }: { actual: TransitionTargetOperationBinding }): void => {
    if (!sameTransitionTargetBinding({ actual, expected: binding })) {
      throw new TypeError('native HizoFS source transition driver belongs to another transition binding');
    }
  };
  return {
    driver: {
      cleanupEndpoint: async ({ endpoint }) => {
        requireSourceEndpoint({ endpoint });
        await removeNaidanOpfsContainerDirectory({
          exclusiveGate,
          fileSystemId: sourceFileSystemId,
          storageRoot: nativeNamespaceRoot,
        });
      },
      finalizeTarget: async ({ binding: actual }) => {
        requireBinding({ actual });
        throw new TypeError('native HizoFS source transition driver cannot finalize a target');
      },
      inspectEndpoint: async ({ endpoint }) => {
        requireSourceEndpoint({ endpoint });
        return readiness;
      },
      openSourceEndpoint: async ({ endpoint }): Promise<TransitionSourceEndpointSession> => {
        requireSourceEndpoint({ endpoint });
        if (session === undefined) {
          throw new TypeError('native HizoFS source transition session is unavailable after authority switch');
        }
        if (session.createReadSnapshot === undefined) {
          throw new TypeError('native HizoFS source transition requires immutable read snapshots');
        }
        const snapshot = await session.createReadSnapshot();
        return {
          authorityIdentity,
          close: async () => await snapshot.close(),
          source: projectNativePlainTransitionSource({
            source: createStorageFileSystemTransitionSource({ session: snapshot }),
          }),
        };
      },
      openTargetEndpoint: async ({ binding: actual }) => {
        requireBinding({ actual });
        throw new TypeError('native HizoFS source transition driver cannot open a target endpoint');
      },
      prepareTarget: async ({ binding: actual }) => {
        requireBinding({ actual });
        throw new TypeError('native HizoFS source transition driver cannot prepare a target');
      },
      verifyNormalOpen: async ({ binding: actual }) => {
        requireBinding({ actual });
        throw new TypeError('native HizoFS source transition driver cannot verify a target');
      },
    },
    markAuthoritySwitched(): void {
      readiness = 'root_key_ready';
    },
  };
}

function createNativeHizoFSDisableSourceDriver({ binding, exclusiveGate, nativeNamespaceRoot, session }: {
  binding: TransitionTargetOperationBinding;
  exclusiveGate: NaidanPersistenceControlExclusiveGate;
  nativeNamespaceRoot: FileSystemDirectoryHandle;
  session: StorageFileSystemSession | undefined;
}): NativeHizoFSSourceTransitionDriver {
  const fileSystemId = (() => {
    switch (binding.source.type) {
    case 'hizofs': return binding.source.fileSystemId;
    case 'plain': throw new TypeError('native HizoFS disable source driver requires a HizoFS source');
    default: return binding.source satisfies never;
    }
  })();
  return createNativeHizoFSSourceTransitionDriver({
    authorityIdentity: nativeDisableSourceAuthorityIdentity({ fileSystemId }),
    binding,
    exclusiveGate,
    nativeNamespaceRoot,
    session,
    targetType: 'plain',
  });
}

function createNativeHizoFSReencryptSourceDriver({ binding, exclusiveGate, nativeNamespaceRoot, session }: {
  binding: TransitionTargetOperationBinding;
  exclusiveGate: NaidanPersistenceControlExclusiveGate;
  nativeNamespaceRoot: FileSystemDirectoryHandle;
  session: StorageFileSystemSession | undefined;
}): NativeHizoFSSourceTransitionDriver {
  const fileSystemId = (() => {
    switch (binding.source.type) {
    case 'hizofs': return binding.source.fileSystemId;
    case 'plain': throw new TypeError('native HizoFS re-encrypt source driver requires a HizoFS source');
    default: return binding.source satisfies never;
    }
  })();
  switch (binding.target.type) {
  case 'hizofs':
    if (binding.target.fileSystemId === fileSystemId) {
      throw new TypeError('native HizoFS re-encrypt source and target must be distinct');
    }
    break;
  case 'plain': throw new TypeError('native HizoFS re-encrypt source driver requires a HizoFS target');
  default: binding.target satisfies never;
  }
  return createNativeHizoFSSourceTransitionDriver({
    authorityIdentity: nativeReencryptSourceAuthorityIdentity({ fileSystemId }),
    binding,
    exclusiveGate,
    nativeNamespaceRoot,
    session,
    targetType: 'hizofs',
  });
}


function createNativeHizoFSReencryptTransitionDriver({
  binding,
  markTargetNormalOpenVerified,
  source,
  target,
}: {
  binding: TransitionTargetOperationBinding;
  markTargetNormalOpenVerified: () => void;
  source: TransitionEndpointDriver;
  target: TransitionEndpointDriver;
}): TransitionEndpointDriver {
  const requireSourceEndpoint = ({ endpoint }: { endpoint: NaidanPersistenceEndpointV1 }): void => {
    if (!sameTransitionEndpoint({ actual: endpoint, expected: binding.source })) {
      throw new TypeError('native HizoFS re-encrypt source operation belongs to another endpoint');
    }
  };
  const requireTargetBinding = ({ actual }: { actual: TransitionTargetOperationBinding }): void => {
    if (!sameTransitionTargetBinding({ actual, expected: binding })) {
      throw new TypeError('native HizoFS re-encrypt target operation belongs to another transition binding');
    }
  };
  const driverForEndpoint = ({ endpoint }: { endpoint: NaidanPersistenceEndpointV1 }): TransitionEndpointDriver => {
    if (sameTransitionEndpoint({ actual: endpoint, expected: binding.source })) return source;
    if (sameTransitionEndpoint({ actual: endpoint, expected: binding.target })) return target;
    throw new TypeError('native HizoFS re-encrypt driver received an unrelated endpoint');
  };
  return {
    cleanupEndpoint: async ({ endpoint }) => await driverForEndpoint({ endpoint }).cleanupEndpoint({ endpoint }),
    finalizeTarget: async ({ binding: actual }) => {
      requireTargetBinding({ actual });
      await target.finalizeTarget({ binding: actual });
    },
    inspectEndpoint: async ({ endpoint }) => await driverForEndpoint({ endpoint }).inspectEndpoint({ endpoint }),
    openSourceEndpoint: async ({ endpoint }) => {
      requireSourceEndpoint({ endpoint });
      return await source.openSourceEndpoint({ endpoint });
    },
    openTargetEndpoint: async ({ binding: actual }) => {
      requireTargetBinding({ actual });
      return await target.openTargetEndpoint({ binding: actual });
    },
    prepareTarget: async ({ binding: actual }) => {
      requireTargetBinding({ actual });
      await target.prepareTarget({ binding: actual });
    },
    verifyNormalOpen: async ({ binding: actual }) => {
      requireTargetBinding({ actual });
      await target.verifyNormalOpen({ binding: actual });
      markTargetNormalOpenVerified();
    },
  };
}

function sameNativeReencryptTransition({ actual, binding }: {
  actual: TransitionSemanticState;
  binding: TransitionTargetOperationBinding;
}): boolean {
  const mode = actual.mode;
  return mode.type === 'transitioning'
    && mode.operation === 're_encrypt'
    && mode.operationId === binding.operationId
    && mode.phase.type === 'building_target'
    && sameTransitionEndpoint({ actual: mode.phase.source, expected: binding.source })
    && sameTransitionEndpoint({ actual: mode.phase.target, expected: binding.target });
}

async function settleNativeHizoFSReencryptTargetAfterStartFailure({
  binding,
  control,
  removeTarget,
  targetFileSystemId,
}: {
  binding: TransitionTargetOperationBinding;
  control: TransitionControlPort;
  removeTarget: () => Promise<void>;
  targetFileSystemId: FileSystemId;
}): Promise<'removed' | 'retained'> {
  const sourceFileSystemId = (() => {
    switch (binding.source.type) {
    case 'hizofs': return binding.source.fileSystemId;
    case 'plain': throw new TypeError('native re-encrypt source binding must be HizoFS');
    default: return binding.source satisfies never;
    }
  })();
  const authenticated = await control.readState();
  if (sameNativeReencryptTransition({ actual: authenticated, binding })) return 'retained';
  switch (authenticated.mode.type) {
  case 'hizofs':
    if (authenticated.mode.activeFileSystemId !== sourceFileSystemId
      || authenticated.retiredFileSystemIds.includes(targetFileSystemId)) return 'retained';
    await removeTarget();
    return 'removed';
  case 'plain':
  case 'transitioning': return 'retained';
  default: return authenticated.mode satisfies never;
  }
}

function sameSemanticTransitionState({ actual, binding }: {
  actual: TransitionSemanticState;
  binding: TransitionTargetOperationBinding;
}): boolean {
  const mode = actual.mode;
  return mode.type === 'transitioning'
    && mode.operation === 'encrypt'
    && mode.operationId === binding.operationId
    && mode.phase.type === 'building_target'
    && sameTransitionEndpoint({ actual: mode.phase.source, expected: binding.source })
    && sameTransitionEndpoint({ actual: mode.phase.target, expected: binding.target });
}

function nativeHizoFSDisableSourceRemainsAuthoritativeAfterStartFailure({
  actual,
  binding,
}: {
  actual: TransitionSemanticState;
  binding: TransitionTargetOperationBinding;
}): boolean {
  const sourceFileSystemId = (() => {
    switch (binding.source.type) {
    case 'hizofs': return binding.source.fileSystemId;
    case 'plain': throw new TypeError('native disable source binding must be HizoFS');
    default: return binding.source satisfies never;
    }
  })();
  switch (actual.mode.type) {
  case 'hizofs': return actual.mode.activeFileSystemId === sourceFileSystemId;
  case 'plain':
  case 'transitioning': return false;
  default: return actual.mode satisfies never;
  }
}

async function settleNativeHizoFSEnableTargetAfterStartFailure({
  binding,
  control,
  fileSystemId,
  removeTarget,
}: {
  binding: TransitionTargetOperationBinding;
  control: TransitionControlPort;
  fileSystemId: FileSystemId;
  removeTarget: () => Promise<void>;
}): Promise<'removed' | 'retained'> {
  const authenticated = await control.readState();
  if (sameSemanticTransitionState({ actual: authenticated, binding })) return 'retained';

  // Only an authenticated stable-plain state that does not retain this exact
  // File System ID proves the freshly created target never became routing or
  // cleanup authority. Every transitioning/HizoFS/ambiguous state retains the
  // target so restart recovery cannot lose an already committed transition.
  switch (authenticated.mode.type) {
  case 'plain':
    if (authenticated.retiredFileSystemIds.includes(fileSystemId)) return 'retained';
    await removeTarget();
    return 'removed';
  case 'hizofs':
  case 'transitioning': return 'retained';
  default: return authenticated.mode satisfies never;
  }
}

function createNativeHizoFSRootKeyProofScope({ fileSystemId, nativeNamespaceRoot, openProfile, passphrase }: {
  fileSystemId: FileSystemId;
  nativeNamespaceRoot: FileSystemDirectoryHandle;
  openProfile: CredentialCandidateOpenProfile;
  passphrase: string;
}): NativeHizoFSRootKeyProofScope {
  return {
    async withRootKeyProof<T>({ fileSystemId: requestedFileSystemId, operation }: {
      fileSystemId: FileSystemId;
      operation: ({ rootKey }: { rootKey: PersistenceControlRootKeyDerivationCapability }) => Promise<T>;
    }): Promise<T> {
      if (requestedFileSystemId !== fileSystemId) {
        throw new TypeError('native transition proof scope belongs to another HizoFS endpoint');
      }
      const containerRoot = await openNaidanOpfsContainerDirectory({
        fileSystemId,
        storageRoot: nativeNamespaceRoot,
      });
      const outcome: { resolved: boolean; value: T | undefined } = { resolved: false, value: undefined };
      const opened = await openBrowserAuthenticatedReadOnlyContainerCapability({
        containerRoot,
        openProfile,
        passphrase,
        verifyProofAuthority: async ({ fileSystemId: openedFileSystemId, rootKeyProof }) => {
          if (openedFileSystemId !== fileSystemId) {
            throw new TypeError('native transition proof scope opened another HizoFS endpoint');
          }
          outcome.value = await operation({ rootKey: rootKeyProof });
          outcome.resolved = true;
        },
      });
      switch (opened.type) {
      case 'credential_rejected': throw new TypeError('native transition credential was rejected after initial proof');
      case 'opened':
        return await runWithCredentialAuthorityRelease({
          failureMessage: 'native transition proof scope validation and credential authority release both failed',
          operation: async () => {
            if (!outcome.resolved) throw new Error('native transition proof scope returned without executing its operation');
            return outcome.value as T;
          },
          releaseResources: opened.releaseResources,
        });
      default: return opened satisfies never;
      }
    },
  };
}

function createCallbackScopedPersistenceControlTransitionPort({
  bootstrapAuthorization,
  endpointInspectionPort,
  fileSystemId,
  initialOpenProfile,
  physical,
  proofScopeForProfile,
}: {
  bootstrapAuthorization: 'verified_plain_namespace' | undefined;
  endpointInspectionPort: PhaseSpecificEndpointInspectionPort;
  fileSystemId: FileSystemId;
  initialOpenProfile: CredentialCandidateOpenProfile;
  physical: PersistenceControlPhysicalPort;
  proofScopeForProfile: ({ openProfile }: {
    openProfile: CredentialCandidateOpenProfile;
  }) => NativeHizoFSRootKeyProofScope;
}): TransitionControlPort {
  let currentOpenProfile = initialOpenProfile;
  let scopedOpenProfile: CredentialCandidateOpenProfile | undefined;
  let scopedRootKey: PersistenceControlRootKeyDerivationCapability | undefined;

  const proofAuthority: PersistenceControlProofAuthority = {
    resolveRootKey: async ({ fileSystemId: requestedFileSystemId }) => requestedFileSystemId === fileSystemId
      && scopedRootKey !== undefined
      ? { rootKey: scopedRootKey, state: 'resolved' }
      : { state: 'unresolved' },
    validateEndpointReadiness: async ({ control }) => {
      const openProfile = scopedOpenProfile;
      if (openProfile === undefined) {
        throw new Error('Persistence Control proof authority is outside its credential callback scope');
      }
      const authenticationFileSystemId = persistenceControlAuthenticationFileSystemId({ mode: control.mode });
      const projectedOpenProfile: CredentialCandidateOpenProfile = (() => {
        if (authenticationFileSystemId === undefined) return openProfile;
        if (authenticationFileSystemId !== fileSystemId) {
          throw new TypeError('Persistence Control candidate authenticates another native HizoFS endpoint');
        }
        const requiredOpenProfile = credentialCandidateOpenProfileFromMode({ mode: control.mode });
        if (openProfile === requiredOpenProfile) return requiredOpenProfile;
        if (openProfile === 'normal_read' && requiredOpenProfile === 'root_key_proof') {
          return 'root_key_proof';
        }
        throw new TypeError('opened native HizoFS proof is weaker than the Persistence Control candidate requires');
      })();
      return await validatePhaseSpecificPersistenceEndpointReadiness({
        control,
        openedAuthenticationEndpoint: { fileSystemId, openProfile: projectedOpenProfile },
        port: endpointInspectionPort,
      });
    },
  };
  const basePort = createPersistenceControlTransitionPort({
    bootstrapAuthorization,
    physical,
    proofAuthority,
    randomSource: undefined,
  });

  const withPort = async <T>({ openProfile, operation }: {
    openProfile: CredentialCandidateOpenProfile;
    operation: ({ port }: { port: TransitionControlPort }) => Promise<T>;
  }): Promise<T> => await proofScopeForProfile({ openProfile }).withRootKeyProof({
    fileSystemId,
    operation: async ({ rootKey }) => {
      if (scopedRootKey !== undefined || scopedOpenProfile !== undefined) {
        throw new Error('Persistence Control credential callback scope is already active');
      }
      scopedRootKey = rootKey;
      scopedOpenProfile = openProfile;
      try {
        return await operation({ port: basePort });
      } finally {
        scopedOpenProfile = undefined;
        scopedRootKey = undefined;
      }
    },
  });

  return {
    publishState: async ({ state }) => {
      const nextOpenProfile = credentialCandidateOpenProfileFromMode({ mode: state.mode });
      if (persistenceControlAuthenticationFileSystemId({ mode: state.mode }) !== fileSystemId) {
        throw new TypeError('Persistence Control publication changed the authenticated native HizoFS endpoint');
      }
      await withPort({
        openProfile: nextOpenProfile,
        operation: async ({ port }) => await port.publishState({ state }),
      });
      currentOpenProfile = nextOpenProfile;
    },
    readState: async () => await withPort({
      openProfile: currentOpenProfile,
      operation: async ({ port }) => await port.readState(),
    }),
  };
}

type NativeHizoFSReencryptControl = Readonly<{
  control: TransitionControlPort;
  markTargetNormalOpenVerified(): void;
}>;

function createNativeHizoFSReencryptControl({
  endpointInspectionPort,
  physical,
  sourceFileSystemId,
  sourceRootKeyProof,
  targetFileSystemId,
  targetProofScope,
}: {
  endpointInspectionPort: PhaseSpecificEndpointInspectionPort;
  physical: PersistenceControlPhysicalPort;
  sourceFileSystemId: FileSystemId;
  sourceRootKeyProof: PersistenceControlRootKeyDerivationCapability;
  targetFileSystemId: FileSystemId;
  targetProofScope: NativeHizoFSRootKeyProofScope;
}): NativeHizoFSReencryptControl {
  if (sourceFileSystemId === targetFileSystemId) {
    throw new TypeError('native re-encrypt control requires distinct source and target File System IDs');
  }
  let targetNormalOpenVerified = false;

  const withPort = async <T>({ includeTarget, operation }: {
    includeTarget: boolean;
    operation: ({ port }: { port: TransitionControlPort }) => Promise<T>;
  }): Promise<T> => {
    const run = async ({ targetRootKey }: {
      targetRootKey: PersistenceControlRootKeyDerivationCapability | undefined;
    }): Promise<T> => {
      const proofAuthority: PersistenceControlProofAuthority = {
        resolveRootKey: async ({ fileSystemId }) => {
          if (fileSystemId === sourceFileSystemId) return { rootKey: sourceRootKeyProof, state: 'resolved' };
          if (fileSystemId === targetFileSystemId && targetRootKey !== undefined) {
            return { rootKey: targetRootKey, state: 'resolved' };
          }
          return { state: 'unresolved' };
        },
        validateEndpointReadiness: async ({ control }) => {
          const authenticationFileSystemId = persistenceControlAuthenticationFileSystemId({ mode: control.mode });
          const openedAuthenticationEndpoint: OpenedAuthenticationEndpoint = (() => {
            if (authenticationFileSystemId === sourceFileSystemId) {
              return { fileSystemId: sourceFileSystemId, openProfile: 'normal_read' };
            }
            if (authenticationFileSystemId === targetFileSystemId && targetRootKey !== undefined && targetNormalOpenVerified) {
              return { fileSystemId: targetFileSystemId, openProfile: 'normal_read' };
            }
            throw new TypeError('native re-encrypt control lacks the required authenticated endpoint');
          })();
          return await validatePhaseSpecificPersistenceEndpointReadiness({
            control,
            openedAuthenticationEndpoint,
            port: endpointInspectionPort,
          });
        },
      };
      return await operation({
        port: createPersistenceControlTransitionPort({ bootstrapAuthorization: undefined, physical, proofAuthority, randomSource: undefined }),
      });
    };

    if (!includeTarget) return await run({ targetRootKey: undefined });
    if (!targetNormalOpenVerified) {
      throw new TypeError('native re-encrypt target has not passed every retained-credential normal-open proof');
    }
    return await targetProofScope.withRootKeyProof({
      fileSystemId: targetFileSystemId,
      operation: async ({ rootKey }) => await run({ targetRootKey: rootKey }),
    });
  };

  return {
    control: {
      publishState: async ({ state }) => {
        const authenticationFileSystemId = persistenceControlAuthenticationFileSystemId({ mode: state.mode });
        if (authenticationFileSystemId !== sourceFileSystemId && authenticationFileSystemId !== targetFileSystemId) {
          throw new TypeError('native re-encrypt publication authenticates an unrelated HizoFS endpoint');
        }
        await withPort({
          includeTarget: targetNormalOpenVerified || authenticationFileSystemId === targetFileSystemId,
          operation: async ({ port }) => await port.publishState({ state }),
        });
      },
      readState: async () => await withPort({
        includeTarget: targetNormalOpenVerified,
        operation: async ({ port }) => await port.readState(),
      }),
    },
    markTargetNormalOpenVerified(): void {
      targetNormalOpenVerified = true;
    },
  };
}

function progressNumber({ value }: { value: bigint }): number {
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);
}

function reportNativeReencryptProgress({ onProgress, result }: {
  onProgress: OpfsEncryptionTransitionProgressListener | undefined;
  result: Awaited<ReturnType<typeof advancePersistenceTransition>>;
}): void {
  if (onProgress === undefined) return;
  switch (result.state) {
  case 'copying':
    onProgress({ progress: {
      completedBytes: progressNumber({ value: result.cursor.completedBytes }),
      completedEntries: progressNumber({ value: result.cursor.completedEntries }),
      operation: 'reencrypting',
      percent: undefined,
      phase: 'copying',
      totalBytes: undefined,
      totalEntries: undefined,
    } });
    return;
  case 'verifying':
    onProgress({ progress: {
      completedBytes: progressNumber({ value: result.cursor.verifiedBytes }),
      completedEntries: progressNumber({ value: result.cursor.verifiedEntries }),
      operation: 'reencrypting',
      percent: undefined,
      phase: 'verifying',
      totalBytes: undefined,
      totalEntries: undefined,
    } });
    return;
  case 'authority_switched':
    onProgress({ progress: { completedBytes: 0, completedEntries: 0, operation: 'reencrypting', percent: undefined, phase: 'cleaning_source', totalBytes: undefined, totalEntries: undefined } });
    return;
  case 'retired_cleanup':
  case 'stable':
    onProgress({ progress: { completedBytes: 0, completedEntries: 0, operation: 'reencrypting', percent: 100, phase: 'finalizing', totalBytes: undefined, totalEntries: undefined } });
    return;
  default: return result satisfies never;
  }
}

function reportNativeEnableProgress({ onProgress, result }: {
  onProgress: OpfsEncryptionTransitionProgressListener | undefined;
  result: Awaited<ReturnType<typeof advancePersistenceTransition>>;
}): void {
  if (onProgress === undefined) return;
  switch (result.state) {
  case 'copying':
    onProgress({ progress: {
      completedBytes: progressNumber({ value: result.cursor.completedBytes }),
      completedEntries: progressNumber({ value: result.cursor.completedEntries }),
      operation: 'encrypting',
      percent: undefined,
      phase: 'copying',
      totalBytes: undefined,
      totalEntries: undefined,
    } });
    return;
  case 'verifying':
    onProgress({ progress: {
      completedBytes: progressNumber({ value: result.cursor.verifiedBytes }),
      completedEntries: progressNumber({ value: result.cursor.verifiedEntries }),
      operation: 'encrypting',
      percent: undefined,
      phase: 'verifying',
      totalBytes: undefined,
      totalEntries: undefined,
    } });
    return;
  case 'authority_switched':
    onProgress({ progress: { completedBytes: 0, completedEntries: 0, operation: 'encrypting', percent: undefined, phase: 'cleaning_source', totalBytes: undefined, totalEntries: undefined } });
    return;
  case 'retired_cleanup':
  case 'stable':
    onProgress({ progress: { completedBytes: 0, completedEntries: 0, operation: 'encrypting', percent: 100, phase: 'finalizing', totalBytes: undefined, totalEntries: undefined } });
    return;
  default: return result satisfies never;
  }
}

function reportNativeDisableProgress({ onProgress, result }: {
  onProgress: OpfsEncryptionTransitionProgressListener | undefined;
  result: Awaited<ReturnType<typeof advancePersistenceTransition>>;
}): void {
  if (onProgress === undefined) return;
  switch (result.state) {
  case 'copying':
    onProgress({ progress: {
      completedBytes: progressNumber({ value: result.cursor.completedBytes }),
      completedEntries: progressNumber({ value: result.cursor.completedEntries }),
      operation: 'decrypting',
      percent: undefined,
      phase: 'copying',
      totalBytes: undefined,
      totalEntries: undefined,
    } });
    return;
  case 'verifying':
    onProgress({ progress: {
      completedBytes: progressNumber({ value: result.cursor.verifiedBytes }),
      completedEntries: progressNumber({ value: result.cursor.verifiedEntries }),
      operation: 'decrypting',
      percent: undefined,
      phase: 'verifying',
      totalBytes: undefined,
      totalEntries: undefined,
    } });
    return;
  case 'authority_switched':
    onProgress({ progress: { completedBytes: 0, completedEntries: 0, operation: 'decrypting', percent: undefined, phase: 'switching_authority', totalBytes: undefined, totalEntries: undefined } });
    return;
  case 'retired_cleanup':
    onProgress({ progress: { completedBytes: 0, completedEntries: 0, operation: 'decrypting', percent: undefined, phase: 'cleaning_source', totalBytes: undefined, totalEntries: undefined } });
    return;
  case 'stable':
    onProgress({ progress: { completedBytes: 0, completedEntries: 0, operation: 'decrypting', percent: 100, phase: 'finalizing', totalBytes: undefined, totalEntries: undefined } });
    return;
  default: return result satisfies never;
  }
}

export type NativeHizoFSConvergenceResult =
  | { readonly type: 'credential_rejected' }
  | { readonly fileSystemId: FileSystemId; readonly type: 'converged_encrypted' }
  | { readonly type: 'converged_plain' };

type NativeHizoFSConvergenceAuthority =
  | Readonly<{
      binding: TransitionTargetOperationBinding;
      fileSystemId: FileSystemId;
      openProfile: CredentialCandidateOpenProfile;
      operation: 'encrypt';
    }>
  | Readonly<{
      binding: TransitionTargetOperationBinding;
      fileSystemId: FileSystemId;
      openProfile: CredentialCandidateOpenProfile;
      operation: 'decrypt';
      phase: 'building_target' | 'cleaning_up_source';
    }>
  | Readonly<{
      binding: TransitionTargetOperationBinding;
      fileSystemId: FileSystemId;
      openProfile: CredentialCandidateOpenProfile;
      operation: 're_encrypt';
      phase: 'building_target' | 'cleaning_up_source';
    }>;

function nativeEncryptTransitionBinding({ control }: {
  control: NaidanPersistenceControlV1;
}): TransitionTargetOperationBinding {
  const mode = control.mode;
  switch (mode.type) {
  case 'transitioning': break;
  case 'hizofs':
  case 'plain': throw new TypeError('native convergence requires an active Persistence Control transition');
  default: return mode satisfies never;
  }
  switch (mode.operation) {
  case 'encrypt': break;
  case 'decrypt': throw new TypeError('native enable convergence received an interrupted disable transition');
  case 're_encrypt': throw new TypeError('native enable convergence received an interrupted re-encrypt transition');
  default: return mode.operation satisfies never;
  }
  if (mode.phase.source.type !== 'plain' || mode.phase.target.type !== 'hizofs') {
    throw new TypeError('native enable convergence requires a plain source and HizoFS target');
  }
  return {
    operationId: mode.operationId,
    source: mode.phase.source,
    target: mode.phase.target,
  };
}

function nativeDecryptTransitionBinding({ control }: {
  control: NaidanPersistenceControlV1;
}): TransitionTargetOperationBinding {
  const mode = control.mode;
  switch (mode.type) {
  case 'transitioning': break;
  case 'hizofs':
  case 'plain': throw new TypeError('native convergence requires an active Persistence Control transition');
  default: return mode satisfies never;
  }
  switch (mode.operation) {
  case 'decrypt': break;
  case 'encrypt': throw new TypeError('native decrypt convergence received an interrupted enable transition');
  case 're_encrypt': throw new TypeError('native disable convergence received an interrupted re-encrypt transition');
  default: return mode.operation satisfies never;
  }
  if (mode.phase.source.type !== 'hizofs' || mode.phase.target.type !== 'plain') {
    throw new TypeError('native disable convergence requires a HizoFS source and plain target');
  }
  return {
    operationId: mode.operationId,
    source: mode.phase.source,
    target: mode.phase.target,
  };
}

function nativeReencryptTransitionBinding({ control }: {
  control: NaidanPersistenceControlV1;
}): TransitionTargetOperationBinding {
  const mode = control.mode;
  switch (mode.type) {
  case 'transitioning': break;
  case 'hizofs':
  case 'plain': throw new TypeError('native convergence requires an active Persistence Control transition');
  default: return mode satisfies never;
  }
  switch (mode.operation) {
  case 're_encrypt': break;
  case 'decrypt': throw new TypeError('native re-encrypt convergence received an interrupted disable transition');
  case 'encrypt': throw new TypeError('native re-encrypt convergence received an interrupted enable transition');
  default: return mode.operation satisfies never;
  }
  if (mode.phase.source.type !== 'hizofs'
    || mode.phase.target.type !== 'hizofs'
    || mode.phase.source.fileSystemId === mode.phase.target.fileSystemId) {
    throw new TypeError('native re-encrypt convergence requires distinct HizoFS source and target endpoints');
  }
  return {
    operationId: mode.operationId,
    source: mode.phase.source,
    target: mode.phase.target,
  };
}

function nativeConvergenceAuthority({ control, fileSystemId }: {
  control: NaidanPersistenceControlV1;
  fileSystemId: FileSystemId;
}): NativeHizoFSConvergenceAuthority {
  const mode = control.mode;
  switch (mode.type) {
  case 'transitioning': break;
  case 'hizofs':
  case 'plain': throw new TypeError('native convergence requires an active Persistence Control transition');
  default: return mode satisfies never;
  }
  const openProfile = credentialCandidateOpenProfile({ control });
  switch (mode.operation) {
  case 'encrypt': {
    const binding = nativeEncryptTransitionBinding({ control });
    switch (binding.target.type) {
    case 'hizofs':
      if (binding.target.fileSystemId !== fileSystemId) {
        throw new TypeError('credential proof belongs to another native enable target');
      }
      return { binding, fileSystemId, openProfile, operation: 'encrypt' };
    case 'plain': throw new TypeError('native enable convergence target is not HizoFS');
    default: return binding.target satisfies never;
    }
  }
  case 'decrypt': {
    const binding = nativeDecryptTransitionBinding({ control });
    switch (binding.source.type) {
    case 'hizofs':
      if (binding.source.fileSystemId !== fileSystemId) {
        throw new TypeError('credential proof belongs to another native disable source');
      }
      return { binding, fileSystemId, openProfile, operation: 'decrypt', phase: mode.phase.type };
    case 'plain': throw new TypeError('native disable convergence source is not HizoFS');
    default: return binding.source satisfies never;
    }
  }
  case 're_encrypt': {
    const binding = nativeReencryptTransitionBinding({ control });
    const authenticationEndpoint = (() => {
      switch (mode.phase.type) {
      case 'building_target': return binding.source;
      case 'cleaning_up_source': return binding.target;
      default: return mode.phase.type satisfies never;
      }
    })();
    switch (authenticationEndpoint.type) {
    case 'hizofs':
      if (authenticationEndpoint.fileSystemId !== fileSystemId) {
        throw new TypeError('credential proof belongs to another native re-encrypt authentication endpoint');
      }
      return { binding, fileSystemId, openProfile, operation: 're_encrypt', phase: mode.phase.type };
    case 'plain': throw new TypeError('native re-encrypt authentication endpoint is not HizoFS');
    default: return authenticationEndpoint satisfies never;
    }
  }
  default: return mode.operation satisfies never;
  }
}

function sameNativeDecryptTransition({ actual, binding }: {
  actual: TransitionSemanticState;
  binding: TransitionTargetOperationBinding;
}): boolean {
  const mode = actual.mode;
  return mode.type === 'transitioning'
    && mode.operation === 'decrypt'
    && mode.operationId === binding.operationId
    && sameTransitionEndpoint({ actual: mode.phase.source, expected: binding.source })
    && sameTransitionEndpoint({ actual: mode.phase.target, expected: binding.target });
}

function sameNativeEncryptTransition({ actual, binding }: {
  actual: TransitionSemanticState;
  binding: TransitionTargetOperationBinding;
}): boolean {
  const mode = actual.mode;
  return mode.type === 'transitioning'
    && mode.operation === 'encrypt'
    && mode.operationId === binding.operationId
    && sameTransitionEndpoint({ actual: mode.phase.source, expected: binding.source })
    && sameTransitionEndpoint({ actual: mode.phase.target, expected: binding.target });
}

/**
 * A transient credential authority must always be released, but a later
 * release failure must not erase the authority or validation failure that
 * explains why the operation was rejected.
 */
async function runWithCredentialAuthorityRelease<T>({ failureMessage, operation, releaseResources }: {
  failureMessage: string;
  operation: () => Promise<T>;
  releaseResources: () => Promise<void>;
}): Promise<T> {
  let operationFailure: unknown;
  let value: T | undefined;
  try {
    value = await operation();
  } catch (cause: unknown) {
    operationFailure = cause;
  }
  try {
    await releaseResources();
  } catch (releaseFailure: unknown) {
    if (operationFailure !== undefined) {
      throw new AggregateError([operationFailure, releaseFailure], failureMessage);
    }
    throw releaseFailure;
  }
  if (operationFailure !== undefined) throw operationFailure;
  return value as T;
}

function requireCurrentNativeConvergenceTransition({
  actual,
  authority,
  expectedPhase,
}: {
  actual: TransitionSemanticState;
  authority: NativeHizoFSConvergenceAuthority;
  expectedPhase: 'building_target' | 'cleaning_up_source';
}): void {
  const mode = actual.mode;
  if (mode.type !== 'transitioning'
    || mode.operation !== authority.operation
    || mode.operationId !== authority.binding.operationId
    || mode.phase.type !== expectedPhase
    || !sameTransitionEndpoint({ actual: mode.phase.source, expected: authority.binding.source })
    || !sameTransitionEndpoint({ actual: mode.phase.target, expected: authority.binding.target })) {
    throw new TypeError('Persistence Control transition changed after convergence credential proof');
  }
}

async function convergeNativePersistenceTransition({
  authority,
  control,
  expectedPhase,
  lockManager,
  nativeNamespaceRoot,
  signal,
}: {
  authority: NativeHizoFSConvergenceAuthority;
  control: TransitionControlPort;
  expectedPhase: 'building_target' | 'cleaning_up_source';
  lockManager: BrowserHizoFSRuntimeHostOptions['lockManager'];
  nativeNamespaceRoot: FileSystemDirectoryHandle;
  signal: AbortSignal | undefined;
}): Promise<TransitionConvergenceResult> {
  const runConvergence = async ({ plainTargetDisposition }: {
    plainTargetDisposition: 'preserve' | 'remove_before_source_recovery';
  }): Promise<TransitionConvergenceResult> => {
    requireCurrentNativeConvergenceTransition({
      actual: await control.readState(),
      authority,
      expectedPhase,
    });
    switch (plainTargetDisposition) {
    case 'preserve': break;
    case 'remove_before_source_recovery': {
      await cleanupNativePlainApplicationNamespaceWithReport({ nativeNamespaceRoot });
      if (!await isNativePlainApplicationNamespaceEmpty({ nativeNamespaceRoot })) {
        throw new TypeError('abandoned native plain transition target remained after cleanup');
      }
      requireCurrentNativeConvergenceTransition({
        actual: await control.readState(),
        authority,
        expectedPhase,
      });
      break;
    }
    default: plainTargetDisposition satisfies never;
    }
    return await convergeInterruptedPersistenceTransition({
      control,
      progressPort: undefined,
    });
  };

  switch (authority.operation) {
  case 'decrypt':
    switch (authority.phase) {
    case 'building_target':
      return await runWithExclusiveOpfsPlainNamespaceFence({
        lockManager,
        run: async () => await runConvergence({
          plainTargetDisposition: 'remove_before_source_recovery',
        }),
        signal,
      });
    case 'cleaning_up_source':
      return await runConvergence({ plainTargetDisposition: 'preserve' });
    default: return authority.phase satisfies never;
    }
  case 'encrypt':
    return await runConvergence({ plainTargetDisposition: 'preserve' });
  case 're_encrypt':
    return await runConvergence({ plainTargetDisposition: 'preserve' });
  default: return authority satisfies never;
  }
}

export async function runNativeHizoFSConvergeTransition({
  lockManager,
  nativeNamespaceRoot,
  passphrase,
  signal,
  storageRoot,
}: {
  lockManager: BrowserHizoFSRuntimeHostOptions['lockManager'];
  nativeNamespaceRoot: FileSystemDirectoryHandle;
  passphrase: string;
  signal: AbortSignal | undefined;
  storageRoot: FileSystemDirectoryHandle;
}): Promise<NativeHizoFSConvergenceResult> {
  const exclusiveGate = createBrowserNaidanPersistenceControlExclusiveGate({ lockManager });
  const physical = createOpfsPersistenceControlPhysicalPort({ exclusiveGate, storageRoot });
  const captured = await capturePersistenceControlAuthority({ physical });
  const opened = await openNativeCapturedCredentialRequiredPersistenceRuntime({
    captured,
    nativeNamespaceRoot,
    passphrase,
    physical,
  });
  switch (opened.type) {
  case 'credential_rejected': return opened;
  case 'opened': break;
  default: return opened satisfies never;
  }

  const selectedMode = opened.selected.control.mode;
  switch (selectedMode.type) {
  case 'plain':
  case 'hizofs':
    return await runWithCredentialAuthorityRelease({
      failureMessage: 'native convergence stable-state rejection and credential authority release both failed',
      operation: async () => {
        throw new TypeError('native convergence requires an active Persistence Control transition');
      },
      releaseResources: opened.releaseResources,
    });
  case 'transitioning': break;
  default: return selectedMode satisfies never;
  }
  const authority = nativeConvergenceAuthority({
    control: opened.selected.control,
    fileSystemId: opened.fileSystemId,
  });
  const expectedPhase = selectedMode.phase.type;
  await opened.releaseResources();

  const endpointInspectionPort = createNativePhaseSpecificEndpointInspectionPort({
    nativeNamespaceRoot,
    openContainer: openBrowserAuthenticatedReadOnlyContainerCapability,
    passphrase,
  });
  const proofScope = createNativeHizoFSRootKeyProofScope({
    fileSystemId: authority.fileSystemId,
    nativeNamespaceRoot,
    openProfile: authority.openProfile,
    passphrase,
  });
  const convergence = await proofScope.withRootKeyProof({
    fileSystemId: authority.fileSystemId,
    operation: async ({ rootKey }) => {
      const proofAuthority: PersistenceControlProofAuthority = {
        resolveRootKey: async ({ fileSystemId }) => fileSystemId === authority.fileSystemId
          ? { rootKey, state: 'resolved' }
          : { state: 'unresolved' },
        validateEndpointReadiness: async ({ control }) => {
          const authenticationFileSystemId = persistenceControlAuthenticationFileSystemId({ mode: control.mode });
          if (authenticationFileSystemId !== undefined
            && authenticationFileSystemId !== authority.fileSystemId) {
            throw new TypeError('Persistence Control convergence selected another authentication endpoint');
          }
          switch (control.mode.type) {
          case 'plain':
            return await validatePhaseSpecificPersistenceEndpointReadiness({
              control,
              openedAuthenticationEndpoint: {
                fileSystemId: authority.fileSystemId,
                openProfile: authority.openProfile,
              },
              port: endpointInspectionPort,
            });
          case 'hizofs':
          case 'transitioning': break;
          default: return control.mode satisfies never;
          }
          const requiredOpenProfile = credentialCandidateOpenProfileFromMode({ mode: control.mode });
          const projectedOpenProfile: CredentialCandidateOpenProfile = authority.openProfile === requiredOpenProfile
            ? requiredOpenProfile
            : authority.openProfile === 'normal_read' && requiredOpenProfile === 'root_key_proof'
              ? 'root_key_proof'
              : (() => {
                throw new TypeError('opened convergence proof is weaker than the Persistence Control candidate requires');
              })();
          return await validatePhaseSpecificPersistenceEndpointReadiness({
            control,
            openedAuthenticationEndpoint: {
              fileSystemId: authority.fileSystemId,
              openProfile: projectedOpenProfile,
            },
            port: endpointInspectionPort,
          });
        },
      };
      const control = createPersistenceControlTransitionPort({
        bootstrapAuthorization: undefined,
        physical,
        proofAuthority,
        randomSource: undefined,
      });
      return await convergeNativePersistenceTransition({
        authority,
        control,
        expectedPhase,
        lockManager,
        nativeNamespaceRoot,
        signal,
      });
    },
  });
  await cleanupRetiredLocalTransitionProgress({ exclusiveGate, storageRoot });

  switch (convergence.stableState.mode.type) {
  case 'plain': return { type: 'converged_plain' };
  case 'hizofs': return {
    fileSystemId: convergence.stableState.mode.activeFileSystemId,
    type: 'converged_encrypted',
  };
  case 'transitioning': throw new TypeError('native convergence returned a transitioning authority');
  default: return convergence.stableState.mode satisfies never;
  }
}

type NativeHizoFSDisableTransitionSession = Readonly<{
  fileSystemId: FileSystemId;
  fileSystemSession: StorageFileSystemSession;
  close(): Promise<void>;
}>;

type NativeHizoFSDisableTransitionOptions = Readonly<{
  lockManager: Pick<LockManager, 'request'>;
  nativeNamespaceRoot: FileSystemDirectoryHandle;
  onProgress: OpfsEncryptionTransitionProgressListener | undefined;
  session: NativeHizoFSDisableTransitionSession;
  signal: AbortSignal | undefined;
  storageRoot: FileSystemDirectoryHandle;
}>;

export async function runNativeHizoFSDisableTransition({
  lockManager,
  nativeNamespaceRoot,
  onProgress,
  session,
  signal,
  storageRoot,
}: NativeHizoFSDisableTransitionOptions): Promise<void> {
  return await runWithExclusiveOpfsPlainNamespaceFence({
    lockManager,
    run: async () => await runNativeHizoFSDisableTransitionWithPlainNamespaceFence({
      lockManager,
      nativeNamespaceRoot,
      onProgress,
      session,
      signal,
      storageRoot,
    }),
    signal,
  });
}

async function runNativeHizoFSDisableTransitionWithPlainNamespaceFence({
  lockManager,
  nativeNamespaceRoot,
  onProgress,
  session,
  signal,
  storageRoot,
}: NativeHizoFSDisableTransitionOptions): Promise<void> {
  const exclusiveGate = createBrowserNaidanPersistenceControlExclusiveGate({ lockManager });
  const operationId: TransitionOperationId = parseTransitionOperationId({ value: nanoid() });
  const fileSystemId = session.fileSystemId;
  const binding: TransitionTargetOperationBinding = {
    operationId,
    source: { fileSystemId, type: 'hizofs' },
    target: { type: 'plain' },
  };
  const sourceAuthorityIdentity = nativeDisableSourceAuthorityIdentity({ fileSystemId });
  let closeSessionAfterFailure = false;
  let transitionRuntime: NativePlainTransitionRuntimeState | undefined;
  let trialStage: NativeDisableTrialStage = 'authenticate_source';
  reportHizoFSTrialDebug({
    detail: { event: 'native_disable', fileSystemId, operationId, stage: 'started' },
    level: 'info',
  });

  const transitionAttempt = await withAuthenticatedDevelopmentWritableSessionRootKeyProof({
    operation: async ({ fileSystemId: provenFileSystemId, rootKeyProof }) => {
      if (provenFileSystemId !== fileSystemId) {
        throw new TypeError('native disable session proof belongs to another File System ID');
      }
      const endpointInspectionPort: PhaseSpecificEndpointInspectionPort = {
        inspectHizoFSEndpoint: async ({ fileSystemId: requestedFileSystemId, openProfile }) => {
          if (requestedFileSystemId !== fileSystemId) return 'absent';
          switch (openProfile) {
          case 'normal_read': return 'fully_verified';
          case 'root_key_proof': return 'root_key_ready';
          default: return openProfile satisfies never;
          }
        },
        inspectPlainEndpoint: async () => await inspectNativePlainEndpoint({ nativeNamespaceRoot }),
      };
      const proofAuthority: PersistenceControlProofAuthority = {
        resolveRootKey: async ({ fileSystemId: requestedFileSystemId }) => requestedFileSystemId === fileSystemId
          ? { rootKey: rootKeyProof, state: 'resolved' }
          : { state: 'unresolved' },
        validateEndpointReadiness: async ({ control }) => {
          const authenticationFileSystemId = persistenceControlAuthenticationFileSystemId({ mode: control.mode });
          const openProfile: PersistenceEndpointOpenProfile = authenticationFileSystemId === fileSystemId
            ? credentialCandidateOpenProfileFromMode({ mode: control.mode })
            : 'normal_read';
          return await validatePhaseSpecificPersistenceEndpointReadiness({
            control,
            openedAuthenticationEndpoint: { fileSystemId, openProfile },
            port: endpointInspectionPort,
          });
        },
      };
      const baseControl = createPersistenceControlTransitionPort({
        bootstrapAuthorization: undefined,
        physical: createOpfsPersistenceControlPhysicalPort({ exclusiveGate, storageRoot }),
        proofAuthority,
        randomSource: undefined,
      });
      const sourceDriver = createNativeHizoFSDisableSourceDriver({
        binding,
        exclusiveGate,
        nativeNamespaceRoot,
        session: session.fileSystemSession,
      });
      const control: TransitionControlPort = {
        publishState: async ({ state }) => {
          await baseControl.publishState({ state });
          if (state.mode.type === 'transitioning'
            && state.mode.operation === 'decrypt'
            && state.mode.phase.type === 'cleaning_up_source') {
            sourceDriver.markAuthoritySwitched();
          }
        },
        readState: async () => await baseControl.readState(),
      };
      trialStage = 'start_persistence_transition';
      try {
        await startPersistenceTransition({ control, operationId, source: binding.source, target: binding.target });
        closeSessionAfterFailure = true;
        reportHizoFSTrialDebug({
          detail: { event: 'native_disable', fileSystemId, operationId, stage: 'persistence_transition_started' },
          level: 'info',
        });
      } catch (cause: unknown) {
        try {
          const authenticated = await baseControl.readState();
          closeSessionAfterFailure = !nativeHizoFSDisableSourceRemainsAuthoritativeAfterStartFailure({
            actual: authenticated,
            binding,
          });
        } catch (resolutionCause: unknown) {
          closeSessionAfterFailure = true;
          throw new AggregateError(
            [cause, resolutionCause],
            'native disable transition start failed and source authority could not be resolved',
          );
        }
        throw cause;
      }
      trialStage = 'prepare_transition_runtime';
      const runtimeBinding = {
        operationId,
        sourceAuthorityIdentity,
        sourceEndpoint: binding.source,
        targetAuthorityIdentity: NATIVE_PLAIN_DISABLE_AUTHORITY_IDENTITY,
        targetEndpoint: binding.target,
      } as const;
      const runtime = new NativePlainTransitionRuntimeState({ binding: runtimeBinding });
      transitionRuntime = runtime;
      const provider = new TransitionProviderAdapter({
        hizofs: sourceDriver.driver,
        plain: createNativePlainDisableTransitionDriver({
          binding,
          nativeNamespaceRoot,
          runtime,
          verificationPageSize: NATIVE_ENABLE_TRANSITION_POLICY.verification.maximumDirectoryEntriesPerRead,
        }),
      });
      reportHizoFSTrialDebug({
        detail: { event: 'native_disable', fileSystemId, operationId, stage: 'runtime_prepared' },
        level: 'info',
      });
      trialStage = 'advance_transition';
      let lastReportedState: TransitionAdvanceResult['state'] | undefined;
      for (;;) {
        signal?.throwIfAborted();
        const result = await advancePersistenceTransition({
          control,
          policy: NATIVE_ENABLE_TRANSITION_POLICY,
          progressPort: runtime.progressPort,
          provider,
          signal,
        });
        reportNativeDisableProgress({ onProgress, result });
        if (result.state !== lastReportedState) {
          lastReportedState = result.state;
          reportHizoFSTrialDebug({
            detail: { event: 'native_disable', fileSystemId, operationId, stage: result.state },
            level: 'info',
          });
        }
        switch (result.state) {
        case 'retired_cleanup': {
          const stable = await control.readState();
          switch (stable.mode.type) {
          case 'plain': break;
          case 'hizofs':
          case 'transitioning': throw new TypeError('native disable did not publish stable plain authority');
          default: stable.mode satisfies never;
          }
          const plainReadiness = await inspectNativePlainEndpoint({ nativeNamespaceRoot });
          switch (plainReadiness) {
          case 'fully_verified': break;
          case 'invalid': throw new TypeError('native disable stable plain authority failed normal traversal');
          default: plainReadiness satisfies never;
          }
          await runtime.progressPort.clear({ operationId });
          await cleanupRetiredLocalTransitionProgress({ exclusiveGate, storageRoot });
          reportHizoFSTrialDebug({
            detail: { event: 'native_disable', fileSystemId, operationId, stage: 'stable' },
            level: 'info',
          });
          return;
        }
        case 'authority_switched':
        case 'copying':
        case 'verifying': break;
        case 'stable': throw new TypeError('native disable reached stable state before retiring its HizoFS source');
        default: return result satisfies never;
        }
      }
    },
    session: session.fileSystemSession,
  }).then(
    () => ({ type: 'completed' }) as const,
    (cause: unknown) => ({ cause, type: 'failed' }) as const,
  );
  switch (transitionAttempt.type) {
  case 'completed': break;
  case 'failed': {
    let transitionFailure = transitionAttempt.cause;
    try {
      await transitionRuntime?.abandonTarget({ operationId });
    } catch (markerCleanupCause: unknown) {
      transitionFailure = new AggregateError(
        [transitionFailure, markerCleanupCause],
        'native disable transition and runtime ownership-marker cleanup both failed',
      );
    }
    if (!closeSessionAfterFailure) {
      reportHizoFSTrialFailure({
        cause: transitionFailure,
        detail: { event: 'native_disable_failure', fileSystemId, operationId, stage: trialStage },
      });
      throw transitionFailure;
    }
    const transitionFailureStage = trialStage;
    try {
      trialStage = 'settle_source_session';
      await session.close();
    } catch (closeCause: unknown) {
      const failure = new AggregateError(
        [transitionFailure, closeCause],
        'native disable transition failed after authority may have changed and source-session cleanup also failed',
      );
      reportHizoFSTrialFailure({
        cause: failure,
        detail: { event: 'native_disable_failure', fileSystemId, operationId, stage: trialStage },
      });
      throw failure;
    }
    reportHizoFSTrialFailure({
      cause: transitionFailure,
      detail: { event: 'native_disable_failure', fileSystemId, operationId, stage: transitionFailureStage },
    });
    throw transitionFailure;
  }
  default: transitionAttempt satisfies never;
  }

  trialStage = 'settle_source_session';
  try {
    await session.close();
  } catch (cause: unknown) {
    reportHizoFSTrialFailure({
      cause,
      detail: { event: 'native_disable_failure', fileSystemId, operationId, stage: trialStage },
    });
    throw cause;
  }
  // WHY: source deletion is not part of the user-visible authority switch.
  // The stable plain control record retains the source File System ID so
  // detached maintenance can retry cleanup without blocking Naidan.
  return;
}

export type NativeHizoFSReturnToPlainTransitionResult =
  | { readonly type: 'credential_rejected' }
  | { readonly type: 'returned_plain' };

type OpenedNativeReturnToPlainSession = Readonly<{
  authoritativeEndpoint: NaidanPersistenceEndpointV1;
  fileSystemId: FileSystemId;
  fileSystemSession: StorageFileSystemSession;
}>;

async function completeNativeHizoFSReturnToPlainWith({
  convergedFileSystemId,
  opened,
  runDisable,
}: {
  convergedFileSystemId: FileSystemId;
  opened: OpenedNativeReturnToPlainSession;
  runDisable: ({ session }: { session: NativeHizoFSDisableTransitionSession }) => Promise<void>;
}): Promise<void> {
  if (opened.fileSystemId !== convergedFileSystemId
    || !sameTransitionEndpoint({
      actual: opened.authoritativeEndpoint,
      expected: { fileSystemId: convergedFileSystemId, type: 'hizofs' },
    })) {
    const cause = new TypeError('return-to-plain reopened a different encrypted authority');
    try {
      await opened.fileSystemSession.close();
    } catch (closeCause: unknown) {
      throw new AggregateError([cause, closeCause], 'return-to-plain authority rejection and encrypted-session cleanup both failed');
    }
    throw cause;
  }
  let closed = false;
  const transientSession: NativeHizoFSDisableTransitionSession = {
    fileSystemId: opened.fileSystemId,
    fileSystemSession: opened.fileSystemSession,
    async close() {
      if (closed) return;
      closed = true;
      await opened.fileSystemSession.close();
    },
  };
  try {
    await runDisable({ session: transientSession });
  } catch (cause: unknown) {
    try {
      await transientSession.close();
    } catch (closeCause: unknown) {
      throw new AggregateError([cause, closeCause], 'return-to-plain transition and encrypted-session cleanup both failed');
    }
    throw cause;
  }
}

export async function runNativeHizoFSReturnToPlainTransition({
  lockManager,
  nativeNamespaceRoot,
  onProgress,
  passphrase,
  runtimePolicy,
  signal,
  storageRoot,
}: {
  lockManager: BrowserHizoFSRuntimeHostOptions['lockManager'];
  nativeNamespaceRoot: FileSystemDirectoryHandle;
  onProgress: OpfsEncryptionTransitionProgressListener | undefined;
  passphrase: string;
  runtimePolicy: BrowserHizoFSRuntimeHostOptions['policy'];
  signal: AbortSignal | undefined;
  storageRoot: FileSystemDirectoryHandle;
}): Promise<NativeHizoFSReturnToPlainTransitionResult> {
  signal?.throwIfAborted();
  const converged = await runNativeHizoFSConvergeTransition({
    lockManager,
    nativeNamespaceRoot,
    passphrase,
    signal,
    storageRoot,
  });
  switch (converged.type) {
  case 'credential_rejected': return converged;
  case 'converged_plain': return { type: 'returned_plain' };
  case 'converged_encrypted': break;
  default: return converged satisfies never;
  }

  const exclusiveGate = createBrowserNaidanPersistenceControlExclusiveGate({ lockManager });
  const physical = createOpfsPersistenceControlPhysicalPort({ exclusiveGate, storageRoot });
  const captured = await capturePersistenceControlAuthority({ physical });
  const opened = await openNativeCredentialRequiredApplicationSession({
    captured,
    lockManager,
    nativeNamespaceRoot,
    passphrase,
    physical,
    runtimePolicy,
  });
  switch (opened.type) {
  case 'credential_rejected': return opened;
  case 'opened': break;
  default: return opened satisfies never;
  }
  await completeNativeHizoFSReturnToPlainWith({
    convergedFileSystemId: converged.fileSystemId,
    opened,
    runDisable: async ({ session }) => {
      const cleanup = await runNativeStableHizoFSRetiredPlainCleanup({
        lockManager,
        nativeNamespaceRoot,
        session,
        storageRoot,
      });
      switch (cleanup.state) {
      case 'completed':
        if (cleanup.remainingEntryCount !== 0) {
          throw new TypeError('return-to-plain could not clear the retired plain source');
        }
        break;
      case 'plain_namespace_in_use':
        throw new TypeError('return-to-plain plain target remains leased by another runtime');
      default: cleanup satisfies never;
      }
      await runNativeHizoFSDisableTransition({
        lockManager,
        nativeNamespaceRoot,
        onProgress,
        session,
        signal,
        storageRoot,
      });
    },
  });
  return { type: 'returned_plain' };
}


type NativeRetainedPassphraseCredentialProof = Parameters<
  typeof withAuthenticatedDevelopmentWritableSessionRetainedCredentials
>[0]['retainedCredentials'][number];

function normalizeNativeRetainedCredentials({ retainedCredentials }: {
  retainedCredentials: readonly OpfsPersistenceRetainedCredential[];
}): readonly NativeRetainedPassphraseCredentialProof[] {
  return retainedCredentials.map(({ passphrase, sourceSlotId, ...unhandledCredential }) => {
    unhandledCredential satisfies Record<PropertyKey, never>;
    return sourceSlotId === undefined
      ? { passphrase }
      : {
        passphrase,
        sourceSlotId: sourceSlotId as NativeRetainedPassphraseCredentialProof['sourceSlotId'],
      };
  });
}


type NativeHizoFSReencryptBuildingStart = Readonly<{
  onStarted(): void;
  removeUnreferencedTarget(): Promise<void>;
}>;

function nativeHizoFSReencryptBindingFileSystemIds({ binding }: {
  binding: TransitionTargetOperationBinding;
}): Readonly<{ sourceFileSystemId: FileSystemId; targetFileSystemId: FileSystemId }> {
  const sourceFileSystemId = (() => {
    switch (binding.source.type) {
    case 'hizofs': return binding.source.fileSystemId;
    case 'plain': throw new TypeError('native re-encrypt source binding must be HizoFS');
    default: return binding.source satisfies never;
    }
  })();
  const targetFileSystemId = (() => {
    switch (binding.target.type) {
    case 'hizofs': return binding.target.fileSystemId;
    case 'plain': throw new TypeError('native re-encrypt target binding must be HizoFS');
    default: return binding.target satisfies never;
    }
  })();
  if (sourceFileSystemId === targetFileSystemId) {
    throw new TypeError('native re-encrypt source and target File System IDs must be distinct');
  }
  return { sourceFileSystemId, targetFileSystemId };
}

async function advanceNativeHizoFSReencryptBuildingTransition({
  binding,
  exclusiveGate,
  nativeNamespaceRoot,
  onProgress,
  passphrases,
  physical,
  sourceRootKeyProof,
  sourceSession,
  start,
  signal,
}: {
  binding: TransitionTargetOperationBinding;
  exclusiveGate: NaidanPersistenceControlExclusiveGate;
  nativeNamespaceRoot: FileSystemDirectoryHandle;
  onProgress: OpfsEncryptionTransitionProgressListener | undefined;
  passphrases: readonly string[];
  physical: PersistenceControlPhysicalPort;
  sourceRootKeyProof: PersistenceControlRootKeyDerivationCapability;
  sourceSession: StorageFileSystemSession;
  start: NativeHizoFSReencryptBuildingStart;
  signal: AbortSignal | undefined;
}): Promise<void> {
  const operationPassphrase = passphrases[0];
  if (operationPassphrase === undefined) {
    throw new RangeError('native re-encrypt building coordinator requires at least one retained credential');
  }
  const { sourceFileSystemId, targetFileSystemId } = nativeHizoFSReencryptBindingFileSystemIds({ binding });
  const sourceDriver = createNativeHizoFSReencryptSourceDriver({
    binding,
    exclusiveGate,
    nativeNamespaceRoot,
    session: sourceSession,
  });
  const targetProofScopeForProfile = ({ openProfile }: {
    openProfile: CredentialCandidateOpenProfile;
  }): NativeHizoFSRootKeyProofScope => createNativeHizoFSRootKeyProofScope({
    fileSystemId: targetFileSystemId,
    nativeNamespaceRoot,
    openProfile,
    passphrase: operationPassphrase,
  });
  const endpointInspectionPort = createNativePhaseSpecificEndpointInspectionPort({
    nativeNamespaceRoot,
    openContainer: openBrowserAuthenticatedReadOnlyContainerCapability,
    passphrase: operationPassphrase,
  });
  const reencryptControl = createNativeHizoFSReencryptControl({
    endpointInspectionPort,
    physical,
    sourceFileSystemId,
    sourceRootKeyProof,
    targetFileSystemId,
    targetProofScope: targetProofScopeForProfile({ openProfile: 'normal_read' }),
  });
  const control: TransitionControlPort = {
    publishState: async ({ state }) => {
      await reencryptControl.control.publishState({ state });
      if (state.mode.type === 'transitioning'
        && state.mode.operation === 're_encrypt'
        && state.mode.phase.type === 'cleaning_up_source') {
        sourceDriver.markAuthoritySwitched();
      }
    },
    readState: async () => await reencryptControl.control.readState(),
  };

  let transitionStarted = false;
  try {
    await startPersistenceTransition({
      control,
      operationId: binding.operationId,
      source: binding.source,
      target: binding.target,
    });
    transitionStarted = true;
    start.onStarted();

    const sourceAuthorityIdentity = nativeReencryptSourceAuthorityIdentity({ fileSystemId: sourceFileSystemId });
    const targetAuthorityIdentity = nativeReencryptTargetAuthorityIdentity({ fileSystemId: targetFileSystemId });
    const runtimeBinding = {
      operationId: binding.operationId,
      sourceAuthorityIdentity,
      sourceEndpoint: binding.source,
      targetAuthorityIdentity,
      targetEndpoint: binding.target,
    } as const;
    const runtimeState = new RuntimeHizoFSTransitionImportState({
      binding: runtimeBinding,
    });
    const recheckPublicationAllowed = async (): Promise<void> => {
      const state = await control.readState();
      if (!sameNativeReencryptTransition({ actual: state, binding })) {
        throw new TypeError('Persistence Control no longer authorizes the native re-encrypt target publication');
      }
    };
    const targetDriver = createNativeHizoFSEnableTransitionDriverWith({
      authorityIdentity: targetAuthorityIdentity,
      binding,
      exclusiveGate,
      initialOpenProfile: 'root_key_proof',
      importStatePort: runtimeState.importStatePort,
      inspectTarget: async ({ openProfile }) => await inspectNativeHizoFSEndpoint({
        fileSystemId: targetFileSystemId,
        nativeNamespaceRoot,
        openProfile,
        passphrase: operationPassphrase,
      }),
      limits: NATIVE_ENABLE_TARGET_IMPORT_LIMITS,
      normalOpenVerificationPassphrases: passphrases,
      operationPassphrase,
      recheckPublicationAllowed,
      runtime: browserNativeHizoFSEnableTransitionDriverRuntime,
      storageRoot: nativeNamespaceRoot,
      verifyProofAuthority: async ({ fileSystemId: openedFileSystemId }) => {
        if (openedFileSystemId !== targetFileSystemId) {
          throw new TypeError('native re-encrypt target opened with another File System ID');
        }
      },
    });
    const provider = new TransitionProviderAdapter({
      hizofs: createNativeHizoFSReencryptTransitionDriver({
        binding,
        markTargetNormalOpenVerified: reencryptControl.markTargetNormalOpenVerified,
        source: sourceDriver.driver,
        target: targetDriver,
      }),
      plain: createNativePlainEnableTransitionDriver({ nativeNamespaceRoot }),
    });

    for (;;) {
      signal?.throwIfAborted();
      const result = await advancePersistenceTransition({
        control,
        policy: NATIVE_ENABLE_TRANSITION_POLICY,
        progressPort: runtimeState.progressPort,
        provider,
        signal,
      });
      reportNativeReencryptProgress({ onProgress, result });
      switch (result.state) {
      case 'retired_cleanup': return;
      case 'authority_switched':
      case 'copying':
      case 'verifying': break;
      case 'stable': throw new TypeError('native re-encrypt reached stable state before retiring its HizoFS source');
      default: return result satisfies never;
      }
    }
  } catch (cause: unknown) {
    if (!transitionStarted) {
      try {
        await settleNativeHizoFSReencryptTargetAfterStartFailure({
          binding,
          control,
          removeTarget: start.removeUnreferencedTarget,
          targetFileSystemId,
        });
      } catch (cleanupCause: unknown) {
        throw new AggregateError(
          [cause, cleanupCause],
          'native re-encrypt transition start failed and exact target cleanup ownership could not be resolved',
        );
      }
    }
    throw cause;
  }
}

export async function runNativeHizoFSReencryptTransition({
  lockManager,
  nativeNamespaceRoot,
  onProgress,
  retainedCredentials,
  session,
  signal,
  storageRoot,
}: {
  lockManager: Pick<LockManager, 'request'>;
  nativeNamespaceRoot: FileSystemDirectoryHandle;
  onProgress: OpfsEncryptionTransitionProgressListener | undefined;
  retainedCredentials: readonly OpfsPersistenceRetainedCredential[];
  session: Readonly<{
    fileSystemId: FileSystemId;
    fileSystemSession: StorageFileSystemSession;
    close(): Promise<void>;
  }>;
  signal: AbortSignal | undefined;
  storageRoot: FileSystemDirectoryHandle;
}): Promise<FileSystemId> {
  if (retainedCredentials.length < 1) {
    throw new RangeError('native re-encrypt requires at least one retained credential');
  }
  const exclusiveGate = createBrowserNaidanPersistenceControlExclusiveGate({ lockManager });
  const physical = createOpfsPersistenceControlPhysicalPort({ exclusiveGate, storageRoot });
  const captured = await capturePersistenceControlAuthority({ physical });
  const sourceFileSystemId = session.fileSystemId;
  let closeSessionAfterFailure = false;

  const transitionAttempt = await withAuthenticatedDevelopmentWritableSessionRetainedCredentials({
    operation: async ({ fileSystemId: provenFileSystemId, retainedCredentials: provenCredentials, rootKeyProof }) => {
      if (provenFileSystemId !== sourceFileSystemId) {
        throw new TypeError('native re-encrypt credential proof belongs to another File System ID');
      }
      const passphrases = provenCredentials.map(({ passphrase }) => passphrase);
      const operationPassphrase = passphrases[0];
      if (operationPassphrase === undefined) {
        throw new RangeError('native re-encrypt credential proof returned an empty credential set');
      }
      const targetFileSystemId = await createNativeHizoFSTransitionTargetWith({
        exclusiveGate,
        passphrases,
        runtime: browserNativeHizoFSTransitionTargetCreationPort,
        storageRoot: nativeNamespaceRoot,
      });
      const operationId: TransitionOperationId = parseTransitionOperationId({ value: nanoid() });
      const binding: TransitionTargetOperationBinding = {
        operationId,
        source: { fileSystemId: sourceFileSystemId, type: 'hizofs' },
        target: { fileSystemId: targetFileSystemId, type: 'hizofs' },
      };
      await advanceNativeHizoFSReencryptBuildingTransition({
        binding,
        exclusiveGate,
        nativeNamespaceRoot,
        onProgress,
        passphrases,
        physical,
        sourceRootKeyProof: rootKeyProof,
        sourceSession: session.fileSystemSession,
        start: {
          onStarted(): void {
            closeSessionAfterFailure = true;
          },
          removeUnreferencedTarget: async () => await removeNaidanOpfsContainerDirectory({
            exclusiveGate,
            fileSystemId: targetFileSystemId,
            storageRoot: nativeNamespaceRoot,
          }),
        },
        signal,
      });
      return { binding, operationPassphrase, targetFileSystemId };
    },
    recheckAuthority: async () => await recheckPersistenceControlAuthority({ captured, physical }),
    retainedCredentials: normalizeNativeRetainedCredentials({ retainedCredentials }),
    session: session.fileSystemSession,
  }).then(
    value => ({ type: 'completed', value }) as const,
    (cause: unknown) => ({ cause, type: 'failed' }) as const,
  );

  switch (transitionAttempt.type) {
  case 'failed':
    if (!closeSessionAfterFailure) throw transitionAttempt.cause;
    try {
      await session.close();
    } catch (closeCause: unknown) {
      throw new AggregateError(
        [transitionAttempt.cause, closeCause],
        'native re-encrypt failed after authority may have changed and source-session cleanup also failed',
      );
    }
    throw transitionAttempt.cause;
  case 'completed': break;
  default: return transitionAttempt satisfies never;
  }

  const { targetFileSystemId } = transitionAttempt.value;
  await session.close();
  await cleanupRetiredLocalTransitionProgress({ exclusiveGate, storageRoot });
  return targetFileSystemId;
}

export async function runNativeHizoFSEnableTransition({
  lockManager,
  nativeNamespaceRoot,
  onProgress,
  passphrase,
  signal,
  storageRoot,
}: {
  lockManager: Pick<LockManager, 'request'>;
  nativeNamespaceRoot: FileSystemDirectoryHandle;
  onProgress: OpfsEncryptionTransitionProgressListener | undefined;
  passphrase: string;
  signal: AbortSignal | undefined;
  storageRoot: FileSystemDirectoryHandle;
}): Promise<FileSystemId> {
  const plainReadiness = await inspectNativePlainEndpoint({ nativeNamespaceRoot });
  switch (plainReadiness) {
  case 'fully_verified': break;
  case 'invalid': throw new TypeError('native enable transition requires a verified plain source');
  default: return plainReadiness satisfies never;
  }
  const exclusiveGate = createBrowserNaidanPersistenceControlExclusiveGate({ lockManager });
  const fileSystemId = await createNativeHizoFSEnableTransitionTarget({
    exclusiveGate,
    passphrase,
    storageRoot: nativeNamespaceRoot,
  });
  const operationId: TransitionOperationId = parseTransitionOperationId({ value: nanoid() });
  const binding: TransitionTargetOperationBinding = {
    operationId,
    source: { type: 'plain' },
    target: { fileSystemId, type: 'hizofs' },
  };
  reportHizoFSTrialDebug({
    detail: { event: 'native_enable', fileSystemId, operationId, stage: 'target_created' },
    level: 'info',
  });
  const targetAuthorityIdentity = nativeEnableTargetAuthorityIdentity({ fileSystemId });
  const proofScopeForProfile = ({ openProfile }: {
    openProfile: CredentialCandidateOpenProfile;
  }): NativeHizoFSRootKeyProofScope => createNativeHizoFSRootKeyProofScope({
    fileSystemId,
    nativeNamespaceRoot,
    openProfile,
    passphrase,
  });
  const endpointInspectionPort = createNativePhaseSpecificEndpointInspectionPort({
    nativeNamespaceRoot,
    openContainer: openBrowserAuthenticatedReadOnlyContainerCapability,
    passphrase,
  });
  const control = createCallbackScopedPersistenceControlTransitionPort({
    bootstrapAuthorization: 'verified_plain_namespace',
    endpointInspectionPort,
    fileSystemId,
    initialOpenProfile: 'root_key_proof',
    physical: createOpfsPersistenceControlPhysicalPort({ exclusiveGate, storageRoot }),
    proofScopeForProfile,
  });
  let transitionStarted = false;
  let trialStage: NativeEnableTrialStage = 'start_persistence_transition';
  try {
    await startPersistenceTransition({ control, operationId, source: binding.source, target: binding.target });
    transitionStarted = true;
    reportHizoFSTrialDebug({
      detail: { event: 'native_enable', fileSystemId, operationId, stage: 'persistence_transition_started' },
      level: 'info',
    });
    trialStage = 'prepare_transition_runtime';
    const runtimeBinding = {
      operationId,
      sourceAuthorityIdentity: NATIVE_PLAIN_ENABLE_AUTHORITY_IDENTITY,
      sourceEndpoint: binding.source,
      targetAuthorityIdentity,
      targetEndpoint: binding.target,
    } as const;
    const runtimeState = new RuntimeHizoFSTransitionImportState({
      binding: runtimeBinding,
    });
    const recheckPublicationAllowed = async (): Promise<void> => {
      const state = await control.readState();
      if (!sameSemanticTransitionState({ actual: state, binding })) {
        throw new TypeError('Persistence Control no longer authorizes the native enable target publication');
      }
    };
    const provider = new TransitionProviderAdapter({
      hizofs: createNativeHizoFSEnableTransitionDriver({
        authorityIdentity: targetAuthorityIdentity,
        binding,
        exclusiveGate,
        initialOpenProfile: 'root_key_proof',
        importStatePort: runtimeState.importStatePort,
        inspectTarget: async ({ openProfile }) => await inspectNativeHizoFSEndpoint({
          fileSystemId,
          nativeNamespaceRoot,
          openProfile,
          passphrase,
        }),
        limits: NATIVE_ENABLE_TARGET_IMPORT_LIMITS,
        passphrase,
        recheckPublicationAllowed,
        storageRoot: nativeNamespaceRoot,
        verifyProofAuthority: async ({ fileSystemId: openedFileSystemId }) => {
          if (openedFileSystemId !== fileSystemId) throw new TypeError('native enable target opened with another File System ID');
        },
      }),
      plain: createNativePlainEnableTransitionDriver({ nativeNamespaceRoot }),
    });
    reportHizoFSTrialDebug({
      detail: { event: 'native_enable', fileSystemId, operationId, stage: 'runtime_prepared' },
      level: 'info',
    });
    trialStage = 'advance_transition';
    let lastReportedState: TransitionAdvanceResult['state'] | undefined;
    for (;;) {
      signal?.throwIfAborted();
      const result = await advancePersistenceTransition({
        control,
        policy: NATIVE_ENABLE_TRANSITION_POLICY,
        progressPort: runtimeState.progressPort,
        provider,
        signal,
      });
      reportNativeEnableProgress({ onProgress, result });
      if (result.state !== lastReportedState) {
        lastReportedState = result.state;
        reportHizoFSTrialDebug({
          detail: { event: 'native_enable', fileSystemId, operationId, stage: result.state },
          level: 'info',
        });
      }
      switch (result.state) {
      case 'stable': {
        await cleanupRetiredLocalTransitionProgress({ exclusiveGate, storageRoot });
        return fileSystemId;
      }
      case 'authority_switched':
      case 'copying':
      case 'retired_cleanup':
      case 'verifying': break;
      default: return result satisfies never;
      }
    }
  } catch (cause: unknown) {
    reportHizoFSTrialFailure({
      cause,
      detail: { event: 'native_enable_failure', fileSystemId, operationId, stage: trialStage },
    });
    if (!transitionStarted) {
      try {
        await settleNativeHizoFSEnableTargetAfterStartFailure({
          binding,
          control,
          fileSystemId,
          removeTarget: async () => await removeNaidanOpfsContainerDirectory({
            exclusiveGate,
            fileSystemId,
            storageRoot: nativeNamespaceRoot,
          }),
        });
      } catch (cleanupCause: unknown) {
        throw new AggregateError(
          [cause, cleanupCause],
          'native enable transition start failed and exact target cleanup ownership could not be resolved',
        );
      }
    }
    throw cause;
  }
}

export async function replaceNativeAuthenticatedDevelopmentWritableSessionPassphrase({
  recheckAuthority,
  replacementPassphrase,
  session,
}: {
  recheckAuthority: () => Promise<void>;
  replacementPassphrase: string;
  session: StorageFileSystemSession;
}): Promise<StorageFileSystemSession> {
  return await replaceAuthenticatedDevelopmentWritableSessionPassphrase({
    recheckAuthority,
    replacementPassphrase,
    session,
  });
}

type NativeCredentialCandidateAuthority =
  | { readonly authority: AuthenticatedDevelopmentWritableContainerCapability; readonly type: 'development_writable' }
  | { readonly authority: AuthenticatedReadOnlyContainerCapability; readonly type: 'root_key_proof' };

type NativeCredentialCandidateOpenResult =
  | { readonly type: 'credential_rejected' }
  | {
      readonly authority: NativeCredentialCandidateAuthority;
      readonly releaseResources: () => Promise<void>;
      readonly type: 'opened';
    };

type NativeHizoFSRuntimePort = {
  readonly createCoordinationScope: typeof createBrowserContainerCoordinationScope;
  readonly createRuntimeHost: typeof createBrowserHizoFSWorkerRuntimeHost;
  readonly openApplicationSessionFromCapability: ({ authority, canonicalBackingLocation, recheckAuthority, runtimeHost }: {
    authority: NativeCredentialCandidateAuthority;
    canonicalBackingLocation: string;
    recheckAuthority: () => Promise<void>;
    runtimeHost: ReturnType<typeof createBrowserHizoFSWorkerRuntimeHost>;
  }) => Promise<StorageFileSystemSession>;
  readonly openContainerCapability: ({ containerRoot, openProfile, passphrase, verifyProofAuthority }: {
    containerRoot: FileSystemDirectoryHandle;
    openProfile: CredentialCandidateOpenProfile;
    passphrase: string;
    verifyProofAuthority: Parameters<typeof openBrowserAuthenticatedReadOnlyContainerCapability>[0]['verifyProofAuthority'];
  }) => Promise<NativeCredentialCandidateOpenResult>;
};

const browserNativeHizoFSRuntimePort: NativeHizoFSRuntimePort = Object.freeze({
  createCoordinationScope: createBrowserContainerCoordinationScope,
  createRuntimeHost: createBrowserHizoFSWorkerRuntimeHost,
  openApplicationSessionFromCapability: async ({ authority, canonicalBackingLocation, recheckAuthority, runtimeHost }) => {
    switch (authority.type) {
    case 'development_writable':
      return await openAuthenticatedDevelopmentWritableApplicationSessionFromCapability({
        authority: authority.authority,
        canonicalBackingLocation,
        recheckAuthority,
        runtimeHost,
      });
    case 'root_key_proof':
      return await openAuthenticatedReadOnlyApplicationSessionFromCapability({
        authority: authority.authority,
        recheckAuthority,
        runtimeHost,
      });
    default: return authority satisfies never;
    }
  },
  openContainerCapability: async ({ containerRoot, openProfile, passphrase, verifyProofAuthority }) => {
    switch (openProfile) {
    case 'normal_read': {
      const opened = await openBrowserAuthenticatedDevelopmentWritableContainerCapability({
        containerRoot,
        passphrase,
        verifyProofAuthority,
      });
      switch (opened.type) {
      case 'credential_rejected': return opened;
      case 'opened': return {
        authority: { authority: opened.authority, type: 'development_writable' },
        releaseResources: opened.releaseResources,
        type: 'opened',
      };
      default: return opened satisfies never;
      }
    }
    case 'root_key_proof': {
      const opened = await openBrowserAuthenticatedReadOnlyContainerCapability({
        containerRoot,
        openProfile,
        passphrase,
        verifyProofAuthority,
      });
      switch (opened.type) {
      case 'credential_rejected': return opened;
      case 'opened': return {
        authority: { authority: opened.authority, type: 'root_key_proof' },
        releaseResources: opened.releaseResources,
        type: 'opened',
      };
      default: return opened satisfies never;
      }
    }
    default: return openProfile satisfies never;
    }
  },
});

function credentialCandidateOpenProfileFromMode({ mode }: {
  mode: NaidanPersistenceModeV1;
}): CredentialCandidateOpenProfile {
  switch (mode.type) {
  case 'plain': throw new TypeError('plain Persistence Control cannot require a credential');
  case 'hizofs': return 'normal_read';
  case 'transitioning': {
    const { operation, phase } = mode;
    switch (operation) {
    case 'encrypt':
      switch (phase.type) {
      case 'building_target': return 'root_key_proof';
      case 'cleaning_up_source': return 'normal_read';
      default: return phase.type satisfies never;
      }
    case 'decrypt':
      switch (phase.type) {
      case 'building_target': return 'normal_read';
      case 'cleaning_up_source': return 'root_key_proof';
      default: return phase.type satisfies never;
      }
    case 're_encrypt': return 'normal_read';
    default: return operation satisfies never;
    }
  }
  default: return mode satisfies never;
  }
}

function credentialCandidateOpenProfile({ control }: {
  control: NaidanPersistenceControlV1;
}): CredentialCandidateOpenProfile {
  return credentialCandidateOpenProfileFromMode({ mode: control.mode });
}

async function highestCredentialRequiredCandidate({ physical }: {
  physical: PersistenceControlReadablePhysicalPort;
}): Promise<{ readonly fileSystemId: FileSystemId; readonly openProfile: CredentialCandidateOpenProfile }> {
  const read = await readPersistenceControlCandidates({
    physical,
    proofAuthority: {
      async resolveRootKey() {
        return { state: 'unresolved' };
      },
      async validateEndpointReadiness() {
        return 'invalid';
      },
    },
  });

  try {
    selectPersistenceControlAuthority({ candidates: read.candidates });
  } catch (cause: unknown) {
    if (!(cause instanceof PersistenceControlSelectionError) || cause.code !== 'higher_protection_unresolved') {
      throw cause;
    }
    const sequence = ({ candidate }: { candidate: PersistenceControlCandidate }): number => {
      switch (candidate.state) {
      case 'structurally_invalid': return 0;
      case 'proof_invalid':
      case 'proof_valid':
      case 'protection_unresolved': return candidate.control.sequence;
      default: return candidate satisfies never;
      }
    };
    const highestSequence = Math.max(...read.candidates.map((candidate) => sequence({ candidate })));
    const highest = read.candidates.find((candidate): candidate is Extract<
      PersistenceControlCandidate,
      { state: 'protection_unresolved' }
    > => (
      candidate.state === 'protection_unresolved'
      && candidate.control.sequence === highestSequence
    ));
    if (highest === undefined) {
      throw new Error('higher unresolved Persistence Control candidate was not preserved by inspection');
    }
    switch (highest.control.protection.type) {
    case 'hizofs_aes_256_gcm':
      return {
        fileSystemId: highest.control.protection.authenticationFileSystemId,
        openProfile: credentialCandidateOpenProfile({ control: highest.control }),
      };
    case 'plain_sha256': throw new Error('plain Persistence Control cannot require a credential');
    default: return highest.control.protection satisfies never;
    }
  }

  throw new Error('Persistence Control no longer requires a credential');
}

/**
 * Proves exactly the highest unresolved Persistence Control candidate.
 *
 * Wrong credentials never fall back to an older structural candidate. The
 * opened container remains caller-invisible until its callback-scoped root-key
 * proof selects a matching control and the provider rechecks the captured A/B
 * bytes under its short coordination gate.
 */
export async function openCapturedCredentialRequiredPersistenceRuntime<Authority>({
  captured,
  openCandidate,
  passphrase,
  physical,
  validateEndpointReadiness,
}: {
  captured: CapturedPersistenceControlAuthority;
  openCandidate: ({ fileSystemId, openProfile, passphrase, verifyProofAuthority }: {
    fileSystemId: FileSystemId;
    openProfile: CredentialCandidateOpenProfile;
    passphrase: string;
    verifyProofAuthority: ({ fileSystemId, rootKeyProof }: {
      fileSystemId: FileSystemId;
      rootKeyProof: PersistenceControlRootKeyDerivationCapability;
    }) => Promise<void>;
  }) => Promise<CredentialCandidateOpenResult<Authority>>;
  passphrase: string;
  physical: PersistenceControlReadablePhysicalPort;
  validateEndpointReadiness: ({ control }: {
    control: NaidanPersistenceControlV1;
  }) => Promise<'invalid' | 'valid'>;
}): Promise<CredentialBoundPersistenceControlOpenResult<Authority>> {
  const capturedPhysical = createCapturedPersistenceControlReadablePhysicalPort({ captured });
  const {
    fileSystemId: expectedFileSystemId,
    openProfile,
  } = await highestCredentialRequiredCandidate({ physical: capturedPhysical });
  let selected: SelectedPersistenceControlAuthority | undefined;

  const opened = await openCandidate({
    fileSystemId: expectedFileSystemId,
    openProfile,
    passphrase,
    verifyProofAuthority: async ({ fileSystemId, rootKeyProof }) => {
      if (fileSystemId !== expectedFileSystemId) {
        throw new TypeError('opened HizoFS container identity does not match the credential-required candidate');
      }
      selected = await openPersistenceControl({
        physical: capturedPhysical,
        proofAuthority: {
          async resolveRootKey({ fileSystemId: requestedFileSystemId }) {
            return requestedFileSystemId === fileSystemId
              ? { rootKey: rootKeyProof, state: 'resolved' }
              : { state: 'unresolved' };
          },
          validateEndpointReadiness,
        },
      });
      const authenticationFileSystemId = persistenceControlAuthenticationFileSystemId({ mode: selected.control.mode });
      if (authenticationFileSystemId !== fileSystemId) {
        throw new TypeError('selected Persistence Control authority is not authenticated by the opened HizoFS container');
      }
    },
  });

  switch (opened.type) {
  case 'credential_rejected':
    if (selected !== undefined) {
      throw new Error('candidate opener rejected a credential after proving Persistence Control authority');
    }
    return opened;
  case 'opened': break;
  default: return opened satisfies never;
  }

  try {
    if (selected === undefined) {
      throw new Error('candidate opener returned without proving Persistence Control authority');
    }
    await recheckPersistenceControlAuthority({ captured, physical });
    return {
      authority: opened.authority,
      fileSystemId: expectedFileSystemId,
      releaseResources: opened.releaseResources,
      selected,
      type: 'opened',
    };
  } catch (cause: unknown) {
    try {
      await opened.releaseResources();
    } catch (releaseCause: unknown) {
      throw new AggregateError(
        [cause, releaseCause],
        'Persistence Control unlock failed and opened authority cleanup also failed',
      );
    }
    throw cause;
  }
}


function credentialBoundAuthoritativeEndpoint({ control }: {
  control: NaidanPersistenceControlV1;
}): NaidanPersistenceEndpointV1 {
  switch (control.mode.type) {
  case 'plain': throw new TypeError('credential-bound Persistence Control cannot authorize plain stable mode');
  case 'hizofs': return { fileSystemId: control.mode.activeFileSystemId, type: 'hizofs' };
  case 'transitioning': return authoritativeTransitionEndpoint({ mode: control.mode });
  default: return control.mode satisfies never;
  }
}

async function throwAfterApplicationSessionCleanup({
  cause,
  fileSystemSession,
  releaseResources,
}: {
  cause: unknown;
  fileSystemSession: StorageFileSystemSession | undefined;
  releaseResources: () => Promise<void>;
}): Promise<never> {
  const cleanupFailures: unknown[] = [];
  if (fileSystemSession !== undefined) {
    try {
      await fileSystemSession.close();
    } catch (closeCause: unknown) {
      cleanupFailures.push(closeCause);
    }
  }
  try {
    await releaseResources();
  } catch (releaseCause: unknown) {
    cleanupFailures.push(releaseCause);
  }
  if (cleanupFailures.length !== 0) {
    throw new AggregateError(
      [cause, ...cleanupFailures],
      'credential-bound session registration failed and resource cleanup also failed',
    );
  }
  throw cause;
}

type ApplicationSessionRecheckState = 'failed' | 'invalid' | 'not_called' | 'running' | 'succeeded';
type ApplicationSessionRecheckStatus = { failure: unknown; state: ApplicationSessionRecheckState };

function beginApplicationSessionAuthorityRecheck({ status }: {
  status: ApplicationSessionRecheckStatus;
}): void {
  switch (status.state) {
  case 'not_called':
    status.state = 'running';
    return;
  case 'failed':
  case 'invalid':
  case 'running':
  case 'succeeded':
    status.state = 'invalid';
    throw new Error('application session opener invoked the authority recheck more than once');
  default: return status.state satisfies never;
  }
}

function completeApplicationSessionAuthorityRecheck({ status }: {
  status: ApplicationSessionRecheckStatus;
}): void {
  switch (status.state) {
  case 'running':
    status.state = 'succeeded';
    return;
  case 'invalid':
    // A concurrent second invocation already invalidated the one-shot gate.
    return;
  case 'failed':
  case 'not_called':
  case 'succeeded':
    throw new Error(`authority recheck completed from invalid state: ${status.state}`);
  default: return status.state satisfies never;
  }
}

function failApplicationSessionAuthorityRecheck({ cause, status }: {
  cause: unknown;
  status: ApplicationSessionRecheckStatus;
}): void {
  status.failure = cause;
  switch (status.state) {
  case 'running':
    status.state = 'failed';
    return;
  case 'invalid':
    // Preserve invalid when another invocation raced with the failing one.
    return;
  case 'failed':
  case 'not_called':
  case 'succeeded':
    throw new Error(`authority recheck failed from invalid state: ${status.state}`, { cause });
  default: return status.state satisfies never;
  }
}

async function openApplicationSessionAfterRequiredRecheck({
  openSession,
  recheckAuthority,
  releaseResources,
}: {
  openSession: ({ recheckAuthority }: {
    recheckAuthority: () => Promise<void>;
  }) => Promise<StorageFileSystemSession>;
  recheckAuthority: () => Promise<void>;
  releaseResources: () => Promise<void>;
}): Promise<StorageFileSystemSession> {
  const recheckStatus: ApplicationSessionRecheckStatus = {
    failure: undefined,
    state: 'not_called',
  };
  let fileSystemSession: StorageFileSystemSession | undefined;
  try {
    fileSystemSession = await openSession({
      recheckAuthority: async () => {
        beginApplicationSessionAuthorityRecheck({ status: recheckStatus });
        try {
          await recheckAuthority();
        } catch (cause: unknown) {
          failApplicationSessionAuthorityRecheck({ cause, status: recheckStatus });
          throw cause;
        }
        completeApplicationSessionAuthorityRecheck({ status: recheckStatus });
      },
    });

    switch (recheckStatus.state) {
    case 'succeeded': return fileSystemSession;
    case 'not_called': throw new Error('application session opener returned without rechecking Persistence Control authority');
    case 'running': throw new Error('application session opener returned before awaiting Persistence Control authority recheck');
    case 'failed': throw new Error(
      'application session opener returned after Persistence Control authority recheck failed',
      { cause: recheckStatus.failure },
    );
    case 'invalid': throw new Error('application session opener violated the one-shot authority recheck contract');
    default: return recheckStatus.state satisfies never;
    }
  } catch (cause: unknown) {
    return await throwAfterApplicationSessionCleanup({
      cause,
      fileSystemSession,
      releaseResources,
    });
  }
}

/**
 * Transfers a proved credential candidate into exactly one authoritative
 * read-only application session.
 *
 * The selected control is reinterpreted only through its normative transition
 * authority rule. The final A/B byte recheck is callback-bound to session
 * registration so an opener cannot expose a namespace before proving that the
 * detached authority is still current.
 */
export async function registerCredentialBoundApplicationSession<Authority>({
  captured,
  opened,
  openHizoFSApplicationSession,
  openPlainApplicationSession,
  physical,
}: {
  captured: CapturedPersistenceControlAuthority;
  opened: CredentialBoundPersistenceControlOpenResult<Authority>;
  openHizoFSApplicationSession: ({ authority, fileSystemId, recheckAuthority }: {
    authority: Authority;
    fileSystemId: FileSystemId;
    recheckAuthority: () => Promise<void>;
  }) => Promise<StorageFileSystemSession>;
  openPlainApplicationSession: ({ recheckAuthority }: {
    recheckAuthority: () => Promise<void>;
  }) => Promise<StorageFileSystemSession>;
  physical: PersistenceControlReadablePhysicalPort;
}): Promise<CredentialBoundApplicationSessionOpenResult> {
  switch (opened.type) {
  case 'credential_rejected': return opened;
  case 'opened': break;
  default: return opened satisfies never;
  }

  let authoritativeEndpoint: NaidanPersistenceEndpointV1;
  let requiredProfile: CredentialCandidateOpenProfile;
  try {
    authoritativeEndpoint = credentialBoundAuthoritativeEndpoint({
      control: opened.selected.control,
    });
    requiredProfile = credentialCandidateOpenProfile({ control: opened.selected.control });
  } catch (cause: unknown) {
    return await throwAfterApplicationSessionCleanup({
      cause,
      fileSystemSession: undefined,
      releaseResources: opened.releaseResources,
    });
  }
  const recheckAuthority = async () => await recheckPersistenceControlAuthority({ captured, physical });

  switch (authoritativeEndpoint.type) {
  case 'hizofs': {
    switch (requiredProfile) {
    case 'normal_read': break;
    case 'root_key_proof':
      return await throwAfterApplicationSessionCleanup({
        cause: new TypeError('root-key-proof-only credential authority cannot open an authoritative HizoFS session'),
        fileSystemSession: undefined,
        releaseResources: opened.releaseResources,
      });
    default: return requiredProfile satisfies never;
    }
    if (authoritativeEndpoint.fileSystemId !== opened.fileSystemId) {
      return await throwAfterApplicationSessionCleanup({
        cause: new TypeError('opened credential authority does not match the authoritative HizoFS endpoint'),
        fileSystemSession: undefined,
        releaseResources: opened.releaseResources,
      });
    }
    const fileSystemSession = await openApplicationSessionAfterRequiredRecheck({
      openSession: async ({ recheckAuthority: requiredRecheck }) => await openHizoFSApplicationSession({
        authority: opened.authority,
        fileSystemId: opened.fileSystemId,
        recheckAuthority: requiredRecheck,
      }),
      recheckAuthority,
      releaseResources: opened.releaseResources,
    });
    return {
      authoritativeEndpoint,
      fileSystemId: opened.fileSystemId,
      fileSystemSession,
      selected: opened.selected,
      type: 'opened',
    };
  }
  case 'plain': {
    switch (requiredProfile) {
    case 'root_key_proof': break;
    case 'normal_read':
      return await throwAfterApplicationSessionCleanup({
        cause: new TypeError('normal-read credential authority cannot be discarded for a plain authoritative endpoint'),
        fileSystemSession: undefined,
        releaseResources: opened.releaseResources,
      });
    default: return requiredProfile satisfies never;
    }
    // The proof-only HizoFS capability is no longer authoritative once the
    // transition says plain storage owns the namespace. Release its root key
    // before exposing the native session, then exact-recheck the control.
    await opened.releaseResources();
    const fileSystemSession = await openApplicationSessionAfterRequiredRecheck({
      openSession: openPlainApplicationSession,
      recheckAuthority,
      releaseResources: async () => undefined,
    });
    return {
      authoritativeEndpoint,
      fileSystemId: opened.fileSystemId,
      fileSystemSession,
      selected: opened.selected,
      type: 'opened',
    };
  }
  default: return authoritativeEndpoint satisfies never;
  }
}


function isNotFoundError({ cause }: { cause: unknown }): boolean {
  return cause instanceof DOMException
    ? cause.name === 'NotFoundError'
    : cause instanceof Error
      && (cause.name === 'NotFoundError' || cause.message.startsWith('NotFoundError'));
}

/**
 * Traversal is the readiness proof. Iterator cleanup is still attempted, but
 * a cleanup failure must not erase the traversal failure that invalidates the
 * endpoint.
 */
async function consumeOneNativePlainDirectoryKey({ iterator }: {
  iterator: AsyncIterator<string>;
}): Promise<void> {
  let traversalFailure: unknown;
  try {
    await iterator.next();
  } catch (cause: unknown) {
    traversalFailure = cause;
  }

  let cleanupFailure: unknown;
  try {
    await iterator.return?.();
  } catch (cause: unknown) {
    cleanupFailure = cause;
  }

  if (traversalFailure !== undefined && cleanupFailure !== undefined) {
    throw new AggregateError(
      [traversalFailure, cleanupFailure],
      'native plain endpoint traversal and iterator cleanup both failed',
    );
  }
  if (traversalFailure !== undefined) throw traversalFailure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
}

async function inspectNativePlainEndpoint({ nativeNamespaceRoot }: {
  nativeNamespaceRoot: FileSystemDirectoryHandle;
}) {
  let storageRoot: FileSystemDirectoryHandle;
  try {
    storageRoot = await nativeNamespaceRoot.getDirectoryHandle(
      NAIDAN_OPFS_STORAGE_DIRECTORY_NAME,
      { create: false },
    );
  } catch (cause: unknown) {
    if (isNotFoundError({ cause })) return 'invalid' as const;
    throw cause;
  }

  // Opening the directory alone is not a traversal proof. Consume at most one
  // key so permission, detached-handle, and iterator failures remain visible.
  const iterator = storageRoot.keys()[Symbol.asyncIterator]();
  await consumeOneNativePlainDirectoryKey({ iterator });
  return 'fully_verified' as const;
}

type EndpointInspectionContainerOpenResult =
  | { readonly type: 'credential_rejected' }
  | { readonly releaseResources: () => Promise<void>; readonly type: 'opened' };

type EndpointInspectionContainerOpener = ({ containerRoot, openProfile, passphrase, verifyProofAuthority }: {
  containerRoot: FileSystemDirectoryHandle;
  openProfile: PersistenceEndpointOpenProfile;
  passphrase: string;
  verifyProofAuthority: Parameters<typeof openBrowserAuthenticatedReadOnlyContainerCapability>[0]['verifyProofAuthority'];
}) => Promise<EndpointInspectionContainerOpenResult>;

async function inspectNativeHizoFSEndpointWith({
  fileSystemId,
  nativeNamespaceRoot,
  openContainer,
  openProfile,
  passphrase,
}: {
  fileSystemId: FileSystemId;
  nativeNamespaceRoot: FileSystemDirectoryHandle;
  openContainer: EndpointInspectionContainerOpener;
  openProfile: PersistenceEndpointOpenProfile;
  passphrase: string;
}) {
  let containerRoot: FileSystemDirectoryHandle;
  try {
    containerRoot = await openNaidanOpfsContainerDirectory({
      fileSystemId,
      storageRoot: nativeNamespaceRoot,
    });
  } catch (cause: unknown) {
    if (isNotFoundError({ cause })) return 'absent' as const;
    throw cause;
  }

  let proofObserved = false;
  let identityMatches = false;
  const opened = await openContainer({
    containerRoot,
    openProfile,
    passphrase,
    verifyProofAuthority: async ({ fileSystemId: openedFileSystemId }) => {
      proofObserved = true;
      identityMatches = openedFileSystemId === fileSystemId;
    },
  });

  switch (opened.type) {
  case 'credential_rejected': return 'invalid' as const;
  case 'opened':
    return await runWithCredentialAuthorityRelease({
      failureMessage: 'HizoFS endpoint inspection and credential authority release both failed',
      operation: async () => {
        if (!proofObserved) {
          throw new Error('HizoFS endpoint opener returned without exposing callback-scoped identity proof');
        }
        if (!identityMatches) return 'invalid' as const;
        switch (openProfile) {
        case 'normal_read': return 'fully_verified' as const;
        case 'root_key_proof': return 'root_key_ready' as const;
        default: return openProfile satisfies never;
        }
      },
      releaseResources: opened.releaseResources,
    });
  default: return opened satisfies never;
  }
}

async function inspectNativeHizoFSEndpoint({ fileSystemId, nativeNamespaceRoot, openProfile, passphrase }: {
  fileSystemId: FileSystemId;
  nativeNamespaceRoot: FileSystemDirectoryHandle;
  openProfile: PersistenceEndpointOpenProfile;
  passphrase: string;
}) {
  return await inspectNativeHizoFSEndpointWith({
    fileSystemId,
    nativeNamespaceRoot,
    openContainer: openBrowserAuthenticatedReadOnlyContainerCapability,
    openProfile,
    passphrase,
  });
}

function createNativePhaseSpecificEndpointInspectionPort({ nativeNamespaceRoot, openContainer, passphrase }: {
  nativeNamespaceRoot: FileSystemDirectoryHandle;
  openContainer: EndpointInspectionContainerOpener;
  passphrase: string;
}): PhaseSpecificEndpointInspectionPort {
  return {
    inspectHizoFSEndpoint: async ({ fileSystemId, openProfile }) => await inspectNativeHizoFSEndpointWith({
      fileSystemId,
      nativeNamespaceRoot,
      openContainer,
      openProfile,
      passphrase,
    }),
    inspectPlainEndpoint: async () => await inspectNativePlainEndpoint({ nativeNamespaceRoot }),
  };
}

async function openNativeCapturedCredentialRequiredPersistenceRuntimeWith({
  captured,
  hizofsRuntime,
  nativeNamespaceRoot,
  passphrase,
  physical,
}: {
  captured: CapturedPersistenceControlAuthority;
  hizofsRuntime: NativeHizoFSRuntimePort;
  nativeNamespaceRoot: FileSystemDirectoryHandle;
  passphrase: string;
  physical: PersistenceControlReadablePhysicalPort;
}) {
  let openedAuthenticationEndpoint: OpenedAuthenticationEndpoint | undefined;
  const endpointPort = createNativePhaseSpecificEndpointInspectionPort({
    nativeNamespaceRoot,
    openContainer: hizofsRuntime.openContainerCapability,
    passphrase,
  });

  return await openCapturedCredentialRequiredPersistenceRuntime({
    captured,
    openCandidate: async ({ fileSystemId, openProfile, passphrase: candidatePassphrase, verifyProofAuthority }) => {
      if (openedAuthenticationEndpoint !== undefined) {
        throw new Error('credential candidate open re-entered while another authentication endpoint was active');
      }
      openedAuthenticationEndpoint = { fileSystemId, openProfile };
      try {
        const containerRoot = await openNaidanOpfsContainerDirectory({
          fileSystemId,
          storageRoot: nativeNamespaceRoot,
        });
        return await hizofsRuntime.openContainerCapability({
          containerRoot,
          openProfile,
          passphrase: candidatePassphrase,
          verifyProofAuthority,
        });
      } finally {
        openedAuthenticationEndpoint = undefined;
      }
    },
    passphrase,
    physical,
    validateEndpointReadiness: async ({ control }) => {
      const opened = openedAuthenticationEndpoint;
      if (opened === undefined) {
        throw new Error('endpoint readiness validation ran outside the credential candidate proof callback');
      }
      return await validatePhaseSpecificPersistenceEndpointReadiness({
        control,
        openedAuthenticationEndpoint: opened,
        port: endpointPort,
      });
    },
  });
}

export async function openNativeCapturedCredentialRequiredPersistenceRuntime({
  captured,
  nativeNamespaceRoot,
  passphrase,
  physical,
}: {
  captured: CapturedPersistenceControlAuthority;
  nativeNamespaceRoot: FileSystemDirectoryHandle;
  passphrase: string;
  physical: PersistenceControlReadablePhysicalPort;
}) {
  return await openNativeCapturedCredentialRequiredPersistenceRuntimeWith({
    captured,
    hizofsRuntime: browserNativeHizoFSRuntimePort,
    nativeNamespaceRoot,
    passphrase,
    physical,
  });
}


/**
 * Opens the credential candidate and registers only the endpoint that is
 * authoritative for the selected stable/transition phase.
 *
 * Normal-read HizoFS authority is transferred into the explicitly unverified
 * development writable profile. Root-key-proof authority remains proof-only
 * and can never become an application namespace. A release-qualified profile
 * requires separately reviewed browser durability evidence and environment
 * attestation.
 */
async function openNativeCredentialRequiredApplicationSessionWith({
  captured,
  hizofsRuntime,
  lockManager,
  nativeNamespaceRoot,
  passphrase,
  physical,
  runtimePolicy,
}: {
  captured: CapturedPersistenceControlAuthority;
  hizofsRuntime: NativeHizoFSRuntimePort;
  lockManager: BrowserHizoFSRuntimeHostOptions['lockManager'];
  nativeNamespaceRoot: FileSystemDirectoryHandle;
  passphrase: string;
  physical: PersistenceControlReadablePhysicalPort;
  runtimePolicy: BrowserHizoFSRuntimeHostOptions['policy'];
}): Promise<CredentialBoundApplicationSessionOpenResult> {
  const opened = await openNativeCapturedCredentialRequiredPersistenceRuntimeWith({
    captured,
    hizofsRuntime,
    nativeNamespaceRoot,
    passphrase,
    physical,
  });
  return await registerCredentialBoundApplicationSession({
    captured,
    opened,
    openHizoFSApplicationSession: async ({ authority, fileSystemId, recheckAuthority }) => {
      const scope = await hizofsRuntime.createCoordinationScope({
        canonicalBackingLocation: naidanOpfsContainerOriginRelativePath({ fileSystemId }),
      });
      const runtimeHost = hizofsRuntime.createRuntimeHost({
        lockManager,
        policy: runtimePolicy,
        scope,
      });
      return await hizofsRuntime.openApplicationSessionFromCapability({
        authority,
        canonicalBackingLocation: naidanOpfsContainerOriginRelativePath({ fileSystemId }),
        recheckAuthority,
        runtimeHost,
      });
    },
    openPlainApplicationSession: async ({ recheckAuthority }) => {
      await recheckAuthority();
      return createNativeOpfsFileSystemSession({ root: nativeNamespaceRoot });
    },
    physical,
  });
}

export async function openNativeCredentialRequiredApplicationSession({
  captured,
  lockManager,
  nativeNamespaceRoot,
  passphrase,
  physical,
  runtimePolicy,
}: {
  captured: CapturedPersistenceControlAuthority;
  lockManager: BrowserHizoFSRuntimeHostOptions['lockManager'];
  nativeNamespaceRoot: FileSystemDirectoryHandle;
  passphrase: string;
  physical: PersistenceControlReadablePhysicalPort;
  runtimePolicy: BrowserHizoFSRuntimeHostOptions['policy'];
}): Promise<CredentialBoundApplicationSessionOpenResult> {
  return await openNativeCredentialRequiredApplicationSessionWith({
    captured,
    hizofsRuntime: browserNativeHizoFSRuntimePort,
    lockManager,
    nativeNamespaceRoot,
    passphrase,
    physical,
    runtimePolicy,
  });
}

/**
 * Inspects Persistence Control before any credential exists.
 *
 * HizoFS protection deliberately remains unresolved. This function may expose
 * detached candidate metadata for the unlock presentation, but only a plain
 * proof-valid authority may become an application routing decision here.
 */
export async function inspectNativeCredentialAwarePersistenceRuntime({
  nativeNamespaceRoot,
  physical,
}: {
  nativeNamespaceRoot: FileSystemDirectoryHandle;
  physical: PersistenceControlReadablePhysicalPort;
}): Promise<OpfsEncryptionInspection> {
  return await inspectCredentialAwarePersistenceRuntime({
    physical,
    validateEndpointReadiness: async ({ control }) => {
      switch (control.mode.type) {
      case 'plain': {
        const readiness = await inspectNativePlainEndpoint({ nativeNamespaceRoot });
        switch (readiness) {
        case 'fully_verified': return 'valid';
        case 'invalid': return 'invalid';
        default: return readiness satisfies never;
        }
      }
      case 'hizofs':
      case 'transitioning':
        // Protected endpoint readiness is passphrase-bound and therefore must
        // never be resolved during detached startup inspection.
        return 'invalid';
      default: return control.mode satisfies never;
      }
    },
  });
}

type NativeStableHizoFSRetiredContainerCleanupRuntime = Readonly<{
  createControlPhysical: typeof createOpfsPersistenceControlPhysicalPort;
  removeRetiredContainer: typeof removeNaidanOpfsContainerDirectory;
}>;

const browserNativeStableHizoFSRetiredContainerCleanupRuntime: NativeStableHizoFSRetiredContainerCleanupRuntime = Object.freeze({
  createControlPhysical: createOpfsPersistenceControlPhysicalPort,
  removeRetiredContainer: removeNaidanOpfsContainerDirectory,
});

async function runNativeStableHizoFSRetiredContainerCleanupWith({
  activeFileSystemId,
  exclusiveGate,
  nativeNamespaceRoot,
  proofAuthority,
  runtime,
  storageRoot,
}: {
  activeFileSystemId: FileSystemId;
  exclusiveGate: NaidanPersistenceControlExclusiveGate;
  nativeNamespaceRoot: FileSystemDirectoryHandle;
  proofAuthority: PersistenceControlProofAuthority;
  runtime: NativeStableHizoFSRetiredContainerCleanupRuntime;
  storageRoot: FileSystemDirectoryHandle;
}): Promise<void> {
  for (;;) {
    let maintenanceProgressed = false;
    await exclusiveGate.runExclusive({
      operation: async () => {
        const alreadyExclusiveGate = alreadyExclusivePersistenceControlGate();
        const physical = runtime.createControlPhysical({ exclusiveGate: alreadyExclusiveGate, storageRoot });
        const control = createPersistenceControlTransitionPort({
          bootstrapAuthorization: undefined,
          physical,
          proofAuthority,
          randomSource: undefined,
        });
        const selected = await openPersistenceControl({ physical, proofAuthority });
        const current = {
          mode: selected.control.mode,
          retiredFileSystemIds: selected.control.retiredFileSystemIds,
        };
        switch (current.mode.type) {
        case 'hizofs':
          if (current.mode.activeFileSystemId !== activeFileSystemId) {
            throw new TypeError('stable HizoFS retired-container cleanup authority belongs to another File System ID');
          }
          break;
        case 'plain':
        case 'transitioning': throw new TypeError('stable HizoFS retired-container cleanup requires stable HizoFS authority');
        default: current.mode satisfies never;
        }
        const [fileSystemId, ...remainingRetiredFileSystemIds] = current.retiredFileSystemIds;
        if (fileSystemId === undefined) {
          switch (selected.redundancy) {
          case 'converged': return;
          case 'degraded':
            await control.publishState({ state: current });
            maintenanceProgressed = true;
            return;
          default: return selected.redundancy satisfies never;
          }
        }
        if (fileSystemId === activeFileSystemId) {
          throw new TypeError('stable HizoFS retired-container cleanup cannot remove the active File System ID');
        }
        await runtime.removeRetiredContainer({
          exclusiveGate: alreadyExclusiveGate,
          fileSystemId,
          storageRoot: nativeNamespaceRoot,
        });
        await control.publishState({
          state: {
            mode: current.mode,
            retiredFileSystemIds: remainingRetiredFileSystemIds,
          },
        });
        maintenanceProgressed = true;
      },
    });
    if (!maintenanceProgressed) return;
  }
}

export async function runNativeStableHizoFSRetiredContainerCleanup({
  lockManager,
  nativeNamespaceRoot,
  session,
  storageRoot,
}: {
  lockManager: Pick<LockManager, 'request'>;
  nativeNamespaceRoot: FileSystemDirectoryHandle;
  session: OpfsPersistenceUnlockedSession;
  storageRoot: FileSystemDirectoryHandle;
}): Promise<void> {
  await withAuthenticatedDevelopmentWritableSessionRootKeyProof({
    operation: async ({ fileSystemId, rootKeyProof }) => {
      if (fileSystemId !== session.fileSystemId) {
        throw new TypeError('stable HizoFS retired-container cleanup session proof belongs to another File System ID');
      }
      const proofAuthority: PersistenceControlProofAuthority = {
        resolveRootKey: async ({ fileSystemId: requestedFileSystemId }) => requestedFileSystemId === fileSystemId
          ? { rootKey: rootKeyProof, state: 'resolved' }
          : { state: 'unresolved' },
        validateEndpointReadiness: async ({ control }) => {
          switch (control.mode.type) {
          case 'hizofs': return control.mode.activeFileSystemId === fileSystemId ? 'valid' : 'invalid';
          case 'plain':
          case 'transitioning': return 'invalid';
          default: return control.mode satisfies never;
          }
        },
      };
      await runNativeStableHizoFSRetiredContainerCleanupWith({
        activeFileSystemId: fileSystemId,
        exclusiveGate: createBrowserNaidanPersistenceControlExclusiveGate({ lockManager }),
        nativeNamespaceRoot,
        proofAuthority,
        runtime: browserNativeStableHizoFSRetiredContainerCleanupRuntime,
        storageRoot,
      });
    },
    session: session.fileSystemSession,
  });
}

export async function runNativeStableHizoFSRetiredPlainCleanup({
  lockManager,
  nativeNamespaceRoot,
  session,
  storageRoot,
}: {
  lockManager: Pick<LockManager, 'request'>;
  nativeNamespaceRoot: FileSystemDirectoryHandle;
  session: Pick<OpfsPersistenceUnlockedSession, 'fileSystemId' | 'fileSystemSession'>;
  storageRoot: FileSystemDirectoryHandle;
}): Promise<OpfsPersistenceUnlockedMaintenanceResult> {
  let remainingEntryCount: number | undefined;
  reportHizoFSTrialDebug({
    detail: {
      event: 'retired_plain_cleanup',
      failure: undefined,
      fileSystemId: session.fileSystemId,
      remainingEntryCount: undefined,
      removedEntryCount: undefined,
      stage: 'scheduled',
    },
    level: 'info',
  });
  try {
    const fenced = await runWithOpportunisticExclusiveOpfsPlainNamespaceFence({
      lockManager,
      run: async () => await withAuthenticatedDevelopmentWritableSessionRootKeyProof({
        operation: async ({ fileSystemId, rootKeyProof }) => {
          if (fileSystemId !== session.fileSystemId) {
            throw new TypeError('retired plain cleanup session proof belongs to another File System ID');
          }
          const exclusiveGate = createBrowserNaidanPersistenceControlExclusiveGate({ lockManager });
          const physical = createOpfsPersistenceControlPhysicalPort({ exclusiveGate, storageRoot });
          const proofAuthority: PersistenceControlProofAuthority = {
            resolveRootKey: async ({ fileSystemId: requestedFileSystemId }) => requestedFileSystemId === fileSystemId
              ? { rootKey: rootKeyProof, state: 'resolved' }
              : { state: 'unresolved' },
            validateEndpointReadiness: async ({ control }) => {
              switch (control.mode.type) {
              case 'hizofs': return control.mode.activeFileSystemId === fileSystemId ? 'valid' : 'invalid';
              case 'plain':
              case 'transitioning': return 'invalid';
              default: return control.mode satisfies never;
              }
            },
          };
          const selected = await openPersistenceControl({ physical, proofAuthority });
          switch (selected.control.mode.type) {
          case 'hizofs':
            if (selected.control.mode.activeFileSystemId !== fileSystemId) {
              throw new TypeError('retired plain cleanup authority belongs to another File System ID');
            }
            break;
          case 'plain':
          case 'transitioning':
            throw new TypeError('retired plain cleanup requires stable HizoFS authority');
          default: selected.control.mode satisfies never;
          }
          const before = await listNativePlainApplicationNamespaceEntryNames({ nativeNamespaceRoot });
          remainingEntryCount = before.length;
          reportHizoFSTrialDebug({
            detail: {
              event: 'retired_plain_cleanup',
              failure: undefined,
              fileSystemId,
              remainingEntryCount,
              removedEntryCount: undefined,
              stage: 'started',
            },
            level: 'info',
          });
          const removed = await cleanupNativePlainApplicationNamespaceWithReport({ nativeNamespaceRoot });
          const remaining = await listNativePlainApplicationNamespaceEntryNames({ nativeNamespaceRoot });
          remainingEntryCount = remaining.length;
          reportHizoFSTrialDebug({
            detail: {
              event: 'retired_plain_cleanup',
              failure: undefined,
              fileSystemId,
              remainingEntryCount,
              removedEntryCount: removed.length,
              stage: 'completed',
            },
            level: 'info',
          });
          return {
            remainingEntryCount,
            removedEntryCount: removed.length,
            state: 'completed',
          } as const;
        },
        session: session.fileSystemSession,
      }),
    });
    switch (fenced.state) {
    case 'completed': return fenced.value;
    case 'unavailable':
      reportHizoFSTrialDebug({
        detail: {
          event: 'retired_plain_cleanup',
          failure: undefined,
          fileSystemId: session.fileSystemId,
          remainingEntryCount: undefined,
          removedEntryCount: undefined,
          stage: 'plain_namespace_in_use',
        },
        level: 'info',
      });
      return { state: 'plain_namespace_in_use' };
    default: return fenced satisfies never;
    }
  } catch (cause: unknown) {
    reportRetiredPlainCleanupFailure({ cause, fileSystemId: session.fileSystemId, remainingEntryCount });
    throw cause;
  }
}

type NativeStablePlainRetiredCleanupRuntime = Readonly<{
  createControlPhysical: typeof createOpfsPersistenceControlPhysicalPort;
  inspectPlainEndpoint: typeof inspectNativePlainEndpoint;
  removeRetiredContainer: typeof removeNaidanOpfsContainerDirectory;
}>;

const browserNativeStablePlainRetiredCleanupRuntime: NativeStablePlainRetiredCleanupRuntime = Object.freeze({
  createControlPhysical: createOpfsPersistenceControlPhysicalPort,
  inspectPlainEndpoint: inspectNativePlainEndpoint,
  removeRetiredContainer: removeNaidanOpfsContainerDirectory,
});

function alreadyExclusivePersistenceControlGate(): NaidanPersistenceControlExclusiveGate {
  return {
    async runExclusive<T>({ operation }: { operation: () => Promise<T> }): Promise<T> {
      return await operation();
    },
  };
}

async function runNativeStablePlainRetiredCleanupWith({
  exclusiveGate,
  nativeNamespaceRoot,
  runtime,
  storageRoot,
}: {
  exclusiveGate: NaidanPersistenceControlExclusiveGate;
  nativeNamespaceRoot: FileSystemDirectoryHandle;
  runtime: NativeStablePlainRetiredCleanupRuntime;
  storageRoot: FileSystemDirectoryHandle;
}): Promise<void> {
  for (;;) {
    let maintenanceProgressed = false;
    await exclusiveGate.runExclusive({
      operation: async () => {
        const alreadyExclusiveGate = alreadyExclusivePersistenceControlGate();
        const proofAuthority: PersistenceControlProofAuthority = {
          resolveRootKey: async () => ({ state: 'unresolved' }),
          validateEndpointReadiness: async ({ control }) => {
            switch (control.mode.type) {
            case 'plain': break;
            case 'hizofs':
            case 'transitioning': return 'invalid';
            default: return control.mode satisfies never;
            }
            const readiness = await runtime.inspectPlainEndpoint({ nativeNamespaceRoot });
            switch (readiness) {
            case 'fully_verified': return 'valid';
            case 'invalid': return 'invalid';
            default: return readiness satisfies never;
            }
          },
        };
        const physical = runtime.createControlPhysical({ exclusiveGate: alreadyExclusiveGate, storageRoot });
        const control = createPersistenceControlTransitionPort({
          bootstrapAuthorization: undefined,
          physical,
          proofAuthority,
          randomSource: undefined,
        });
        const selected = await openPersistenceControl({ physical, proofAuthority });
        const current = {
          mode: selected.control.mode,
          retiredFileSystemIds: selected.control.retiredFileSystemIds,
        };
        switch (current.mode.type) {
        case 'plain': break;
        case 'hizofs':
        case 'transitioning': throw new TypeError('stable plain startup maintenance requires plain Persistence Control authority');
        default: current.mode satisfies never;
        }
        const [fileSystemId, ...remainingRetiredFileSystemIds] = current.retiredFileSystemIds;
        if (fileSystemId === undefined) {
          switch (selected.redundancy) {
          case 'converged': return;
          case 'degraded':
            await control.publishState({ state: current });
            maintenanceProgressed = true;
            return;
          default: return selected.redundancy satisfies never;
          }
        }
        await runtime.removeRetiredContainer({
          exclusiveGate: alreadyExclusiveGate,
          fileSystemId,
          storageRoot: nativeNamespaceRoot,
        });
        await control.publishState({
          state: {
            mode: { type: 'plain' },
            retiredFileSystemIds: remainingRetiredFileSystemIds,
          },
        });
        maintenanceProgressed = true;
      },
    });
    if (!maintenanceProgressed) return;
  }
}

export async function runNativeStablePlainRetiredCleanup({
  lockManager,
  nativeNamespaceRoot,
  storageRoot,
}: {
  lockManager: BrowserHizoFSRuntimeHostOptions['lockManager'];
  nativeNamespaceRoot: FileSystemDirectoryHandle;
  storageRoot: FileSystemDirectoryHandle;
}): Promise<void> {
  await runNativeStablePlainRetiredCleanupWith({
    exclusiveGate: createBrowserNaidanPersistenceControlExclusiveGate({ lockManager }),
    nativeNamespaceRoot,
    runtime: browserNativeStablePlainRetiredCleanupRuntime,
    storageRoot,
  });
}

export async function captureNativePersistenceControlAuthority({ physical }: {
  physical: PersistenceControlReadablePhysicalPort;
}): Promise<CapturedPersistenceControlAuthority> {
  return await capturePersistenceControlAuthority({ physical });
}

export async function inspectCredentialAwarePersistenceRuntime({
  physical,
  validateEndpointReadiness,
}: {
  physical: PersistenceControlReadablePhysicalPort;
  validateEndpointReadiness: ({ control }: {
    control: NaidanPersistenceControlV1;
  }) => Promise<'invalid' | 'valid'>;
}): Promise<OpfsEncryptionInspection> {
  const inspection = await inspectPersistenceControl({
    physical,
    proofAuthority: {
      async resolveRootKey() {
        return { state: 'unresolved' };
      },
      validateEndpointReadiness,
    },
  });
  return projectPersistenceRuntimeInspection({ inspection });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  reportNativeEnableTrialFailure,
  completeNativeHizoFSReturnToPlainWith,
  consumeOneNativePlainDirectoryKey,
  createCallbackScopedPersistenceControlTransitionPort,
  createNativeHizoFSDisableSourceDriver,
  createNativeHizoFSReencryptControl,
  createNativeHizoFSReencryptTransitionDriver,
  createNativeHizoFSReencryptSourceDriver,
  createNativeHizoFSEnableTransitionDriverWith,
  createNativeHizoFSEnableTransitionTargetWith,
  createNativePhaseSpecificEndpointInspectionPort,
  convergeNativePersistenceTransition,
  openNativeCredentialRequiredApplicationSessionWith,
  credentialBoundAuthoritativeEndpoint,
  credentialCandidateOpenProfile,
  credentialCandidateOpenProfileFromMode,
  inspectNativeHizoFSEndpoint,
  inspectNativeHizoFSEndpointWith,
  inspectNativePlainEndpoint,
  nativeDecryptTransitionBinding,
  nativeEncryptTransitionBinding,
  nativeReencryptTransitionBinding,
  nativeConvergenceAuthority,
  sameNativeDecryptTransition,
  sameNativeEncryptTransition,
  nativeHizoFSDisableSourceRemainsAuthoritativeAfterStartFailure,
  normalizeNativeRetainedCredentials,
  sameTransitionEndpoint,
  sameTransitionTargetBinding,
  settleNativeHizoFSEnableTargetAfterStartFailure,
  settleNativeHizoFSReencryptTargetAfterStartFailure,
  runNativeStableHizoFSRetiredContainerCleanupWith,
  runNativeStablePlainRetiredCleanupWith,
  runWithCredentialAuthorityRelease,
};
