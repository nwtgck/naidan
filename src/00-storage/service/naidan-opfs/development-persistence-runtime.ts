import type { IStorageProvider } from '@/00-storage/service/interface';
import { HostVolumeDB } from '@/00-storage/service/opfs/host-volume-db';
import type { StorageFileSystemSession } from '@/00-storage/service/storage-file-system/types';
import { recheckPersistenceControlAuthority } from '@/00-storage/service/naidan-persistence-control/store/persistence-control-authority-handshake';
import type { CapturedPersistenceControlAuthority } from '@/00-storage/service/naidan-persistence-control/store/persistence-control-authority-handshake';
import type { PersistenceControlReadablePhysicalPort } from '@/00-storage/service/naidan-persistence-control/store';
import { NaidanOpfsStorageBackend } from '@/00-storage/service/naidan-opfs/backend';
import { createOpfsPersistenceControlReadablePhysicalPort } from '@/00-storage/service/naidan-opfs/opfs-persistence-control-readable-port';
import { listNativePlainApplicationNamespaceEntryNames } from '@/00-storage/service/naidan-opfs/native-plain-application-namespace';
import { installOpfsPersistenceRuntimeFactory } from '@/00-storage/service/naidan-opfs/persistence-runtime-registry';
import type {
  OpfsEncryptionInspection,
  OpfsPersistenceRuntime,
  OpfsPersistenceTransitionRequest,
} from '@/00-storage/service/naidan-opfs/persistence-runtime-contract';
import {
  captureNativePersistenceControlAuthority,
  inspectNativeCredentialAwarePersistenceRuntime,
  NAIDAN_HIZOFS_LAZY_DURABILITY_POLICY,
  openNativeCredentialRequiredApplicationSession,
  replaceNativeAuthenticatedDevelopmentWritableSessionPassphrase,
  runNativeHizoFSConvergeTransition,
  runNativeHizoFSDisableTransition,
  runNativeHizoFSEnableTransition,
  runNativeHizoFSReencryptTransition,
  runNativeHizoFSReturnToPlainTransition,
  runNativeStableHizoFSRetiredContainerCleanup,
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

type DevelopmentRuntimePort = Readonly<{
  captureAuthority: ({ physical }: {
    physical: PersistenceControlReadablePhysicalPort;
  }) => Promise<CapturedPersistenceControlAuthority>;
  createBackend: ({ fileSystemSession }: {
    fileSystemSession: StorageFileSystemSession;
  }) => Promise<IStorageProvider>;
  // The HizoFS credential-publication implementation owns writer acquisition
  // and its management clean-head barrier. Wrapping this call in a second
  // barrier would invert the required writer-before-barrier ordering.
  changeSessionPassphrase: ({ fileSystemSession, recheckAuthority, replacementPassphrase }: {
    fileSystemSession: StorageFileSystemSession;
    recheckAuthority: () => Promise<void>;
    replacementPassphrase: string;
  }) => Promise<StorageFileSystemSession>;
  createPhysical: ({ storageRoot }: {
    storageRoot: FileSystemDirectoryHandle;
  }) => PersistenceControlReadablePhysicalPort;
  getNativeNamespaceRoot: () => Promise<FileSystemDirectoryHandle>;
  runConvergeTransition: ({ lockManager, nativeNamespaceRoot, passphrase, signal, storageRoot }: {
    lockManager: DevelopmentLockManager;
    nativeNamespaceRoot: FileSystemDirectoryHandle;
    passphrase: string;
    signal: AbortSignal | undefined;
    storageRoot: FileSystemDirectoryHandle;
  }) => ReturnType<typeof runNativeHizoFSConvergeTransition>;
  runDisableTransition: ({ lockManager, nativeNamespaceRoot, onProgress, session, signal, storageRoot }: {
    lockManager: DevelopmentLockManager;
    nativeNamespaceRoot: FileSystemDirectoryHandle;
    onProgress: Parameters<OpfsPersistenceRuntime['runTransition']>[0]['onProgress'];
    session: import('@/00-storage/service/naidan-opfs/persistence-runtime-contract').OpfsPersistenceUnlockedSession;
    signal: AbortSignal | undefined;
    storageRoot: FileSystemDirectoryHandle;
  }) => Promise<void>;
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
  runStableHizoFSRetiredContainerCleanup: ({ lockManager, nativeNamespaceRoot, session, storageRoot }: {
    lockManager: DevelopmentLockManager;
    nativeNamespaceRoot: FileSystemDirectoryHandle;
    session: import('@/00-storage/service/naidan-opfs/persistence-runtime-contract').OpfsPersistenceUnlockedSession;
    storageRoot: FileSystemDirectoryHandle;
  }) => ReturnType<typeof runNativeStableHizoFSRetiredContainerCleanup>;
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

let didWarnAboutDevelopmentProfile = false;

const DEFAULT_DEVELOPMENT_RUNTIME_POLICY: DevelopmentRuntimePolicy = Object.freeze({
  lazyDurability: NAIDAN_HIZOFS_LAZY_DURABILITY_POLICY,
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
  runConvergeTransition: async ({ lockManager, nativeNamespaceRoot, passphrase, signal, storageRoot }) => (
    await runNativeHizoFSConvergeTransition({ lockManager, nativeNamespaceRoot, passphrase, signal, storageRoot })
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
  runStableHizoFSRetiredContainerCleanup: runNativeStableHizoFSRetiredContainerCleanup,
  runStablePlainRetiredCleanup: runNativeStablePlainRetiredCleanup,
  inspect: inspectNativeCredentialAwarePersistenceRuntime,
  openApplicationSession: openNativeCredentialRequiredApplicationSession,
});

async function runWithManagementCleanHeadBarrierRetainedForSessionShutdown<Result>({ operation, session }: {
  operation: () => Promise<Result>;
  session: import('@/00-storage/service/naidan-opfs/persistence-runtime-contract').OpfsPersistenceUnlockedSession;
}): Promise<Result> {
  const barrier = session.openManagementCleanHeadBarrier();
  await barrier.ensureCleanHead();
  // WHY: authority-switch operations must not reopen the retired source
  // runtime between publication and provider teardown. The session close path
  // releases this barrier only after the filesystem session is closed.
  return await operation();
}

async function createDevelopmentUnlockedSession({ opened, port }: {
  opened: Extract<CredentialBoundApplicationSessionOpenResult, { readonly type: 'opened' }>;
  port: DevelopmentRuntimePort;
}): Promise<import('@/00-storage/service/naidan-opfs/persistence-runtime-contract').OpfsPersistenceUnlockedSession> {
  let backend: IStorageProvider;
  try {
    backend = await port.createBackend({ fileSystemSession: opened.fileSystemSession });
  } catch (cause: unknown) {
    const cleanupFailures: unknown[] = [];
    try {
      await opened.fileSystemSession.close();
    } catch (closeCause: unknown) {
      cleanupFailures.push(closeCause);
    }
    try {
      await opened.gracefullyShutdownRuntime();
    } catch (shutdownCause: unknown) {
      cleanupFailures.push(shutdownCause);
    }
    if (cleanupFailures.length !== 0) {
      throw new AggregateError(
        [cause, ...cleanupFailures],
        'development HizoFS backend initialization and cleanup failed',
      );
    }
    throw cause;
  }
  let activeManagementBarrier: import('@/00-storage/service/naidan-opfs/persistence-runtime-contract').OpfsPersistenceManagementCleanHeadBarrier | undefined;
  let activeManagementBarrierHasCleanHead = false;
  let backendDisposed = false;
  let fileSystemSessionClosed = false;
  let runtimeShutdown = false;
  let closeOperation: Promise<void> | undefined;
  const openManagementCleanHeadBarrier = (): import('@/00-storage/service/naidan-opfs/persistence-runtime-contract').OpfsPersistenceManagementCleanHeadBarrier => {
    const existing = activeManagementBarrier;
    if (existing !== undefined) return existing;
    const underlying = opened.openManagementCleanHeadBarrier();
    let released = false;
    const barrier = Object.freeze({
      ensureCleanHead: async () => {
        if (released) throw new TypeError('management clean-head barrier is already released');
        await underlying.ensureCleanHead();
        activeManagementBarrierHasCleanHead = true;
      },
      release: () => {
        if (released) throw new TypeError('management clean-head barrier is already released');
        underlying.release();
        released = true;
        if (activeManagementBarrier === barrier) {
          activeManagementBarrier = undefined;
          activeManagementBarrierHasCleanHead = false;
        }
      },
    });
    activeManagementBarrier = barrier;
    return barrier;
  };
  const close = async (): Promise<void> => {
    if (backendDisposed && fileSystemSessionClosed && activeManagementBarrier === undefined && runtimeShutdown) return;
    const existing = closeOperation;
    if (existing !== undefined) return await existing;
    const operation = (async () => {
      const failures: unknown[] = [];
      if (!backendDisposed) {
        try {
          await backend.dispose();
          backendDisposed = true;
        } catch (cause: unknown) {
          failures.push(cause);
        }
      }
      if (!fileSystemSessionClosed && activeManagementBarrier === undefined) {
        openManagementCleanHeadBarrier();
      }
      if (!fileSystemSessionClosed
        && activeManagementBarrier !== undefined
        && !activeManagementBarrierHasCleanHead) {
        try {
          // WHY: normal provider close must settle accepted working state while
          // the application session still owns its publication capability.
          // Keep a failed barrier for fencing, but retry its settlement on the
          // next close attempt rather than stranding the session permanently.
          await activeManagementBarrier.ensureCleanHead();
        } catch (cause: unknown) {
          failures.push(cause);
        }
      }
      if (activeManagementBarrier !== undefined && activeManagementBarrierHasCleanHead) {
        // WHY: keep mutation admission fenced until the application session no
        // longer owns the retired/closing authority. Transition paths already
        // arrive here with a clean head; normal close establishes one above.
        if (!fileSystemSessionClosed) {
          try {
            await opened.fileSystemSession.close();
            fileSystemSessionClosed = true;
          } catch (cause: unknown) {
            failures.push(cause);
          }
        }
        if (fileSystemSessionClosed && activeManagementBarrier !== undefined) {
          try {
            activeManagementBarrier.release();
          } catch (cause: unknown) {
            failures.push(cause);
          }
        }
        if (fileSystemSessionClosed && activeManagementBarrier === undefined && !runtimeShutdown) {
          try {
            await opened.gracefullyShutdownRuntime();
            runtimeShutdown = true;
          } catch (cause: unknown) {
            failures.push(cause);
          }
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'development HizoFS session cleanup failed');
    })();
    closeOperation = operation;
    try {
      await operation;
    } finally {
      if (closeOperation === operation) closeOperation = undefined;
    }
  };
  return {
    backend,
    close,
    writableProfile: 'development-unverified',
    fileSystemId: opened.fileSystemId,
    fileSystemSession: opened.fileSystemSession,
    openManagementCleanHeadBarrier,
    openAuthenticatedInspectionSession: opened.openAuthenticatedInspectionSession,
  };
}

/**
 * Connects unreleased writable HizoFS to Naidan's ordinary provider path.
 *
 * This composition deliberately preserves the `development-unverified` label:
 * it executes the real mutation/publication protocol but cannot satisfy a
 * public release durability gate. Native enable and disable use the
 * authenticated transition coordinator. Transition work progress is scoped to
 * one runtime invocation; startup converges interrupted coarse authority before
 * a later user operation starts again from the selected source. Explicit
 * interrupted-encrypt return-to-plain is connected. Native re-encrypt rotates
 * the Root Key while retaining only the explicitly proven credential set.
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
    runUnlockedMaintenance: async ({ nativeNamespaceRoot, session, storageRoot }) => {
      // Retired-container cleanup owns Persistence Control publication and
      // removes only non-active container directories. Holding the active
      // filesystem management barrier here would block foreground mutations
      // for an opportunistic background task without protecting active roots.
      await port.runStableHizoFSRetiredContainerCleanup({
        lockManager,
        nativeNamespaceRoot,
        session,
        storageRoot,
      });
      return {
        remainingEntryCount: (await listNativePlainApplicationNamespaceEntryNames({ nativeNamespaceRoot })).length,
        removedEntryCount: 0,
        state: 'completed',
      };
    },
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
        return { type: 'completed' };
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
          signal,
          storageRoot,
        });
        switch (converged.type) {
        case 'credential_rejected': throw new OpfsDevelopmentCredentialRejectedError();
        case 'converged_encrypted':
        case 'converged_plain': return { type: 'completed' };
        default: return converged satisfies never;
        }
      }
      case 'disable': return await runWithManagementCleanHeadBarrierRetainedForSessionShutdown({
        operation: async () => {
          await port.runDisableTransition({
            lockManager,
            nativeNamespaceRoot,
            onProgress,
            session: request.session,
            signal,
            storageRoot,
          });
          return { type: 'completed' as const };
        },
        session: request.session,
      });
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
        case 'returned_plain': return { type: 'completed' };
        default: return returned satisfies never;
        }
      }
      case 'reencrypt': {
        if (request.retainedCredentials[0] === undefined) {
          throw new RangeError('OPFS re-encrypt requires at least one retained credential');
        }
        return await runWithManagementCleanHeadBarrierRetainedForSessionShutdown({
          operation: async () => {
            await port.runReencryptTransition({
              lockManager,
              nativeNamespaceRoot,
              onProgress,
              retainedCredentials: request.retainedCredentials,
              session: request.session,
              signal,
              storageRoot,
            });
            return { type: 'completed' as const };
          },
          session: request.session,
        });
      }
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

export function createDevelopmentUnverifiedOpfsPersistenceRuntime({ lockManager }: {
  lockManager: DevelopmentLockManager;
}): OpfsPersistenceRuntime {
  if (!didWarnAboutDevelopmentProfile) {
    didWarnAboutDevelopmentProfile = true;
    console.warn('[hizofs-development]', {
      releaseDurabilityQualification: 'not-demonstrated',
      writableProfile: 'development-unverified',
    });
  }
  return createDevelopmentOpfsPersistenceRuntime({
    lockManager,
    runtimePolicy: DEFAULT_DEVELOPMENT_RUNTIME_POLICY,
  });
}

export function installDevelopmentUnverifiedOpfsPersistenceRuntime({
  lockManager = navigator.locks,
}: {
  lockManager?: DevelopmentLockManager;
} = {}): () => void {
  return installOpfsPersistenceRuntimeFactory({
    factory: async () => createDevelopmentUnverifiedOpfsPersistenceRuntime({ lockManager }),
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  createDevelopmentOpfsPersistenceRuntimeWith,
};
