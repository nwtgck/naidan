<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import type { StorageDirectoryHandle } from '@/00-storage/service/storage-file-system/types';
import FileExplorer from '@/features/file-explorer/components/FileExplorer.vue';
import type { FileExplorerEntry } from '@/features/file-explorer/logic/types';
import type { FileExplorerRootDescriptor } from '@/features/file-explorer/worker/types';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  DatabaseIcon,
  FileArchiveIcon,
  FilesIcon,
  FolderTreeIcon,
  HardDriveIcon,
  LoaderCircleIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-vue-next';
import { useDebugHizoFSWorkbench } from '@/features/debug-hizofs/composables/useDebugHizoFSWorkbench';
import type { HizoFSPhysicalInspectionSource } from '@/features/debug-hizofs/logic/active-physical-inspection-source';
import type { HizoFSPhysicalInspectorTraversalBreadcrumb } from '@/features/debug-hizofs/logic/physical-inspector-record-traversal';
import type { HizoFSAuthenticatedInspectionSession } from '@/features/debug-hizofs/worker/authenticated-inspection-session';
import type { HizoFSPhysicalInspectionWorker } from '@/features/debug-hizofs/worker/physical-inspection';
import HizoFSBenchmarkPanel from './HizoFSBenchmarkPanel.vue';
import { exactObject } from '@/utils/exact-object';
import HizoFSPhysicalInspectorPanel from './HizoFSPhysicalInspectorPanel.vue';
import type {
  HizoFSComprehensiveFixtureProgress,
  HizoFSComprehensiveFixtureResult,
} from '@/features/debug-hizofs/benchmark/comprehensive-workload';

const props = defineProps<{
  authenticatedSession?: HizoFSAuthenticatedInspectionSession;
  decryptedRoot?: StorageDirectoryHandle;
  physicalInspectionSource?: HizoFSPhysicalInspectionSource;
  physicalInspector?: HizoFSPhysicalInspectionWorker;
}>();

const {
  authenticatedInspectionSession: installedAuthenticatedInspectionSession,
  closeDebugHizoFSWorkbench,
  createTemporaryHizoFSWorkspace,
  decryptedRoot: installedDecryptedRoot,
  destroyTemporaryHizoFSWorkspace,
  generateTemporaryHizoFSFixture,
  physicalInspectionSource: installedPhysicalInspectionSource,
  refreshActiveHizoFSReadAuthorities,
  refreshTemporaryHizoFSWorkspaces,
  selectTemporaryHizoFSWorkspace,
  selectedTemporaryWorkspaceId,
  temporaryAuthenticatedInspectionSession,
  temporaryDecryptedRoot,
  temporaryInspectionRevision,
  temporaryWorkspace,
  temporaryWorkspaces,
} = useDebugHizoFSWorkbench();
const primaryView = ref<'benchmark' | 'physical_inspector'>('physical_inspector');
type WorkbenchInspectionSourceKind = 'active_encrypted_store' | 'ephemeral_debug_workspace' | 'standalone_container';
type WorkbenchInspectionSource = Readonly<
  | {
      access: 'read';
      description: string;
      kind: 'active_encrypted_store';
      label: string;
      status: 'available' | 'opening' | 'partial' | 'unavailable';
    }
  | {
      access: 'read_write' | 'unavailable';
      description: string;
      kind: 'ephemeral_debug_workspace';
      label: string;
      status: 'available' | 'opening' | 'partial' | 'unavailable';
    }
  | {
      access: 'read';
      description: string;
      kind: 'standalone_container';
      label: string;
      status: 'available' | 'opening' | 'unavailable';
    }
>;
const selectedInspectionSourceKind = ref<WorkbenchInspectionSourceKind>('active_encrypted_store');
const companionExplorerExpanded = ref(true);
const workbenchColumnScroll = ref<HTMLElement>();
const companionFollowEnabled = ref(true);
const inspectedNamespacePath = ref<string>();
const inspectedNamespaceAuthority = ref<Readonly<{
  authorityMode: 'active' | 'fallback_read_only';
  commitSequence: string;
}>>();
const physicalTraversalBreadcrumbs = ref<readonly HizoFSPhysicalInspectorTraversalBreadcrumb[]>([]);
const requestedNamespacePath = ref<string>();
const openedInspector = ref<HizoFSPhysicalInspectionWorker>();
const openingInspector = ref(false);
const refreshingActiveReadAuthorities = ref(false);
const inspectorErrorMessage = ref<string>();
const activeReadAuthorityErrorMessage = ref<string>();
const temporaryWorkspaceErrorMessage = ref<string>();
const changingTemporaryWorkspace = ref(false);
const generatingTemporaryFixture = ref(false);
const temporaryFixtureProgress = ref<HizoFSComprehensiveFixtureProgress>();
const temporaryFixtureResult = ref<HizoFSComprehensiveFixtureResult>();
const standaloneInspector = ref<HizoFSPhysicalInspectionWorker>();
const standaloneContainerName = ref<string>();
const standaloneErrorMessage = ref<string>();
const openingStandaloneContainer = ref(false);
type PendingNamespacePathJump = Readonly<{
  generation: number;
  path: string;
  sourceKind: WorkbenchInspectionSourceKind;
}>;
let namespacePathJumpGeneration = 0;
let pendingNamespacePathJump: PendingNamespacePathJump | undefined;
let openGeneration = 0;
let standaloneOpenGeneration = 0;
let unmounted = false;

const configuredAuthenticatedInspectionSession = computed(() => (
  props.authenticatedSession ?? installedAuthenticatedInspectionSession.value
));
const configuredPhysicalInspectionSource = computed(() => (
  props.physicalInspectionSource ?? installedPhysicalInspectionSource.value
));
const configuredDecryptedRoot = computed(() => props.decryptedRoot ?? installedDecryptedRoot.value);
const selectedAuthenticatedInspectionSession = computed(() => {
  switch (selectedInspectionSourceKind.value) {
  case 'active_encrypted_store': return configuredAuthenticatedInspectionSession.value;
  case 'ephemeral_debug_workspace': return temporaryAuthenticatedInspectionSession.value;
  case 'standalone_container': return undefined;
  default: return selectedInspectionSourceKind.value satisfies never;
  }
});
const selectedDecryptedRoot = computed(() => {
  switch (selectedInspectionSourceKind.value) {
  case 'active_encrypted_store': return configuredDecryptedRoot.value;
  case 'ephemeral_debug_workspace': return temporaryDecryptedRoot.value;
  case 'standalone_container': return undefined;
  default: return selectedInspectionSourceKind.value satisfies never;
  }
});
const companionFileExplorerRoot = computed<FileExplorerRootDescriptor | undefined>(() => {
  const root = selectedDecryptedRoot.value;
  if (root === undefined) return undefined;
  return exactObject<Extract<FileExplorerRootDescriptor, { kind: 'storage-directory' }>>()({
    handle: root,
    kind: 'storage-directory',
    readOnly: true,
    rootName: root.name.length === 0 ? '/' : root.name,
  });
});
const activeInspector = computed(() => props.physicalInspector ?? openedInspector.value);

function temporaryInspectionSource(): Extract<WorkbenchInspectionSource, { kind: 'ephemeral_debug_workspace' }> {
  const workspace = temporaryWorkspace.value;
  if (workspace === undefined) {
    return {
      access: 'read_write',
      description: 'Document-lifetime filesystems for inspection and controlled fixtures',
      kind: 'ephemeral_debug_workspace',
      label: 'Temporary HizoFS',
      status: changingTemporaryWorkspace.value ? 'opening' : 'unavailable',
    };
  }
  switch (workspace.status) {
  case 'live': return {
    access: 'read_write',
    description: 'Document-lifetime filesystems for inspection and controlled fixtures',
    kind: 'ephemeral_debug_workspace',
    label: `Temporary HizoFS · ${shortWorkspaceId({ workspaceId: workspace.workspaceId })}`,
    status: changingTemporaryWorkspace.value
      ? 'opening'
      : temporaryAuthenticatedInspectionSession.value !== undefined && temporaryDecryptedRoot.value !== undefined
        ? 'available'
        : 'partial',
  };
  case 'stale': return {
    access: 'unavailable',
    description: 'Raw OPFS residue from an expired document runtime',
    kind: 'ephemeral_debug_workspace',
    label: `Temporary residue · ${shortWorkspaceId({ workspaceId: workspace.workspaceId })}`,
    status: changingTemporaryWorkspace.value ? 'opening' : 'unavailable',
  };
  default: return workspace satisfies never;
  }
}

const inspectionSources = computed<readonly WorkbenchInspectionSource[]>(() => [
  {
    access: 'read',
    description: 'Current Naidan HizoFS · authenticated production data',
    kind: 'active_encrypted_store',
    label: 'Naidan active HizoFS',
    status: openingInspector.value || refreshingActiveReadAuthorities.value
      ? 'opening'
      : (activeInspector.value !== undefined || configuredAuthenticatedInspectionSession.value !== undefined) && configuredDecryptedRoot.value !== undefined
        ? 'available'
        : (activeInspector.value !== undefined || configuredAuthenticatedInspectionSession.value !== undefined) || configuredDecryptedRoot.value !== undefined
          ? 'partial'
          : 'unavailable',
  },
  temporaryInspectionSource(),
  {
    access: 'read',
    description: 'Open an independent HizoFS container for offline inspection',
    kind: 'standalone_container',
    label: standaloneContainerName.value === undefined
      ? 'Standalone HizoFS'
      : `Standalone HizoFS · ${standaloneContainerName.value}`,
    status: openingStandaloneContainer.value
      ? 'opening'
      : standaloneInspector.value === undefined ? 'unavailable' : 'available',
  },
]);
const selectedInspectionSource = computed(() => {
  const source = inspectionSources.value.find(candidate => candidate.kind === selectedInspectionSourceKind.value);
  if (source === undefined) throw new Error('Selected HizoFS Workbench source is missing');
  return source;
});
const selectedSourceHasConnectedInstance = computed(() => {
  switch (selectedInspectionSource.value.kind) {
  case 'active_encrypted_store': return true;
  case 'ephemeral_debug_workspace':
    return temporaryWorkspace.value?.status === 'live'
      && temporaryAuthenticatedInspectionSession.value !== undefined;
  case 'standalone_container': return standaloneInspector.value !== undefined;
  default: return selectedInspectionSource.value satisfies never;
  }
});
const selectedPhysicalInspector = computed(() => {
  switch (selectedInspectionSourceKind.value) {
  case 'active_encrypted_store': return activeInspector.value;
  case 'ephemeral_debug_workspace': return undefined;
  case 'standalone_container': return standaloneInspector.value;
  default: return selectedInspectionSourceKind.value satisfies never;
  }
});
function fallbackCompanionStatus(): string | undefined {
  const authorityMode = inspectedNamespaceAuthority.value?.authorityMode;
  switch (authorityMode) {
  case undefined:
  case 'active': return undefined;
  case 'fallback_read_only':
    return inspectedNamespacePath.value === undefined
      ? 'fallback read-only observation · current snapshot detached'
      : `fallback read-only ${inspectedNamespacePath.value} · current snapshot detached`;
  default: return authorityMode satisfies never;
  }
}
const companionExplorerStatus = computed(() => {
  switch (selectedInspectionSource.value.kind) {
  case 'active_encrypted_store': {
    if (companionFileExplorerRoot.value === undefined) return 'read snapshot unavailable';
    if (!companionFollowEnabled.value) {
      return inspectedNamespacePath.value === undefined
        ? 'detached · no persisted path selected'
        : `detached · persisted selection ${inspectedNamespacePath.value}`;
    }
    const fallbackStatus = fallbackCompanionStatus();
    if (fallbackStatus !== undefined) return fallbackStatus;
    return inspectedNamespacePath.value === undefined
      ? 'read snapshot connected · no persisted path selected'
      : `following current path ${inspectedNamespacePath.value} · record identity not asserted`;
  }
  case 'ephemeral_debug_workspace': {
    if (companionFileExplorerRoot.value === undefined) {
      return temporaryWorkspace.value === undefined
        ? 'temporary filesystem not created'
        : 'temporary filesystem exists · decrypted read unavailable';
    }
    if (!companionFollowEnabled.value) {
      return inspectedNamespacePath.value === undefined
        ? 'detached · no persisted path selected'
        : `detached · persisted selection ${inspectedNamespacePath.value}`;
    }
    const fallbackStatus = fallbackCompanionStatus();
    if (fallbackStatus !== undefined) return fallbackStatus;
    return inspectedNamespacePath.value === undefined
      ? 'temporary filesystem connected · no persisted path selected'
      : `following current path ${inspectedNamespacePath.value} · record identity not asserted`;
  }
  case 'standalone_container':
    return standaloneInspector.value === undefined
      ? 'standalone container not opened'
      : 'physical + authenticated namespace inspection available · decrypted filesystem session unavailable';
  default: return selectedInspectionSource.value satisfies never;
  }
});
const companionRevealPath = computed(() => {
  if (!companionFollowEnabled.value) return undefined;
  const authorityMode = inspectedNamespaceAuthority.value?.authorityMode;
  switch (authorityMode) {
  case 'active': return inspectedNamespacePath.value;
  case undefined:
  case 'fallback_read_only': return undefined;
  default: return authorityMode satisfies never;
  }
});
const companionExplorerBadge = computed(() => {
  switch (selectedInspectionSource.value.kind) {
  case 'active_encrypted_store': return companionFollowEnabled.value ? 'Follow on' : 'Detached';
  case 'ephemeral_debug_workspace':
    if (temporaryWorkspace.value === undefined) return 'Create first';
    return companionFollowEnabled.value ? 'Follow on' : 'Detached';
  case 'standalone_container': return 'Unavailable';
  default: return selectedInspectionSource.value satisfies never;
  }
});


type WorkbenchInstanceEntryKind =
  | 'active_roots'
  | 'derived_filesystem'
  | 'physical_authority'
  | 'root_namespace'
  | 'segments';

async function focusWorkbenchSurface({ selector }: { selector: string }): Promise<void> {
  await nextTick();
  const scroll = workbenchColumnScroll.value;
  if (scroll === undefined) return;
  const target = scroll.querySelector<HTMLElement>(selector);
  if (target === null) return;
  scroll.scrollLeft = target.offsetLeft;
}

async function settlePendingNamespacePathJump({ jump }: {
  jump: PendingNamespacePathJump;
}): Promise<void> {
  await nextTick();
  if (
    unmounted
    || pendingNamespacePathJump?.generation !== jump.generation
    || selectedInspectionSourceKind.value !== jump.sourceKind
  ) return;
  const scroll = workbenchColumnScroll.value;
  if (scroll === undefined) return;
  const target = [...scroll.querySelectorAll<HTMLElement>('[data-namespace-column-path]')]
    .find(candidate => candidate.dataset.namespaceColumnPath === jump.path);
  if (target === undefined) return;
  const scrollBounds = scroll.getBoundingClientRect();
  const targetBounds = target.getBoundingClientRect();
  let horizontalDelta = 0;
  if (targetBounds.left < scrollBounds.left && targetBounds.right > scrollBounds.right) {
    horizontalDelta = 0;
  } else if (targetBounds.left < scrollBounds.left) {
    horizontalDelta = targetBounds.left - scrollBounds.left;
  } else if (targetBounds.right > scrollBounds.right) {
    horizontalDelta = targetBounds.right - scrollBounds.right;
  }
  scroll.scrollLeft += horizontalDelta;
  pendingNamespacePathJump = undefined;
}

async function focusPhysicalTraversalBreadcrumb({ breadcrumb }: {
  breadcrumb: HizoFSPhysicalInspectorTraversalBreadcrumb;
}): Promise<void> {
  switch (breadcrumb.kind) {
  case 'authority':
    await focusWorkbenchSurface({ selector: '[data-workbench-inspector-surface="physical-authority"]' });
    return;
  case 'frame':
    await focusWorkbenchSurface({ selector: '[data-workbench-inspector-surface="segments"]' });
    return;
  case 'namespace':
    await focusLogicalNamespaceBreadcrumb();
    return;
  case 'record':
    await focusWorkbenchSurface({ selector: `[data-workbench-traversal-column-index="${String(breadcrumb.columnIndex)}"]` });
    return;
  default:
    breadcrumb satisfies never;
  }
}

async function focusLogicalNamespaceBreadcrumb(): Promise<void> {
  await focusWorkbenchSurface({ selector: '[data-workbench-inspector-surface="namespace"]' });
}

function selectWorkbenchInstanceEntry({ kind }: { kind: WorkbenchInstanceEntryKind }): void {
  switch (kind) {
  case 'physical_authority':
  case 'active_roots':
    void focusWorkbenchSurface({ selector: '[data-workbench-inspector-surface="physical-authority"]' });
    return;
  case 'root_namespace':
    requestedNamespacePath.value = '/';
    void focusWorkbenchSurface({ selector: '[data-workbench-inspector-surface="namespace"]' });
    return;
  case 'segments':
    void focusWorkbenchSurface({ selector: '[data-workbench-inspector-surface="segments"]' });
    return;
  case 'derived_filesystem':
    companionExplorerExpanded.value = true;
    return;
  default:
    kind satisfies never;
  }
}

function sourceStatusLabel({ source }: { source: WorkbenchInspectionSource }): string {
  switch (source.status) {
  case 'available': return 'ready';
  case 'opening': return 'opening';
  case 'partial': return 'partial';
  case 'unavailable': return 'unavailable';
  default: return source satisfies never;
  }
}

function sourceIcon({ source }: { source: WorkbenchInspectionSource }): 'active' | 'standalone' | 'temporary' {
  switch (source.kind) {
  case 'active_encrypted_store': return 'active';
  case 'ephemeral_debug_workspace': return 'temporary';
  case 'standalone_container': return 'standalone';
  default: return source satisfies never;
  }
}

function shortWorkspaceId({ workspaceId }: { workspaceId: string }): string {
  return workspaceId.length <= 12 ? workspaceId : `${workspaceId.slice(0, 8)}…`;
}

function resetTemporaryFixtureState(): void {
  temporaryFixtureProgress.value = undefined;
  temporaryFixtureResult.value = undefined;
}

function resetInspectionNavigation(): void {
  namespacePathJumpGeneration += 1;
  pendingNamespacePathJump = undefined;
  inspectedNamespacePath.value = undefined;
  inspectedNamespaceAuthority.value = undefined;
  requestedNamespacePath.value = undefined;
  physicalTraversalBreadcrumbs.value = [];
  companionFollowEnabled.value = true;
}

async function createTemporaryWorkspaceFromUi(): Promise<void> {
  if (changingTemporaryWorkspace.value) return;
  changingTemporaryWorkspace.value = true;
  temporaryWorkspaceErrorMessage.value = undefined;
  try {
    await createTemporaryHizoFSWorkspace();
    selectedInspectionSourceKind.value = 'ephemeral_debug_workspace';
    resetInspectionNavigation();
    resetTemporaryFixtureState();
    requestedNamespacePath.value = '/';
  } catch (error: unknown) {
    temporaryWorkspaceErrorMessage.value = errorMessage({ error });
  } finally {
    changingTemporaryWorkspace.value = false;
  }
}

async function selectTemporaryWorkspaceFromUi({ workspaceId }: { workspaceId: string }): Promise<void> {
  if (changingTemporaryWorkspace.value || generatingTemporaryFixture.value) return;
  changingTemporaryWorkspace.value = true;
  temporaryWorkspaceErrorMessage.value = undefined;
  try {
    await selectTemporaryHizoFSWorkspace({ workspaceId });
    selectedInspectionSourceKind.value = 'ephemeral_debug_workspace';
    resetInspectionNavigation();
    resetTemporaryFixtureState();
  } catch (error: unknown) {
    temporaryWorkspaceErrorMessage.value = errorMessage({ error });
  } finally {
    changingTemporaryWorkspace.value = false;
  }
}

async function destroyTemporaryWorkspaceFromUi({ workspaceId }: { workspaceId: string }): Promise<void> {
  if (changingTemporaryWorkspace.value) return;
  changingTemporaryWorkspace.value = true;
  temporaryWorkspaceErrorMessage.value = undefined;
  try {
    await destroyTemporaryHizoFSWorkspace({ workspaceId });
    if (selectedTemporaryWorkspaceId.value === undefined) {
      resetInspectionNavigation();
      resetTemporaryFixtureState();
    }
  } catch (error: unknown) {
    temporaryWorkspaceErrorMessage.value = errorMessage({ error });
  } finally {
    changingTemporaryWorkspace.value = false;
  }
}

async function generateTemporaryFixtureFromUi(): Promise<void> {
  const workspace = temporaryWorkspace.value;
  if (workspace?.status !== 'live' || generatingTemporaryFixture.value) return;
  generatingTemporaryFixture.value = true;
  temporaryWorkspaceErrorMessage.value = undefined;
  resetTemporaryFixtureState();
  try {
    temporaryFixtureResult.value = await generateTemporaryHizoFSFixture({
      onProgress: ({ progress }) => {
        temporaryFixtureProgress.value = progress;
      },
      workspaceId: workspace.workspaceId,
    });
    resetInspectionNavigation();
    requestedNamespacePath.value = temporaryFixtureResult.value.rootPath;
    companionExplorerExpanded.value = true;
  } catch (error: unknown) {
    temporaryWorkspaceErrorMessage.value = errorMessage({ error });
  } finally {
    generatingTemporaryFixture.value = false;
  }
}

function selectInspectionSource({ kind }: { kind: WorkbenchInspectionSourceKind }): void {
  selectedInspectionSourceKind.value = kind;
  resetInspectionNavigation();
  switch (kind) {
  case 'active_encrypted_store':
    void refreshActiveSource();
    return;
  case 'ephemeral_debug_workspace':
  case 'standalone_container':
    return;
  default:
    kind satisfies never;
  }
}

async function refreshActiveSource(): Promise<void> {
  if (refreshingActiveReadAuthorities.value) return;
  refreshingActiveReadAuthorities.value = true;
  activeReadAuthorityErrorMessage.value = undefined;
  try {
    await refreshActiveHizoFSReadAuthorities();
    await refreshPhysicalInspector();
  } catch (error: unknown) {
    activeReadAuthorityErrorMessage.value = errorMessage({ error });
  } finally {
    refreshingActiveReadAuthorities.value = false;
  }
}

function recordInspectedNamespacePath({ authorityMode, commitSequence, path }: {
  authorityMode: 'active' | 'fallback_read_only';
  commitSequence: string;
  path: string;
}): void {
  inspectedNamespacePath.value = path;
  inspectedNamespaceAuthority.value = { authorityMode, commitSequence };
  requestedNamespacePath.value = path;
  const jump = pendingNamespacePathJump;
  if (jump?.path === path && jump.sourceKind === selectedInspectionSourceKind.value) {
    void settlePendingNamespacePathJump({ jump });
  }
}

function recordPhysicalTraversalBreadcrumbs({ breadcrumbs }: {
  breadcrumbs: readonly HizoFSPhysicalInspectorTraversalBreadcrumb[];
}): void {
  physicalTraversalBreadcrumbs.value = breadcrumbs;
}

function requestNamespaceInspectionPathFromFileExplorer({ entry }: { entry: FileExplorerEntry }): void {
  const {
    canMutate: _canMutate,
    canNavigate: _canNavigate,
    directory: _directory,
    extension: _extension,
    handle: _handle,
    kind: _kind,
    lastModified: _lastModified,
    mimeCategory: _mimeCategory,
    name: _name,
    path,
    readOnly: _readOnly,
    size: _size,
    ...unhandledEntry
  } = entry;
  unhandledEntry satisfies Record<PropertyKey, never>;
  const jump = {
    generation: ++namespacePathJumpGeneration,
    path,
    sourceKind: selectedInspectionSourceKind.value,
  } satisfies PendingNamespacePathJump;
  pendingNamespacePathJump = jump;
  requestedNamespacePath.value = path;
  if (inspectedNamespacePath.value === path) void settlePendingNamespacePathJump({ jump });
}

function isActiveInspectionSourceKind({ kind }: { kind: WorkbenchInspectionSourceKind }): boolean {
  switch (kind) {
  case 'active_encrypted_store': return true;
  case 'ephemeral_debug_workspace':
  case 'standalone_container': return false;
  default: return kind satisfies never;
  }
}

async function openStandaloneContainer(): Promise<void> {
  if (openingStandaloneContainer.value) return;
  const showDirectoryPicker = Reflect.get(window, 'showDirectoryPicker') as unknown;
  if (typeof showDirectoryPicker !== 'function') {
    standaloneErrorMessage.value = 'This browser does not provide a directory picker.';
    return;
  }
  const generation = ++standaloneOpenGeneration;
  openingStandaloneContainer.value = true;
  standaloneErrorMessage.value = undefined;
  try {
    const containerRoot = await Reflect.apply(showDirectoryPicker, window, [{ mode: 'read' }]) as FileSystemDirectoryHandle;
    const inspection = await import('@/features/debug-hizofs/worker/opfs-physical-inspection');
    const inspector = inspection.createHizoFSPhysicalInspectionWorkerForDirectory({ containerRoot });
    if (unmounted || generation !== standaloneOpenGeneration) return;
    standaloneContainerName.value = containerRoot.name;
    standaloneInspector.value = inspector;
    inspectedNamespacePath.value = undefined;
    inspectedNamespaceAuthority.value = undefined;
    requestedNamespacePath.value = undefined;
    physicalTraversalBreadcrumbs.value = [];
  } catch (error: unknown) {
    if (!unmounted && generation === standaloneOpenGeneration) {
      standaloneInspector.value = undefined;
      standaloneContainerName.value = undefined;
      standaloneErrorMessage.value = errorMessage({ error });
    }
  } finally {
    if (!unmounted && generation === standaloneOpenGeneration) openingStandaloneContainer.value = false;
  }
}

function errorMessage({ error }: { error: unknown }): string {
  return error instanceof Error ? error.message : String(error);
}

async function refreshPhysicalInspector(): Promise<void> {
  if (props.physicalInspector !== undefined || configuredAuthenticatedInspectionSession.value !== undefined) {
    openedInspector.value = undefined;
    inspectorErrorMessage.value = undefined;
    return;
  }

  const generation = ++openGeneration;
  openingInspector.value = true;
  inspectorErrorMessage.value = undefined;
  openedInspector.value = undefined;
  try {
    const configuredSource = configuredPhysicalInspectionSource.value;
    if (configuredSource === undefined) {
      openingInspector.value = false;
      return;
    }
    const inspector = await configuredSource.open();
    if (unmounted || generation !== openGeneration) return;
    openedInspector.value = inspector;
  } catch (error: unknown) {
    if (unmounted || generation !== openGeneration) return;
    inspectorErrorMessage.value = errorMessage({ error });
  } finally {
    if (!unmounted && generation === openGeneration) openingInspector.value = false;
  }
}

watch(
  () => [
    configuredAuthenticatedInspectionSession.value,
    configuredPhysicalInspectionSource.value,
    props.physicalInspector,
  ] as const,
  () => {
    openGeneration += 1;
    openedInspector.value = undefined;
    inspectorErrorMessage.value = undefined;
    switch (primaryView.value) {
    case 'physical_inspector':
      if (isActiveInspectionSourceKind({ kind: selectedInspectionSourceKind.value })) void refreshPhysicalInspector();
      return;
    case 'benchmark':
      return;
    default: {
      const _ex: never = primaryView.value;
      throw new Error(`Unhandled HizoFS Workbench view: ${String(_ex)}`);
    }
    }
  },
);

watch(primaryView, view => {
  switch (view) {
  case 'physical_inspector':
    if (isActiveInspectionSourceKind({ kind: selectedInspectionSourceKind.value }) && activeInspector.value === undefined && !openingInspector.value) void refreshPhysicalInspector();
    return;
  case 'benchmark':
    return;
  default: {
    const _ex: never = view;
    throw new Error(`Unhandled HizoFS Workbench view: ${String(_ex)}`);
  }
  }
});

onMounted(() => {
  void refreshPhysicalInspector();
  void refreshTemporaryHizoFSWorkspaces().catch((error: unknown) => {
    temporaryWorkspaceErrorMessage.value = errorMessage({ error });
  });
});

onUnmounted(() => {
  unmounted = true;
  namespacePathJumpGeneration += 1;
  pendingNamespacePathJump = undefined;
  openGeneration += 1;
  standaloneOpenGeneration += 1;
  openedInspector.value = undefined;
  standaloneInspector.value = undefined;
});

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      refreshPhysicalInspector,
    },
  }) || {}),
});
</script>

<template>
  <div tw-class="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-2 sm:p-4" @click.self="closeDebugHizoFSWorkbench">
    <section role="dialog" aria-modal="true" aria-labelledby="hizofs-workbench-title" tw-class="flex h-[96vh] w-full max-w-[1800px] flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-900">
      <header tw-class="flex shrink-0 items-center gap-3 border-b border-gray-200 px-4 py-3 dark:border-gray-700">
        <DatabaseIcon tw-class="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
        <div tw-class="min-w-0 flex-1">
          <h2 id="hizofs-workbench-title" tw-class="text-sm font-semibold text-gray-900 dark:text-gray-100">HizoFS Workbench</h2>
          <div tw-class="mt-0.5 flex min-w-0 items-center gap-2 font-mono text-[10px] text-gray-500 dark:text-gray-400">
            <span tw-class="truncate">{{ selectedInspectionSource.label }}</span>
            <span>·</span>
            <span>{{ selectedInspectionSource.access }}</span>
            <span>·</span>
            <span>{{ sourceStatusLabel({ source: selectedInspectionSource }) }}</span>
          </div>
        </div>
        <div tw-class="flex rounded-lg border border-gray-300 p-0.5 text-xs dark:border-gray-600">
          <button
            type="button"
            data-testid="physical-tab"
            :tw-class="['rounded px-2.5 py-1', primaryView === 'physical_inspector' ? 'bg-emerald-600 text-white' : 'hover:bg-gray-100 dark:hover:bg-gray-800']"
            @click="primaryView = 'physical_inspector'"
          >Inspection</button>
          <button
            type="button"
            data-testid="benchmark-tab"
            :tw-class="['rounded px-2.5 py-1', primaryView === 'benchmark' ? 'bg-emerald-600 text-white' : 'hover:bg-gray-100 dark:hover:bg-gray-800']"
            @click="primaryView = 'benchmark'"
          >Benchmark</button>
        </div>
        <button
          v-if="primaryView === 'physical_inspector' && selectedInspectionSource.kind === 'active_encrypted_store'"
          type="button"
          aria-label="Refresh HizoFS instance"
          tw-class="rounded-lg p-2 text-gray-500 hover:bg-gray-100 disabled:opacity-40 dark:text-gray-300 dark:hover:bg-gray-800"
          :disabled="openingInspector || refreshingActiveReadAuthorities"
          @click="refreshActiveSource"
        ><RefreshCwIcon :tw-class="['h-4 w-4', openingInspector || refreshingActiveReadAuthorities ? 'animate-spin' : '']" /></button>
        <button type="button" aria-label="Close HizoFS Workbench" tw-class="rounded-lg p-2 text-gray-500 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800" @click="closeDebugHizoFSWorkbench"><XIcon tw-class="h-5 w-5" /></button>
      </header>

      <nav v-if="primaryView === 'physical_inspector'" data-testid="hizofs-workbench-breadcrumbs" tw-class="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-gray-200 bg-gray-50 px-3 py-1.5 font-mono text-[10px] text-gray-500 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-400">
        <span>Sources</span>
        <ChevronRightIcon tw-class="h-3 w-3 shrink-0" />
        <span tw-class="max-w-[260px] truncate">{{ selectedInspectionSource.label }}</span>
        <ChevronRightIcon tw-class="h-3 w-3 shrink-0" />
        <span>Persisted structure</span>
        <template v-if="selectedSourceHasConnectedInstance">
          <template v-for="(breadcrumb, breadcrumbIndex) in physicalTraversalBreadcrumbs" :key="`${String(breadcrumbIndex)}:${breadcrumb.kind}:${breadcrumb.label}`">
            <ChevronRightIcon tw-class="h-3 w-3 shrink-0" />
            <button
              type="button"
              data-testid="hizofs-workbench-traversal-breadcrumb"
              :data-breadcrumb-kind="breadcrumb.kind"
              tw-class="max-w-[240px] truncate rounded px-1 py-0.5 hover:bg-gray-200 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200"
              @click="focusPhysicalTraversalBreadcrumb({ breadcrumb })"
            >{{ breadcrumb.label }}</button>
          </template>
          <template v-if="inspectedNamespacePath !== undefined">
            <ChevronRightIcon tw-class="h-3 w-3 shrink-0 text-blue-400" />
            <button
              type="button"
              data-testid="hizofs-workbench-logical-breadcrumb"
              tw-class="max-w-[320px] truncate rounded px-1 py-0.5 text-blue-600 hover:bg-blue-100 dark:text-blue-300 dark:hover:bg-blue-950/40"
              @click="focusLogicalNamespaceBreadcrumb"
            >{{ inspectedNamespaceAuthority?.authorityMode === 'fallback_read_only' ? 'fallback authority logical' : 'current logical path' }} {{ inspectedNamespacePath }}</button>
          </template>
        </template>
      </nav>

      <template v-if="primaryView === 'physical_inspector'">
        <div ref="workbenchColumnScroll" data-workbench-column-scroll data-testid="hizofs-workbench-column-scroll" tw-class="flex min-h-0 flex-1 overflow-x-auto overflow-y-hidden bg-gray-100 dark:bg-gray-950">
          <aside data-testid="hizofs-workbench-sources-column" tw-class="flex w-[300px] shrink-0 flex-col border-r border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
            <div tw-class="flex items-center justify-between border-b border-gray-200 px-3 py-2 dark:border-gray-700">
              <div>
                <div tw-class="text-[10px] font-semibold uppercase tracking-wide text-gray-500">Sources</div>
                <div tw-class="text-[9px] text-gray-400">HizoFS instances</div>
              </div>
              <button type="button" data-testid="hizofs-create-temporary-preview" :disabled="changingTemporaryWorkspace || generatingTemporaryFixture" tw-class="rounded border border-emerald-300 px-2 py-1 text-[10px] font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-950/30" @click="createTemporaryWorkspaceFromUi"><PlusIcon tw-class="mr-1 inline h-3 w-3" />Temporary</button>
            </div>
            <div tw-class="min-h-0 flex-1 overflow-auto">
              <button
                v-for="source in inspectionSources"
                :key="source.kind"
                type="button"
                data-testid="hizofs-workbench-source"
                :data-source-kind="source.kind"
                :tw-class="['flex w-full items-start gap-3 border-b border-gray-100 px-3 py-3 text-left dark:border-gray-800', selectedInspectionSourceKind === source.kind ? 'bg-emerald-50 dark:bg-emerald-950/30' : 'bg-white hover:bg-gray-50 dark:bg-gray-900 dark:hover:bg-gray-800']"
                @click="selectInspectionSource({ kind: source.kind })"
              >
                <HardDriveIcon v-if="sourceIcon({ source }) === 'active'" tw-class="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                <DatabaseIcon v-else-if="sourceIcon({ source }) === 'temporary'" tw-class="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                <FileArchiveIcon v-else tw-class="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />
                <span tw-class="min-w-0 flex-1">
                  <span tw-class="block truncate text-xs font-medium text-gray-800 dark:text-gray-200">{{ source.label }}</span>
                  <span tw-class="mt-1 block text-[9px] leading-4 text-gray-500 dark:text-gray-400">{{ source.description }}</span>
                  <span tw-class="mt-1 flex items-center gap-2 font-mono text-[9px] text-gray-400"><span>{{ source.access }}</span><span>{{ sourceStatusLabel({ source }) }}</span></span>
                </span>
                <ChevronRightIcon tw-class="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-300" />
              </button>
              <section v-if="temporaryWorkspaces.length > 0" data-testid="hizofs-temporary-workspace-list" tw-class="border-b border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-950">
                <div tw-class="border-b border-gray-200 px-3 py-1.5 text-[9px] font-semibold uppercase tracking-wide text-gray-500 dark:border-gray-700">Temporary HizoFS</div>
                <div v-for="workspace in temporaryWorkspaces" :key="workspace.workspaceId" :tw-class="['flex border-b border-gray-100 last:border-b-0 dark:border-gray-800', selectedTemporaryWorkspaceId === workspace.workspaceId ? 'bg-emerald-50 dark:bg-emerald-950/30' : '']">
                  <button type="button" data-testid="hizofs-temporary-workspace" :data-workspace-id="workspace.workspaceId" :disabled="changingTemporaryWorkspace || generatingTemporaryFixture" tw-class="min-w-0 flex-1 px-3 py-2 text-left disabled:opacity-50" @click="selectTemporaryWorkspaceFromUi({ workspaceId: workspace.workspaceId })">
                    <span tw-class="block truncate font-mono text-[10px] text-gray-700 dark:text-gray-300">{{ shortWorkspaceId({ workspaceId: workspace.workspaceId }) }}</span>
                    <span :tw-class="workspace.status === 'live' ? 'mt-0.5 block text-[9px] text-emerald-600 dark:text-emerald-300' : 'mt-0.5 block text-[9px] text-amber-600 dark:text-amber-300'">{{ workspace.status === 'live' ? 'Available until reload' : 'Expired · cleanup only' }}</span>
                  </button>
                  <button type="button" data-testid="hizofs-remove-temporary-workspace" :data-workspace-id="workspace.workspaceId" :aria-label="workspace.status === 'live' ? 'Destroy temporary HizoFS' : 'Clean up remaining OPFS data'" :disabled="changingTemporaryWorkspace || generatingTemporaryFixture" tw-class="self-center p-2 text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-30 dark:hover:bg-red-950/30" @click="destroyTemporaryWorkspaceFromUi({ workspaceId: workspace.workspaceId })"><Trash2Icon tw-class="h-3.5 w-3.5" /></button>
                </div>
              </section>
            </div>
          </aside>

          <aside tw-class="flex w-[330px] shrink-0 flex-col border-r border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
            <header tw-class="border-b border-gray-200 px-3 py-2 dark:border-gray-700">
              <div tw-class="text-[10px] font-semibold uppercase tracking-wide text-gray-500">File system instance</div>
              <div tw-class="mt-1 truncate font-mono text-[10px] text-gray-700 dark:text-gray-300">{{ selectedInspectionSource.label }}</div>
            </header>

            <template v-if="selectedSourceHasConnectedInstance">
              <div v-if="selectedInspectionSource.kind === 'ephemeral_debug_workspace'" tw-class="border-b border-emerald-200 p-3 dark:border-emerald-900">
                <div tw-class="grid gap-2">
                  <button type="button" data-testid="hizofs-generate-temporary-fixture" :disabled="changingTemporaryWorkspace || generatingTemporaryFixture || temporaryFixtureResult !== undefined" tw-class="w-full border border-emerald-300 px-3 py-2 text-left text-xs font-medium text-emerald-700 disabled:opacity-50 dark:border-emerald-800 dark:text-emerald-300" @click="generateTemporaryFixtureFromUi">{{ generatingTemporaryFixture ? 'Generating sample data…' : temporaryFixtureResult === undefined ? 'Generate comprehensive sample data' : 'Sample data generated' }}</button>
                  <button type="button" data-testid="hizofs-destroy-temporary-workspace" :disabled="changingTemporaryWorkspace || generatingTemporaryFixture" tw-class="w-full border border-red-200 px-3 py-2 text-left text-xs font-medium text-red-700 disabled:opacity-50 dark:border-red-900 dark:text-red-300" @click="destroyTemporaryWorkspaceFromUi({ workspaceId: temporaryWorkspace!.workspaceId })">Destroy temporary filesystem</button>
                </div>
                <div v-if="temporaryFixtureProgress !== undefined" data-testid="hizofs-temporary-fixture-progress" tw-class="mt-2 border-t border-emerald-100 pt-2 font-mono text-[9px] text-emerald-700 dark:border-emerald-900 dark:text-emerald-300">
                  <div>{{ temporaryFixtureProgress.phase }} · {{ temporaryFixtureProgress.completedPhaseCount }} / {{ temporaryFixtureProgress.totalPhaseCount }}</div>
                  <div tw-class="mt-1 text-gray-500 dark:text-gray-400">{{ temporaryFixtureProgress.detail }}</div>
                </div>
                <div v-if="temporaryFixtureResult !== undefined" data-testid="hizofs-temporary-fixture-result" tw-class="mt-2 border-t border-emerald-100 pt-2 text-[9px] text-emerald-700 dark:border-emerald-900 dark:text-emerald-300">{{ temporaryFixtureResult.coverage.length }} audit cases · {{ temporaryFixtureResult.rootPath }}</div>
              </div>
              <details data-testid="hizofs-workbench-source-capabilities" tw-class="shrink-0 border-b border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-950">
                <summary tw-class="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-[9px] dark:text-gray-300">
                  <span tw-class="font-semibold uppercase tracking-wide text-gray-500">Source capabilities</span>
                  <span tw-class="ml-auto font-mono text-emerald-600 dark:text-emerald-300">Physical: {{ selectedPhysicalInspector !== undefined || selectedAuthenticatedInspectionSession !== undefined ? 'available' : 'pending' }}</span>
                  <span tw-class="font-mono text-blue-600 dark:text-blue-300">Logical: {{ selectedDecryptedRoot !== undefined ? 'available' : 'pending' }}</span>
                  <span tw-class="font-mono text-gray-500 dark:text-gray-400">Writes: not exposed</span>
                  <ChevronDownIcon tw-class="h-3 w-3 shrink-0 text-gray-400" />
                </summary>
                <div tw-class="grid grid-cols-3 gap-px border-t border-gray-200 bg-gray-200 dark:border-gray-700 dark:bg-gray-700">
                  <div tw-class="bg-white px-3 py-2 dark:bg-gray-900"><span tw-class="block text-[10px] font-medium text-gray-700 dark:text-gray-300">Physical inspection</span><span tw-class="block font-mono text-[9px] text-gray-400">authenticated persisted reads · {{ selectedPhysicalInspector !== undefined || selectedAuthenticatedInspectionSession !== undefined ? 'available' : 'pending' }}</span></div>
                  <div tw-class="bg-white px-3 py-2 dark:bg-gray-900"><span tw-class="block text-[10px] font-medium text-gray-700 dark:text-gray-300">Decrypted filesystem</span><span tw-class="block font-mono text-[9px] text-gray-400">stable read snapshot · {{ selectedDecryptedRoot !== undefined ? 'available' : 'pending' }}</span></div>
                  <div tw-class="bg-white px-3 py-2 dark:bg-gray-900"><span tw-class="block text-[10px] font-medium text-gray-700 dark:text-gray-300">Mutation authority</span><span tw-class="block font-mono text-[9px] text-gray-400">production writes / publication · not exposed</span></div>
                </div>
              </details>
              <div tw-class="min-h-0 flex-1 overflow-auto">
                <div tw-class="border-b border-emerald-200 bg-emerald-50 px-3 py-2 text-[9px] font-semibold uppercase tracking-wide text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/20 dark:text-emerald-300">Persisted / authenticated</div>
                <button type="button" data-testid="hizofs-workbench-instance-entry" data-instance-entry-kind="physical_authority" tw-class="flex w-full items-center gap-3 border-b border-gray-100 bg-emerald-50/40 px-3 py-2.5 text-left hover:bg-emerald-50 dark:border-gray-800 dark:bg-emerald-950/10 dark:hover:bg-emerald-950/20" @click="selectWorkbenchInstanceEntry({ kind: 'physical_authority' })"><SearchIcon tw-class="h-4 w-4 text-emerald-600" /><span tw-class="min-w-0 flex-1"><span tw-class="block text-xs font-medium">Physical authority</span><span tw-class="block text-[9px] text-gray-400">Unlock Envelope copies and Superblock selection</span></span><ChevronRightIcon tw-class="h-3.5 w-3.5" /></button>
                <button type="button" data-testid="hizofs-workbench-instance-entry" data-instance-entry-kind="active_roots" tw-class="flex w-full items-center gap-3 border-b border-gray-100 px-3 py-2.5 text-left hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800" @click="selectWorkbenchInstanceEntry({ kind: 'active_roots' })"><DatabaseIcon tw-class="h-4 w-4 text-emerald-600" /><span tw-class="min-w-0 flex-1"><span tw-class="block text-xs font-medium">Active Commit and roots</span><span tw-class="block text-[9px] text-gray-400">Commit, Inode Table and relocation references</span></span><ChevronRightIcon tw-class="h-3.5 w-3.5" /></button>
                <button type="button" data-testid="hizofs-workbench-instance-entry" data-instance-entry-kind="root_namespace" tw-class="flex w-full items-center gap-3 border-b border-gray-100 px-3 py-2.5 text-left hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800" @click="selectWorkbenchInstanceEntry({ kind: 'root_namespace' })"><FolderTreeIcon tw-class="h-4 w-4 text-emerald-600" /><span tw-class="min-w-0 flex-1"><span tw-class="block text-xs font-medium">Root directory / namespace</span><span tw-class="block text-[9px] text-gray-400">Shortcut into authenticated Directory and Inode routing</span></span><ChevronRightIcon tw-class="h-3.5 w-3.5" /></button>
                <button type="button" data-testid="hizofs-workbench-instance-entry" data-instance-entry-kind="segments" tw-class="flex w-full items-center gap-3 border-b border-gray-100 px-3 py-2.5 text-left hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800" @click="selectWorkbenchInstanceEntry({ kind: 'segments' })"><HardDriveIcon tw-class="h-4 w-4 text-emerald-600" /><span tw-class="min-w-0 flex-1"><span tw-class="block text-xs font-medium">Segments / frames</span><span tw-class="block text-[9px] text-gray-400">Physical records and exact persisted locations</span></span><ChevronRightIcon tw-class="h-3.5 w-3.5" /></button>
                <div tw-class="border-b border-blue-200 bg-blue-50 px-3 py-2 text-[9px] font-semibold uppercase tracking-wide text-blue-700 dark:border-blue-900 dark:bg-blue-950/20 dark:text-blue-300">Derived / decrypted</div>
                <button type="button" data-testid="hizofs-workbench-instance-entry" data-instance-entry-kind="derived_filesystem" tw-class="flex w-full items-center gap-3 border-b border-gray-100 px-3 py-2.5 text-left hover:bg-blue-50 dark:border-gray-800 dark:hover:bg-blue-950/20" @click="selectWorkbenchInstanceEntry({ kind: 'derived_filesystem' })"><FolderTreeIcon tw-class="h-4 w-4 text-blue-500" /><span tw-class="min-w-0 flex-1"><span tw-class="block text-xs font-medium">Derived filesystem view</span><span tw-class="block text-[9px] text-gray-400">Read-only File Explorer for the same source</span></span><ChevronRightIcon tw-class="h-3.5 w-3.5" /></button>
              </div>
            </template>

            <template v-else>
              <div :tw-class="selectedInspectionSource.kind === 'ephemeral_debug_workspace' ? 'border-b border-emerald-200 bg-emerald-50 px-3 py-2 dark:border-emerald-900 dark:bg-emerald-950/20' : 'border-b border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-950'">
                <div :tw-class="selectedInspectionSource.kind === 'ephemeral_debug_workspace' ? 'text-[9px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300' : 'text-[9px] font-semibold uppercase tracking-wide text-gray-500'">{{ selectedInspectionSource.kind === 'ephemeral_debug_workspace' ? 'Temporary HizoFS' : 'Standalone HizoFS' }}</div>
                <div tw-class="mt-1 text-[10px] leading-4 text-gray-500 dark:text-gray-400">{{ selectedInspectionSource.kind === 'ephemeral_debug_workspace' ? 'Disposable self-contained filesystem for isolated inspection and experiments.' : 'Independent container for offline authenticated inspection.' }}</div>
              </div>
              <div tw-class="border-b border-gray-200 p-3 dark:border-gray-700">
                <button
                  v-if="selectedInspectionSource.kind === 'ephemeral_debug_workspace' && temporaryWorkspace === undefined"
                  type="button"
                  data-testid="hizofs-create-temporary-workspace"
                  :disabled="changingTemporaryWorkspace || generatingTemporaryFixture"
                  tw-class="w-full border border-emerald-300 px-3 py-2 text-left text-xs font-medium text-emerald-700 disabled:opacity-50 dark:border-emerald-800 dark:text-emerald-300"
                  @click="createTemporaryWorkspaceFromUi"
                >{{ changingTemporaryWorkspace ? 'Creating temporary filesystem…' : 'Create temporary filesystem' }}</button>
                <button
                  v-else-if="selectedInspectionSource.kind === 'ephemeral_debug_workspace'"
                  type="button"
                  data-testid="hizofs-cleanup-selected-temporary"
                  :disabled="changingTemporaryWorkspace || generatingTemporaryFixture"
                  tw-class="w-full border border-red-200 px-3 py-2 text-left text-xs font-medium text-red-700 disabled:opacity-50 dark:border-red-900 dark:text-red-300"
                  @click="destroyTemporaryWorkspaceFromUi({ workspaceId: temporaryWorkspace!.workspaceId })"
                >{{ temporaryWorkspace!.status === 'stale' ? 'Clean up remaining OPFS data' : 'Retry Temporary HizoFS cleanup' }}</button>
                <button v-else type="button" data-testid="hizofs-open-standalone-container" :disabled="openingStandaloneContainer" tw-class="w-full border border-gray-300 px-3 py-2 text-left text-xs font-medium disabled:opacity-60 dark:border-gray-700" @click="openStandaloneContainer">{{ openingStandaloneContainer ? 'Opening standalone HizoFS…' : 'Open standalone HizoFS…' }}</button>
                <p v-if="temporaryWorkspaceErrorMessage !== undefined && selectedInspectionSource.kind === 'ephemeral_debug_workspace'" tw-class="mt-2 break-words font-mono text-[9px] text-red-600 dark:text-red-300">{{ temporaryWorkspaceErrorMessage }}</p>
                <p v-else-if="standaloneErrorMessage !== undefined && selectedInspectionSource.kind === 'standalone_container'" data-testid="hizofs-standalone-container-error" tw-class="mt-2 break-words font-mono text-[9px] text-red-600 dark:text-red-300">{{ standaloneErrorMessage }}</p>
                <p v-else tw-class="mt-2 font-mono text-[9px] text-amber-600 dark:text-amber-300">{{ selectedInspectionSource.kind === 'ephemeral_debug_workspace' ? temporaryWorkspace?.status === 'stale' ? 'Expired Temporary HizoFS · cleanup removes remaining raw OPFS data without reopening it.' : 'Creates a real self-contained HizoFS source with physical + decrypted read capabilities for this document.' : 'Choose the HizoFS container directory. Authentication remains a one-shot Inspector operation; no decrypted filesystem session is created.' }}</p>
              </div>
              <div tw-class="min-h-0 flex-1 overflow-auto">
                <div tw-class="border-b border-emerald-200 bg-emerald-50 px-3 py-2 text-[9px] font-semibold uppercase tracking-wide text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/20 dark:text-emerald-300">Persisted / authenticated</div>
                <button type="button" data-testid="hizofs-workbench-instance-entry" data-instance-entry-kind="physical_authority" tw-class="flex w-full items-center gap-3 border-b border-gray-100 px-3 py-2.5 text-left hover:bg-emerald-50 dark:border-gray-800 dark:hover:bg-emerald-950/20" @click="selectWorkbenchInstanceEntry({ kind: 'physical_authority' })"><SearchIcon tw-class="h-4 w-4 text-emerald-600" /><span tw-class="min-w-0 flex-1"><span tw-class="block text-xs font-medium">Physical authority</span><span tw-class="block text-[9px] text-gray-400">Unlock / Superblock source authority</span></span><ChevronRightIcon tw-class="h-3.5 w-3.5" /></button>
                <button type="button" data-testid="hizofs-workbench-instance-entry" data-instance-entry-kind="root_namespace" tw-class="flex w-full items-center gap-3 border-b border-gray-100 px-3 py-2.5 text-left hover:bg-emerald-50 dark:border-gray-800 dark:hover:bg-emerald-950/20" @click="selectWorkbenchInstanceEntry({ kind: 'root_namespace' })"><FolderTreeIcon tw-class="h-4 w-4 text-emerald-600" /><span tw-class="min-w-0 flex-1"><span tw-class="block text-xs font-medium">Root directory / namespace</span><span tw-class="block text-[9px] text-gray-400">Authenticated directory and inode routing</span></span><ChevronRightIcon tw-class="h-3.5 w-3.5" /></button>
                <button type="button" data-testid="hizofs-workbench-instance-entry" data-instance-entry-kind="segments" tw-class="flex w-full items-center gap-3 border-b border-gray-100 px-3 py-2.5 text-left hover:bg-emerald-50 dark:border-gray-800 dark:hover:bg-emerald-950/20" @click="selectWorkbenchInstanceEntry({ kind: 'segments' })"><HardDriveIcon tw-class="h-4 w-4 text-emerald-600" /><span tw-class="min-w-0 flex-1"><span tw-class="block text-xs font-medium">Segments / frames</span><span tw-class="block text-[9px] text-gray-400">Physical record locations and framing</span></span><ChevronRightIcon tw-class="h-3.5 w-3.5" /></button>
                <div tw-class="border-b border-blue-200 bg-blue-50 px-3 py-2 text-[9px] font-semibold uppercase tracking-wide text-blue-700 dark:border-blue-900 dark:bg-blue-950/20 dark:text-blue-300">Derived / decrypted</div>
                <button type="button" data-testid="hizofs-workbench-instance-entry" data-instance-entry-kind="derived_filesystem" tw-class="flex w-full items-center gap-3 border-b border-gray-100 px-3 py-2.5 text-left hover:bg-blue-50 dark:border-gray-800 dark:hover:bg-blue-950/20" @click="selectWorkbenchInstanceEntry({ kind: 'derived_filesystem' })"><FolderTreeIcon tw-class="h-4 w-4 text-blue-500" /><span tw-class="min-w-0 flex-1"><span tw-class="block text-xs font-medium">Derived filesystem view</span><span tw-class="block text-[9px] text-gray-400">Decrypted File Explorer companion</span></span><ChevronRightIcon tw-class="h-3.5 w-3.5" /></button>
              </div>
            </template>
          </aside>

          <template v-if="selectedSourceHasConnectedInstance">
            <section v-if="selectedInspectionSource.kind === 'active_encrypted_store' && openingInspector" tw-class="flex h-full w-[440px] shrink-0 flex-col border-r border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
              <div tw-class="border-b border-emerald-200 bg-emerald-50 px-3 py-2 text-[9px] font-semibold uppercase tracking-wide text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/20 dark:text-emerald-300">Authenticated inspection</div>
              <div tw-class="flex flex-1 items-center justify-center gap-2 text-sm text-gray-500"><LoaderCircleIcon tw-class="h-5 w-5 animate-spin" />Opening active HizoFS…</div>
            </section>
            <section v-else-if="selectedInspectionSource.kind === 'active_encrypted_store' && inspectorErrorMessage !== undefined" tw-class="flex h-full w-[440px] shrink-0 flex-col border-r border-red-200 bg-white dark:border-red-900 dark:bg-gray-900">
              <div tw-class="border-b border-red-200 bg-red-50 px-3 py-2 text-[9px] font-semibold uppercase tracking-wide text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">Physical Inspector is unavailable</div>
              <div tw-class="p-3 text-sm text-red-800 dark:text-red-200"><p tw-class="break-words">{{ inspectorErrorMessage }}</p><button type="button" data-testid="retry-inspector" tw-class="mt-3 inline-flex items-center gap-2 border border-current px-3 py-1.5" @click="refreshPhysicalInspector"><RefreshCwIcon tw-class="h-4 w-4" />Retry</button></div>
            </section>
            <HizoFSPhysicalInspectorPanel
              v-else-if="selectedPhysicalInspector !== undefined || selectedAuthenticatedInspectionSession !== undefined"
              :key="`${selectedInspectionSource.kind}:${selectedTemporaryWorkspaceId ?? ''}:${String(temporaryInspectionRevision)}`"
              :authenticated-session="selectedAuthenticatedInspectionSession"
              :embedded-in-workbench="true"
              :inspector="selectedPhysicalInspector"
              :requested-namespace-path="requestedNamespacePath"
              @namespace-inspected="recordInspectedNamespacePath"
              @traversal-changed="recordPhysicalTraversalBreadcrumbs"
            />
            <section v-else tw-class="flex h-full w-[440px] shrink-0 flex-col border-r border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
              <div tw-class="border-b border-gray-200 px-3 py-2 text-[9px] font-semibold uppercase tracking-wide text-gray-500 dark:border-gray-700">Authenticated inspection</div>
              <div tw-class="p-3 text-sm text-gray-500">No authenticated physical Inspector source is available.</div>
            </section>
          </template>

          <div v-else data-testid="hizofs-workbench-preview-columns" tw-class="flex h-full shrink-0">
            <section data-testid="hizofs-workbench-preview-control-column" tw-class="flex w-[440px] shrink-0 flex-col border-r border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
              <header tw-class="border-b border-emerald-200 bg-emerald-50 px-3 py-2 dark:border-emerald-900 dark:bg-emerald-950/20">
                <div tw-class="text-[9px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">Inspection controls</div>
                <div tw-class="mt-0.5 font-mono text-[9px] text-gray-500 dark:text-gray-400">{{ selectedInspectionSource.label }} · authenticated source pending</div>
              </header>
              <div tw-class="border-b border-gray-100 px-3 py-3 dark:border-gray-800">
                <div tw-class="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Namespace path</div>
                <div tw-class="mt-1 border border-gray-200 bg-gray-50 px-2 py-1.5 font-mono text-[10px] text-gray-500 dark:border-gray-700 dark:bg-gray-950">/</div>
              </div>
              <div tw-class="grid gap-2 border-b border-gray-100 px-3 py-3 dark:border-gray-800">
                <button type="button" disabled tw-class="border border-gray-300 px-2.5 py-1.5 text-left text-[10px] font-medium opacity-50 dark:border-gray-700">Read physical state</button>
                <button type="button" disabled tw-class="bg-emerald-600 px-2.5 py-1.5 text-left text-[10px] font-medium text-white opacity-50">Inspect root namespace</button>
              </div>
              <div tw-class="px-3 py-3 font-mono text-[10px] leading-5 text-amber-600 dark:text-amber-300">Backend pending · controls are intentionally inert until this source can supply both authenticated physical inspection and decrypted filesystem capabilities.</div>
            </section>
            <section data-workbench-inspector-surface="physical-authority" tw-class="flex w-[440px] shrink-0 flex-col border-r border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
              <div tw-class="border-b border-emerald-200 bg-emerald-50 px-3 py-2 dark:border-emerald-900 dark:bg-emerald-950/20">
                <div tw-class="text-[9px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">Persisted structure · Authority copies</div>
                <div tw-class="mt-0.5 font-mono text-[9px] text-gray-500 dark:text-gray-400">{{ selectedInspectionSource.label }} · backend connection pending</div>
              </div>
              <div tw-class="divide-y divide-gray-100 dark:divide-gray-800">
                <div v-for="label in ['Unlock Envelope copies', 'Superblock copies', 'Active Commit and roots']" :key="label" tw-class="flex items-center px-3 py-3 text-xs"><span tw-class="min-w-0 flex-1">{{ label }}</span><span tw-class="font-mono text-[9px] text-gray-400">not loaded</span></div>
              </div>
            </section>
            <section data-workbench-inspector-surface="segments" tw-class="flex w-[440px] shrink-0 flex-col border-r border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
              <div tw-class="border-b border-emerald-200 bg-emerald-50 px-3 py-2 dark:border-emerald-900 dark:bg-emerald-950/20">
                <div tw-class="text-[9px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">Segments / frames</div>
                <div tw-class="mt-0.5 font-mono text-[9px] text-gray-500 dark:text-gray-400">physical persisted records · backend connection pending</div>
              </div>
              <div tw-class="px-3 py-3 font-mono text-[10px] leading-5 text-gray-400">Segment identities, frame offsets, record kinds and framing metadata will appear here.</div>
            </section>
            <section data-testid="hizofs-workbench-preview-record-column" tw-class="flex w-[440px] shrink-0 flex-col overflow-y-auto border-r border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
              <div tw-class="border-b border-emerald-200 bg-emerald-50 px-3 py-2 dark:border-emerald-900 dark:bg-emerald-950/20">
                <div tw-class="text-[9px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">Reference destination</div>
                <div tw-class="mt-0.5 font-mono text-[9px] text-gray-400">No authenticated record selected</div>
              </div>
              <section tw-class="border-b border-gray-100 dark:border-gray-800">
                <div tw-class="border-b border-gray-100 bg-gray-50 px-3 py-1.5 text-[9px] font-semibold uppercase tracking-wide text-gray-500 dark:border-gray-800 dark:bg-gray-950">Overview</div>
                <div tw-class="px-3 py-3 text-[10px] leading-5 text-gray-500 dark:text-gray-400">Selecting a persisted reference will open its authenticated record here while preserving the source chain to the left.</div>
              </section>
              <section tw-class="border-b border-gray-200 dark:border-gray-700">
                <div tw-class="border-b border-emerald-200 bg-emerald-50 px-3 py-1.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/20 dark:text-emerald-300">Persisted references</div>
                <div tw-class="px-3 py-2.5 font-mono text-[10px] text-gray-400">Outgoing authenticated references will appear here.</div>
              </section>
              <section tw-class="border-b border-gray-200 dark:border-gray-700">
                <div tw-class="border-b border-gray-200 bg-emerald-50 px-3 py-1.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-700 dark:border-gray-700 dark:bg-emerald-950/20 dark:text-emerald-300">Exact decoded representation</div>
                <div tw-class="px-3 py-2.5 font-mono text-[10px] text-gray-400">Decoded DTO / bounded payload pending.</div>
              </section>
              <section tw-class="border-b border-gray-200 dark:border-gray-700">
                <div tw-class="border-b border-gray-200 bg-gray-50 px-3 py-1.5 text-[9px] font-semibold uppercase tracking-wide text-gray-500 dark:border-gray-700 dark:bg-gray-950">Authenticated plaintext preview</div>
                <div tw-class="px-3 py-2.5 font-mono text-[10px] text-gray-400">Authenticated bytes preview pending.</div>
              </section>
              <section tw-class="border-b border-gray-200 dark:border-gray-700">
                <div tw-class="border-b border-gray-200 bg-gray-50 px-3 py-1.5 text-[9px] font-semibold uppercase tracking-wide text-gray-500 dark:border-gray-700 dark:bg-gray-950">Binary representation</div>
                <div tw-class="px-3 py-2.5 font-mono text-[10px] text-gray-400">Full framed binary inspection pending.</div>
              </section>
            </section>
          </div>
        </div>

        <section
          data-testid="hizofs-workbench-companion-explorer"
          :data-expanded="companionExplorerExpanded ? 'true' : 'false'"
          tw-class="shrink-0 border-t border-blue-200 bg-white dark:border-blue-900 dark:bg-gray-900"
        >
          <header tw-class="flex items-center gap-3 px-3 py-2">
            <button type="button" data-testid="hizofs-toggle-companion-explorer" tw-class="flex min-w-0 flex-1 items-center gap-2 text-left" @click="companionExplorerExpanded = !companionExplorerExpanded">
              <ChevronUpIcon v-if="companionExplorerExpanded" tw-class="h-3.5 w-3.5 shrink-0 text-blue-500" />
              <ChevronDownIcon v-else tw-class="h-3.5 w-3.5 shrink-0 text-blue-500" />
              <FilesIcon tw-class="h-4 w-4 shrink-0 text-blue-500" />
              <span tw-class="min-w-0 flex-1">
                <span tw-class="block text-[9px] font-semibold uppercase tracking-wide text-blue-600 dark:text-blue-300">Derived filesystem view · decrypted companion</span>
                <span tw-class="block truncate font-mono text-[10px] text-gray-500 dark:text-gray-400">{{ companionExplorerStatus }}</span>
              </span>
            </button>
            <button v-if="selectedSourceHasConnectedInstance" type="button" data-testid="hizofs-toggle-companion-follow" tw-class="rounded border border-blue-200 bg-blue-50 px-2 py-1 text-[9px] font-semibold uppercase tracking-wide text-blue-700 hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-300 dark:hover:bg-blue-950/50" @click="companionFollowEnabled = !companionFollowEnabled">{{ companionExplorerBadge }}</button><span v-else tw-class="rounded border border-blue-200 bg-blue-50 px-2 py-1 text-[9px] font-semibold uppercase tracking-wide text-blue-700 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-300">{{ companionExplorerBadge }}</span>
          </header>
          <div v-show="companionExplorerExpanded" data-testid="hizofs-workbench-companion-body" tw-class="h-[34vh] min-h-[260px] border-t border-blue-100 dark:border-blue-900">
            <Suspense v-if="selectedSourceHasConnectedInstance && companionFileExplorerRoot !== undefined">
              <FileExplorer
                :key="`${selectedInspectionSource.kind}:${selectedTemporaryWorkspaceId ?? ''}:${String(temporaryInspectionRevision)}`"
                :root="companionFileExplorerRoot"
                :initial-path="undefined"
                :initial-locked="true"
                :reveal-path="companionRevealPath"
                entry-context-action-label="Use path in HizoFS Inspector"
                initial-view-mode="column"
                initial-preview-visibility="visible"
                reveal-file-preview="load"
                tw-class="h-full"
                @entry-context-action="requestNamespaceInspectionPathFromFileExplorer"
              />
              <template #fallback><div tw-class="flex h-full items-center justify-center gap-2 text-xs text-gray-500"><LoaderCircleIcon tw-class="h-4 w-4 animate-spin" />Opening decrypted view…</div></template>
            </Suspense>
            <div v-else tw-class="flex h-full items-center justify-center px-8 text-center text-xs text-gray-500">{{ selectedInspectionSource.kind === 'active_encrypted_store' ? activeReadAuthorityErrorMessage ?? 'Unlock the active HizoFS and refresh this source to obtain a stable decrypted read snapshot.' : selectedSourceHasConnectedInstance ? 'This source must supply a decrypted root before files can be shown here.' : 'The decrypted File Explorer will occupy this same companion surface when this source backend is connected.' }}</div>
          </div>
        </section>
      </template>

      <main v-else tw-class="min-h-0 flex-1 overflow-auto p-4">
        <HizoFSBenchmarkPanel />
      </main>
    </section>
  </div>
</template>
