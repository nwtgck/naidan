import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TEST_ONLY as PERSISTENCE_RUNTIME_TEST_ONLY, type OpfsPersistenceRuntime, type OpfsPersistenceUnlockedSession } from '@/00-storage/service/naidan-opfs/persistence-runtime-contract';
import { installOpfsPersistenceRuntimeFactory, TEST_ONLY as PERSISTENCE_RUNTIME_REGISTRY_TEST_ONLY } from '@/00-storage/service/naidan-opfs/persistence-runtime-registry';
import {
  openActiveAuthenticatedHizoFSContainerLocationLease,
  TEST_ONLY as ACTIVE_HIZOFS_LOCATION_TEST_ONLY,
} from '@/00-storage/service/naidan-opfs/active-hizofs-container-location';
import { naidanOpfsContainerOriginRelativePathComponents } from '@/00-storage/service/naidan-opfs/opfs-storage-location';
import { OPFSStorageProvider, TEST_ONLY as OPFS_STORAGE_TEST_ONLY } from './opfs-storage';
import { InMemoryWebLockManager } from '@/00-storage/service/test-support/in-memory-web-locks';

// --- Mocks for OPFS ---
class MockFileSystemFileHandle {
  kind = 'file' as const;
  constructor(public name: string, private content: string = '') {}
  getFile() {
    return Promise.resolve({
      text: () => Promise.resolve(this.content),
    });
  }
  createWritable() {
    return Promise.resolve({
      write: (data: string) => {
        this.content = data; return Promise.resolve();
      },
      close: () => Promise.resolve(),
    });
  }
}

class MockFileSystemDirectoryHandle {
  kind = 'directory' as const;
  public entries = new Map<string, MockFileSystemDirectoryHandle | MockFileSystemFileHandle>();

  constructor(public name: string) {}

  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    if (!this.entries.has(name)) {
      if (options?.create) {
        this.entries.set(name, new MockFileSystemDirectoryHandle(name));
      } else {
        const err = new Error(`Directory not found: ${name}`);
        err.name = 'NotFoundError';
        throw err;
      }
    }
    const entry = this.entries.get(name);
    if (entry?.kind !== 'directory') throw new Error(`Entry is not a directory: ${name}`);
    return entry;
  }

  async getFileHandle(name: string, options?: { create?: boolean }) {
    if (!this.entries.has(name)) {
      if (options?.create) {
        this.entries.set(name, new MockFileSystemFileHandle(name));
      } else {
        const err = new Error(`File not found: ${name}`);
        err.name = 'NotFoundError';
        throw err;
      }
    }
    const entry = this.entries.get(name);
    if (entry?.kind !== 'file') throw new Error(`Entry is not a file: ${name}`);
    return entry;
  }

  async removeEntry(name: string, _options?: { recursive?: boolean }) {
    this.entries.delete(name);
  }

  async *keys() {
    for (const key of this.entries.keys()) {
      yield key;
    }
  }
}

const mockOpfsRoot = new MockFileSystemDirectoryHandle('opfs-root');

describe('OPFS Persistence Control runtime composition', () => {
  beforeEach(() => {
    mockOpfsRoot.entries.clear();
    PERSISTENCE_RUNTIME_REGISTRY_TEST_ONLY.reset();
    ACTIVE_HIZOFS_LOCATION_TEST_ONLY.reset();
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: () => Promise.resolve(mockOpfsRoot),
      },
    });
  });

  it('allows return-to-plain authentication for an unresolved interrupted transition', () => {
    expect(() => OPFS_STORAGE_TEST_ONLY.requireReturnToPlainInspection({
      inspection: PERSISTENCE_RUNTIME_TEST_ONLY.createTransitionCredentialRequiredInspection({
        firstSequence: 3,
        secondSequence: 2,
      }),
    })).not.toThrow();
  });

  it('rejects stable unlock and known decrypt or re-encrypt transitions before return-to-plain', () => {
    expect(() => OPFS_STORAGE_TEST_ONLY.requireReturnToPlainInspection({
      inspection: PERSISTENCE_RUNTIME_TEST_ONLY.createCredentialRequiredInspection({
        firstSequence: 3,
        secondSequence: 2,
      }),
    })).toThrow('Stable encrypted OPFS storage');
    for (const operation of ['decrypt', 're_encrypt'] as const) {
      expect(() => OPFS_STORAGE_TEST_ONLY.requireReturnToPlainInspection({
        inspection: PERSISTENCE_RUNTIME_TEST_ONLY.createTransitioningInspection({
          operation,
          phase: 'building_target',
          sourceFileSystemId: 'returnPlainSource001',
          targetFileSystemId: operation === 're_encrypt' ? 'returnPlainTarget001' : undefined,
        }),
      })).toThrow('Only interrupted OPFS encryption');
    }
  });

  it('fails closed when a plain authority conflicts with an installed HizoFS session', () => {
    const fileSystemId = PERSISTENCE_RUNTIME_TEST_ONLY.createEncryptedInspection({
      fileSystemId: '0123456789_ABCDEFGHIJ',
    }).mode.activeFileSystemId;
    const unlockedSession = { fileSystemId } as OpfsPersistenceUnlockedSession;

    expect(OPFS_STORAGE_TEST_ONLY.projectEncryptionSettingsInspection({
      inspection: { type: 'plain' },
      unlockedSession,
    })).toMatchObject({
      error: { message: 'Plain Persistence Control authority conflicts with an installed HizoFS session' },
      type: 'recovery_required',
    });
  });

  it('fails closed when the unlocked HizoFS session does not match the selected authority', () => {
    const inspection = PERSISTENCE_RUNTIME_TEST_ONLY.createEncryptedInspection({
      fileSystemId: '0123456789_ABCDEFGHIJ',
    });
    const differentFileSystemId = PERSISTENCE_RUNTIME_TEST_ONLY.createEncryptedInspection({
      fileSystemId: 'ZYXWVUTSRQ_9876543210',
    }).mode.activeFileSystemId;
    const unlockedSession = { fileSystemId: differentFileSystemId } as OpfsPersistenceUnlockedSession;

    expect(OPFS_STORAGE_TEST_ONLY.projectEncryptionSettingsInspection({
      inspection,
      unlockedSession,
    })).toMatchObject({
      error: { message: 'Authenticated HizoFS session does not match the selected Persistence Control authority' },
      type: 'recovery_required',
    });
  });

  it('does not request the Persistence Control runtime for a plain namespace', async () => {
    const createRuntime = vi.fn<() => Promise<OpfsPersistenceRuntime>>();
    installOpfsPersistenceRuntimeFactory({ factory: createRuntime });
    const provider = new OPFSStorageProvider();

    await expect(provider.inspectEncryption()).resolves.toEqual({ type: 'plain' });
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it('preserves plain backend initialization failure when session cleanup succeeds', async () => {
    const initializationFailure = new Error('plain backend initialization failed');
    const close = vi.fn(async () => undefined);

    await expect(OPFS_STORAGE_TEST_ONLY.closePlainSessionAfterBackendInitializationFailure({
      cause: initializationFailure,
      fileSystemSession: { close },
    })).rejects.toBe(initializationFailure);
    expect(close).toHaveBeenCalledOnce();
  });

  it('preserves plain backend initialization and session cleanup failures together', async () => {
    const initializationFailure = new Error('plain backend initialization failed');
    const cleanupFailure = new Error('plain session cleanup failed');
    const close = vi.fn(async () => {
      throw cleanupFailure;
    });

    await expect(OPFS_STORAGE_TEST_ONLY.closePlainSessionAfterBackendInitializationFailure({
      cause: initializationFailure,
      fileSystemSession: { close },
    })).rejects.toMatchObject({
      errors: [initializationFailure, cleanupFailure],
      message: 'plain OPFS backend initialization and session cleanup both failed',
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it('preserves storage operation failure when session suspension succeeds', async () => {
    const operationFailure = new Error('storage operation failed');
    const suspend = vi.fn(async () => undefined);

    await expect(OPFS_STORAGE_TEST_ONLY.suspendStorageSessionAfterFailure({
      cause: operationFailure,
      message: 'storage operation and session suspension both failed',
      suspend,
    })).rejects.toBe(operationFailure);
    expect(suspend).toHaveBeenCalledOnce();
  });

  it('preserves storage operation and session suspension failures together', async () => {
    const operationFailure = new Error('storage operation failed');
    const suspensionFailure = new Error('storage session suspension failed');
    const suspend = vi.fn(async () => {
      throw suspensionFailure;
    });

    await expect(OPFS_STORAGE_TEST_ONLY.suspendStorageSessionAfterFailure({
      cause: operationFailure,
      message: 'storage operation and session suspension both failed',
      suspend,
    })).rejects.toMatchObject({
      errors: [operationFailure, suspensionFailure],
      message: 'storage operation and session suspension both failed',
    });
    expect(suspend).toHaveBeenCalledOnce();
  });

  it('preserves transition failure when provider shutdown succeeds', async () => {
    const transitionFailure = new Error('transition failed');
    const settle = vi.fn(async () => undefined);

    await expect(OPFS_STORAGE_TEST_ONLY.settleProviderAfterTransitionFailure({
      cause: transitionFailure,
      message: 'transition and provider shutdown both failed',
      settle,
    })).rejects.toBe(transitionFailure);
    expect(settle).toHaveBeenCalledOnce();
  });

  it('preserves transition and provider shutdown failures together', async () => {
    const transitionFailure = new Error('transition failed');
    const settlementFailure = new Error('provider shutdown failed');
    const settle = vi.fn(async () => {
      throw settlementFailure;
    });

    await expect(OPFS_STORAGE_TEST_ONLY.settleProviderAfterTransitionFailure({
      cause: transitionFailure,
      message: 'transition and provider shutdown both failed',
      settle,
    })).rejects.toMatchObject({
      errors: [transitionFailure, settlementFailure],
      message: 'transition and provider shutdown both failed',
    });
    expect(settle).toHaveBeenCalledOnce();
  });

  it('runs every provider shutdown step and preserves a single failure', async () => {
    const suspensionFailure = new Error('storage suspension failed');
    const clearBackend = vi.fn();
    const clearFileSystemSession = vi.fn(async () => undefined);
    const clearPersistenceSession = vi.fn(async () => undefined);
    const suspend = vi.fn(async () => {
      throw suspensionFailure;
    });

    await expect(OPFS_STORAGE_TEST_ONLY.settleStorageProviderShutdown({
      clearBackend,
      clearFileSystemSession,
      clearPersistenceSession,
      message: 'provider shutdown failed',
      suspend,
    })).rejects.toBe(suspensionFailure);
    expect(suspend).toHaveBeenCalledOnce();
    expect(clearPersistenceSession).toHaveBeenCalledOnce();
    expect(clearFileSystemSession).toHaveBeenCalledOnce();
    expect(clearBackend).toHaveBeenCalledOnce();
  });

  it('preserves every provider shutdown failure in operation order', async () => {
    const suspensionFailure = new Error('storage suspension failed');
    const persistenceSessionFailure = new Error('persistence session cleanup failed');
    const fileSystemSessionFailure = new Error('filesystem session cleanup failed');
    const clearBackend = vi.fn();

    await expect(OPFS_STORAGE_TEST_ONLY.settleStorageProviderShutdown({
      clearBackend,
      clearFileSystemSession: async () => {
        throw fileSystemSessionFailure;
      },
      clearPersistenceSession: async () => {
        throw persistenceSessionFailure;
      },
      message: 'provider shutdown failed',
      suspend: async () => {
        throw suspensionFailure;
      },
    })).rejects.toMatchObject({
      errors: [suspensionFailure, persistenceSessionFailure, fileSystemSessionFailure],
      message: 'provider shutdown failed',
    });
    expect(clearBackend).toHaveBeenCalledOnce();
  });

  it('preserves session installation failure when candidate cleanup succeeds', async () => {
    const installationFailure = new Error('session installation failed');
    const close = vi.fn(async () => undefined);

    await expect(OPFS_STORAGE_TEST_ONLY.closePersistenceSessionAfterInstallFailure({
      cause: installationFailure,
      session: { close },
    })).rejects.toBe(installationFailure);
    expect(close).toHaveBeenCalledOnce();
  });

  it('preserves session installation and candidate cleanup failures together', async () => {
    const installationFailure = new Error('session installation failed');
    const cleanupFailure = new Error('candidate session cleanup failed');
    const close = vi.fn(async () => {
      throw cleanupFailure;
    });

    await expect(OPFS_STORAGE_TEST_ONLY.closePersistenceSessionAfterInstallFailure({
      cause: installationFailure,
      session: { close },
    })).rejects.toMatchObject({
      errors: [installationFailure, cleanupFailure],
      message: 'authenticated OPFS session installation and candidate cleanup both failed',
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it('settles only the current provider at the reload boundary', async () => {
    const settleProvider = vi.fn(async () => undefined);

    await expect(OPFS_STORAGE_TEST_ONLY.settleProviderForReloadAfterTransition({
      settleProvider,
    })).resolves.toBeUndefined();

    expect(settleProvider).toHaveBeenCalledOnce();
  });

  it('propagates current-provider settlement failure before reload', async () => {
    const settlementFailure = new Error('current provider settlement failed');

    await expect(OPFS_STORAGE_TEST_ONLY.settleProviderForReloadAfterTransition({
      settleProvider: async () => {
        throw settlementFailure;
      },
    })).rejects.toBe(settlementFailure);
  });

  it('has no transition-result session cleanup hook at the reload boundary', async () => {
    const resultSessionClose = vi.fn(async () => undefined);
    const settleProvider = vi.fn(async () => undefined);

    await OPFS_STORAGE_TEST_ONLY.settleProviderForReloadAfterTransition({ settleProvider });

    expect(resultSessionClose).not.toHaveBeenCalled();
    expect(settleProvider).toHaveBeenCalledOnce();
  });

  it('fails closed when Persistence Control exists but no runtime is installed', async () => {
    const storageRoot = await mockOpfsRoot.getDirectoryHandle('naidan-storage', { create: true });
    await storageRoot.getDirectoryHandle('persistence-control', { create: true });
    const provider = new OPFSStorageProvider();

    const inspection = await provider.inspectEncryption();

    expect(inspection.type).toBe('recovery_required');
    if (inspection.type !== 'recovery_required') throw new Error('Expected recovery-required inspection');
    expect(inspection.error).toMatchObject({ message: 'OPFS Persistence Control runtime is not connected' });
  });

  it('unlocks credential-required storage from only the runtime-selected authority', async () => {
    const storageRoot = await mockOpfsRoot.getDirectoryHandle('naidan-storage', { create: true });
    await storageRoot.getDirectoryHandle('persistence-control', { create: true });
    const inspection = PERSISTENCE_RUNTIME_TEST_ONLY.createCredentialRequiredInspection({
      firstSequence: 2,
      secondSequence: 1,
    });
    const sessionClose = vi.fn(async () => {});
    const session = {
      backend: {},
      close: sessionClose,
      fileSystemId: PERSISTENCE_RUNTIME_TEST_ONLY.createEncryptedInspection({
        fileSystemId: '0123456789_ABCDEFGHIJ',
      }).mode.activeFileSystemId,
      fileSystemSession: {},
    } as unknown as OpfsPersistenceUnlockedSession;
    const runtime: OpfsPersistenceRuntime = {
      writableProfile: 'development-unverified',
      runUnlockedMaintenance: vi.fn(async () => ({
        remainingEntryCount: 0,
        removedEntryCount: 0,
        state: 'completed' as const,
      })),
      inspect: vi.fn(async () => inspection),
      runStartupMaintenance: vi.fn(async () => undefined),
      unlockWithPassphrase: vi.fn(async () => session),
      changePassphrase: vi.fn(async () => {
        throw new Error('not used');
      }),
      runTransition: vi.fn(async () => {
        throw new Error('not used');
      }),
    };
    const uninstall = installOpfsPersistenceRuntimeFactory({ factory: async () => runtime });
    const provider = new OPFSStorageProvider();

    const { blockingReason, candidates, requiredAction, type, ...unhandledInspection } = inspection;
    unhandledInspection satisfies Record<PropertyKey, never>;
    expect({ blockingReason, candidates, requiredAction, type }).toEqual(inspection);
    expect('mode' in inspection).toBe(false);
    await expect(provider.inspectEncryptionSettings()).resolves.toEqual({
      access: 'locked',
      type: 'encrypted',
    });

    await provider.unlockWithPassphrase({ passphrase: 'correct horse battery staple' });

    await expect(provider.inspectEncryptionSettings()).resolves.toEqual({
      access: 'unlocked',
      fileSystemId: session.fileSystemId,
      type: 'encrypted',
    });
    expect(runtime.unlockWithPassphrase).toHaveBeenCalledWith({
      passphrase: 'correct horse battery staple',
      storageRoot,
    });
    const locationLease = await openActiveAuthenticatedHizoFSContainerLocationLease();
    expect(locationLease.physicalPath).toEqual(
      naidanOpfsContainerOriginRelativePathComponents({ fileSystemId: session.fileSystemId }),
    );
    expect(() => locationLease.assertCurrent()).not.toThrow();

    await provider.dispose();
    expect(() => locationLease.assertCurrent()).toThrow('no longer current');
    await expect(openActiveAuthenticatedHizoFSContainerLocationLease()).rejects.toThrow('unavailable');
    expect(sessionClose).toHaveBeenCalledOnce();
    uninstall();
  });

  it('settles unlocked maintenance before starting a re-encryption transition', async () => {
    vi.stubGlobal('navigator', {
      locks: new InMemoryWebLockManager(),
      storage: {
        getDirectory: () => Promise.resolve(mockOpfsRoot),
      },
    });
    const storageRoot = await mockOpfsRoot.getDirectoryHandle('naidan-storage', { create: true });
    await storageRoot.getDirectoryHandle('persistence-control', { create: true });
    const inspection = PERSISTENCE_RUNTIME_TEST_ONLY.createCredentialRequiredInspection({
      firstSequence: 2,
      secondSequence: 1,
    });
    const maintenance = Promise.withResolvers<void>();
    const session = {
      backend: {},
      close: vi.fn(async () => undefined),
      fileSystemId: PERSISTENCE_RUNTIME_TEST_ONLY.createEncryptedInspection({
        fileSystemId: '0123456789_ABCDEFGHIJ',
      }).mode.activeFileSystemId,
      fileSystemSession: {},
    } as unknown as OpfsPersistenceUnlockedSession;
    const runTransition = vi.fn(async () => ({ type: 'completed' as const }));
    const runtime: OpfsPersistenceRuntime = {
      writableProfile: 'development-unverified',
      runUnlockedMaintenance: vi.fn(async () => {
        await maintenance.promise;
        return {
          remainingEntryCount: 0,
          removedEntryCount: 0,
          state: 'completed' as const,
        };
      }),
      inspect: vi.fn(async () => inspection),
      runStartupMaintenance: vi.fn(async () => undefined),
      unlockWithPassphrase: vi.fn(async () => session),
      changePassphrase: vi.fn(async () => {
        throw new Error('not used');
      }),
      runTransition,
    };
    const uninstall = installOpfsPersistenceRuntimeFactory({ factory: async () => runtime });
    const provider = new OPFSStorageProvider();

    try {
      await provider.unlockWithPassphrase({ passphrase: 'current passphrase' });
      const transition = provider.reencrypt({
        onProgress: undefined,
        retainedCredentials: [{ passphrase: 'current passphrase' }],
        signal: undefined,
      });
      await Promise.resolve();
      expect(runTransition).not.toHaveBeenCalled();

      maintenance.resolve();
      await transition;
      expect(runTransition).toHaveBeenCalledOnce();
      expect(runTransition).toHaveBeenCalledWith({
        nativeNamespaceRoot: mockOpfsRoot,
        onProgress: undefined,
        request: {
          operation: 'reencrypt',
          retainedCredentials: [{ passphrase: 'current passphrase' }],
          session,
        },
        signal: undefined,
        storageRoot,
      });
    } finally {
      maintenance.resolve();
      await provider.dispose();
      uninstall();
    }
  });

  it('replaces the active physical location with the next authenticated session generation', async () => {
    await mockOpfsRoot.getDirectoryHandle('naidan-storage', { create: true });
    const storageRoot = await mockOpfsRoot.getDirectoryHandle('naidan-storage');
    await storageRoot.getDirectoryHandle('persistence-control', { create: true });
    const inspection = PERSISTENCE_RUNTIME_TEST_ONLY.createCredentialRequiredInspection({
      firstSequence: 2,
      secondSequence: 1,
    });
    const firstFileSystemId = PERSISTENCE_RUNTIME_TEST_ONLY.createEncryptedInspection({
      fileSystemId: '0123456789_ABCDEFGHIJ',
    }).mode.activeFileSystemId;
    const secondFileSystemId = PERSISTENCE_RUNTIME_TEST_ONLY.createEncryptedInspection({
      fileSystemId: 'ABCDEFGHIJ_0123456789',
    }).mode.activeFileSystemId;
    const firstClose = vi.fn(async () => undefined);
    const secondClose = vi.fn(async () => undefined);
    const firstSession = {
      backend: {},
      close: firstClose,
      fileSystemId: firstFileSystemId,
      fileSystemSession: {},
    } as unknown as OpfsPersistenceUnlockedSession;
    const secondSession = {
      backend: {},
      close: secondClose,
      fileSystemId: secondFileSystemId,
      fileSystemSession: {},
    } as unknown as OpfsPersistenceUnlockedSession;
    const runtime: OpfsPersistenceRuntime = {
      writableProfile: 'development-unverified',
      runUnlockedMaintenance: vi.fn(async () => ({
        remainingEntryCount: 0,
        removedEntryCount: 0,
        state: 'completed' as const,
      })),
      inspect: vi.fn(async () => inspection),
      runStartupMaintenance: vi.fn(async () => undefined),
      unlockWithPassphrase: vi.fn(async () => firstSession),
      changePassphrase: vi.fn(async () => secondSession),
      runTransition: vi.fn(async () => {
        throw new Error('not used');
      }),
    };
    const uninstall = installOpfsPersistenceRuntimeFactory({ factory: async () => runtime });
    const provider = new OPFSStorageProvider();

    await provider.unlockWithPassphrase({ passphrase: 'first passphrase' });
    const firstLease = await openActiveAuthenticatedHizoFSContainerLocationLease();
    await provider.changePassphrase({ passphrase: 'second passphrase' });
    const secondLease = await openActiveAuthenticatedHizoFSContainerLocationLease();

    expect(() => firstLease.assertCurrent()).toThrow('no longer current');
    expect(secondLease.physicalPath).toEqual(
      naidanOpfsContainerOriginRelativePathComponents({ fileSystemId: secondFileSystemId }),
    );
    expect(() => secondLease.assertCurrent()).not.toThrow();
    expect(runtime.changePassphrase).toHaveBeenCalledWith({
      passphrase: 'second passphrase',
      session: firstSession,
      storageRoot,
    });
    expect(firstClose).toHaveBeenCalledOnce();

    await provider.dispose();
    expect(() => secondLease.assertCurrent()).toThrow('no longer current');
    expect(secondClose).toHaveBeenCalledOnce();
    uninstall();
  });

  it('closes a replacement session when previous-session cleanup blocks installation', async () => {
    await mockOpfsRoot.getDirectoryHandle('naidan-storage', { create: true });
    const storageRoot = await mockOpfsRoot.getDirectoryHandle('naidan-storage');
    await storageRoot.getDirectoryHandle('persistence-control', { create: true });
    const inspection = PERSISTENCE_RUNTIME_TEST_ONLY.createCredentialRequiredInspection({
      firstSequence: 2,
      secondSequence: 1,
    });
    const previousCleanupFailure = new Error('previous session cleanup failed');
    const firstClose = vi.fn(async () => {
      throw previousCleanupFailure;
    });
    const secondClose = vi.fn(async () => undefined);
    const firstSession = {
      backend: {},
      close: firstClose,
      fileSystemId: PERSISTENCE_RUNTIME_TEST_ONLY.createEncryptedInspection({
        fileSystemId: '0123456789_ABCDEFGHIJ',
      }).mode.activeFileSystemId,
      fileSystemSession: {},
    } as unknown as OpfsPersistenceUnlockedSession;
    const secondSession = {
      backend: {},
      close: secondClose,
      fileSystemId: PERSISTENCE_RUNTIME_TEST_ONLY.createEncryptedInspection({
        fileSystemId: 'ABCDEFGHIJ_0123456789',
      }).mode.activeFileSystemId,
      fileSystemSession: {},
    } as unknown as OpfsPersistenceUnlockedSession;
    const runtime: OpfsPersistenceRuntime = {
      writableProfile: 'development-unverified',
      runUnlockedMaintenance: vi.fn(async () => ({
        remainingEntryCount: 0,
        removedEntryCount: 0,
        state: 'completed' as const,
      })),
      inspect: vi.fn(async () => inspection),
      runStartupMaintenance: vi.fn(async () => undefined),
      unlockWithPassphrase: vi.fn(async () => firstSession),
      changePassphrase: vi.fn(async () => secondSession),
      runTransition: vi.fn(async () => {
        throw new Error('not used');
      }),
    };
    const uninstall = installOpfsPersistenceRuntimeFactory({ factory: async () => runtime });
    const provider = new OPFSStorageProvider();

    await provider.unlockWithPassphrase({ passphrase: 'first passphrase' });
    await expect(provider.changePassphrase({ passphrase: 'second passphrase' })).rejects.toBe(previousCleanupFailure);

    expect(firstClose).toHaveBeenCalledOnce();
    expect(secondClose).toHaveBeenCalledOnce();
    await expect(openActiveAuthenticatedHizoFSContainerLocationLease()).rejects.toThrow('unavailable');
    await provider.dispose();
    uninstall();
  });

  it('closes a runtime session whose File System ID cannot identify a canonical container', async () => {
    const storageRoot = await mockOpfsRoot.getDirectoryHandle('naidan-storage', { create: true });
    await storageRoot.getDirectoryHandle('persistence-control', { create: true });
    const inspection = PERSISTENCE_RUNTIME_TEST_ONLY.createCredentialRequiredInspection({
      firstSequence: 1,
      secondSequence: undefined,
    });
    const sessionClose = vi.fn(async () => undefined);
    const invalidSession = {
      backend: {},
      close: sessionClose,
      fileSystemId: 'not-a-canonical-id',
      fileSystemSession: {},
    } as unknown as OpfsPersistenceUnlockedSession;
    const runtime: OpfsPersistenceRuntime = {
      writableProfile: 'development-unverified',
      runUnlockedMaintenance: vi.fn(async () => ({
        remainingEntryCount: 0,
        removedEntryCount: 0,
        state: 'completed' as const,
      })),
      inspect: vi.fn(async () => inspection),
      runStartupMaintenance: vi.fn(async () => undefined),
      unlockWithPassphrase: vi.fn(async () => invalidSession),
      changePassphrase: vi.fn(async () => {
        throw new Error('not used');
      }),
      runTransition: vi.fn(async () => {
        throw new Error('not used');
      }),
    };
    const uninstall = installOpfsPersistenceRuntimeFactory({ factory: async () => runtime });
    const provider = new OPFSStorageProvider();

    await expect(provider.unlockWithPassphrase({ passphrase: 'passphrase' })).rejects.toThrow(
      'File System ID must use the exact 21-character Nano ID alphabet',
    );
    expect(sessionClose).toHaveBeenCalledOnce();
    await expect(openActiveAuthenticatedHizoFSContainerLocationLease()).rejects.toThrow('unavailable');

    await provider.dispose();
    expect(sessionClose).toHaveBeenCalledOnce();
    uninstall();
  });

  it('uses the installed runtime without exposing its secret-bearing capabilities', async () => {
    const storageRoot = await mockOpfsRoot.getDirectoryHandle('naidan-storage', { create: true });
    await storageRoot.getDirectoryHandle('persistence-control', { create: true });
    const expected = PERSISTENCE_RUNTIME_TEST_ONLY.createEncryptedInspection({ fileSystemId: 'encrypted-store' });
    const runtime: OpfsPersistenceRuntime = {
      writableProfile: 'development-unverified',
      runUnlockedMaintenance: vi.fn(async () => ({
        remainingEntryCount: 0,
        removedEntryCount: 0,
        state: 'completed' as const,
      })),
      inspect: vi.fn(async () => expected),
      runStartupMaintenance: vi.fn(async () => undefined),
      unlockWithPassphrase: vi.fn(async () => {
        throw new Error('not used');
      }),
      changePassphrase: vi.fn(async () => {
        throw new Error('not used');
      }),
      runTransition: vi.fn(async () => {
        throw new Error('not used');
      }),
    };
    const uninstall = installOpfsPersistenceRuntimeFactory({ factory: async () => runtime });
    const provider = new OPFSStorageProvider();

    await expect(provider.inspectEncryption()).resolves.toBe(expected);
    expect(runtime.inspect).toHaveBeenCalledWith({ storageRoot });
    uninstall();
  });

  it('does not block the stable plain backend on retired-source maintenance', async () => {
    const storageRoot = await mockOpfsRoot.getDirectoryHandle('naidan-storage', { create: true });
    await storageRoot.getDirectoryHandle('persistence-control', { create: true });
    const maintenance = Promise.withResolvers<void>();
    const runStartupMaintenance = vi.fn(async () => await maintenance.promise);
    const runtime: OpfsPersistenceRuntime = {
      writableProfile: 'development-unverified',
      runUnlockedMaintenance: vi.fn(async () => ({
        remainingEntryCount: 0,
        removedEntryCount: 0,
        state: 'completed' as const,
      })),
      changePassphrase: vi.fn(async () => {
        throw new Error('not used');
      }),
      inspect: vi.fn(async () => ({ type: 'plain' } as const)),
      runStartupMaintenance,
      runTransition: vi.fn(async () => {
        throw new Error('not used');
      }),
      unlockWithPassphrase: vi.fn(async () => {
        throw new Error('not used');
      }),
    };
    const uninstall = installOpfsPersistenceRuntimeFactory({ factory: async () => runtime });
    const provider = new OPFSStorageProvider();
    try {
      await provider.init();
      expect(runStartupMaintenance).toHaveBeenCalledWith({
        nativeNamespaceRoot: mockOpfsRoot,
        storageRoot,
      });
      maintenance.resolve();
      await maintenance.promise;
    } finally {
      await provider.dispose();
      uninstall();
    }
  });

  it('keeps stable plain storage available when retired-source maintenance fails', async () => {
    const storageRoot = await mockOpfsRoot.getDirectoryHandle('naidan-storage', { create: true });
    await storageRoot.getDirectoryHandle('persistence-control', { create: true });
    const maintenanceError = new Error('retired source is temporarily busy');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const runtime: OpfsPersistenceRuntime = {
      writableProfile: 'development-unverified',
      runUnlockedMaintenance: vi.fn(async () => ({
        remainingEntryCount: 0,
        removedEntryCount: 0,
        state: 'completed' as const,
      })),
      changePassphrase: vi.fn(async () => {
        throw new Error('not used');
      }),
      inspect: vi.fn(async () => ({ type: 'plain' } as const)),
      runStartupMaintenance: vi.fn(async () => {
        throw maintenanceError;
      }),
      runTransition: vi.fn(async () => {
        throw new Error('not used');
      }),
      unlockWithPassphrase: vi.fn(async () => {
        throw new Error('not used');
      }),
    };
    const uninstall = installOpfsPersistenceRuntimeFactory({ factory: async () => runtime });
    const provider = new OPFSStorageProvider();
    try {
      await expect(provider.init()).resolves.toBeUndefined();
      await vi.waitFor(() => {
        expect(error).toHaveBeenCalledWith(
          '[opfs-encryption] deferred startup maintenance failed',
          maintenanceError,
        );
      });
    } finally {
      await provider.dispose();
      uninstall();
      error.mockRestore();
    }
  });
});

describe('OPFSStorageProvider Directory Isolation', () => {
  beforeEach(() => {
    mockOpfsRoot.entries.clear();
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: () => Promise.resolve(mockOpfsRoot),
      },
    });
  });

  it('should create and use "naidan-storage" directory within OPFS root', async () => {
    const provider = new OPFSStorageProvider();

    // Initial state: root is empty
    expect(mockOpfsRoot.entries.size).toBe(0);

    // After init, the storage directory should exist
    await provider.init();
    expect(mockOpfsRoot.entries.has('naidan-storage')).toBe(true);
    const storageDir = mockOpfsRoot.entries.get('naidan-storage') as MockFileSystemDirectoryHandle;
    expect(storageDir.kind).toBe('directory');

    // Saving settings should put the file inside the subdirectory, NOT the root
    await provider.saveSettings({ settings: {
      titleGeneration: { endpoint: 'same_scope', model: 'same_scope', lmParameters: { temperature: undefined, topP: undefined, maxCompletionTokens: undefined, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } } },
      storageType: 'opfs',
      providerProfiles: [],
      mounts: [],
      endpoint: { type: 'openai', url: 'http://localhost' },
    } });

    expect(mockOpfsRoot.entries.has('settings.json')).toBe(false);
    expect(storageDir.entries.has('settings.json')).toBe(true);
  });

  it('should only clear contents within the "naidan-storage" directory', async () => {
    const provider = new OPFSStorageProvider();
    await provider.init();
    const storageDir = mockOpfsRoot.entries.get('naidan-storage') as MockFileSystemDirectoryHandle;

    // Manually add a file to root (outside our app's control)
    mockOpfsRoot.entries.set('other-app-data.txt', new MockFileSystemFileHandle('other-app-data.txt'));

    // Save some app data
    await provider.saveSettings({ settings: {
      titleGeneration: { endpoint: 'same_scope', model: 'same_scope', lmParameters: { temperature: undefined, topP: undefined, maxCompletionTokens: undefined, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } } },
      storageType: 'opfs',
      providerProfiles: [],
      mounts: [],
      endpoint: { type: 'openai', url: 'http://localhost' },
    } });

    expect(storageDir.entries.size).toBeGreaterThan(0);
    expect(mockOpfsRoot.entries.has('other-app-data.txt')).toBe(true);

    await provider.clearAll();

    // clearAll is scoped to the provider-owned directory. It removes Naidan
    // data without deleting the directory or unrelated entries in the OPFS root.
    expect(storageDir.entries.size).toBe(0);
    expect(mockOpfsRoot.entries.get('naidan-storage')).toBe(storageDir);
    expect(mockOpfsRoot.entries.has('other-app-data.txt')).toBe(true);
  });
});
