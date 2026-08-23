import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installHizoFSPhysicalInspectionSource,
  TEST_ONLY,
  useDebugHizoFSWorkbench,
} from '@/features/debug-hizofs/composables/useDebugHizoFSWorkbench';
import type { StorageDirectoryHandle } from '@/00-storage/service/storage-file-system/types';
import type { HizoFSPhysicalInspectionSource } from '@/features/debug-hizofs/logic/active-physical-inspection-source';
import type { HizoFSAuthenticatedInspectionSession } from '@/00-storage/service/hizofs/inspection';


function authenticatedInspectionSession(): HizoFSAuthenticatedInspectionSession {
  return {
    inspectContainer: vi.fn(async () => ({}) as never),
    inspectHomeRecord: vi.fn(async () => ({}) as never),
    inspectNamespacePath: vi.fn(async () => ({}) as never),
    inspectRecord: vi.fn(async () => ({}) as never),
    inspectRecordFrame: vi.fn(async () => ({}) as never),
  };
}

function source(): HizoFSPhysicalInspectionSource {
  return { open: vi.fn(async () => {
    throw new Error('not called');
  }) };
}

beforeEach(() => {
  TEST_ONLY.reset();
});

describe('HizoFS Workbench source composition', () => {
  it('does not let stale provider cleanup remove a newer source', () => {
    const first = source();
    const second = source();
    const disposeFirst = installHizoFSPhysicalInspectionSource({ source: first });
    expect(useDebugHizoFSWorkbench().physicalInspectionSource.value).toBe(first);

    const disposeSecond = installHizoFSPhysicalInspectionSource({ source: second });
    disposeFirst();
    expect(useDebugHizoFSWorkbench().physicalInspectionSource.value).toBe(second);

    disposeSecond();
    expect(useDebugHizoFSWorkbench().physicalInspectionSource.value).toBeUndefined();
  });

  it('loads the active location and physical Inspector only when requested', async () => {
    const physicalSource = source();
    const openLease = vi.fn(async () => {
      throw new Error('not called');
    });
    const createSource = vi.fn(() => physicalSource);
    const loadActiveLocation = vi.fn(async () => ({
      openActiveAuthenticatedHizoFSContainerLocationLease: openLease,
    }));
    const loadInspectionSource = vi.fn(async () => ({
      createActiveHizoFSPhysicalInspectionSource: createSource,
    }));

    await TEST_ONLY.ensureDefaultHizoFSPhysicalInspectionSourceWith({
      loadActiveLocation,
      loadInspectionSource,
    });

    expect(loadActiveLocation).toHaveBeenCalledOnce();
    expect(loadInspectionSource).toHaveBeenCalledOnce();
    expect(createSource).toHaveBeenCalledWith({ openLease });
    expect(useDebugHizoFSWorkbench().physicalInspectionSource.value).toBe(physicalSource);
  });


  it('leases an authenticated physical inspection session and releases it on close', async () => {
    const session = authenticatedInspectionSession();
    const dispose = vi.fn(async () => undefined);
    const assertCurrent = vi.fn();
    const openLease = vi.fn(async () => ({ assertCurrent, dispose, session }));
    const loadActiveLocation = vi.fn(async () => ({
      openActiveAuthenticatedHizoFSInspectionSessionLease: openLease,
    }));

    await TEST_ONLY.openDefaultAuthenticatedInspectionSessionWith({ loadActiveLocation });

    const workbench = useDebugHizoFSWorkbench();
    expect(workbench.authenticatedInspectionSession.value).toBe(session);
    expect(assertCurrent).toHaveBeenCalledOnce();

    await workbench.closeDebugHizoFSWorkbench();
    expect(workbench.authenticatedInspectionSession.value).toBeUndefined();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('retains a failed authenticated-session cleanup internally for retry without exposing the session', async () => {
    const session = authenticatedInspectionSession();
    const dispose = vi.fn()
      .mockRejectedValueOnce(new Error('inspection cleanup blocked'))
      .mockResolvedValueOnce(undefined);
    const loadActiveLocation = vi.fn(async () => ({
      openActiveAuthenticatedHizoFSInspectionSessionLease: vi.fn(async () => ({
        assertCurrent: () => undefined,
        dispose,
        session,
      })),
    }));

    await TEST_ONLY.openDefaultAuthenticatedInspectionSessionWith({ loadActiveLocation });
    const workbench = useDebugHizoFSWorkbench();

    await expect(workbench.closeDebugHizoFSWorkbench()).rejects.toThrow('inspection cleanup blocked');
    expect(workbench.authenticatedInspectionSession.value).toBeUndefined();

    await expect(workbench.closeDebugHizoFSWorkbench()).resolves.toBeUndefined();
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it('leases a decrypted read snapshot for the visible Workbench and releases it on close', async () => {
    const root = { kind: 'directory', name: 'snapshot-root' } as StorageDirectoryHandle;
    const dispose = vi.fn(async () => undefined);
    const assertCurrent = vi.fn();
    const openLease = vi.fn(async () => ({ assertCurrent, dispose, root }));
    const loadActiveLocation = vi.fn(async () => ({
      openActiveAuthenticatedHizoFSDecryptedSnapshotLease: openLease,
    }));

    await TEST_ONLY.openDefaultDecryptedRootWith({ loadActiveLocation });

    const workbench = useDebugHizoFSWorkbench();
    expect(workbench.decryptedRoot.value).toBe(root);
    expect(assertCurrent).toHaveBeenCalledOnce();

    await workbench.closeDebugHizoFSWorkbench();
    expect(workbench.decryptedRoot.value).toBeUndefined();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('retains a failed decrypted-snapshot cleanup internally for retry without exposing the root', async () => {
    const root = { kind: 'directory', name: 'snapshot-root' } as StorageDirectoryHandle;
    const dispose = vi.fn()
      .mockRejectedValueOnce(new Error('snapshot cleanup blocked'))
      .mockResolvedValueOnce(undefined);
    const loadActiveLocation = vi.fn(async () => ({
      openActiveAuthenticatedHizoFSDecryptedSnapshotLease: vi.fn(async () => ({
        assertCurrent: () => undefined,
        dispose,
        root,
      })),
    }));

    await TEST_ONLY.openDefaultDecryptedRootWith({ loadActiveLocation });
    const workbench = useDebugHizoFSWorkbench();

    await expect(workbench.closeDebugHizoFSWorkbench()).rejects.toThrow('snapshot cleanup blocked');
    expect(workbench.decryptedRoot.value).toBeUndefined();

    await expect(workbench.closeDebugHizoFSWorkbench()).resolves.toBeUndefined();
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it('does not hide a decrypted snapshot provider failure as an unavailable capability', async () => {
    const loadActiveLocation = vi.fn(async () => ({
      openActiveAuthenticatedHizoFSDecryptedSnapshotLease: vi.fn(async () => {
        throw new Error('snapshot provider failed');
      }),
    }));

    await expect(TEST_ONLY.openDefaultDecryptedRootWith({ loadActiveLocation }))
      .rejects.toThrow('snapshot provider failed');
    expect(useDebugHizoFSWorkbench().decryptedRoot.value).toBeUndefined();
  });

  it('disposes a decrypted snapshot that becomes stale while opening', async () => {
    const root = { kind: 'directory', name: 'stale-root' } as StorageDirectoryHandle;
    const dispose = vi.fn(async () => undefined);
    const assertCurrent = vi.fn(() => {
      throw new Error('no longer current');
    });
    const loadActiveLocation = vi.fn(async () => ({
      openActiveAuthenticatedHizoFSDecryptedSnapshotLease: vi.fn(async () => ({
        assertCurrent,
        dispose,
        root,
      })),
    }));

    await expect(TEST_ONLY.openDefaultDecryptedRootWith({ loadActiveLocation })).resolves.toBeUndefined();
    expect(useDebugHizoFSWorkbench().decryptedRoot.value).toBeUndefined();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('releases an authenticated session when a later decrypted provider open fails', async () => {
    const session = authenticatedInspectionSession();
    const disposeInspection = vi.fn(async () => undefined);
    const loadActiveLocation = vi.fn(async () => ({
      openActiveAuthenticatedHizoFSDecryptedSnapshotLease: vi.fn(async () => {
        throw new Error('decrypted provider failed');
      }),
      openActiveAuthenticatedHizoFSInspectionSessionLease: vi.fn(async () => ({
        assertCurrent: () => undefined,
        dispose: disposeInspection,
        session,
      })),
    }));

    await expect(TEST_ONLY.openDebugHizoFSWorkbenchWith({ loadActiveLocation }))
      .rejects.toThrow('decrypted provider failed');
    expect(disposeInspection).toHaveBeenCalledOnce();
    expect(useDebugHizoFSWorkbench().authenticatedInspectionSession.value).toBeUndefined();
    expect(useDebugHizoFSWorkbench().decryptedRoot.value).toBeUndefined();
    expect(useDebugHizoFSWorkbench().isDebugHizoFSWorkbenchOpen.value).toBe(false);
  });

  it('replaces the active read authorities when the selected source is refreshed', async () => {
    const firstRoot = { kind: 'directory', name: 'first-root' } as StorageDirectoryHandle;
    const secondRoot = { kind: 'directory', name: 'second-root' } as StorageDirectoryHandle;
    const disposeFirst = vi.fn(async () => undefined);
    const disposeSecond = vi.fn(async () => undefined);
    let root = firstRoot;
    const loadActiveLocation = vi.fn(async () => ({
      openActiveAuthenticatedHizoFSDecryptedSnapshotLease: vi.fn(async () => ({
        assertCurrent: () => undefined,
        dispose: root === firstRoot ? disposeFirst : disposeSecond,
        root,
      })),
      openActiveAuthenticatedHizoFSInspectionSessionLease: vi.fn(async () => undefined),
    }));

    await TEST_ONLY.refreshActiveHizoFSReadAuthoritiesWith({ loadActiveLocation });
    expect(useDebugHizoFSWorkbench().decryptedRoot.value).toBe(firstRoot);

    root = secondRoot;
    await TEST_ONLY.refreshActiveHizoFSReadAuthoritiesWith({ loadActiveLocation });

    expect(disposeFirst).toHaveBeenCalledOnce();
    expect(useDebugHizoFSWorkbench().decryptedRoot.value).toBe(secondRoot);
    expect(disposeSecond).not.toHaveBeenCalled();
  });

  it('does not resume opening after close invalidates an in-flight authenticated session open', async () => {
    const session = authenticatedInspectionSession();
    const disposeInspection = vi.fn(async () => undefined);
    let resolveInspection: ((value: {
      assertCurrent(): void;
      dispose(): Promise<void>;
      readonly session: HizoFSAuthenticatedInspectionSession;
    }) => void) | undefined;
    let signalInspectionStarted: (() => void) | undefined;
    const inspectionStarted = new Promise<void>(resolve => {
      signalInspectionStarted = resolve;
    });
    const openInspection = vi.fn(async () => await new Promise<
      { assertCurrent(): void; dispose(): Promise<void>; readonly session: HizoFSAuthenticatedInspectionSession }
        >(resolve => {
          resolveInspection = resolve;
          signalInspectionStarted?.();
        }));
    const openDecrypted = vi.fn(async () => ({
      assertCurrent: () => undefined,
      dispose: async () => undefined,
      root: { kind: 'directory', name: 'should-not-open' } as StorageDirectoryHandle,
    }));
    const loadActiveLocation = vi.fn(async () => ({
      openActiveAuthenticatedHizoFSDecryptedSnapshotLease: openDecrypted,
      openActiveAuthenticatedHizoFSInspectionSessionLease: openInspection,
    }));

    const opening = TEST_ONLY.openDebugHizoFSWorkbenchWith({ loadActiveLocation });
    await inspectionStarted;
    const closing = useDebugHizoFSWorkbench().closeDebugHizoFSWorkbench();
    resolveInspection?.({
      assertCurrent: () => undefined,
      dispose: disposeInspection,
      session,
    });

    await opening;
    await closing;
    expect(useDebugHizoFSWorkbench().isDebugHizoFSWorkbenchOpen.value).toBe(false);
    expect(useDebugHizoFSWorkbench().authenticatedInspectionSession.value).toBeUndefined();
    expect(useDebugHizoFSWorkbench().decryptedRoot.value).toBeUndefined();
    expect(openDecrypted).not.toHaveBeenCalled();
    expect(disposeInspection).toHaveBeenCalledOnce();
  });

  it('creates multiple temporary workspaces and exposes only the selected source', async () => {
    const authenticatedSession = authenticatedInspectionSession();
    const root = { kind: 'directory', name: 'temporary-root' } as StorageDirectoryHandle;
    const first = {
      status: 'live' as const,
      workspaceId: 'temporary-workspace-a',
      createdAt: 1,
      fileSystemId: 'temporary-file-system-a',
      physicalPath: ['naidan-debug-hizofs', 'runtime-temporary-workspace-a.hizofs'],
    };
    const second = { ...first, workspaceId: 'temporary-workspace-b', fileSystemId: 'temporary-file-system-b' };
    const summaries = [first, second];
    const destroy = vi.fn(async () => undefined);
    const create = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const open = vi.fn(async ({ workspaceId }: { workspaceId: string }) => ({
      authenticatedInspectionSession: authenticatedSession,
      decryptedRoot: root,
      source: summaries.find(summary => summary.workspaceId === workspaceId) ?? first,
      dispose: async () => undefined,
    }));
    let visibleCount = 0;
    const workspaceModule = {
      createHizoFSDebugWorkspace: async () => {
        const summary = await create();
        visibleCount += 1;
        return summary;
      },
      deleteStaleHizoFSDebugWorkspaceResidue: vi.fn(async () => undefined),
      destroyHizoFSDebugWorkspace: destroy,
      generateHizoFSDebugWorkspaceComprehensiveFixture: vi.fn(),
      listHizoFSDebugWorkspaces: vi.fn(async () => summaries.slice(0, visibleCount)),
      openHizoFSDebugWorkspace: open,
    };

    await TEST_ONLY.createTemporaryHizoFSWorkspaceWith({
      loadAuthority: async () => ({
        createBrowserHizoFSDebugWorkspaceAuthority: () => ({ create: vi.fn() }),
      }),
      loadWorkspace: async () => workspaceModule,
    });
    await TEST_ONLY.createTemporaryHizoFSWorkspaceWith({
      loadAuthority: async () => ({
        createBrowserHizoFSDebugWorkspaceAuthority: () => ({ create: vi.fn() }),
      }),
      loadWorkspace: async () => workspaceModule,
    });

    const workbench = useDebugHizoFSWorkbench();
    expect(workbench.temporaryWorkspaces.value).toEqual([first, second]);
    expect(workbench.temporaryWorkspace.value).toEqual(second);
    expect(workbench.temporaryAuthenticatedInspectionSession.value).toBe(authenticatedSession);
    expect(workbench.temporaryDecryptedRoot.value).toBe(root);
    expect(destroy).not.toHaveBeenCalled();
    expect(open).toHaveBeenLastCalledWith({ workspaceId: second.workspaceId });

    await workbench.closeDebugHizoFSWorkbench();
    expect(workbench.temporaryWorkspaces.value).toEqual([first, second]);
    expect(workbench.temporaryWorkspace.value).toEqual(second);

    await TEST_ONLY.selectTemporaryHizoFSWorkspaceWith({
      loadWorkspace: async () => workspaceModule,
      workspaceId: first.workspaceId,
    });
    expect(workbench.temporaryWorkspace.value).toEqual(first);
    expect(workbench.temporaryAuthenticatedInspectionSession.value).toBe(authenticatedSession);
    expect(open).toHaveBeenLastCalledWith({ workspaceId: first.workspaceId });
  });

  it('keeps a failed temporary destruction retryable without exposing stale read capabilities', async () => {
    const authenticatedSession = authenticatedInspectionSession();
    const root = { kind: 'directory', name: 'temporary-root' } as StorageDirectoryHandle;
    const summary = {
      status: 'live' as const,
      workspaceId: 'retryable-temporary-workspace',
      createdAt: 1,
      fileSystemId: 'temporary-file-system',
      physicalPath: ['naidan-debug-hizofs', 'runtime-retryable-temporary-workspace.hizofs'],
    };
    let listed = [summary];
    const destroy = vi.fn()
      .mockRejectedValueOnce(new Error('temporary cleanup blocked'))
      .mockImplementationOnce(async () => {
        listed = [];
      });
    const workspaceModule = {
      createHizoFSDebugWorkspace: async () => summary,
      deleteStaleHizoFSDebugWorkspaceResidue: vi.fn(async () => undefined),
      destroyHizoFSDebugWorkspace: destroy,
      generateHizoFSDebugWorkspaceComprehensiveFixture: vi.fn(),
      listHizoFSDebugWorkspaces: vi.fn(async () => listed),
      openHizoFSDebugWorkspace: async () => ({
        authenticatedInspectionSession: authenticatedSession,
        decryptedRoot: root,
        source: summary,
        dispose: async () => undefined,
      }),
    };

    await TEST_ONLY.createTemporaryHizoFSWorkspaceWith({
      loadAuthority: async () => ({
        createBrowserHizoFSDebugWorkspaceAuthority: () => ({ create: vi.fn() }),
      }),
      loadWorkspace: async () => workspaceModule,
    });

    await expect(TEST_ONLY.destroyTemporaryHizoFSWorkspaceWith({
      loadWorkspace: async () => workspaceModule,
      workspaceId: summary.workspaceId,
    })).rejects.toThrow('temporary cleanup blocked');
    const workbench = useDebugHizoFSWorkbench();
    expect(workbench.temporaryWorkspace.value).toEqual(summary);
    expect(workbench.temporaryAuthenticatedInspectionSession.value).toBeUndefined();
    expect(workbench.temporaryDecryptedRoot.value).toBeUndefined();

    await TEST_ONLY.destroyTemporaryHizoFSWorkspaceWith({
      loadWorkspace: async () => workspaceModule,
      workspaceId: summary.workspaceId,
    });
    expect(workbench.temporaryWorkspace.value).toBeUndefined();
    expect(destroy).toHaveBeenCalledTimes(2);
  });

  it('removes a temporary workspace when opening its combined source fails', async () => {
    const summary = {
      status: 'live' as const,
      workspaceId: 'failed-temporary-workspace',
      createdAt: 1,
      fileSystemId: 'temporary-file-system',
      physicalPath: ['naidan-debug-hizofs', 'runtime-failed-temporary-workspace.hizofs'],
    };
    const destroy = vi.fn(async (_args: {
      workspaceId: string;
      nativeOpfsRoot: FileSystemDirectoryHandle | undefined;
    }) => undefined);
    let listed = [summary];
    const workspaceModule = {
      createHizoFSDebugWorkspace: async () => summary,
      deleteStaleHizoFSDebugWorkspaceResidue: vi.fn(async () => undefined),
      destroyHizoFSDebugWorkspace: vi.fn(async (args: {
        workspaceId: string;
        nativeOpfsRoot: FileSystemDirectoryHandle | undefined;
      }) => {
        listed = [];
        await destroy(args);
      }),
      generateHizoFSDebugWorkspaceComprehensiveFixture: vi.fn(),
      listHizoFSDebugWorkspaces: vi.fn(async () => listed),
      openHizoFSDebugWorkspace: async () => {
        throw new Error('temporary open failed');
      },
    };

    await expect(TEST_ONLY.createTemporaryHizoFSWorkspaceWith({
      loadAuthority: async () => ({
        createBrowserHizoFSDebugWorkspaceAuthority: () => ({ create: vi.fn() }),
      }),
      loadWorkspace: async () => workspaceModule,
    })).rejects.toThrow('temporary open failed');

    expect(destroy).toHaveBeenCalledWith({
      workspaceId: 'failed-temporary-workspace',
      nativeOpfsRoot: undefined,
    });
    expect(useDebugHizoFSWorkbench().temporaryWorkspace.value).toBeUndefined();
  });

  it('selects stale residue without opening HizoFS and deletes it through raw cleanup', async () => {
    const residue = {
      status: 'stale' as const,
      workspaceId: 'stale-residue',
      fileSystemId: undefined,
      physicalPath: ['naidan-debug-hizofs', 'runtime-stale-residue.hizofs'],
    };
    let listed = [residue];
    const deleteResidue = vi.fn(async () => {
      listed = [];
    });
    const open = vi.fn();
    const workspaceModule = {
      deleteStaleHizoFSDebugWorkspaceResidue: deleteResidue,
      destroyHizoFSDebugWorkspace: vi.fn(),
      listHizoFSDebugWorkspaces: vi.fn(async () => listed),
      openHizoFSDebugWorkspace: open,
    };

    await TEST_ONLY.refreshTemporaryHizoFSWorkspacesWith({ loadWorkspace: async () => workspaceModule });
    await TEST_ONLY.selectTemporaryHizoFSWorkspaceWith({
      loadWorkspace: async () => workspaceModule,
      workspaceId: residue.workspaceId,
    });
    expect(open).not.toHaveBeenCalled();
    expect(useDebugHizoFSWorkbench().temporaryWorkspace.value).toEqual(residue);

    await TEST_ONLY.destroyTemporaryHizoFSWorkspaceWith({
      loadWorkspace: async () => workspaceModule,
      workspaceId: residue.workspaceId,
    });
    expect(deleteResidue).toHaveBeenCalledWith({
      workspaceId: residue.workspaceId,
      nativeOpfsRoot: undefined,
    });
    expect(useDebugHizoFSWorkbench().temporaryWorkspaces.value).toEqual([]);
  });

  it('refreshes the selected projection after a purpose-specific fixture operation', async () => {
    const generate = vi.fn(async () => ({
      coverage: [],
      manifestPath: '/__hizofs_fixture__/manifest.json',
      rootPath: '/__hizofs_fixture__',
    }));
    const workspaceId = 'fixture-workspace';
    const summary = {
      status: 'live' as const,
      workspaceId,
      createdAt: 1,
      fileSystemId: 'fixture-file-system',
      physicalPath: ['naidan-debug-hizofs', 'runtime-fixture-workspace.hizofs'],
    };
    await TEST_ONLY.refreshTemporaryHizoFSWorkspacesWith({
      loadWorkspace: async () => ({ listHizoFSDebugWorkspaces: async () => [summary] }),
    });
    await TEST_ONLY.selectTemporaryHizoFSWorkspaceWith({
      loadWorkspace: async () => ({
        openHizoFSDebugWorkspace: async () => ({
          authenticatedInspectionSession: authenticatedInspectionSession(),
          decryptedRoot: { kind: 'directory', name: 'fixture-root' } as StorageDirectoryHandle,
          source: summary,
          dispose: async () => undefined,
        }),
      }),
      workspaceId,
    });

    await TEST_ONLY.generateTemporaryHizoFSFixtureWith({
      loadWorkspace: async () => ({ generateHizoFSDebugWorkspaceComprehensiveFixture: generate }),
      onProgress: () => undefined,
      workspaceId,
    });
    expect(generate).toHaveBeenCalledWith({ onProgress: expect.any(Function), workspaceId });
    expect(useDebugHizoFSWorkbench().temporaryInspectionRevision.value).toBe(1);
  });

  it('opens without fabricating a physical source when no active provider is available', async () => {
    const workbench = useDebugHizoFSWorkbench();

    await workbench.openDebugHizoFSWorkbench();

    expect(workbench.isDebugHizoFSWorkbenchOpen.value).toBe(true);
    expect(workbench.authenticatedInspectionSession.value).toBeUndefined();
    expect(workbench.physicalInspectionSource.value).toBeUndefined();
  });

  it('does not load a default source when a provider source is already installed', async () => {
    const providerSource = source();
    installHizoFSPhysicalInspectionSource({ source: providerSource });
    const loadActiveLocation = vi.fn();
    const loadInspectionSource = vi.fn();

    await TEST_ONLY.ensureDefaultHizoFSPhysicalInspectionSourceWith({
      loadActiveLocation,
      loadInspectionSource,
    });

    expect(loadActiveLocation).not.toHaveBeenCalled();
    expect(loadInspectionSource).not.toHaveBeenCalled();
    expect(useDebugHizoFSWorkbench().physicalInspectionSource.value).toBe(providerSource);
  });
});
