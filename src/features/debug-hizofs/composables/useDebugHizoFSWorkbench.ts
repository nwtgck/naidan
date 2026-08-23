import { computed, readonly, ref, shallowReadonly, shallowRef } from 'vue';
import type { StorageDirectoryHandle } from '@/00-storage/service/storage-file-system/types';
import type { HizoFSPhysicalInspectionSource } from '@/features/debug-hizofs/logic/active-physical-inspection-source';
import type { HizoFSAuthenticatedInspectionSession } from '@/00-storage/service/hizofs/inspection';
import type { HizoFSDebugWorkspaceSession, HizoFSDebugWorkspaceSummary } from '@/features/debug-hizofs/logic/debug-workspace';
import type {
  HizoFSComprehensiveFixtureProgress,
  HizoFSComprehensiveFixtureResult,
} from '@/features/debug-hizofs/benchmark/comprehensive-workload';

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
const temporaryWorkspaces = shallowRef<readonly HizoFSDebugWorkspaceSummary[]>([]);
const selectedTemporaryWorkspaceId = ref<string>();
const temporaryWorkspace = computed(() => temporaryWorkspaces.value.find(
  workspace => workspace.workspaceId === selectedTemporaryWorkspaceId.value,
));
const temporaryAuthenticatedInspectionSession = shallowRef<HizoFSAuthenticatedInspectionSession>();
const temporaryDecryptedRoot = shallowRef<StorageDirectoryHandle>();
const temporaryInspectionRevision = ref(0);
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

async function refreshActiveHizoFSReadAuthoritiesWith({ loadActiveLocation }: {
  loadActiveLocation: () => Promise<ActiveWorkbenchLocationModule>;
}): Promise<'current' | 'stale'> {
  const generation = ++workbenchLifecycleGeneration;
  try {
    await openDefaultAuthenticatedInspectionSessionWith({ loadActiveLocation });
    if (generation !== workbenchLifecycleGeneration) return 'stale';
    await openDefaultDecryptedRootWith({ loadActiveLocation });
    if (generation !== workbenchLifecycleGeneration) return 'stale';
    return 'current';
  } catch (cause: unknown) {
    if (generation === workbenchLifecycleGeneration) {
      workbenchLifecycleGeneration += 1;
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

async function openDebugHizoFSWorkbenchWith({ loadActiveLocation }: {
  loadActiveLocation: () => Promise<ActiveWorkbenchLocationModule>;
}): Promise<void> {
  isOpen.value = false;
  try {
    const result = await refreshActiveHizoFSReadAuthoritiesWith({ loadActiveLocation });
    switch (result) {
    case 'current':
      isOpen.value = true;
      return;
    case 'stale': return;
    default: return result satisfies never;
    }
  } catch (cause: unknown) {
    isOpen.value = false;
    throw cause;
  }
}

type DebugWorkspaceModule = Pick<
  typeof import('@/features/debug-hizofs/logic/debug-workspace'),
  | 'createHizoFSDebugWorkspace'
  | 'deleteStaleHizoFSDebugWorkspaceResidue'
  | 'destroyHizoFSDebugWorkspace'
  | 'generateHizoFSDebugWorkspaceComprehensiveFixture'
  | 'listHizoFSDebugWorkspaces'
  | 'openHizoFSDebugWorkspace'
>;

function clearSelectedTemporaryWorkspaceCapabilities(): void {
  temporaryAuthenticatedInspectionSession.value = undefined;
  temporaryDecryptedRoot.value = undefined;
}

async function refreshTemporaryHizoFSWorkspacesWith({ loadWorkspace }: {
  loadWorkspace: () => Promise<Pick<DebugWorkspaceModule, 'listHizoFSDebugWorkspaces'>>;
}): Promise<void> {
  const workspaceModule = await loadWorkspace();
  temporaryWorkspaces.value = await workspaceModule.listHizoFSDebugWorkspaces({ nativeOpfsRoot: undefined });
  const selected = temporaryWorkspace.value;
  if (selected === undefined) {
    selectedTemporaryWorkspaceId.value = undefined;
    clearSelectedTemporaryWorkspaceCapabilities();
    return;
  }
  switch (selected.status) {
  case 'live': return;
  case 'stale':
    clearSelectedTemporaryWorkspaceCapabilities();
    return;
  default: return selected satisfies never;
  }
}

async function selectTemporaryHizoFSWorkspaceWith({ loadWorkspace, workspaceId }: {
  loadWorkspace: () => Promise<Pick<DebugWorkspaceModule, 'openHizoFSDebugWorkspace'>>;
  workspaceId: string;
}): Promise<void> {
  const selected = temporaryWorkspaces.value.find(workspace => workspace.workspaceId === workspaceId);
  if (selected === undefined) throw new Error(`HizoFS debug workspace is not listed: ${workspaceId}`);
  const generation = ++temporaryWorkspaceGeneration;
  selectedTemporaryWorkspaceId.value = workspaceId;
  clearSelectedTemporaryWorkspaceCapabilities();
  switch (selected.status) {
  case 'stale': return;
  case 'live': break;
  default: return selected satisfies never;
  }
  const workspaceModule = await loadWorkspace();
  const session: HizoFSDebugWorkspaceSession = await workspaceModule.openHizoFSDebugWorkspace({ workspaceId });
  if (generation !== temporaryWorkspaceGeneration || selectedTemporaryWorkspaceId.value !== workspaceId) {
    await session.dispose();
    return;
  }
  temporaryAuthenticatedInspectionSession.value = session.authenticatedInspectionSession;
  temporaryDecryptedRoot.value = session.decryptedRoot;
}

async function createTemporaryHizoFSWorkspaceWith({ loadAuthority, loadWorkspace }: {
  loadAuthority: () => Promise<Pick<typeof import('@/features/debug-hizofs/worker/debug-workspace-authority'), 'createBrowserHizoFSDebugWorkspaceAuthority'>>;
  loadWorkspace: () => Promise<DebugWorkspaceModule>;
}): Promise<void> {
  const workspaceModule = await loadWorkspace();
  const authorityModule = await loadAuthority();
  const summary = await workspaceModule.createHizoFSDebugWorkspace({
    authority: authorityModule.createBrowserHizoFSDebugWorkspaceAuthority(),
    nativeOpfsRoot: undefined,
  });
  try {
    await refreshTemporaryHizoFSWorkspacesWith({ loadWorkspace: async () => workspaceModule });
    await selectTemporaryHizoFSWorkspaceWith({
      loadWorkspace: async () => workspaceModule,
      workspaceId: summary.workspaceId,
    });
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
    await refreshTemporaryHizoFSWorkspacesWith({ loadWorkspace: async () => workspaceModule });
    throw cause;
  }
}

async function destroyTemporaryHizoFSWorkspaceWith({ loadWorkspace, workspaceId }: {
  loadWorkspace: () => Promise<Pick<
    DebugWorkspaceModule,
    'deleteStaleHizoFSDebugWorkspaceResidue' | 'destroyHizoFSDebugWorkspace' | 'listHizoFSDebugWorkspaces'
  >>;
  workspaceId: string;
}): Promise<void> {
  const workspace = temporaryWorkspaces.value.find(candidate => candidate.workspaceId === workspaceId);
  if (workspace === undefined) throw new Error(`HizoFS debug workspace is not listed: ${workspaceId}`);
  const wasSelected = selectedTemporaryWorkspaceId.value === workspaceId;
  if (wasSelected) {
    temporaryWorkspaceGeneration += 1;
    clearSelectedTemporaryWorkspaceCapabilities();
  }
  const workspaceModule = await loadWorkspace();
  try {
    switch (workspace.status) {
    case 'live':
      await workspaceModule.destroyHizoFSDebugWorkspace({ workspaceId, nativeOpfsRoot: undefined });
      break;
    case 'stale':
      await workspaceModule.deleteStaleHizoFSDebugWorkspaceResidue({ workspaceId, nativeOpfsRoot: undefined });
      break;
    default: workspace satisfies never;
    }
    if (wasSelected) selectedTemporaryWorkspaceId.value = undefined;
  } finally {
    await refreshTemporaryHizoFSWorkspacesWith({ loadWorkspace: async () => workspaceModule });
  }
}

async function generateTemporaryHizoFSFixtureWith({ loadWorkspace, onProgress, workspaceId }: {
  loadWorkspace: () => Promise<Pick<DebugWorkspaceModule, 'generateHizoFSDebugWorkspaceComprehensiveFixture'>>;
  onProgress: ({ progress }: { progress: HizoFSComprehensiveFixtureProgress }) => void;
  workspaceId: string;
}): Promise<HizoFSComprehensiveFixtureResult> {
  const workspaceModule = await loadWorkspace();
  const result = await workspaceModule.generateHizoFSDebugWorkspaceComprehensiveFixture({
    onProgress,
    workspaceId,
  });
  if (selectedTemporaryWorkspaceId.value === workspaceId) temporaryInspectionRevision.value += 1;
  return result;
}

export function useDebugHizoFSWorkbench() {
  async function createTemporaryHizoFSWorkspace(): Promise<void> {
    await createTemporaryHizoFSWorkspaceWith({
      loadAuthority: async () => await import('@/features/debug-hizofs/worker/debug-workspace-authority'),
      loadWorkspace: async () => await import('@/features/debug-hizofs/logic/debug-workspace'),
    });
  }

  async function refreshTemporaryHizoFSWorkspaces(): Promise<void> {
    await refreshTemporaryHizoFSWorkspacesWith({
      loadWorkspace: async () => await import('@/features/debug-hizofs/logic/debug-workspace'),
    });
  }

  async function selectTemporaryHizoFSWorkspace({ workspaceId }: { workspaceId: string }): Promise<void> {
    await selectTemporaryHizoFSWorkspaceWith({
      loadWorkspace: async () => await import('@/features/debug-hizofs/logic/debug-workspace'),
      workspaceId,
    });
  }

  async function destroyTemporaryHizoFSWorkspace({ workspaceId }: { workspaceId: string }): Promise<void> {
    await destroyTemporaryHizoFSWorkspaceWith({
      loadWorkspace: async () => await import('@/features/debug-hizofs/logic/debug-workspace'),
      workspaceId,
    });
  }

  async function generateTemporaryHizoFSFixture({ onProgress, workspaceId }: {
    onProgress: ({ progress }: { progress: HizoFSComprehensiveFixtureProgress }) => void;
    workspaceId: string;
  }): Promise<HizoFSComprehensiveFixtureResult> {
    return await generateTemporaryHizoFSFixtureWith({
      loadWorkspace: async () => await import('@/features/debug-hizofs/logic/debug-workspace'),
      onProgress,
      workspaceId,
    });
  }

  async function openDebugHizoFSWorkbench(): Promise<void> {
    await openDebugHizoFSWorkbenchWith({
      loadActiveLocation: async () => await import(
        '@/00-storage/service/naidan-opfs/active-hizofs-container-location'
      ),
    });
  }

  async function refreshActiveHizoFSReadAuthorities(): Promise<void> {
    await refreshActiveHizoFSReadAuthoritiesWith({
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
    generateTemporaryHizoFSFixture,
    refreshTemporaryHizoFSWorkspaces,
    selectTemporaryHizoFSWorkspace,
    selectedTemporaryWorkspaceId: readonly(selectedTemporaryWorkspaceId),
    temporaryAuthenticatedInspectionSession: shallowReadonly(temporaryAuthenticatedInspectionSession),
    temporaryDecryptedRoot: shallowReadonly(temporaryDecryptedRoot),
    temporaryInspectionRevision: readonly(temporaryInspectionRevision),
    temporaryWorkspace: shallowReadonly(temporaryWorkspace),
    temporaryWorkspaces: shallowReadonly(temporaryWorkspaces),
    decryptedRoot: shallowReadonly(decryptedRoot),
    physicalInspectionSource: shallowReadonly(physicalInspectionSource),
    openDebugHizoFSWorkbench,
    refreshActiveHizoFSReadAuthorities,
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
  generateTemporaryHizoFSFixtureWith,
  refreshTemporaryHizoFSWorkspacesWith,
  selectTemporaryHizoFSWorkspaceWith,
  ensureDefaultHizoFSPhysicalInspectionSourceWith,
  openDebugHizoFSWorkbenchWith,
  refreshActiveHizoFSReadAuthoritiesWith,
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
    temporaryWorkspaces.value = [];
    selectedTemporaryWorkspaceId.value = undefined;
    temporaryAuthenticatedInspectionSession.value = undefined;
    temporaryDecryptedRoot.value = undefined;
    temporaryInspectionRevision.value = 0;
    isOpen.value = false;
  },
};
