import type { IStorageProvider } from '@/00-storage/service/interface';
import { HostVolumeDB } from '@/00-storage/service/opfs/host-volume-db';
import type { StorageFileSystemSession } from '@/00-storage/service/storage-file-system/types';
import { recheckPersistenceControlAuthority } from '@/00-storage/service/naidan-persistence-control/store/persistence-control-authority-handshake';
import type { CapturedPersistenceControlAuthority } from '@/00-storage/service/naidan-persistence-control/store/persistence-control-authority-handshake';
import type { PersistenceControlReadablePhysicalPort } from '@/00-storage/service/naidan-persistence-control/store';
import { NaidanOpfsStorageBackend } from '@/00-storage/service/naidan-opfs/backend';
import { createOpfsPersistenceControlReadablePhysicalPort } from '@/00-storage/service/naidan-opfs/opfs-persistence-control-readable-port';
import { installOpfsPersistenceRuntimeFactory } from '@/00-storage/service/naidan-opfs/persistence-runtime-registry';
import type {
  OpfsEncryptionInspection,
  OpfsPersistenceRetainedCredential,
  OpfsPersistenceRuntime,
  OpfsPersistenceTransitionRequest,
} from '@/00-storage/service/naidan-opfs/persistence-runtime-contract';
import {
  captureNativePersistenceControlAuthority,
  inspectNativeCredentialAwarePersistenceRuntime,
  openNativeCredentialRequiredApplicationSession,
  replaceNativeAuthenticatedDevelopmentWritableSessionPassphrase,
  runNativeHizoFSConvergeTransition,
  runNativeHizoFSDisableTransition,
  runNativeHizoFSEnableTransition,
  runNativeHizoFSReencryptTransition,
  runNativeHizoFSResumeTransition,
  runNativeHizoFSReturnToPlainTransition,
  runNativeStableHizoFSRetiredPlainCleanup,
  runNativeStablePlainRetiredCleanup,
  type CredentialBoundApplicationSessionOpenResult,
} from '@/00-storage/service/naidan-opfs/production-persistence-runtime';
import { reportHizoFSTrialDebug } from '@/00-storage/service/naidan-opfs/trial-debug';

type NativeApplicationSessionOptions = Parameters<typeof openNativeCredentialRequiredApplicationSession>[0];
type DevelopmentLockManager = NativeApplicationSessionOptions['lockManager'];
type DevelopmentRuntimePolicy = NativeApplicationSessionOptions['runtimePolicy'];

export class OpfsDevelopmentCredentialRejectedError extends Error {
  constructor() {
    super('HizoFS credential was rejected');
    this.name = 'OpfsDevelopmentCredentialRejectedError';
  }
}

export class OpfsDevelopmentPersistenceOperationUnavailableError extends Error {
  constructor({ operation }: { operation: string }) {
    super(`${operation} is not connected in the development HizoFS runtime`);
    this.name = 'OpfsDevelopmentPersistenceOperationUnavailableError';
  }
}

type DevelopmentRuntimePort = Readonly<{
  captureAuthority: ({ physical }: {
    physical: PersistenceControlReadablePhysicalPort;
  }) => Promise<CapturedPersistenceControlAuthority>;
  createBackend: ({ fileSystemSession }: {
    fileSystemSession: StorageFileSystemSession;
  }) => Promise<IStorageProvider>;
  changeSessionPassphrase: ({ fileSystemSession, recheckAuthority, replacementPassphrase }: {
    fileSystemSession: StorageFileSystemSession;
    recheckAuthority: () => Promise<void>;
    replacementPassphrase: string;
  }) => Promise<StorageFileSystemSession>;
  createPhysical: ({ storageRoot }: {
    storageRoot: FileSystemDirectoryHandle;
  }) => PersistenceControlReadablePhysicalPort;
  getNativeNamespaceRoot: () => Promise<FileSystemDirectoryHandle>;
  runConvergeTransition: ({ lockManager, nativeNamespaceRoot, passphrase, storageRoot }: {
    lockManager: DevelopmentLockManager;
    nativeNamespaceRoot: FileSystemDirectoryHandle;
    passphrase: string;
    storageRoot: FileSystemDirectoryHandle;
  }) => ReturnType<typeof runNativeHizoFSConvergeTransition>;
  runDisableTransition: ({ lockManager, nativeNamespaceRoot, onProgress, session, signal, storageRoot }: {
    lockManager: DevelopmentLockManager;
    nativeNamespaceRoot: FileSystemDirectoryHandle;
    onProgress: Parameters<OpfsPersistenceRuntime['runTransition']>[0]['onProgress'];
    session: import('@/00-storage/service/naidan-opfs/persistence-runtime-contract').OpfsPersistenceUnlockedSession;
    signal: AbortSignal | undefined;
    storageRoot: FileSystemDirectoryHandle;
  }) => Promise<StorageFileSystemSession>;
  runEnableTransition: ({ lockManager, nativeNamespaceRoot, onProgress, passphrase, signal, storageRoot }: {
    lockManager: DevelopmentLockManager;
    nativeNamespaceRoot: FileSystemDirectoryHandle;
    onProgress: Parameters<OpfsPersistenceRuntime['runTransition']>[0]['onProgress'];
    passphrase: string;
    signal: AbortSignal | undefined;
    storageRoot: FileSystemDirectoryHandle;
  }) => Promise<void>;
  runReencryptTransition: ({ lockManager, nativeNamespaceRoot, onProgress, retainedCredentials, session, signal, storageRoot }: {
    lockManager: DevelopmentLockManager;
    nativeNamespaceRoot: FileSystemDirectoryHandle;
    onProgress: Parameters<OpfsPersistenceRuntime['runTransition']>[0]['onProgress'];
    retainedCredentials: Extract<OpfsPersistenceTransitionRequest, { readonly operation: 'reencrypt' }>['retainedCredentials'];
    session: import('@/00-storage/service/naidan-opfs/persistence-runtime-contract').OpfsPersistenceUnlockedSession;
    signal: AbortSignal | undefined;
    storageRoot: FileSystemDirectoryHandle;
  }) => Promise<void>;
  runReturnToPlainTransition: ({ lockManager, nativeNamespaceRoot, onProgress, passphrase, runtimePolicy, signal, storageRoot }: {
    lockManager: DevelopmentLockManager;
    nativeNamespaceRoot: FileSystemDirectoryHandle;
    onProgress: Parameters<OpfsPersistenceRuntime['runTransition']>[0]['onProgress'];
    passphrase: string;
    runtimePolicy: DevelopmentRuntimePolicy;
    signal: AbortSignal | undefined;
    storageRoot: FileSystemDirectoryHandle;
  }) => ReturnType<typeof runNativeHizoFSReturnToPlainTransition>;
  runStablePlainRetiredCleanup: ({ lockManager, nativeNamespaceRoot, storageRoot }: {
    lockManager: DevelopmentLockManager;
    nativeNamespaceRoot: FileSystemDirectoryHandle;
    storageRoot: FileSystemDirectoryHandle;
  }) => Promise<void>;
  runStableHizoFSRetiredPlainCleanup: ({ lockManager, nativeNamespaceRoot, session, storageRoot }: {
    lockManager: DevelopmentLockManager;
    nativeNamespaceRoot: FileSystemDirectoryHandle;
    session: import('@/00-storage/service/naidan-opfs/persistence-runtime-contract').OpfsPersistenceUnlockedSession;
    storageRoot: FileSystemDirectoryHandle;
  }) => ReturnType<typeof runNativeStableHizoFSRetiredPlainCleanup>;
  runResumeTransition: ({ lockManager, nativeNamespaceRoot, onProgress, retainedCredentials, runtimePolicy, signal, storageRoot }: {
    lockManager: DevelopmentLockManager;
    nativeNamespaceRoot: FileSystemDirectoryHandle;
    onProgress: Parameters<OpfsPersistenceRuntime['runTransition']>[0]['onProgress'];
    retainedCredentials: readonly OpfsPersistenceRetainedCredential[];
    runtimePolicy: DevelopmentRuntimePolicy;
    signal: AbortSignal | undefined;
    storageRoot: FileSystemDirectoryHandle;
  }) => ReturnType<typeof runNativeHizoFSResumeTransition>;
  inspect: ({ nativeNamespaceRoot, physical }: {
    nativeNamespaceRoot: FileSystemDirectoryHandle;
    physical: PersistenceControlReadablePhysicalPort;
  }) => Promise<OpfsEncryptionInspection>;
  openApplicationSession: ({ captured, lockManager, nativeNamespaceRoot, passphrase, physical, runtimePolicy }: {
    captured: CapturedPersistenceControlAuthority;
    lockManager: DevelopmentLockManager;
    nativeNamespaceRoot: FileSystemDirectoryHandle;
    passphrase: string;
    physical: PersistenceControlReadablePhysicalPort;
    runtimePolicy: DevelopmentRuntimePolicy;
  }) => Promise<CredentialBoundApplicationSessionOpenResult>;
}>;

const DEFAULT_DEVELOPMENT_RUNTIME_POLICY: DevelopmentRuntimePolicy = Object.freeze({
  maxDirectoryIteratorEntries: 4_096,
  maxHeldLockNames: 1_024,
  maxMaintenanceRootRegistrations: 1_024,
  maxReaderPins: 256,
  maxSegmentReferences: 4_096,
});

const browserPort: DevelopmentRuntimePort = Object.freeze({
  captureAuthority: captureNativePersistenceControlAuthority,
  changeSessionPassphrase: async ({ fileSystemSession, recheckAuthority, replacementPassphrase }) => (
    await replaceNativeAuthenticatedDevelopmentWritableSessionPassphrase({
      recheckAuthority,
      replacementPassphrase,
      session: fileSystemSession,
    })
  ),
  createBackend: async ({ fileSystemSession }) => {
    const backend = new NaidanOpfsStorageBackend({
      hostVolumeDB: new HostVolumeDB(),
      namespaceRoot: fileSystemSession.root,
    });
    await backend.init();
    return backend;
  },
  createPhysical: createOpfsPersistenceControlReadablePhysicalPort,
  getNativeNamespaceRoot: async () => await navigator.storage.getDirectory(),
  runConvergeTransition: async ({ lockManager, nativeNamespaceRoot, passphrase, storageRoot }) => (
    await runNativeHizoFSConvergeTransition({ lockManager, nativeNamespaceRoot, passphrase, storageRoot })
  ),
  runDisableTransition: async ({ lockManager, nativeNamespaceRoot, onProgress, session, signal, storageRoot }) => (
    await runNativeHizoFSDisableTransition({ lockManager, nativeNamespaceRoot, onProgress, session, signal, storageRoot })
  ),
  runEnableTransition: async ({ lockManager, nativeNamespaceRoot, onProgress, passphrase, signal, storageRoot }) => {
    await runNativeHizoFSEnableTransition({ lockManager, nativeNamespaceRoot, onProgress, passphrase, signal, storageRoot });
  },
  runReencryptTransition: async ({ lockManager, nativeNamespaceRoot, onProgress, retainedCredentials, session, signal, storageRoot }) => {
    await runNativeHizoFSReencryptTransition({
      lockManager,
      nativeNamespaceRoot,
      onProgress,
      retainedCredentials,
      session,
      signal,
      storageRoot,
    });
  },
  runReturnToPlainTransition: async ({ lockManager, nativeNamespaceRoot, onProgress, passphrase, runtimePolicy, signal, storageRoot }) => (
    await runNativeHizoFSReturnToPlainTransition({
      lockManager,
      nativeNamespaceRoot,
      onProgress,
      passphrase,
      runtimePolicy,
      signal,
      storageRoot,
    })
  ),
  runStableHizoFSRetiredPlainCleanup: runNativeStableHizoFSRetiredPlainCleanup,
  runStablePlainRetiredCleanup: runNativeStablePlainRetiredCleanup,
  runResumeTransition: async ({ lockManager, nativeNamespaceRoot, onProgress, retainedCredentials, runtimePolicy, signal, storageRoot }) => (
    await runNativeHizoFSResumeTransition({
      lockManager,
      nativeNamespaceRoot,
      onProgress,
      retainedCredentials,
      runtimePolicy,
      signal,
      storageRoot,
    })
  ),
  inspect: inspectNativeCredentialAwarePersistenceRuntime,
  openApplicationSession: openNativeCredentialRequiredApplicationSession,
});

async function closeUnlockedResources({ backend, fileSystemSession }: {
  backend: IStorageProvider;
  fileSystemSession: StorageFileSystemSession;
}): Promise<void> {
  const failures: unknown[] = [];
  try {
    await backend.dispose();
  } catch (cause: unknown) {
    failures.push(cause);
  }
  try {
    await fileSystemSession.close();
  } catch (cause: unknown) {
    failures.push(cause);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'development HizoFS session cleanup failed');
}

async function createDevelopmentUnlockedSession({ opened, port }: {
  opened: Extract<CredentialBoundApplicationSessionOpenResult, { readonly type: 'opened' }>;
  port: DevelopmentRuntimePort;
}): Promise<import('@/00-storage/service/naidan-opfs/persistence-runtime-contract').OpfsPersistenceUnlockedSession> {
  let backend: IStorageProvider;
  try {
    backend = await port.createBackend({ fileSystemSession: opened.fileSystemSession });
  } catch (cause: unknown) {
    try {
      await opened.fileSystemSession.close();
    } catch (closeCause: unknown) {
      throw new AggregateError(
        [cause, closeCause],
        'development HizoFS backend initialization and cleanup failed',
      );
    }
    throw cause;
  }
  let closed = false;
  return {
    backend,
    close: async () => {
      if (closed) return;
      closed = true;
      await closeUnlockedResources({ backend, fileSystemSession: opened.fileSystemSession });
    },
    writableProfile: 'development-unverified',
    fileSystemId: opened.fileSystemId,
    fileSystemSession: opened.fileSystemSession,
  };
}

async function openEncryptedTransitionResult({ lockManager, nativeNamespaceRoot, passphrase, port, runtimePolicy, storageRoot }: {
  lockManager: DevelopmentLockManager;
  nativeNamespaceRoot: FileSystemDirectoryHandle;
  passphrase: string;
  port: DevelopmentRuntimePort;
  runtimePolicy: DevelopmentRuntimePolicy;
  storageRoot: FileSystemDirectoryHandle;
}): Promise<Extract<Awaited<ReturnType<OpfsPersistenceRuntime['runTransition']>>, { type: 'encrypted' }>> {
  const physical = port.createPhysical({ storageRoot });
  const captured = await port.captureAuthority({ physical });
  const opened = await port.openApplicationSession({
    captured,
    lockManager,
    nativeNamespaceRoot,
    passphrase,
    physical,
    runtimePolicy,
  });
  switch (opened.type) {
  case 'credential_rejected': throw new OpfsDevelopmentCredentialRejectedError();
  case 'opened': return { session: await createDevelopmentUnlockedSession({ opened, port }), type: 'encrypted' };
  default: return opened satisfies never;
  }
}

async function openPlainTransitionResult({ fileSystemSession, port }: {
  fileSystemSession: StorageFileSystemSession;
  port: DevelopmentRuntimePort;
}): Promise<Extract<Awaited<ReturnType<OpfsPersistenceRuntime['runTransition']>>, { type: 'plain' }>> {
  let backend: IStorageProvider;
  try {
    backend = await port.createBackend({ fileSystemSession });
  } catch (cause: unknown) {
    try {
      await fileSystemSession.close();
    } catch (closeCause: unknown) {
      throw new AggregateError([cause, closeCause], 'development plain backend initialization and cleanup failed');
    }
    throw cause;
  }
  return { backend, fileSystemSession, type: 'plain' };
}

function unavailableTransition({ request }: {
  request: OpfsPersistenceTransitionRequest;
}): never {
  throw new OpfsDevelopmentPersistenceOperationUnavailableError({
    operation: `OPFS ${request.operation} transition`,
  });
}

/**
 * Connects unreleased writable HizoFS to Naidan's ordinary provider path.
 *
 * This composition deliberately preserves the `development-unverified` label:
 * it executes the real mutation/publication protocol but cannot satisfy a
 * public release durability gate. Native enable and disable use the
 * authenticated transition coordinator. Interrupted enable, disable, and
 * re-encrypt resume from operation-bound progress without replacing the persisted
 * Operation ID or endpoint identities. Explicit interrupted-encrypt return-to-plain
 * is connected. Native re-encrypt rotates the Root Key while retaining only the
 * explicitly proven credential set supplied by the caller.
 */
function createDevelopmentOpfsPersistenceRuntimeWith({ lockManager, port, runtimePolicy }: {
  lockManager: DevelopmentLockManager;
  port: DevelopmentRuntimePort;
  runtimePolicy: DevelopmentRuntimePolicy;
}): OpfsPersistenceRuntime {
  return {
    writableProfile: 'development-unverified',
    inspect: async ({ storageRoot }) => {
      const nativeNamespaceRoot = await port.getNativeNamespaceRoot();
      const physical = port.createPhysical({ storageRoot });
      return await port.inspect({ nativeNamespaceRoot, physical });
    },
    runStartupMaintenance: async ({ nativeNamespaceRoot, storageRoot }) => {
      await port.runStablePlainRetiredCleanup({ lockManager, nativeNamespaceRoot, storageRoot });
    },
    runUnlockedMaintenance: async ({ nativeNamespaceRoot, session, storageRoot }) => (
      await port.runStableHizoFSRetiredPlainCleanup({
        lockManager,
        nativeNamespaceRoot,
        session,
        storageRoot,
      })
    ),
    unlockWithPassphrase: async ({ passphrase, storageRoot }) => {
      reportHizoFSTrialDebug({
        detail: { event: 'unlock', fileSystemId: undefined, stage: 'started' },
        level: 'info',
      });
      const nativeNamespaceRoot = await port.getNativeNamespaceRoot();
      const physical = port.createPhysical({ storageRoot });
      const captured = await port.captureAuthority({ physical });
      const opened = await port.openApplicationSession({
        captured,
        lockManager,
        nativeNamespaceRoot,
        passphrase,
        physical,
        runtimePolicy,
      });
      switch (opened.type) {
      case 'credential_rejected': throw new OpfsDevelopmentCredentialRejectedError();
      case 'opened': {
        reportHizoFSTrialDebug({
          detail: { event: 'unlock', fileSystemId: opened.fileSystemId, stage: 'authority_opened' },
          level: 'info',
        });
        return await createDevelopmentUnlockedSession({ opened, port });
      }
      default: return opened satisfies never;
      }
    },
    changePassphrase: async ({ passphrase, session, storageRoot }) => {
      const physical = port.createPhysical({ storageRoot });
      const captured = await port.captureAuthority({ physical });
      const fileSystemSession = await port.changeSessionPassphrase({
        fileSystemSession: session.fileSystemSession,
        recheckAuthority: async () => await recheckPersistenceControlAuthority({ captured, physical }),
        replacementPassphrase: passphrase,
      });
      if (fileSystemSession !== session.fileSystemSession) {
        throw new TypeError('credential update replaced the active HizoFS application session');
      }
      return session;
    },
    runTransition: async ({ nativeNamespaceRoot, onProgress, request, signal, storageRoot }) => {
      switch (request.operation) {
      case 'enable': {
        await port.runEnableTransition({
          lockManager,
          nativeNamespaceRoot,
          onProgress,
          passphrase: request.passphrase,
          signal,
          storageRoot,
        });
        return await openEncryptedTransitionResult({
          lockManager,
          nativeNamespaceRoot,
          passphrase: request.passphrase,
          port,
          runtimePolicy,
          storageRoot,
        });
      }
      case 'converge': {
        const credential = request.retainedCredentials[0];
        if (credential === undefined || request.retainedCredentials.length !== 1) {
          throw new RangeError('OPFS transition convergence requires exactly one credential');
        }
        const converged = await port.runConvergeTransition({
          lockManager,
          nativeNamespaceRoot,
          passphrase: credential.passphrase,
          storageRoot,
        });
        switch (converged.type) {
        case 'credential_rejected': throw new OpfsDevelopmentCredentialRejectedError();
        case 'converged_encrypted': return await openEncryptedTransitionResult({
          lockManager,
          nativeNamespaceRoot,
          passphrase: credential.passphrase,
          port,
          runtimePolicy,
          storageRoot,
        });
        case 'converged_plain': return await openPlainTransitionResult({
          fileSystemSession: converged.fileSystemSession,
          port,
        });
        default: return converged satisfies never;
        }
      }
      case 'resume': {
        const resumed = await port.runResumeTransition({
          lockManager,
          nativeNamespaceRoot,
          onProgress,
          retainedCredentials: request.retainedCredentials,
          runtimePolicy,
          signal,
          storageRoot,
        });
        switch (resumed.type) {
        case 'credential_rejected': throw new OpfsDevelopmentCredentialRejectedError();
        case 'resumed_encrypted': {
          const credential = request.retainedCredentials[0];
          if (credential === undefined) {
            throw new RangeError('OPFS transition resume requires at least one credential');
          }
          return await openEncryptedTransitionResult({
            lockManager,
            nativeNamespaceRoot,
            passphrase: credential.passphrase,
            port,
            runtimePolicy,
            storageRoot,
          });
        }
        case 'resumed_plain': return await openPlainTransitionResult({
          fileSystemSession: resumed.fileSystemSession,
          port,
        });
        default: return resumed satisfies never;
        }
      }
      case 'disable': {
        const fileSystemSession = await port.runDisableTransition({
          lockManager,
          nativeNamespaceRoot,
          onProgress,
          session: request.session,
          signal,
          storageRoot,
        });
        return await openPlainTransitionResult({ fileSystemSession, port });
      }
      case 'return_to_plain': {
        const returned = await port.runReturnToPlainTransition({
          lockManager,
          nativeNamespaceRoot,
          onProgress,
          passphrase: request.passphrase,
          runtimePolicy,
          signal,
          storageRoot,
        });
        switch (returned.type) {
        case 'credential_rejected': throw new OpfsDevelopmentCredentialRejectedError();
        case 'returned_plain': return await openPlainTransitionResult({
          fileSystemSession: returned.fileSystemSession,
          port,
        });
        default: return returned satisfies never;
        }
      }
      case 'reencrypt': {
        const firstRetainedCredential = request.retainedCredentials[0];
        if (firstRetainedCredential === undefined) {
          throw new RangeError('OPFS re-encrypt requires at least one retained credential');
        }
        await port.runReencryptTransition({
          lockManager,
          nativeNamespaceRoot,
          onProgress,
          retainedCredentials: request.retainedCredentials,
          session: request.session,
          signal,
          storageRoot,
        });
        return await openEncryptedTransitionResult({
          lockManager,
          nativeNamespaceRoot,
          passphrase: firstRetainedCredential.passphrase,
          port,
          runtimePolicy,
          storageRoot,
        });
      }
      case 'debug_interrupt_disable':
      case 'debug_interrupt_enable': return unavailableTransition({ request });
      default: return request satisfies never;
      }
    },
  };
}

export function createDevelopmentOpfsPersistenceRuntime({ lockManager, runtimePolicy }: {
  lockManager: DevelopmentLockManager;
  runtimePolicy: DevelopmentRuntimePolicy;
}): OpfsPersistenceRuntime {
  return createDevelopmentOpfsPersistenceRuntimeWith({ lockManager, port: browserPort, runtimePolicy });
}

export function installDevelopmentUnverifiedOpfsPersistenceRuntime({
  lockManager = navigator.locks,
}: {
  lockManager?: DevelopmentLockManager;
} = {}): () => void {
  console.warn('[hizofs-development]', {
    releaseDurabilityQualification: 'not-demonstrated',
    writableProfile: 'development-unverified',
  });
  return installOpfsPersistenceRuntimeFactory({
    factory: async () => createDevelopmentOpfsPersistenceRuntime({
      lockManager,
      runtimePolicy: DEFAULT_DEVELOPMENT_RUNTIME_POLICY,
    }),
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  createDevelopmentOpfsPersistenceRuntimeWith,
};
