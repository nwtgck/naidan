<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import {
  ActivityIcon,
  ArrowLeftIcon,
  BoxesIcon,
  DatabaseIcon,
  ExternalLinkIcon,
  FileSearchIcon,
  FolderTreeIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  XIcon,
} from 'lucide-vue-next';
import { storageService } from '@/00-storage/service';
import type { OpfsEncryptionDebugSession } from '@/00-storage/service/opfs-encryption/inspection';
import { useDebugEncryptedOpfsInspector } from '@/features/debug-encrypted-opfs/composables/useDebugEncryptedOpfsInspector';
import { useDebugOpfsEncryptionInspector } from '@/features/debug-opfs-encryption/composables/useDebugOpfsEncryptionInspector';
import { createEncryptedOpfsInspectionWorkerClient } from '@/features/debug-encrypted-opfs/worker/client';
import type {
  EncryptedOpfsInspectionOverviewView,
  EncryptedOpfsInspectionWorkerClient,
  EncryptedOpfsInspectedObjectView,
  EncryptedOpfsIntegrityScanResult,
  EncryptedOpfsNamespaceResult,
  EncryptedOpfsPhysicalObjectPageView,
} from '@/features/debug-encrypted-opfs/worker/types';
import FileExplorer from '@/features/file-explorer/components/FileExplorer.vue';
import { useFileExplorerModal } from '@/features/file-explorer/composables/useFileExplorerModal';
import type { FileExplorerRootDescriptor } from '@/features/file-explorer/worker/types';
import { JsonCodeView } from '@/features/json-viewer';

type InspectorTab = 'overview' | 'namespace' | 'objects' | 'integrity';

const { closeDebugEncryptedOpfsInspector } = useDebugEncryptedOpfsInspector();
const { openDebugOpfsEncryptionInspector } = useDebugOpfsEncryptionInspector();
const { openFileExplorer } = useFileExplorerModal();

const session = ref<OpfsEncryptionDebugSession>();
const client = ref<EncryptedOpfsInspectionWorkerClient>();
const overview = ref<EncryptedOpfsInspectionOverviewView>();
const activeTab = ref<InspectorTab>('overview');
const loading = ref(true);
const errorMessage = ref<string>();
const namespaceLoading = ref(false);
const namespaceResult = ref<EncryptedOpfsNamespaceResult>();
const objectsLoading = ref(false);
const objectPage = ref<EncryptedOpfsPhysicalObjectPageView>();
const objectEntries = ref<EncryptedOpfsPhysicalObjectPageView['entries']>([]);
const selectedObjectId = ref<string>();
const selectedObject = ref<EncryptedOpfsInspectedObjectView>();
const selectedObjectLoading = ref(false);
const integrityLoading = ref(false);
const integrityResult = ref<EncryptedOpfsIntegrityScanResult>();

const descriptorJson = computed(() => JSON.stringify(overview.value?.descriptor ?? null, undefined, 2));
const activeCommitJson = computed(() => JSON.stringify(overview.value?.activeCommit ?? null, undefined, 2));
const selectedObjectJson = computed(() => JSON.stringify(selectedObject.value ?? null, undefined, 2));
const integrityJson = computed(() => JSON.stringify(integrityResult.value ?? null, undefined, 2));
const physicalPath = computed(() => session.value?.physicalPath.join('/') ?? '');
const fileExplorerRoot = computed<FileExplorerRootDescriptor | undefined>(() => {
  const current = session.value;
  if (current === undefined) return undefined;
  return {
    kind: 'wesh-mounts',
    rootName: 'EncryptedOpfs root',
    mounts: [{
      type: 'storage_directory',
      path: '/',
      handle: current.decryptedRoot,
      readOnly: true,
    }],
  };
});

onMounted(reload);
onUnmounted(() => {
  void disposeResources();
});

watch(activeTab, tab => {
  switch (tab) {
  case 'overview':
    return;
  case 'namespace':
    if (namespaceResult.value === undefined) void loadNamespace();
    return;
  case 'objects':
    if (objectPage.value === undefined) void loadFirstObjectPage();
    return;
  case 'integrity':
    return;
  default: {
    const _ex: never = tab;
    return _ex;
  }
  }
});

async function disposeResources(): Promise<void> {
  const previousClient = client.value;
  const previousSession = session.value;
  client.value = undefined;
  session.value = undefined;
  try {
    await previousClient?.dispose();
  } finally {
    await previousSession?.dispose();
  }
}

async function reload(): Promise<void> {
  loading.value = true;
  errorMessage.value = undefined;
  overview.value = undefined;
  namespaceResult.value = undefined;
  objectPage.value = undefined;
  objectEntries.value = [];
  selectedObjectId.value = undefined;
  selectedObject.value = undefined;
  integrityResult.value = undefined;
  await disposeResources();
  try {
    const nextSession = await storageService.createOpfsEncryptionDebugSession();
    const nextClient = await createEncryptedOpfsInspectionWorkerClient({
      reader: nextSession.encryptedOpfsReader,
    });
    session.value = nextSession;
    client.value = nextClient;
    overview.value = await nextClient.readOverview();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
    await disposeResources();
  } finally {
    loading.value = false;
  }
}

async function loadNamespace(): Promise<void> {
  const currentClient = client.value;
  if (currentClient === undefined || namespaceLoading.value) return;
  namespaceLoading.value = true;
  try {
    namespaceResult.value = await currentClient.readNamespace({ maximumEntryCount: 10_000 });
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    namespaceLoading.value = false;
  }
}

async function loadFirstObjectPage(): Promise<void> {
  objectEntries.value = [];
  objectPage.value = undefined;
  await loadMoreObjects({ cursor: undefined });
}

async function loadMoreObjects({ cursor }: { cursor: string | undefined }): Promise<void> {
  const currentClient = client.value;
  if (currentClient === undefined || objectsLoading.value) return;
  objectsLoading.value = true;
  try {
    const page = await currentClient.listPhysicalObjects({ cursor, limit: 200 });
    objectPage.value = page;
    objectEntries.value = [...objectEntries.value, ...page.entries];
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    objectsLoading.value = false;
  }
}

async function selectObject({ objectId }: { objectId: string }): Promise<void> {
  const currentClient = client.value;
  if (currentClient === undefined) return;
  selectedObjectId.value = objectId;
  selectedObject.value = undefined;
  selectedObjectLoading.value = true;
  try {
    selectedObject.value = await currentClient.inspectObject({
      objectId,
      binaryPayloadPreviewByteLength: 512,
    });
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    selectedObjectLoading.value = false;
  }
}

async function runIntegrityScan(): Promise<void> {
  const currentClient = client.value;
  if (currentClient === undefined || integrityLoading.value) return;
  integrityLoading.value = true;
  integrityResult.value = undefined;
  try {
    integrityResult.value = await currentClient.runIntegrityScan();
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'AbortError')) {
      errorMessage.value = error instanceof Error ? error.message : String(error);
    }
  } finally {
    integrityLoading.value = false;
  }
}

async function cancelIntegrityScan(): Promise<void> {
  await client.value?.cancelCurrentOperation();
}

function openRawOpfs(): void {
  closeDebugEncryptedOpfsInspector();
  openFileExplorer({ options: { kind: 'opfs-root' } });
}

function openControlPlane(): void {
  closeDebugEncryptedOpfsInspector();
  openDebugOpfsEncryptionInspector();
}

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      reload,
      loadNamespace,
      loadFirstObjectPage,
      runIntegrityScan,
    },
  }) || {}),
});
</script>

<template>
  <Teleport to="body">
    <div tw-class="fixed inset-0 z-[125] flex items-center justify-center bg-black/55 p-2 sm:p-4" @click.self="closeDebugEncryptedOpfsInspector">
      <section role="dialog" aria-modal="true" aria-labelledby="encrypted-opfs-inspector-title" tw-class="flex h-[96vh] w-full max-w-[1500px] flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-900">
        <header tw-class="flex shrink-0 items-center gap-3 border-b border-gray-200 px-4 py-3 dark:border-gray-700">
          <div tw-class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
            <FileSearchIcon tw-class="h-5 w-5" />
          </div>
          <div tw-class="min-w-0 flex-1">
            <h1 id="encrypted-opfs-inspector-title" tw-class="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">EncryptedOpfs Inspector</h1>
            <p tw-class="truncate text-xs text-gray-500 dark:text-gray-400">Persisted DTOs, immutable object graph, decrypted namespace, and integrity state</p>
          </div>
          <div v-if="overview" tw-class="hidden min-w-0 text-right text-[10px] text-gray-500 md:block dark:text-gray-400">
            <div tw-class="truncate font-mono">revision {{ overview.activeCommit.revision }}</div>
            <div tw-class="max-w-72 truncate font-mono">{{ physicalPath }}</div>
          </div>
          <button type="button" aria-label="Reload EncryptedOpfs inspection" tw-class="rounded-lg p-2 text-gray-500 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800" :disabled="loading" @click="reload">
            <RefreshCwIcon :tw-class="['h-4 w-4', loading ? 'animate-spin' : '']" />
          </button>
          <button type="button" aria-label="Close EncryptedOpfs inspector" tw-class="rounded-lg p-2 text-gray-500 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800" @click="closeDebugEncryptedOpfsInspector">
            <XIcon tw-class="h-4 w-4" />
          </button>
        </header>

        <div v-if="loading" tw-class="flex flex-1 items-center justify-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <LoaderCircleIcon tw-class="h-5 w-5 animate-spin" />
          Starting read-only inspection worker…
        </div>
        <div v-else-if="errorMessage && !overview" tw-class="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <div tw-class="max-w-3xl break-words font-mono text-sm text-red-700 dark:text-red-300">{{ errorMessage }}</div>
          <button type="button" tw-class="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800" @click="reload">Retry</button>
        </div>

        <div v-else tw-class="flex min-h-0 flex-1">
          <aside tw-class="flex w-48 shrink-0 flex-col gap-1 border-r border-gray-200 bg-gray-50 p-2 dark:border-gray-700 dark:bg-gray-950">
            <button type="button" data-testid="encrypted-opfs-tab-overview" :tw-class="['flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-medium transition-colors', activeTab === 'overview' ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200' : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800']" @click="activeTab = 'overview'">
              <ShieldCheckIcon tw-class="h-4 w-4" /> Overview
            </button>
            <button type="button" data-testid="encrypted-opfs-tab-namespace" :tw-class="['flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-medium transition-colors', activeTab === 'namespace' ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200' : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800']" @click="activeTab = 'namespace'">
              <FolderTreeIcon tw-class="h-4 w-4" /> Namespace
            </button>
            <button type="button" data-testid="encrypted-opfs-tab-objects" :tw-class="['flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-medium transition-colors', activeTab === 'objects' ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200' : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800']" @click="activeTab = 'objects'">
              <BoxesIcon tw-class="h-4 w-4" /> Objects
            </button>
            <button type="button" data-testid="encrypted-opfs-tab-integrity" :tw-class="['flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-medium transition-colors', activeTab === 'integrity' ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200' : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800']" @click="activeTab = 'integrity'">
              <ActivityIcon tw-class="h-4 w-4" /> Integrity
            </button>
            <div tw-class="mt-auto space-y-1 border-t border-gray-200 pt-2 dark:border-gray-700">
              <button type="button" data-testid="encrypted-opfs-open-control-plane" tw-class="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800" @click="openControlPlane">
                <ArrowLeftIcon tw-class="h-4 w-4" /> Encryption control
              </button>
              <button type="button" data-testid="encrypted-opfs-open-raw" tw-class="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800" @click="openRawOpfs">
                <DatabaseIcon tw-class="h-4 w-4" /> Raw OPFS
                <ExternalLinkIcon tw-class="ml-auto h-3.5 w-3.5" />
              </button>
            </div>
          </aside>

          <main tw-class="min-w-0 flex-1 overflow-hidden">
            <div v-if="errorMessage" tw-class="border-b border-red-200 bg-red-50 px-4 py-2 font-mono text-xs text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">{{ errorMessage }}</div>

            <div v-if="activeTab === 'overview' && overview" tw-class="grid h-full min-h-0 overflow-auto lg:grid-cols-2">
              <section tw-class="min-w-0 border-b border-gray-200 lg:border-b-0 lg:border-r dark:border-gray-700">
                <header tw-class="border-b border-gray-200 px-4 py-2 text-xs font-semibold text-gray-700 dark:border-gray-700 dark:text-gray-200">Descriptor and active commit</header>
                <div tw-class="grid gap-3 p-4 sm:grid-cols-2">
                  <div tw-class="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
                    <div tw-class="text-[10px] uppercase tracking-wide text-gray-400">File system ID</div>
                    <div tw-class="mt-1 break-all font-mono text-xs text-gray-800 dark:text-gray-200">{{ overview.descriptor.fileSystemId }}</div>
                  </div>
                  <div tw-class="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
                    <div tw-class="text-[10px] uppercase tracking-wide text-gray-400">Active revision</div>
                    <div tw-class="mt-1 font-mono text-xs text-gray-800 dark:text-gray-200">{{ overview.activeCommit.revision }}</div>
                  </div>
                </div>
                <div tw-class="border-t border-gray-200 dark:border-gray-700">
                  <JsonCodeView :source="descriptorJson" display-mode="formatted" overflow-mode="scroll" height-mode="content" />
                  <JsonCodeView :source="activeCommitJson" display-mode="formatted" overflow-mode="scroll" height-mode="content" />
                </div>
              </section>
              <section tw-class="min-w-0 overflow-auto">
                <header tw-class="sticky top-0 border-b border-gray-200 bg-white px-4 py-2 text-xs font-semibold text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200">Superblock A/B slots</header>
                <div tw-class="space-y-3 p-4">
                  <article v-for="slot in overview.superblockSlots" :key="slot.slot" tw-class="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
                    <div tw-class="flex items-center justify-between gap-2">
                      <span tw-class="font-mono text-xs font-semibold">slot {{ slot.slot }}</span>
                      <span :tw-class="['rounded px-2 py-0.5 text-[10px] font-semibold uppercase', slot.status === 'valid' ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200' : slot.status === 'missing' ? 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300' : 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200']">{{ slot.status }}{{ slot.selected ? ' · selected' : '' }}</span>
                    </div>
                    <div tw-class="mt-2 break-all font-mono text-[10px] text-gray-500 dark:text-gray-400">{{ slot.physicalPath.join('/') }}</div>
                    <pre v-if="slot.status === 'valid'" tw-class="mt-2 overflow-auto rounded bg-gray-950 p-2 text-[10px] text-gray-100">{{ JSON.stringify(slot.value, undefined, 2) }}</pre>
                    <div v-else-if="slot.status === 'invalid' || slot.status === 'unsupported'" tw-class="mt-2 break-words font-mono text-xs text-red-700 dark:text-red-300">{{ slot.errorMessage }}</div>
                  </article>
                </div>
              </section>
            </div>

            <div v-else-if="activeTab === 'namespace'" tw-class="grid h-full min-h-0 lg:grid-cols-[minmax(0,3fr)_minmax(300px,2fr)]">
              <section tw-class="min-h-0 border-b border-gray-200 lg:border-b-0 lg:border-r dark:border-gray-700">
                <Suspense v-if="fileExplorerRoot">
                  <FileExplorer :root="fileExplorerRoot" :initial-path="undefined" :initial-locked="true" initial-view-mode="list" initial-preview-visibility="visible" tw-class="h-full" />
                </Suspense>
              </section>
              <section tw-class="min-h-0 overflow-auto">
                <header tw-class="sticky top-0 flex items-center justify-between border-b border-gray-200 bg-white px-4 py-2 dark:border-gray-700 dark:bg-gray-900">
                  <span tw-class="text-xs font-semibold text-gray-700 dark:text-gray-200">Persisted namespace map</span>
                  <button type="button" tw-class="rounded border border-gray-300 px-2 py-1 text-[10px] dark:border-gray-600" :disabled="namespaceLoading" @click="loadNamespace">{{ namespaceLoading ? 'Reading…' : 'Refresh' }}</button>
                </header>
                <div v-if="namespaceLoading && !namespaceResult" tw-class="flex items-center justify-center gap-2 p-8 text-xs text-gray-500"><LoaderCircleIcon tw-class="h-4 w-4 animate-spin" /> Traversing inode and directory indexes…</div>
                <template v-else-if="namespaceResult">
                  <div v-if="namespaceResult.issues.length > 0" tw-class="border-b border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                    <div v-for="issue in namespaceResult.issues" :key="issue" tw-class="font-mono">{{ issue }}</div>
                  </div>
                  <button v-for="entry in namespaceResult.entries" :key="`${entry.nodeId}:${entry.path}`" type="button" tw-class="block w-full border-b border-gray-100 px-3 py-2 text-left hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800" @click="activeTab = 'objects'; selectObject({ objectId: entry.inodeObjectId })">
                    <div tw-class="truncate font-mono text-xs text-gray-800 dark:text-gray-200">{{ entry.path }}</div>
                    <div tw-class="mt-1 flex flex-wrap gap-x-3 text-[10px] text-gray-500 dark:text-gray-400">
                      <span>{{ entry.kind }}</span><span>rev {{ entry.revision }}</span><span>{{ entry.storage }}</span><span v-if="entry.size !== undefined">{{ entry.size }} bytes</span>
                    </div>
                  </button>
                  <div v-if="namespaceResult.truncated" tw-class="p-3 text-center text-xs text-amber-700 dark:text-amber-300">Namespace result was truncated at 10,000 entries.</div>
                </template>
              </section>
            </div>

            <div v-else-if="activeTab === 'objects'" tw-class="grid h-full min-h-0 grid-cols-[minmax(260px,1fr)_minmax(0,2fr)]">
              <section tw-class="min-h-0 overflow-auto border-r border-gray-200 dark:border-gray-700">
                <header tw-class="sticky top-0 z-10 flex items-center justify-between border-b border-gray-200 bg-white px-3 py-2 dark:border-gray-700 dark:bg-gray-900">
                  <span tw-class="text-xs font-semibold">Physical objects</span>
                  <span tw-class="font-mono text-[10px] text-gray-400">{{ objectEntries.length }}</span>
                </header>
                <button v-for="entry in objectEntries" :key="entry.objectId" type="button" :tw-class="['block w-full border-b border-gray-100 px-3 py-2 text-left dark:border-gray-800', selectedObjectId === entry.objectId ? 'bg-emerald-50 dark:bg-emerald-950/30' : 'hover:bg-gray-50 dark:hover:bg-gray-800']" @click="selectObject({ objectId: entry.objectId })">
                  <div tw-class="truncate font-mono text-[11px] text-gray-800 dark:text-gray-200">{{ entry.objectId }}</div>
                  <div tw-class="mt-1 truncate font-mono text-[9px] text-gray-400">{{ entry.physicalPath.join('/') }}</div>
                </button>
                <button v-if="objectPage?.nextCursor" type="button" tw-class="w-full px-3 py-3 text-xs text-blue-600 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-blue-950/30" :disabled="objectsLoading" @click="loadMoreObjects({ cursor: objectPage.nextCursor })">{{ objectsLoading ? 'Loading…' : 'Load more' }}</button>
              </section>
              <section tw-class="min-h-0 overflow-auto">
                <div v-if="selectedObjectLoading" tw-class="flex h-full items-center justify-center gap-2 text-xs text-gray-500"><LoaderCircleIcon tw-class="h-4 w-4 animate-spin" /> Decrypting selected object…</div>
                <div v-else-if="selectedObject" tw-class="min-w-0">
                  <div tw-class="grid gap-3 border-b border-gray-200 p-4 sm:grid-cols-3 dark:border-gray-700">
                    <div tw-class="rounded-lg border border-gray-200 p-3 dark:border-gray-700"><div tw-class="text-[10px] uppercase text-gray-400">Record kind</div><div tw-class="mt-1 font-mono text-xs">{{ selectedObject.object.record.kind }}</div></div>
                    <div tw-class="rounded-lg border border-gray-200 p-3 dark:border-gray-700"><div tw-class="text-[10px] uppercase text-gray-400">Physical bytes</div><div tw-class="mt-1 font-mono text-xs">{{ selectedObject.object.physicalByteLength }}</div></div>
                    <div tw-class="rounded-lg border border-gray-200 p-3 dark:border-gray-700"><div tw-class="text-[10px] uppercase text-gray-400">Validation</div><div tw-class="mt-1 font-mono text-xs">{{ selectedObject.validation.status }}</div></div>
                  </div>
                  <div v-if="selectedObject.references.length > 0" tw-class="border-b border-gray-200 p-3 dark:border-gray-700">
                    <div tw-class="mb-2 text-xs font-semibold">Referenced objects</div>
                    <button v-for="reference in selectedObject.references" :key="`${reference.relation}:${reference.objectId}`" type="button" tw-class="mb-1 flex w-full items-center justify-between gap-3 rounded border border-gray-200 px-2 py-1.5 text-left hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800" @click="selectObject({ objectId: reference.objectId })">
                      <span tw-class="text-[10px] text-gray-500">{{ reference.relation }}</span><span tw-class="min-w-0 truncate font-mono text-[10px]">{{ reference.objectId }}</span>
                    </button>
                  </div>
                  <JsonCodeView :source="selectedObjectJson" display-mode="formatted" overflow-mode="scroll" height-mode="content" />
                </div>
                <div v-else tw-class="flex h-full items-center justify-center p-8 text-center text-xs text-gray-500">Select an immutable object to inspect its envelope, exact persisted DTO, binary preview, and references.</div>
              </section>
            </div>

            <div v-else-if="activeTab === 'integrity'" tw-class="h-full overflow-auto">
              <div tw-class="flex flex-wrap items-center gap-2 border-b border-gray-200 p-4 dark:border-gray-700">
                <button type="button" data-testid="encrypted-opfs-run-integrity" tw-class="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50" :disabled="integrityLoading" @click="runIntegrityScan">Run full read-only scan</button>
                <button v-if="integrityLoading" type="button" tw-class="rounded-lg border border-gray-300 px-3 py-2 text-xs dark:border-gray-600" @click="cancelIntegrityScan">Cancel</button>
                <span v-if="integrityLoading" tw-class="flex items-center gap-2 text-xs text-gray-500"><LoaderCircleIcon tw-class="h-4 w-4 animate-spin" /> Traversing persisted object graph in worker…</span>
              </div>
              <template v-if="integrityResult">
                <div tw-class="grid gap-3 border-b border-gray-200 p-4 sm:grid-cols-2 lg:grid-cols-6 dark:border-gray-700">
                  <div tw-class="rounded-lg border border-gray-200 p-3 dark:border-gray-700"><div tw-class="text-[10px] uppercase text-gray-400">Active reachable</div><div tw-class="mt-1 font-mono text-lg">{{ integrityResult.activeReachableObjectCount }}</div></div>
                  <div tw-class="rounded-lg border border-gray-200 p-3 dark:border-gray-700"><div tw-class="text-[10px] uppercase text-gray-400">Fallback reachable</div><div tw-class="mt-1 font-mono text-lg">{{ integrityResult.fallbackReachableObjectCount }}</div></div>
                  <div tw-class="rounded-lg border border-gray-200 p-3 dark:border-gray-700"><div tw-class="text-[10px] uppercase text-gray-400">Protected total</div><div tw-class="mt-1 font-mono text-lg">{{ integrityResult.reachableObjectCount }}</div></div>
                  <div tw-class="rounded-lg border border-gray-200 p-3 dark:border-gray-700"><div tw-class="text-[10px] uppercase text-gray-400">Physical</div><div tw-class="mt-1 font-mono text-lg">{{ integrityResult.physicalObjectCount }}</div></div>
                  <div tw-class="rounded-lg border border-gray-200 p-3 dark:border-gray-700"><div tw-class="text-[10px] uppercase text-gray-400">True orphans</div><div tw-class="mt-1 font-mono text-lg">{{ integrityResult.orphanObjectIds.length }}</div></div>
                  <div tw-class="rounded-lg border border-gray-200 p-3 dark:border-gray-700"><div tw-class="text-[10px] uppercase text-gray-400">Issues</div><div tw-class="mt-1 font-mono text-lg">{{ integrityResult.issues.length }}</div></div>
                </div>
                <JsonCodeView :source="integrityJson" display-mode="formatted" overflow-mode="scroll" height-mode="content" />
              </template>
              <div v-else-if="!integrityLoading" tw-class="p-8 text-center text-xs text-gray-500">The scan authenticates every reachable object, validates exact persisted DTO schemas, derives references, and compares them with physical object enumeration. It never mutates storage.</div>
            </div>
          </main>
        </div>
      </section>
    </div>
  </Teleport>
</template>
