import { readonly, ref, shallowReadonly, shallowRef } from 'vue';
import type { StorageDirectoryHandle } from '@/00-storage/service/storage-file-system/types';
import type { HizoFSPhysicalInspectionSource } from '@/features/debug-hizofs/logic/active-physical-inspection-source';
import type { HizoFSAuthenticatedInspectionSession } from '@/00-storage/service/hizofs/inspection';
import type { HizoFSDebugWorkspaceSession, HizoFSDebugWorkspaceSummary } from '@/features/debug-hizofs/logic/debug-workspace';

type ActivePhysicalLocationModule = Readonly<{
  openActiveAuthenticatedHizoFSContainerLocationLease: () => Promise<{
    readonly physicalPath: readonly string[];
    assertCurrent(): void;
    dispose(): Promise<void>;
  }>;
}>;

type ActiveAuthenticatedInspectionModule = Readonly<{
  openActiveAuthenticatedHizoFSInspectionSessionLease: () => Promise<{
    readonly session: HizoFSAuthenticatedInspectionSession;
    assertCurrent(): void;
    dispose(): Promise<void>;
  } | undefined>;
}>;

type ActiveDecryptedLocationModule = Readonly<{
  openActiveAuthenticatedHizoFSDecryptedSnapshotLease: () => Promise<{
    readonly root: StorageDirectoryHandle;
    assertCurrent(): void;
    dispose(): Promise<void>;
  } | undefined>;
}>;

type ActiveInspectionSourceModule = Readonly<{
  createActiveHizoFSPhysicalInspectionSource: ({ openLease }: {
    openLease: ActivePhysicalLocationModule['openActiveAuthenticatedHizoFSContainerLocationLease'];
  }) => HizoFSPhysicalInspectionSource;
}>;

const isOpen = ref(false);
const physicalInspectionSource = shallowRef<HizoFSPhysicalInspectionSource>();
const authenticatedInspectionSession = shallowRef<HizoFSAuthenticatedInspectionSession>();
const decryptedRoot = shallowRef<StorageDirectoryHandle>();
const temporaryWorkspace = shallowRef<Extract<HizoFSDebugWorkspaceSummary, { readonly status: 'live' }>>();
const temporaryAuthenticatedInspectionSession = shallowRef<HizoFSAuthenticatedInspectionSession>();
const temporaryDecryptedRoot = shallowRef<StorageDirectoryHandle>();
let temporaryWorkspaceGeneration = 0;
let authenticatedInspectionSessionLease: Awaited<ReturnType<ActiveAuthenticatedInspectionModule['openActiveAuthenticatedHizoFSInspectionSessionLease']>> | undefined;
let authenticatedInspectionSessionGeneration = 0;
let decryptedSnapshotLease: Awaited<ReturnType<ActiveDecryptedLocationModule['openActiveAuthenticatedHizoFSDecryptedSnapshotLease']>> | undefined;
let decryptedSnapshotGeneration = 0;
let defaultSourceLoad: Promise<void> | undefined;
let workbenchLifecycleGeneration = 0;

/**
 * Installs the active provider's read-only physical Inspector source.
 *
 * The source is generation-scoped and provider-owned. The cleanup uses exact
 * object identity so a late disposal from an old provider cannot remove the
 * source installed by a newer storage generation.
 */
export function installHizoFSPhysicalInspectionSource({ source }: {
  source: HizoFSPhysicalInspectionSource;
}): () => void {
  physicalInspectionSource.value = source;
  return () => {
    if (physicalInspectionSource.value === source) physicalInspectionSource.value = undefined;
  };
}

async function ensureDefaultHizoFSPhysicalInspectionSourceWith({
  loadActiveLocation,
  loadInspectionSource,
}: {
  loadActiveLocation: () => Promise<ActivePhysicalLocationModule>;
  loadInspectionSource: () => Promise<ActiveInspectionSourceModule>;
}): Promise<void> {
  if (physicalInspectionSource.value !== undefined) return;
  const inFlight = defaultSourceLoad;
  if (inFlight !== undefined) {
    await inFlight;
    return;
  }

  const loading = (async () => {
    const activeLocation = await loadActiveLocation();
    const inspectionSource = await loadInspectionSource();
    if (physicalInspectionSource.value === undefined) {
      installHizoFSPhysicalInspectionSource({
        source: inspectionSource.createActiveHizoFSPhysicalInspectionSource({
          openLease: activeLocation.openActiveAuthenticatedHizoFSContainerLocationLease,
        }),
      });
    }
  })();
  defaultSourceLoad = loading;
  try {
    await loading;
  } finally {
    if (defaultSourceLoad === loading) defaultSourceLoad = undefined;
  }
}


async function releaseAuthenticatedInspectionSessionLease(): Promise<void> {
  authenticatedInspectionSessionGeneration += 1;
  authenticatedInspectionSession.value = undefined;
  const lease = authenticatedInspectionSessionLease;
  if (lease === undefined) return;
  await lease.dispose();
  if (authenticatedInspectionSessionLease === lease) {
    authenticatedInspectionSessionLease = undefined;
  }
}

async function openDefaultAuthenticatedInspectionSessionWith({ loadActiveLocation }: {
  loadActiveLocation: () => Promise<Pick<
    ActiveAuthenticatedInspectionModule,
    'openActiveAuthenticatedHizoFSInspectionSessionLease'
  >>;
}): Promise<void> {
  const generation = ++authenticatedInspectionSessionGeneration;
  const previousLease = authenticatedInspectionSessionLease;
  authenticatedInspectionSession.value = undefined;
  if (previousLease !== undefined) {
    await previousLease.dispose();
    if (authenticatedInspectionSessionLease === previousLease) {
      authenticatedInspectionSessionLease = undefined;
    }
  }

  const activeLocation = await loadActiveLocation();
  const lease = await activeLocation.openActiveAuthenticatedHizoFSInspectionSessionLease();
  if (lease === undefined) return;
  try {
    lease.assertCurrent();
    if (generation !== authenticatedInspectionSessionGeneration) {
      await lease.dispose();
      return;
    }
    authenticatedInspectionSessionLease = lease;
    authenticatedInspectionSession.value = lease.session;
  } catch (cause: unknown) {
    try {
      await lease.dispose();
    } catch (closeFailure: unknown) {
      throw new AggregateError(
        [cause, closeFailure],
        'active HizoFS inspection session validation and cleanup both failed',
      );
    }
    throw cause;
  }
}

async function releaseDecryptedSnapshotLease(): Promise<void> {
  decryptedSnapshotGeneration += 1;
  decryptedRoot.value = undefined;
  const lease = decryptedSnapshotLease;
  if (lease === undefined) return;
  await lease.dispose();
  if (decryptedSnapshotLease === lease) {
    decryptedSnapshotLease = undefined;
  }
}

async function openDefaultDecryptedRootWith({ loadActiveLocation }: {
  loadActiveLocation: () => Promise<Pick<
    ActiveDecryptedLocationModule,
    'openActiveAuthenticatedHizoFSDecryptedSnapshotLease'
  >>;
}): Promise<void> {
  const generation = ++decryptedSnapshotGeneration;
  const previousLease = decryptedSnapshotLease;
  decryptedRoot.value = undefined;
  if (previousLease !== undefined) {
    await previousLease.dispose();
    if (decryptedSnapshotLease === previousLease) {
      decryptedSnapshotLease = undefined;
    }
  }

  let lease: Awaited<ReturnType<ActiveDecryptedLocationModule['openActiveAuthenticatedHizoFSDecryptedSnapshotLease']>> | undefined;
  try {
    const activeLocation = await loadActiveLocation();
    lease = await activeLocation.openActiveAuthenticatedHizoFSDecryptedSnapshotLease();
    if (lease === undefined) return;
    lease.assertCurrent();
    if (generation !== decryptedSnapshotGeneration) {
      await lease.dispose();
      return;
    }
    decryptedSnapshotLease = lease;
    decryptedRoot.value = lease.root;
  } catch (cause: unknown) {
    if (lease === undefined) throw cause;
    try {
      await lease.dispose();
    } catch (closeFailure: unknown) {
      throw new AggregateError(
        [cause, closeFailure],
        'active HizoFS decrypted snapshot open and cleanup both failed',
      );
    }
  }
}


async function releaseWorkbenchReadAuthorities(): Promise<void> {
  const results = await Promise.allSettled([
    releaseAuthenticatedInspectionSessionLease(),
    releaseDecryptedSnapshotLease(),
  ]);
  const failures = results.flatMap(result => {
    switch (result.status) {
    case 'fulfilled': return [];
    case 'rejected': return [result.reason];
    default: return result satisfies never;
    }
  });
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, 'HizoFS Workbench read authority cleanup failed');
  }
}

type ActiveWorkbenchLocationModule = Pick<
  ActiveAuthenticatedInspectionModule & ActiveDecryptedLocationModule,
  'openActiveAuthenticatedHizoFSDecryptedSnapshotLease' | 'openActiveAuthenticatedHizoFSInspectionSessionLease'
>;

async function openDebugHizoFSWorkbenchWith({ loadActiveLocation }: {
  loadActiveLocation: () => Promise<ActiveWorkbenchLocationModule>;
}): Promise<void> {
  const generation = ++workbenchLifecycleGeneration;
  try {
    await openDefaultAuthenticatedInspectionSessionWith({ loadActiveLocation });
    if (generation !== workbenchLifecycleGeneration) return;
    await openDefaultDecryptedRootWith({ loadActiveLocation });
    if (generation !== workbenchLifecycleGeneration) return;
    isOpen.value = true;
  } catch (cause: unknown) {
    if (generation === workbenchLifecycleGeneration) {
      workbenchLifecycleGeneration += 1;
      isOpen.value = false;
      try {
        await releaseWorkbenchReadAuthorities();
      } catch (cleanupFailure: unknown) {
        throw new AggregateError(
          [cause, cleanupFailure],
          'HizoFS Workbench open and read authority cleanup both failed',
        );
      }
    }
    throw cause;
  }
}

async function createTemporaryHizoFSWorkspaceWith({ loadAuthority, loadWorkspace }: {
  loadAuthority: () => Promise<Pick<typeof import('@/features/debug-hizofs/worker/debug-workspace-authority'), 'createBrowserHizoFSDebugWorkspaceAuthority'>>;
  loadWorkspace: () => Promise<Pick<typeof import('@/features/debug-hizofs/logic/debug-workspace'), 'createHizoFSDebugWorkspace' | 'destroyHizoFSDebugWorkspace' | 'openHizoFSDebugWorkspace'>>;
}): Promise<void> {
  if (temporaryWorkspace.value !== undefined) return;
  const generation = ++temporaryWorkspaceGeneration;
  const workspaceModule = await loadWorkspace();
  const authorityModule = await loadAuthority();
  const summary = await workspaceModule.createHizoFSDebugWorkspace({
    authority: authorityModule.createBrowserHizoFSDebugWorkspaceAuthority(),
    nativeOpfsRoot: undefined,
  });
  let session: HizoFSDebugWorkspaceSession | undefined;
  try {
    session = await workspaceModule.openHizoFSDebugWorkspace({ workspaceId: summary.workspaceId });
    if (generation !== temporaryWorkspaceGeneration) {
      await workspaceModule.destroyHizoFSDebugWorkspace({
        workspaceId: summary.workspaceId,
        nativeOpfsRoot: undefined,
      });
      return;
    }
    temporaryWorkspace.value = summary;
    temporaryAuthenticatedInspectionSession.value = session.authenticatedInspectionSession;
    temporaryDecryptedRoot.value = session.decryptedRoot;
  } catch (cause: unknown) {
    try {
      await workspaceModule.destroyHizoFSDebugWorkspace({
        workspaceId: summary.workspaceId,
        nativeOpfsRoot: undefined,
      });
    } catch (cleanupFailure: unknown) {
      throw new AggregateError(
        [cause, cleanupFailure],
        'temporary HizoFS workspace open and cleanup both failed',
      );
    }
    throw cause;
  }
}

async function destroyTemporaryHizoFSWorkspaceWith({ loadWorkspace }: {
  loadWorkspace: () => Promise<Pick<typeof import('@/features/debug-hizofs/logic/debug-workspace'), 'destroyHizoFSDebugWorkspace'>>;
}): Promise<void> {
  const workspace = temporaryWorkspace.value;
  temporaryWorkspaceGeneration += 1;
  if (workspace === undefined) return;

  // WHY: the session may already be partly closed when cleanup fails. Stop
  // exposing read capabilities immediately, but retain the workspace identity
  // until destruction succeeds so the user can retry cleanup.
  temporaryAuthenticatedInspectionSession.value = undefined;
  temporaryDecryptedRoot.value = undefined;
  const workspaceModule = await loadWorkspace();
  await workspaceModule.destroyHizoFSDebugWorkspace({
    workspaceId: workspace.workspaceId,
    nativeOpfsRoot: undefined,
  });
  if (temporaryWorkspace.value?.workspaceId === workspace.workspaceId) {
    temporaryWorkspace.value = undefined;
  }
}

export function useDebugHizoFSWorkbench() {
  async function createTemporaryHizoFSWorkspace(): Promise<void> {
    await createTemporaryHizoFSWorkspaceWith({
      loadAuthority: async () => await import('@/features/debug-hizofs/worker/debug-workspace-authority'),
      loadWorkspace: async () => await import('@/features/debug-hizofs/logic/debug-workspace'),
    });
  }

  async function destroyTemporaryHizoFSWorkspace(): Promise<void> {
    await destroyTemporaryHizoFSWorkspaceWith({
      loadWorkspace: async () => await import('@/features/debug-hizofs/logic/debug-workspace'),
    });
  }

  async function openDebugHizoFSWorkbench(): Promise<void> {
    await openDebugHizoFSWorkbenchWith({
      loadActiveLocation: async () => await import(
        '@/00-storage/service/naidan-opfs/active-hizofs-container-location'
      ),
    });
  }

  async function closeDebugHizoFSWorkbench(): Promise<void> {
    workbenchLifecycleGeneration += 1;
    isOpen.value = false;
    await releaseWorkbenchReadAuthorities();
  }

  return {
    isDebugHizoFSWorkbenchOpen: readonly(isOpen),
    authenticatedInspectionSession: shallowReadonly(authenticatedInspectionSession),
    createTemporaryHizoFSWorkspace,
    destroyTemporaryHizoFSWorkspace,
    temporaryAuthenticatedInspectionSession: shallowReadonly(temporaryAuthenticatedInspectionSession),
    temporaryDecryptedRoot: shallowReadonly(temporaryDecryptedRoot),
    temporaryWorkspace: shallowReadonly(temporaryWorkspace),
    decryptedRoot: shallowReadonly(decryptedRoot),
    physicalInspectionSource: shallowReadonly(physicalInspectionSource),
    openDebugHizoFSWorkbench,
    closeDebugHizoFSWorkbench,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        // Export internal state and logic used only for testing here. Do not reference these in production logic.
        // ESLint-required for useXxx return objects.
      },
    }) || {}),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  createTemporaryHizoFSWorkspaceWith,
  destroyTemporaryHizoFSWorkspaceWith,
  ensureDefaultHizoFSPhysicalInspectionSourceWith,
  openDebugHizoFSWorkbenchWith,
  openDefaultAuthenticatedInspectionSessionWith,
  openDefaultDecryptedRootWith,
  reset() {
    workbenchLifecycleGeneration += 1;
    authenticatedInspectionSessionGeneration += 1;
    void authenticatedInspectionSessionLease?.dispose();
    authenticatedInspectionSessionLease = undefined;
    authenticatedInspectionSession.value = undefined;
    decryptedSnapshotGeneration += 1;
    void decryptedSnapshotLease?.dispose();
    decryptedSnapshotLease = undefined;
    decryptedRoot.value = undefined;
    defaultSourceLoad = undefined;
    physicalInspectionSource.value = undefined;
    temporaryWorkspaceGeneration += 1;
    temporaryWorkspace.value = undefined;
    temporaryAuthenticatedInspectionSession.value = undefined;
    temporaryDecryptedRoot.value = undefined;
    isOpen.value = false;
  },
};
