import { describe, expect, it, vi } from 'vitest';

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
  maxDirectoryIteratorEntries: 32,
  maxHeldLockNames: 64,
  maxMaintenanceRootRegistrations: 32,
  maxReaderPins: 16,
  maxSegmentReferences: 16,
};

const lockManager = {} as RuntimeOptions['lockManager'];
const storageRoot = {} as FileSystemDirectoryHandle;
const nativeNamespaceRoot = {} as FileSystemDirectoryHandle;
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
  openedSession = fileSystemSession(),
  openType = 'opened',
}: {
  applicationBackend?: IStorageProvider;
  backendFailure?: unknown;
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
    runStableHizoFSRetiredPlainCleanup: vi.fn(async () => ({
      remainingEntryCount: 0,
      removedEntryCount: 0,
      state: 'completed' as const,
    })),
    runStablePlainRetiredCleanup: vi.fn(async () => undefined),
    runReturnToPlainTransition: vi.fn(async () => ({ type: 'returned_plain' as const })),
    openApplicationSession: vi.fn(async () => {
      if (openType === 'credential_rejected') return { type: 'credential_rejected' } as const;
      const fileSystemId = 'abcdefghijklmnopqrstu' as FileSystemId;
      return {
        authoritativeEndpoint: { fileSystemId, type: 'hizofs' } as const,
        fileSystemId,
        fileSystemSession: openedSession,
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

  it('removes retired HizoFS containers before cleaning the retired plain namespace', async () => {
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
    expect(runtimePort.runStableHizoFSRetiredPlainCleanup).toHaveBeenCalledWith({
      lockManager,
      nativeNamespaceRoot,
      session,
      storageRoot,
    });
    const retiredContainerCleanup = vi.mocked(runtimePort.runStableHizoFSRetiredContainerCleanup);
    const retiredPlainCleanup = vi.mocked(runtimePort.runStableHizoFSRetiredPlainCleanup);
    expect(
      retiredContainerCleanup.mock.invocationCallOrder[0],
    ).toBeLessThan(retiredPlainCleanup.mock.invocationCallOrder[0] ?? 0);
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
    const runtimePort = port({ applicationBackend, openedSession });
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
  });

  it('closes the opened filesystem session when backend initialization fails', async () => {
    const openedSession = fileSystemSession();
    const failure = new Error('backend init failed');
    const runtimePort = port({ backendFailure: failure, openedSession });
    const subject = runtime({ runtimePort });

    await expect(subject.unlockWithPassphrase({ passphrase: 'passphrase', storageRoot }))
      .rejects.toBe(failure);
    expect(openedSession.close).toHaveBeenCalledTimes(1);
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

  it('runs native disable without constructing a plain application session', async () => {
    const runtimePort = port();
    const subject = runtime({ runtimePort });
    const opened = await subject.unlockWithPassphrase({ passphrase: 'passphrase', storageRoot });

    await expect(subject.runTransition({
      nativeNamespaceRoot,
      onProgress: undefined,
      request: { operation: 'disable', session: opened },
      signal: undefined,
      storageRoot,
    })).resolves.toEqual({ type: 'completed' });
    expect(runtimePort.runDisableTransition).toHaveBeenCalledWith({
      lockManager,
      nativeNamespaceRoot,
      onProgress: undefined,
      session: opened,
      signal: undefined,
      storageRoot,
    });
    expect(runtimePort.createBackend).toHaveBeenCalledTimes(1);
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

  it('replaces the active session passphrase without replacing the application session', async () => {
    const openedSession = fileSystemSession();
    const applicationBackend = backend();
    const runtimePort = port({ applicationBackend, openedSession });
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
