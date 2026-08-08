import { describe, expect, it, vi } from 'vitest';

import { NAIDAN_HIZOFS_LAZY_DURABILITY_POLICY } from '@/00-storage/service/naidan-opfs/production-persistence-runtime';
import type { IStorageProvider } from '@/00-storage/service/interface';
import type { CapturedPersistenceControlAuthority } from '@/00-storage/service/naidan-persistence-control/store/persistence-control-authority-handshake';
import type { PersistenceControlReadablePhysicalPort } from '@/00-storage/service/naidan-persistence-control/store';
import type { StorageDirectoryHandle, StorageFileSystemSession } from '@/00-storage/service/storage-file-system/types';
import {
  OpfsDevelopmentCredentialRejectedError,
  installDevelopmentUnverifiedOpfsPersistenceRuntime,
  TEST_ONLY,
} from '@/00-storage/service/naidan-opfs/development-persistence-runtime';
import {
  createInstalledOpfsPersistenceRuntime,
  TEST_ONLY as REGISTRY_TEST_ONLY,
} from '@/00-storage/service/naidan-opfs/persistence-runtime-registry';

type RuntimePort = Parameters<typeof TEST_ONLY.createDevelopmentOpfsPersistenceRuntimeWith>[0]['port'];

type FileSystemId = Extract<
  Awaited<ReturnType<RuntimePort['openApplicationSession']>>,
  { readonly type: 'opened' }
>['fileSystemId'];

type RuntimeOptions = Parameters<typeof TEST_ONLY.createDevelopmentOpfsPersistenceRuntimeWith>[0];

const runtimePolicy: RuntimeOptions['runtimePolicy'] = {
  lazyDurability: NAIDAN_HIZOFS_LAZY_DURABILITY_POLICY,
  maxDirectoryIteratorEntries: 32,
  maxHeldLockNames: 64,
  maxMaintenanceRootRegistrations: 32,
  maxReaderPins: 16,
  maxSegmentReferences: 16,
};

const lockManager = {} as RuntimeOptions['lockManager'];
const storageRoot = {} as FileSystemDirectoryHandle;
const nativeNamespaceRoot = {
  getDirectoryHandle: vi.fn(async () => {
    throw new DOMException('missing test storage root', 'NotFoundError');
  }),
} as unknown as FileSystemDirectoryHandle;
const physical = {} as PersistenceControlReadablePhysicalPort;
const captured = {} as CapturedPersistenceControlAuthority;

function fileSystemSession(): StorageFileSystemSession & { close: ReturnType<typeof vi.fn> } {
  return {
    capabilities: {
      atomicMove: 'supported',
      directBlob: 'unsupported',
      symbolicLink: 'supported',
      wholeFileClone: 'supported',
    },
    close: vi.fn(async () => undefined),
    root: {} as StorageDirectoryHandle,
    sync: vi.fn(async () => undefined),
  };
}

function backend(): IStorageProvider & { dispose: ReturnType<typeof vi.fn> } {
  return {
    dispose: vi.fn(async () => undefined),
  } as unknown as IStorageProvider & { dispose: ReturnType<typeof vi.fn> };
}

function port({
  applicationBackend = backend(),
  backendFailure,
  gracefullyShutdownRuntime = vi.fn(async () => undefined),
  managementEnsureCleanHead = vi.fn(async () => undefined),
  managementRelease = vi.fn(() => undefined),
  openedSession = fileSystemSession(),
  openType = 'opened',
}: {
  applicationBackend?: IStorageProvider;
  backendFailure?: unknown;
  gracefullyShutdownRuntime?: () => Promise<void>;
  managementEnsureCleanHead?: () => Promise<void>;
  managementRelease?: () => void;
  openedSession?: StorageFileSystemSession;
  openType?: 'credential_rejected' | 'opened';
} = {}): RuntimePort {
  return {
    captureAuthority: vi.fn(async () => captured),
    changeSessionPassphrase: vi.fn(async ({ fileSystemSession }) => fileSystemSession),
    createBackend: vi.fn(async () => {
      if (backendFailure !== undefined) throw backendFailure;
      return applicationBackend;
    }),
    createPhysical: vi.fn(() => physical),
    getNativeNamespaceRoot: vi.fn(async () => nativeNamespaceRoot),
    inspect: vi.fn(async () => ({ type: 'plain' } as const)) as unknown as RuntimePort['inspect'],
    runConvergeTransition: vi.fn(async () => ({
      fileSystemId: 'abcdefghijklmnopqrstu' as FileSystemId,
      type: 'converged_encrypted' as const,
    })),
    runDisableTransition: vi.fn(async () => undefined),
    runEnableTransition: vi.fn(async () => undefined),
    runReencryptTransition: vi.fn(async () => undefined),
    runStableHizoFSRetiredContainerCleanup: vi.fn(async () => undefined),
    runStablePlainRetiredCleanup: vi.fn(async () => undefined),
    runReturnToPlainTransition: vi.fn(async () => ({ type: 'returned_plain' as const })),
    openApplicationSession: vi.fn(async () => {
      if (openType === 'credential_rejected') return { type: 'credential_rejected' } as const;
      const fileSystemId = 'abcdefghijklmnopqrstu' as FileSystemId;
      return {
        authoritativeEndpoint: { fileSystemId, type: 'hizofs' } as const,
        fileSystemId,
        fileSystemSession: openedSession,
        gracefullyShutdownRuntime,
        openManagementCleanHeadBarrier: () => ({
          ensureCleanHead: managementEnsureCleanHead,
          release: managementRelease,
        }),
        selected: {} as never,
        type: 'opened',
      } as const;
    }) as unknown as RuntimePort['openApplicationSession'],
  };
}

function runtime({ runtimePort }: { runtimePort: RuntimePort }) {
  return TEST_ONLY.createDevelopmentOpfsPersistenceRuntimeWith({
    lockManager,
    port: runtimePort,
    runtimePolicy,
  });
}

describe('development-unverified OPFS Persistence runtime', () => {
  it('installs the development profile into the ordinary runtime registry', async () => {
    REGISTRY_TEST_ONLY.reset();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const uninstall = installDevelopmentUnverifiedOpfsPersistenceRuntime({ lockManager });
    try {
      await expect(createInstalledOpfsPersistenceRuntime()).resolves.toMatchObject({
        writableProfile: 'development-unverified',
      });
      expect(warning).toHaveBeenCalledWith('[hizofs-development]', {
        releaseDurabilityQualification: 'not-demonstrated',
        writableProfile: 'development-unverified',
      });
    } finally {
      uninstall();
      warning.mockRestore();
      REGISTRY_TEST_ONLY.reset();
    }
  });

  it('publishes an explicit development profile and delegates detached inspection', async () => {
    const runtimePort = port();
    const subject = runtime({ runtimePort });

    expect(subject.writableProfile).toBe('development-unverified');
    await expect(subject.inspect({ storageRoot })).resolves.toEqual({ type: 'plain' });
    expect(runtimePort.inspect).toHaveBeenCalledWith({ nativeNamespaceRoot, physical });
  });

  it('delegates stable plain startup maintenance without inspecting as a side effect', async () => {
    const runtimePort = port();
    const subject = runtime({ runtimePort });

    await subject.runStartupMaintenance({ nativeNamespaceRoot, storageRoot });

    expect(runtimePort.runStablePlainRetiredCleanup).toHaveBeenCalledWith({
      lockManager,
      nativeNamespaceRoot,
      storageRoot,
    });
    expect(runtimePort.inspect).not.toHaveBeenCalled();
  });

  it('removes retired HizoFS containers without deleting an unowned plain namespace', async () => {
    const runtimePort = port();
    const subject = runtime({ runtimePort });
    const session = await subject.unlockWithPassphrase({
      passphrase: 'correct horse battery staple',
      storageRoot,
    });

    await expect(subject.runUnlockedMaintenance({
      nativeNamespaceRoot,
      session,
      storageRoot,
    })).resolves.toEqual({
      remainingEntryCount: 0,
      removedEntryCount: 0,
      state: 'completed',
    });

    expect(runtimePort.runStableHizoFSRetiredContainerCleanup).toHaveBeenCalledWith({
      lockManager,
      nativeNamespaceRoot,
      session,
      storageRoot,
    });
  });

  it('maps only credential rejection to the explicit development error', async () => {
    const subject = runtime({ runtimePort: port({ openType: 'credential_rejected' }) });

    await expect(subject.unlockWithPassphrase({
      passphrase: 'wrong',
      storageRoot,
    })).rejects.toBeInstanceOf(OpfsDevelopmentCredentialRejectedError);
  });

  it('returns a writable provider session with idempotent complete cleanup', async () => {
    const openedSession = fileSystemSession();
    const applicationBackend = backend();
    const gracefullyShutdownRuntime = vi.fn(async () => undefined);
    const runtimePort = port({ applicationBackend, gracefullyShutdownRuntime, openedSession });
    const subject = runtime({ runtimePort });

    const opened = await subject.unlockWithPassphrase({
      passphrase: 'correct horse battery staple',
      storageRoot,
    });
    expect(opened.writableProfile).toBe('development-unverified');
    expect(opened.backend).toBe(applicationBackend);
    expect(opened.fileSystemSession).toBe(openedSession);
    expect(runtimePort.openApplicationSession).toHaveBeenCalledWith({
      captured,
      lockManager,
      nativeNamespaceRoot,
      passphrase: 'correct horse battery staple',
      physical,
      runtimePolicy,
    });

    await opened.close();
    await opened.close();
    expect(applicationBackend.dispose).toHaveBeenCalledTimes(1);
    expect(openedSession.close).toHaveBeenCalledTimes(1);
    expect(gracefullyShutdownRuntime).toHaveBeenCalledTimes(1);
  });

  it('preserves backend, session, and graceful shutdown failures during provider close', async () => {
    const backendFailure = new Error('backend dispose failed');
    const sessionFailure = new Error('session close failed');
    const shutdownFailure = new Error('runtime shutdown failed');
    const applicationBackend = backend();
    applicationBackend.dispose.mockRejectedValue(backendFailure);
    const openedSession = fileSystemSession();
    openedSession.close.mockRejectedValue(sessionFailure);
    const gracefullyShutdownRuntime = vi.fn(async () => {
      throw shutdownFailure;
    });
    const subject = runtime({
      runtimePort: port({ applicationBackend, gracefullyShutdownRuntime, openedSession }),
    });
    const opened = await subject.unlockWithPassphrase({ passphrase: 'passphrase', storageRoot });

    await expect(opened.close()).rejects.toMatchObject({
      errors: [backendFailure, sessionFailure],
    });
    expect(applicationBackend.dispose).toHaveBeenCalledOnce();
    expect(openedSession.close).toHaveBeenCalledOnce();
    // WHY: filesystem close failed while the clean-head barrier is retained,
    // so runtime disposal must wait for a later close retry.
    expect(gracefullyShutdownRuntime).not.toHaveBeenCalled();
  });

  it('retries a retained clean-head barrier before closing the session', async () => {
    const cleanHeadFailure = new Error('clean-head settlement failed once');
    const managementEnsureCleanHead = vi.fn()
      .mockRejectedValueOnce(cleanHeadFailure)
      .mockResolvedValueOnce(undefined);
    const managementRelease = vi.fn(() => undefined);
    const openedSession = fileSystemSession();
    const gracefullyShutdownRuntime = vi.fn(async () => undefined);
    const subject = runtime({
      runtimePort: port({
        gracefullyShutdownRuntime,
        managementEnsureCleanHead,
        managementRelease,
        openedSession,
      }),
    });
    const opened = await subject.unlockWithPassphrase({ passphrase: 'passphrase', storageRoot });

    await expect(opened.close()).rejects.toBe(cleanHeadFailure);
    expect(openedSession.close).not.toHaveBeenCalled();
    expect(managementRelease).not.toHaveBeenCalled();
    expect(gracefullyShutdownRuntime).not.toHaveBeenCalled();

    await expect(opened.close()).resolves.toBeUndefined();
    expect(managementEnsureCleanHead).toHaveBeenCalledTimes(2);
    expect(openedSession.close).toHaveBeenCalledOnce();
    expect(managementRelease).toHaveBeenCalledOnce();
    expect(gracefullyShutdownRuntime).toHaveBeenCalledOnce();
  });

  it('retains the transition barrier when filesystem close fails and completes shutdown on retry', async () => {
    const events: string[] = [];
    const closeFailure = new Error('session close failed once');
    const openedSession = fileSystemSession();
    openedSession.close
      .mockImplementationOnce(async () => {
        events.push('filesystem_close_failed');
        throw closeFailure;
      })
      .mockImplementationOnce(async () => {
        events.push('filesystem_close_succeeded');
      });
    const applicationBackend = backend();
    applicationBackend.dispose.mockImplementation(async () => {
      events.push('backend_dispose');
    });
    const managementRelease = vi.fn(() => {
      events.push('barrier_release');
    });
    const gracefullyShutdownRuntime = vi.fn(async () => {
      events.push('runtime_shutdown');
    });
    const runtimePort = port({
      applicationBackend,
      gracefullyShutdownRuntime,
      managementRelease,
      openedSession,
    });
    const subject = runtime({ runtimePort });
    const opened = await subject.unlockWithPassphrase({ passphrase: 'passphrase', storageRoot });
    await subject.runTransition({
      nativeNamespaceRoot,
      onProgress: undefined,
      request: { operation: 'disable', session: opened },
      signal: undefined,
      storageRoot,
    });

    await expect(opened.close()).rejects.toBe(closeFailure);
    expect(events).toEqual(['backend_dispose', 'filesystem_close_failed']);
    expect(managementRelease).not.toHaveBeenCalled();
    expect(gracefullyShutdownRuntime).not.toHaveBeenCalled();

    await expect(opened.close()).resolves.toBeUndefined();
    expect(events).toEqual([
      'backend_dispose',
      'filesystem_close_failed',
      'filesystem_close_succeeded',
      'barrier_release',
      'runtime_shutdown',
    ]);
    expect(applicationBackend.dispose).toHaveBeenCalledOnce();
  });

  it('closes the opened filesystem session when backend initialization fails', async () => {
    const openedSession = fileSystemSession();
    const failure = new Error('backend init failed');
    const gracefullyShutdownRuntime = vi.fn(async () => undefined);
    const runtimePort = port({ backendFailure: failure, gracefullyShutdownRuntime, openedSession });
    const subject = runtime({ runtimePort });

    await expect(subject.unlockWithPassphrase({ passphrase: 'passphrase', storageRoot }))
      .rejects.toBe(failure);
    expect(openedSession.close).toHaveBeenCalledTimes(1);
    expect(gracefullyShutdownRuntime).toHaveBeenCalledTimes(1);
  });

  it('runs native enable and returns a reload-only completion result', async () => {
    const runtimePort = port();
    const subject = runtime({ runtimePort });

    await expect(subject.runTransition({
      nativeNamespaceRoot,
      onProgress: undefined,
      request: { operation: 'enable', passphrase: 'passphrase' },
      signal: undefined,
      storageRoot,
    })).resolves.toEqual({ type: 'completed' });
    expect(runtimePort.runEnableTransition).toHaveBeenCalledWith({
      lockManager,
      nativeNamespaceRoot,
      onProgress: undefined,
      passphrase: 'passphrase',
      signal: undefined,
      storageRoot,
    });
    expect(runtimePort.openApplicationSession).not.toHaveBeenCalled();
  });

  it('converges an interrupted native enable without opening an application session', async () => {
    const runtimePort = port();
    const subject = runtime({ runtimePort });

    await expect(subject.runTransition({
      nativeNamespaceRoot,
      onProgress: undefined,
      request: { operation: 'converge', retainedCredentials: [{ passphrase: 'passphrase' }] },
      signal: undefined,
      storageRoot,
    })).resolves.toEqual({ type: 'completed' });
    expect(runtimePort.runConvergeTransition).toHaveBeenCalledWith({
      lockManager,
      nativeNamespaceRoot,
      passphrase: 'passphrase',
      storageRoot,
    });
    expect(runtimePort.openApplicationSession).not.toHaveBeenCalled();
  });

  it('converges an interrupted native disable without constructing a plain backend', async () => {
    const runtimePort = port();
    vi.mocked(runtimePort.runConvergeTransition).mockResolvedValue({ type: 'converged_plain' });
    const subject = runtime({ runtimePort });

    await expect(subject.runTransition({
      nativeNamespaceRoot,
      onProgress: undefined,
      request: { operation: 'converge', retainedCredentials: [{ passphrase: 'passphrase' }] },
      signal: undefined,
      storageRoot,
    })).resolves.toEqual({ type: 'completed' });
    expect(runtimePort.createBackend).not.toHaveBeenCalled();
  });

  it('maps a rejected convergence credential to the explicit development error', async () => {
    const runtimePort = port();
    vi.mocked(runtimePort.runConvergeTransition).mockResolvedValue({ type: 'credential_rejected' });

    await expect(runtime({ runtimePort }).runTransition({
      nativeNamespaceRoot,
      onProgress: undefined,
      request: { operation: 'converge', retainedCredentials: [{ passphrase: 'wrong' }] },
      signal: undefined,
      storageRoot,
    })).rejects.toBeInstanceOf(OpfsDevelopmentCredentialRejectedError);
    expect(runtimePort.openApplicationSession).not.toHaveBeenCalled();
  });

  it('holds the management barrier until the source session is closed after disable', async () => {
    const events: string[] = [];
    const openedSession = fileSystemSession();
    openedSession.close.mockImplementation(async () => {
      events.push('filesystem_close');
    });
    const applicationBackend = backend();
    applicationBackend.dispose.mockImplementation(async () => {
      events.push('backend_dispose');
    });
    const runtimePort = port({
      applicationBackend,
      gracefullyShutdownRuntime: vi.fn(async () => {
        events.push('runtime_shutdown');
      }),
      managementEnsureCleanHead: vi.fn(async () => {
        events.push('ensure');
      }),
      managementRelease: vi.fn(() => {
        events.push('barrier_release');
      }),
      openedSession,
    });
    vi.mocked(runtimePort.runDisableTransition).mockImplementation(async () => {
      events.push('transition');
    });
    const subject = runtime({ runtimePort });
    const opened = await subject.unlockWithPassphrase({ passphrase: 'passphrase', storageRoot });

    await expect(subject.runTransition({
      nativeNamespaceRoot,
      onProgress: undefined,
      request: { operation: 'disable', session: opened },
      signal: undefined,
      storageRoot,
    })).resolves.toEqual({ type: 'completed' });
    expect(events).toEqual(['ensure', 'transition']);
    expect(runtimePort.runDisableTransition).toHaveBeenCalledWith({
      lockManager,
      nativeNamespaceRoot,
      onProgress: undefined,
      session: opened,
      signal: undefined,
      storageRoot,
    });

    await opened.close();
    expect(events).toEqual([
      'ensure',
      'transition',
      'backend_dispose',
      'filesystem_close',
      'barrier_release',
      'runtime_shutdown',
    ]);
  });

  it('forwards the complete retained credential set without reopening after re-encryption', async () => {
    const runtimePort = port();
    const subject = runtime({ runtimePort });
    const opened = await subject.unlockWithPassphrase({ passphrase: 'current passphrase', storageRoot });

    await expect(subject.runTransition({
      nativeNamespaceRoot,
      onProgress: undefined,
      request: {
        operation: 'reencrypt',
        retainedCredentials: [
          { passphrase: 'current passphrase' },
          { passphrase: 'retained recovery passphrase' },
        ],
        session: opened,
      },
      signal: undefined,
      storageRoot,
    })).resolves.toEqual({ type: 'completed' });

    expect(runtimePort.runReencryptTransition).toHaveBeenCalledWith({
      lockManager,
      nativeNamespaceRoot,
      onProgress: undefined,
      retainedCredentials: [
        { passphrase: 'current passphrase' },
        { passphrase: 'retained recovery passphrase' },
      ],
      session: opened,
      signal: undefined,
      storageRoot,
    });
    expect(runtimePort.openApplicationSession).toHaveBeenCalledTimes(1);
    await opened.close();
  });

  it('rejects an empty retained credential set before invoking production re-encrypt', async () => {
    const runtimePort = port();
    const subject = runtime({ runtimePort });
    const opened = await subject.unlockWithPassphrase({ passphrase: 'current passphrase', storageRoot });

    await expect(subject.runTransition({
      nativeNamespaceRoot,
      onProgress: undefined,
      request: { operation: 'reencrypt', retainedCredentials: [], session: opened },
      signal: undefined,
      storageRoot,
    })).rejects.toThrow('requires at least one retained credential');
    expect(runtimePort.runReencryptTransition).not.toHaveBeenCalled();
    await opened.close();
  });

  it('returns an interrupted encrypt operation to plain without constructing a backend', async () => {
    const runtimePort = port();

    await expect(runtime({ runtimePort }).runTransition({
      nativeNamespaceRoot,
      onProgress: undefined,
      request: { operation: 'return_to_plain', passphrase: 'existing passphrase' },
      signal: undefined,
      storageRoot,
    })).resolves.toEqual({ type: 'completed' });
    expect(runtimePort.runReturnToPlainTransition).toHaveBeenCalledWith({
      lockManager,
      nativeNamespaceRoot,
      onProgress: undefined,
      passphrase: 'existing passphrase',
      runtimePolicy,
      signal: undefined,
      storageRoot,
    });
    expect(runtimePort.createBackend).not.toHaveBeenCalled();
  });

  it('maps rejected return-to-plain credentials to the explicit development error', async () => {
    const runtimePort = port();
    vi.mocked(runtimePort.runReturnToPlainTransition).mockResolvedValue({ type: 'credential_rejected' });

    await expect(runtime({ runtimePort }).runTransition({
      nativeNamespaceRoot,
      onProgress: undefined,
      request: { operation: 'return_to_plain', passphrase: 'wrong passphrase' },
      signal: undefined,
      storageRoot,
    })).rejects.toBeInstanceOf(OpfsDevelopmentCredentialRejectedError);
  });

  it('delegates passphrase replacement without opening a duplicate management barrier', async () => {
    const openedSession = fileSystemSession();
    const applicationBackend = backend();
    const events: string[] = [];
    const runtimePort = port({
      applicationBackend,
      managementEnsureCleanHead: vi.fn(async () => {
        events.push('ensure');
      }),
      managementRelease: vi.fn(() => {
        events.push('release');
      }),
      openedSession,
    });
    vi.mocked(runtimePort.changeSessionPassphrase).mockImplementation(async ({ fileSystemSession }) => {
      events.push('change');
      return fileSystemSession;
    });
    const subject = runtime({ runtimePort });
    const opened = await subject.unlockWithPassphrase({ passphrase: 'old passphrase', storageRoot });

    await expect(subject.changePassphrase({
      passphrase: 'replacement',
      session: opened,
      storageRoot,
    })).resolves.toBe(opened);
    expect(runtimePort.changeSessionPassphrase).toHaveBeenCalledWith({
      fileSystemSession: openedSession,
      recheckAuthority: expect.any(Function),
      replacementPassphrase: 'replacement',
    });
    expect(runtimePort.captureAuthority).toHaveBeenCalledTimes(2);
    expect(events).toEqual(['change']);
  });

  it('converges an interrupted transition without restoring work progress', async () => {
    const runtimePort = port();
    const subject = runtime({ runtimePort });

    await expect(subject.runTransition({
      nativeNamespaceRoot,
      onProgress: undefined,
      request: { operation: 'converge', retainedCredentials: [{ passphrase: 'passphrase' }] },
      signal: undefined,
      storageRoot,
    })).resolves.toEqual({ type: 'completed' });

    expect(runtimePort.runConvergeTransition).toHaveBeenCalledWith({
      lockManager,
      nativeNamespaceRoot,
      passphrase: 'passphrase',
      storageRoot,
    });
    expect(runtimePort.openApplicationSession).not.toHaveBeenCalled();
  });

  it('returns stable plain after pre-switch phase convergence', async () => {
    const runtimePort = port();
    vi.mocked(runtimePort.runConvergeTransition).mockResolvedValue({ type: 'converged_plain' });

    await expect(runtime({ runtimePort }).runTransition({
      nativeNamespaceRoot,
      onProgress: undefined,
      request: { operation: 'converge', retainedCredentials: [{ passphrase: 'passphrase' }] },
      signal: undefined,
      storageRoot,
    })).resolves.toEqual({ type: 'completed' });
    expect(runtimePort.createBackend).not.toHaveBeenCalled();
  });

  it('rejects convergence credential collections that are empty or ambiguous', async () => {
    const runtimePort = port();
    const subject = runtime({ runtimePort });

    await expect(subject.runTransition({
      nativeNamespaceRoot,
      onProgress: undefined,
      request: { operation: 'converge', retainedCredentials: [] },
      signal: undefined,
      storageRoot,
    })).rejects.toThrow('requires exactly one credential');
    await expect(subject.runTransition({
      nativeNamespaceRoot,
      onProgress: undefined,
      request: {
        operation: 'converge',
        retainedCredentials: [{ passphrase: 'first' }, { passphrase: 'second' }],
      },
      signal: undefined,
      storageRoot,
    })).rejects.toThrow('requires exactly one credential');
    expect(runtimePort.runConvergeTransition).not.toHaveBeenCalled();
  });

});
