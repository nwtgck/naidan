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
  physicalInspectionSource: installedPhysicalInspectionSource,
  temporaryAuthenticatedInspectionSession,
  temporaryDecryptedRoot,
  temporaryWorkspace,
} = useDebugHizoFSWorkbench();
const primaryView = ref<'benchmark' | 'physical_inspector'>('physical_inspector');
type WorkbenchInspectionSourceKind = 'active_encrypted_store' | 'ephemeral_debug_workspace' | 'standalone_preview';
type WorkbenchInspectionSource = Readonly<
  | {
      access: 'read';
      description: string;
      kind: 'active_encrypted_store';
      label: string;
      status: 'available' | 'opening' | 'partial' | 'unavailable';
    }
  | {
      access: 'read_write';
      description: string;
      kind: 'ephemeral_debug_workspace';
      label: string;
      status: 'available' | 'opening' | 'partial' | 'unavailable';
    }
  | {
      access: 'read';
      description: string;
      kind: 'standalone_preview';
      label: string;
      status: 'preview';
    }
>;
const selectedInspectionSourceKind = ref<WorkbenchInspectionSourceKind>('active_encrypted_store');
const companionExplorerExpanded = ref(true);
const workbenchColumnScroll = ref<HTMLElement>();
const companionFollowEnabled = ref(true);
const inspectedNamespacePath = ref<string>();
const physicalTraversalBreadcrumbs = ref<readonly HizoFSPhysicalInspectorTraversalBreadcrumb[]>([]);
const requestedNamespacePath = ref<string>();
const openedInspector = ref<HizoFSPhysicalInspectionWorker>();
const openingInspector = ref(false);
const inspectorErrorMessage = ref<string>();
const temporaryWorkspaceErrorMessage = ref<string>();
const changingTemporaryWorkspace = ref(false);
let openGeneration = 0;
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
  case 'standalone_preview': return undefined;
  default: return selectedInspectionSourceKind.value satisfies never;
  }
});
const selectedDecryptedRoot = computed(() => {
  switch (selectedInspectionSourceKind.value) {
  case 'active_encrypted_store': return configuredDecryptedRoot.value;
  case 'ephemeral_debug_workspace': return temporaryDecryptedRoot.value;
  case 'standalone_preview': return undefined;
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
    rootName: root.name,
  });
});
const activeInspector = computed(() => props.physicalInspector ?? openedInspector.value);
const inspectionSources = computed<readonly WorkbenchInspectionSource[]>(() => [
  {
    access: 'read',
    description: 'Current Naidan HizoFS · authenticated production data',
    kind: 'active_encrypted_store',
    label: 'Naidan active HizoFS',
    status: openingInspector.value
      ? 'opening'
      : (activeInspector.value !== undefined || configuredAuthenticatedInspectionSession.value !== undefined) && configuredDecryptedRoot.value !== undefined
        ? 'available'
        : (activeInspector.value !== undefined || configuredAuthenticatedInspectionSession.value !== undefined) || configuredDecryptedRoot.value !== undefined
          ? 'partial'
          : 'unavailable',
  },
  {
    access: 'read_write',
    description: 'Disposable simple-case filesystem for inspection and experiments',
    kind: 'ephemeral_debug_workspace',
    label: 'Temporary HizoFS',
    status: changingTemporaryWorkspace.value
      ? 'opening'
      : temporaryWorkspace.value === undefined
        ? 'unavailable'
        : temporaryAuthenticatedInspectionSession.value !== undefined && temporaryDecryptedRoot.value !== undefined
          ? 'available'
          : 'partial',
  },
  {
    access: 'read',
    description: 'Open an independent HizoFS container for offline inspection',
    kind: 'standalone_preview',
    label: 'Standalone HizoFS',
    status: 'preview',
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
  case 'ephemeral_debug_workspace': return temporaryWorkspace.value !== undefined;
  case 'standalone_preview': return false;
  default: return selectedInspectionSource.value satisfies never;
  }
});
const selectedPhysicalInspector = computed(() => {
  switch (selectedInspectionSourceKind.value) {
  case 'active_encrypted_store': return activeInspector.value;
  case 'ephemeral_debug_workspace':
  case 'standalone_preview': return undefined;
  default: return selectedInspectionSourceKind.value satisfies never;
  }
});
const companionExplorerStatus = computed(() => {
  switch (selectedInspectionSource.value.kind) {
  case 'active_encrypted_store':
    if (companionFileExplorerRoot.value === undefined) return 'read snapshot unavailable';
    if (!companionFollowEnabled.value) {
      return inspectedNamespacePath.value === undefined
        ? 'detached · no persisted path selected'
        : `detached · persisted selection ${inspectedNamespacePath.value}`;
    }
    return inspectedNamespacePath.value === undefined
      ? 'read snapshot connected · no persisted path selected'
      : `following ${inspectedNamespacePath.value}`;
  case 'ephemeral_debug_workspace':
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
    return inspectedNamespacePath.value === undefined
      ? 'temporary filesystem connected · no persisted path selected'
      : `following ${inspectedNamespacePath.value}`;
  case 'standalone_preview':
    return 'standalone container not opened · backend pending';
  default: return selectedInspectionSource.value satisfies never;
  }
});
const companionExplorerBadge = computed(() => {
  switch (selectedInspectionSource.value.kind) {
  case 'active_encrypted_store': return companionFollowEnabled.value ? 'Follow on' : 'Detached';
  case 'ephemeral_debug_workspace':
    if (temporaryWorkspace.value === undefined) return 'Create first';
    return companionFollowEnabled.value ? 'Follow on' : 'Detached';
  case 'standalone_preview': return 'UI shell';
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

async function focusPhysicalTraversalBreadcrumb({ breadcrumb }: {
  breadcrumb: HizoFSPhysicalInspectorTraversalBreadcrumb;
}): Promise<void> {
  switch (breadcrumb.kind) {
  case 'authority':
    await focusWorkbenchSurface({ selector: '[data-workbench-inspector-surface="physical-authority"], [data-testid="hizofs-physical-inspector-embedded-control-column"]' });
    return;
  case 'frame':
    await focusWorkbenchSurface({ selector: '[data-workbench-inspector-surface="segments"], [data-testid="hizofs-physical-inspector-embedded-control-column"]' });
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
    void focusWorkbenchSurface({ selector: '[data-workbench-inspector-surface="physical-authority"], [data-testid="hizofs-physical-inspector-embedded-control-column"]' });
    return;
  case 'root_namespace':
    requestedNamespacePath.value = '/';
    void focusWorkbenchSurface({ selector: '[data-workbench-inspector-surface="namespace"], [data-testid="hizofs-physical-inspector-embedded-control-column"]' });
    return;
  case 'segments':
    void focusWorkbenchSurface({ selector: '[data-workbench-inspector-surface="segments"], [data-testid="hizofs-physical-inspector-embedded-control-column"]' });
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
  case 'preview': return 'UI preview';
  default: return source satisfies never;
  }
}

function sourceIcon({ source }: { source: WorkbenchInspectionSource }): 'active' | 'standalone' | 'temporary' {
  switch (source.kind) {
  case 'active_encrypted_store': return 'active';
  case 'ephemeral_debug_workspace': return 'temporary';
  case 'standalone_preview': return 'standalone';
  default: return source satisfies never;
  }
}

async function createTemporaryWorkspaceFromUi(): Promise<void> {
  if (changingTemporaryWorkspace.value) return;
  changingTemporaryWorkspace.value = true;
  temporaryWorkspaceErrorMessage.value = undefined;
  try {
    await createTemporaryHizoFSWorkspace();
    requestedNamespacePath.value = '/';
  } catch (error: unknown) {
    temporaryWorkspaceErrorMessage.value = errorMessage({ error });
  } finally {
    changingTemporaryWorkspace.value = false;
  }
}

async function destroyTemporaryWorkspaceFromUi(): Promise<void> {
  if (changingTemporaryWorkspace.value) return;
  changingTemporaryWorkspace.value = true;
  temporaryWorkspaceErrorMessage.value = undefined;
  try {
    await destroyTemporaryHizoFSWorkspace();
    inspectedNamespacePath.value = undefined;
    requestedNamespacePath.value = undefined;
    physicalTraversalBreadcrumbs.value = [];
  } catch (error: unknown) {
    temporaryWorkspaceErrorMessage.value = errorMessage({ error });
  } finally {
    changingTemporaryWorkspace.value = false;
  }
}

function selectInspectionSource({ kind }: { kind: WorkbenchInspectionSourceKind }): void {
  selectedInspectionSourceKind.value = kind;
  inspectedNamespacePath.value = undefined;
  requestedNamespacePath.value = undefined;
  physicalTraversalBreadcrumbs.value = [];
  companionFollowEnabled.value = true;
  switch (kind) {
  case 'active_encrypted_store':
    if (activeInspector.value === undefined && !openingInspector.value) void refreshPhysicalInspector();
    return;
  case 'ephemeral_debug_workspace':
  case 'standalone_preview':
    return;
  default:
    kind satisfies never;
  }
}

function recordInspectedNamespacePath({ path }: { path: string }): void {
  inspectedNamespacePath.value = path;
  requestedNamespacePath.value = path;
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
  requestedNamespacePath.value = path;
}

function isActiveInspectionSourceKind({ kind }: { kind: WorkbenchInspectionSourceKind }): boolean {
  switch (kind) {
  case 'active_encrypted_store': return true;
  case 'ephemeral_debug_workspace':
  case 'standalone_preview': return false;
  default: return kind satisfies never;
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
});

onUnmounted(() => {
  unmounted = true;
  openGeneration += 1;
  openedInspector.value = undefined;
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
          :disabled="openingInspector"
          @click="refreshPhysicalInspector"
        ><RefreshCwIcon :tw-class="['h-4 w-4', openingInspector ? 'animate-spin' : '']" /></button>
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
            >logical {{ inspectedNamespacePath }}</button>
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
              <button type="button" data-testid="hizofs-create-temporary-preview" tw-class="rounded border border-emerald-300 px-2 py-1 text-[10px] font-medium text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-950/30" @click="selectInspectionSource({ kind: 'ephemeral_debug_workspace' })"><PlusIcon tw-class="mr-1 inline h-3 w-3" />Temporary</button>
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
            </div>
          </aside>

          <aside tw-class="flex w-[330px] shrink-0 flex-col border-r border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
            <header tw-class="border-b border-gray-200 px-3 py-2 dark:border-gray-700">
              <div tw-class="text-[10px] font-semibold uppercase tracking-wide text-gray-500">File system instance</div>
              <div tw-class="mt-1 truncate font-mono text-[10px] text-gray-700 dark:text-gray-300">{{ selectedInspectionSource.label }}</div>
            </header>

            <template v-if="selectedSourceHasConnectedInstance">
              <div v-if="selectedInspectionSource.kind === 'ephemeral_debug_workspace'" tw-class="border-b border-emerald-200 p-3 dark:border-emerald-900">
                <button type="button" data-testid="hizofs-destroy-temporary-workspace" :disabled="changingTemporaryWorkspace" tw-class="w-full border border-red-200 px-3 py-2 text-left text-xs font-medium text-red-700 disabled:opacity-50 dark:border-red-900 dark:text-red-300" @click="destroyTemporaryWorkspaceFromUi">Destroy temporary filesystem</button>
              </div>
              <section data-testid="hizofs-workbench-source-capabilities" tw-class="border-b border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-950">
                <div tw-class="border-b border-gray-200 px-3 py-1.5 text-[9px] font-semibold uppercase tracking-wide text-gray-500 dark:border-gray-700">Source capabilities</div>
                <div tw-class="divide-y divide-gray-100 dark:divide-gray-800">
                  <div tw-class="flex items-start gap-3 px-3 py-2">
                    <span tw-class="min-w-0 flex-1"><span tw-class="block text-[10px] font-medium text-gray-700 dark:text-gray-300">Physical inspection</span><span tw-class="block font-mono text-[9px] text-gray-400">authenticated persisted reads</span></span>
                    <span :tw-class="selectedPhysicalInspector !== undefined || selectedAuthenticatedInspectionSession !== undefined ? 'border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 font-mono text-[9px] text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300' : 'border border-amber-200 bg-amber-50 px-1.5 py-0.5 font-mono text-[9px] text-amber-700 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300'">{{ selectedPhysicalInspector !== undefined || selectedAuthenticatedInspectionSession !== undefined ? 'available' : 'pending' }}</span>
                  </div>
                  <div tw-class="flex items-start gap-3 px-3 py-2">
                    <span tw-class="min-w-0 flex-1"><span tw-class="block text-[10px] font-medium text-gray-700 dark:text-gray-300">Decrypted filesystem</span><span tw-class="block font-mono text-[9px] text-gray-400">stable read snapshot</span></span>
                    <span :tw-class="selectedDecryptedRoot !== undefined ? 'border border-blue-200 bg-blue-50 px-1.5 py-0.5 font-mono text-[9px] text-blue-700 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-300' : 'border border-amber-200 bg-amber-50 px-1.5 py-0.5 font-mono text-[9px] text-amber-700 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300'">{{ selectedDecryptedRoot !== undefined ? 'available' : 'pending' }}</span>
                  </div>
                  <div tw-class="flex items-start gap-3 px-3 py-2">
                    <span tw-class="min-w-0 flex-1"><span tw-class="block text-[10px] font-medium text-gray-700 dark:text-gray-300">Mutation authority</span><span tw-class="block font-mono text-[9px] text-gray-400">production writes / publication</span></span>
                    <span tw-class="border border-gray-200 bg-white px-1.5 py-0.5 font-mono text-[9px] text-gray-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">not exposed</span>
                  </div>
                </div>
              </section>
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
                <div :tw-class="selectedInspectionSource.kind === 'ephemeral_debug_workspace' ? 'text-[9px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300' : 'text-[9px] font-semibold uppercase tracking-wide text-gray-500'">{{ selectedInspectionSource.kind === 'ephemeral_debug_workspace' ? 'Temporary HizoFS' : 'Standalone HizoFS · UI-first preview' }}</div>
                <div tw-class="mt-1 text-[10px] leading-4 text-gray-500 dark:text-gray-400">{{ selectedInspectionSource.kind === 'ephemeral_debug_workspace' ? 'Disposable self-contained filesystem for isolated inspection and experiments.' : 'Independent container for offline authenticated inspection.' }}</div>
              </div>
              <div tw-class="border-b border-gray-200 p-3 dark:border-gray-700">
                <button
                  v-if="selectedInspectionSource.kind === 'ephemeral_debug_workspace'"
                  type="button"
                  data-testid="hizofs-create-temporary-workspace"
                  :disabled="changingTemporaryWorkspace"
                  tw-class="w-full border border-emerald-300 px-3 py-2 text-left text-xs font-medium text-emerald-700 disabled:opacity-50 dark:border-emerald-800 dark:text-emerald-300"
                  @click="createTemporaryWorkspaceFromUi"
                >{{ changingTemporaryWorkspace ? 'Creating temporary filesystem…' : 'Create temporary filesystem' }}</button>
                <button v-else type="button" disabled tw-class="w-full border border-gray-300 px-3 py-2 text-left text-xs font-medium opacity-60 dark:border-gray-700">Open standalone HizoFS…</button>
                <p v-if="temporaryWorkspaceErrorMessage !== undefined && selectedInspectionSource.kind === 'ephemeral_debug_workspace'" tw-class="mt-2 break-words font-mono text-[9px] text-red-600 dark:text-red-300">{{ temporaryWorkspaceErrorMessage }}</p>
                <p v-else tw-class="mt-2 font-mono text-[9px] text-amber-600 dark:text-amber-300">{{ selectedInspectionSource.kind === 'ephemeral_debug_workspace' ? 'Creates a real self-contained HizoFS source with physical + decrypted read capabilities.' : 'Backend pending · standalone source lifecycle and credential acquisition' }}</p>
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
              :key="selectedInspectionSource.kind"
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
                :root="companionFileExplorerRoot"
                :initial-path="undefined"
                :initial-locked="true"
                :reveal-path="companionFollowEnabled ? inspectedNamespacePath : undefined"
                entry-context-action-label="Use path in HizoFS Inspector"
                initial-view-mode="column"
                initial-preview-visibility="visible"
                reveal-file-preview="load"
                tw-class="h-full"
                @entry-context-action="requestNamespaceInspectionPathFromFileExplorer"
              />
              <template #fallback><div tw-class="flex h-full items-center justify-center gap-2 text-xs text-gray-500"><LoaderCircleIcon tw-class="h-4 w-4 animate-spin" />Opening decrypted view…</div></template>
            </Suspense>
            <div v-else tw-class="flex h-full items-center justify-center px-8 text-center text-xs text-gray-500">{{ selectedSourceHasConnectedInstance ? 'This source must supply a decrypted root before files can be shown here.' : 'The decrypted File Explorer will occupy this same companion surface when this source backend is connected.' }}</div>
          </div>
        </section>
      </template>

      <main v-else tw-class="min-h-0 flex-1 overflow-auto p-4">
        <HizoFSBenchmarkPanel />
      </main>
    </section>
  </div>
</template>
