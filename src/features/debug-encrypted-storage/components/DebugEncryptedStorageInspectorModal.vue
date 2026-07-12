<script setup lang="ts">
import { watchDebounced } from '@vueuse/core';
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue';
import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckCircle2Icon,
  ClipboardIcon,
  DatabaseIcon,
  FolderSearchIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  SearchIcon,
  ShieldCheckIcon,
  XIcon,
} from 'lucide-vue-next';
import { JsonCodeView } from '@/features/json-viewer';
import { useFileExplorerModal } from '@/features/file-explorer/composables/useFileExplorerModal';
import { createDebugEncryptedStorageWorkerClient } from '@/features/debug-encrypted-storage/worker/client';
import type {
  DebugEncryptedStorageWorkerClient,
  EncryptedStorageDebugIntegrityReport,
  EncryptedStorageDebugNode,
  EncryptedStorageDebugNodeRef,
  EncryptedStorageDebugPersistedJson,
  EncryptedStorageDebugSearchResult,
} from '@/features/debug-encrypted-storage/worker/types';
import {
  createDebugEncryptedStorageNavigationColumn,
  type DebugEncryptedStorageNavigationColumn,
  type DebugEncryptedStorageNavigationHistoryEntry,
} from '@/features/debug-encrypted-storage/logic/navigation';
import { useDebugEncryptedStorageInspector } from '@/features/debug-encrypted-storage/composables/useDebugEncryptedStorageInspector';
import DebugEncryptedStorageBreadcrumbs from './DebugEncryptedStorageBreadcrumbs.vue';
import DebugEncryptedStorageColumnView from './DebugEncryptedStorageColumnView.vue';

const {
  debugEncryptedStorageInitialNode,
  closeDebugEncryptedStorageInspector,
} = useDebugEncryptedStorageInspector();
const { openFileExplorer } = useFileExplorerModal();

const client = ref<DebugEncryptedStorageWorkerClient>();
const currentNode = ref<EncryptedStorageDebugNode>();
const persistedJson = ref<EncryptedStorageDebugPersistedJson>();
const navigationColumns = ref<readonly DebugEncryptedStorageNavigationColumn[]>([]);
const history = ref<readonly DebugEncryptedStorageNavigationHistoryEntry[]>([]);
const historyIndex = ref(-1);
const loading = ref(true);
const errorMessage = ref<string>();
const query = ref('');
const searchResults = ref<readonly EncryptedStorageDebugSearchResult[]>([]);
const searching = ref(false);
const integrityReport = ref<EncryptedStorageDebugIntegrityReport>();
const scanning = ref(false);
const copied = ref(false);
const jsonDisplayMode = ref<'raw' | 'formatted'>('formatted');
const jsonOverflowMode = ref<'scroll' | 'wrap'>('scroll');
let disposed = false;
let navigationRequestId = 0;
let searchRequestId = 0;
let integrityRequestId = 0;

const canGoBack = computed(() => historyIndex.value > 0);
const canGoForward = computed(() => historyIndex.value >= 0 && historyIndex.value < history.value.length - 1);
const derivedPreviewJson = computed(() => JSON.stringify(currentNode.value?.value ?? null, undefined, 2) ?? 'null');
const persistedJsonSourceLabel = computed(() => {
  const source = persistedJson.value?.source;
  switch (source) {
  case 'decrypted_persisted_bytes':
    return 'Exact decrypted persisted bytes';
  case 'selected_persisted_dto':
    return 'Selected persisted DTO structure';
  case undefined:
    return undefined;
  default: {
    const _ex: never = source;
    throw new Error(`Unhandled persisted JSON source: ${String(_ex)}`);
  }
  }
});

onMounted(async () => {
  try {
    const createdClient = await createDebugEncryptedStorageWorkerClient();
    if (disposed) {
      await createdClient.dispose();
      return;
    }
    client.value = createdClient;
    await navigate({
      ref: debugEncryptedStorageInitialNode.value,
      baseColumns: [],
      recordHistory: true,
    });
  } catch (error) {
    if (!disposed) {
      errorMessage.value = error instanceof Error ? error.message : String(error);
    }
  } finally {
    if (!disposed) {
      loading.value = false;
    }
  }
});

onBeforeUnmount(() => {
  disposed = true;
  navigationRequestId += 1;
  searchRequestId += 1;
  integrityRequestId += 1;
  const activeClient = client.value;
  client.value = undefined;
  if (activeClient !== undefined) {
    void activeClient.dispose();
  }
});

watch(debugEncryptedStorageInitialNode, async refValue => {
  if (client.value !== undefined) {
    await navigate({ ref: refValue, baseColumns: [], recordHistory: true });
  }
});

watch(
  query,
  value => {
    searchRequestId += 1;
    searchResults.value = [];
    searching.value = value.trim().length > 0;
  },
  { flush: 'sync' },
);

watchDebounced(
  query,
  async value => {
    if (value.trim().length > 0) {
      await runSearch({ query: value });
    }
  },
  {
    debounce: 250,
    maxWait: 700,
  },
);

async function navigate({
  ref: targetRef,
  baseColumns,
  recordHistory,
}: {
  ref: EncryptedStorageDebugNodeRef,
  baseColumns: readonly DebugEncryptedStorageNavigationColumn[],
  recordHistory: boolean,
}): Promise<void> {
  const activeClient = client.value;
  if (activeClient === undefined) {
    return;
  }
  const requestId = ++navigationRequestId;
  loading.value = true;
  errorMessage.value = undefined;
  try {
    const node = await activeClient.loadNode({ ref: targetRef });
    const loadedPersistedJson = await activeClient.loadPersistedJson({ ref: targetRef });
    if (disposed || requestId !== navigationRequestId) {
      return;
    }
    const columns = [
      ...baseColumns,
      createDebugEncryptedStorageNavigationColumn({ node }),
    ];
    currentNode.value = node;
    persistedJson.value = loadedPersistedJson;
    navigationColumns.value = columns;
    if (recordHistory) {
      history.value = [
        ...history.value.slice(0, historyIndex.value + 1),
        { ref: targetRef, columns },
      ];
      historyIndex.value = history.value.length - 1;
    }
    await nextTick();
  } catch (error) {
    if (!disposed && requestId === navigationRequestId) {
      errorMessage.value = error instanceof Error ? error.message : String(error);
    }
  } finally {
    if (!disposed && requestId === navigationRequestId) {
      loading.value = false;
    }
  }
}

async function goBack(): Promise<void> {
  if (!canGoBack.value) {
    return;
  }
  historyIndex.value -= 1;
  await restoreHistoryEntry({ index: historyIndex.value });
}

async function goForward(): Promise<void> {
  if (!canGoForward.value) {
    return;
  }
  historyIndex.value += 1;
  await restoreHistoryEntry({ index: historyIndex.value });
}

async function restoreHistoryEntry({ index }: { index: number }): Promise<void> {
  const entry = history.value[index];
  if (entry === undefined) {
    return;
  }
  await navigate({
    ref: entry.ref,
    baseColumns: entry.columns.slice(0, -1),
    recordHistory: false,
  });
}

async function reloadCurrentNode(): Promise<void> {
  if (currentNode.value === undefined) {
    return;
  }
  await navigate({
    ref: currentNode.value.ref,
    baseColumns: navigationColumns.value.slice(0, -1),
    recordHistory: false,
  });
}

async function navigateFromColumn({
  ref,
  columnIndex,
}: {
  ref: EncryptedStorageDebugNodeRef,
  columnIndex: number,
}): Promise<void> {
  await navigate({
    ref,
    baseColumns: navigationColumns.value.slice(0, columnIndex + 1),
    recordHistory: true,
  });
}

async function navigateFromBreadcrumb({ index }: { index: number }): Promise<void> {
  const target = navigationColumns.value[index];
  if (target === undefined) {
    return;
  }
  await navigate({
    ref: target.ref,
    baseColumns: navigationColumns.value.slice(0, index),
    recordHistory: true,
  });
}

async function navigateFromSearch({ ref }: { ref: EncryptedStorageDebugNodeRef }): Promise<void> {
  await navigate({ ref, baseColumns: [], recordHistory: true });
}

async function runSearch({ query: requestedQuery }: { query: string }): Promise<void> {
  const normalized = requestedQuery.trim();
  if (normalized.length === 0) {
    return;
  }
  const activeClient = client.value;
  if (activeClient === undefined) {
    searching.value = false;
    return;
  }
  const requestId = ++searchRequestId;
  searching.value = true;
  errorMessage.value = undefined;
  try {
    const results = await activeClient.search({ query: normalized });
    if (!disposed && requestId === searchRequestId) {
      searchResults.value = results;
    }
  } catch (error) {
    if (!disposed && requestId === searchRequestId) {
      errorMessage.value = error instanceof Error ? error.message : String(error);
    }
  } finally {
    if (!disposed && requestId === searchRequestId) {
      searching.value = false;
    }
  }
}

async function runIntegrityScan(): Promise<void> {
  const activeClient = client.value;
  if (activeClient === undefined) {
    return;
  }
  const requestId = ++integrityRequestId;
  scanning.value = true;
  errorMessage.value = undefined;
  try {
    const report = await activeClient.scanIntegrity();
    if (!disposed && requestId === integrityRequestId) {
      integrityReport.value = report;
    }
  } catch (error) {
    if (!disposed && requestId === integrityRequestId) {
      errorMessage.value = error instanceof Error ? error.message : String(error);
    }
  } finally {
    if (!disposed && requestId === integrityRequestId) {
      scanning.value = false;
    }
  }
}

async function copyPersistedJson(): Promise<void> {
  const json = persistedJson.value?.json;
  if (json === undefined) {
    return;
  }
  await navigator.clipboard.writeText(json);
  copied.value = true;
  window.setTimeout(() => {
    copied.value = false;
  }, 1200);
}

function revealRawOpfs(): void {
  openFileExplorer({ options: { kind: 'opfs-root' } });
}


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
      // ESLint-required for defineExpose.
    },
  }) || {}),
});
</script>

<template>
  <Teleport to="body">
    <div
      tw-class="fixed inset-0 z-[120] flex items-center justify-center bg-gray-950/65 p-3 backdrop-blur-sm sm:p-5"
      data-testid="debug-encrypted-storage-inspector"
      @click.self="closeDebugEncryptedStorageInspector"
    >
      <section tw-class="flex h-[min(960px,calc(100vh-1.5rem))] w-[min(1720px,calc(100vw-1.5rem))] min-w-0 flex-col overflow-hidden rounded-2xl border border-gray-200 bg-gray-50 shadow-2xl dark:border-gray-700 dark:bg-gray-950">
        <header tw-class="flex min-h-14 items-center gap-2 border-b border-gray-200 bg-white px-3 dark:border-gray-800 dark:bg-gray-900 sm:px-4">
          <div tw-class="flex min-w-0 items-center gap-2">
            <div tw-class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600 dark:bg-blue-950/60 dark:text-blue-300">
              <DatabaseIcon tw-class="h-4 w-4" />
            </div>
            <div tw-class="min-w-0">
              <h1 tw-class="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">Encrypted Storage Inspector</h1>
              <p tw-class="truncate text-[11px] font-mono text-gray-500 dark:text-gray-400">read-only · persisted DTO first · worker-backed</p>
            </div>
          </div>
          <div tw-class="ml-auto flex items-center gap-1">
            <button :disabled="!canGoBack" tw-class="rounded-lg p-2 text-gray-500 hover:bg-gray-100 disabled:opacity-30 dark:hover:bg-gray-800" title="Back" @click="goBack">
              <ArrowLeftIcon tw-class="h-4 w-4" />
            </button>
            <button :disabled="!canGoForward" tw-class="rounded-lg p-2 text-gray-500 hover:bg-gray-100 disabled:opacity-30 dark:hover:bg-gray-800" title="Forward" @click="goForward">
              <ArrowRightIcon tw-class="h-4 w-4" />
            </button>
            <button tw-class="rounded-lg p-2 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800" title="Reload current node" @click="reloadCurrentNode">
              <RefreshCwIcon tw-class="h-4 w-4" />
            </button>
            <button tw-class="rounded-lg p-2 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800" title="Open raw OPFS explorer" @click="revealRawOpfs">
              <FolderSearchIcon tw-class="h-4 w-4" />
            </button>
            <button tw-class="rounded-lg p-2 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800" title="Close" @click="closeDebugEncryptedStorageInspector">
              <XIcon tw-class="h-5 w-5" />
            </button>
          </div>
        </header>

        <div tw-class="flex min-h-10 items-center gap-2 border-b border-gray-200 bg-white px-3 dark:border-gray-800 dark:bg-gray-900 sm:px-4">
          <DebugEncryptedStorageBreadcrumbs
            :columns="navigationColumns"
            @navigate="navigateFromBreadcrumb"
          />
        </div>

        <div
          data-testid="encrypted-storage-inspector-layout"
          tw-class="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(300px,0.9fr)_minmax(360px,1.1fr)] overflow-hidden xl:grid-cols-[minmax(560px,1.15fr)_minmax(460px,0.85fr)] xl:grid-rows-1"
        >
          <section
            data-testid="encrypted-storage-navigation-pane"
            tw-class="flex min-h-0 min-w-0 flex-col border-b border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900 xl:border-b-0 xl:border-r"
          >
            <div tw-class="flex shrink-0 items-center gap-2 border-b border-gray-200 p-3 dark:border-gray-800">
              <div tw-class="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-gray-200 bg-gray-50 px-3 dark:border-gray-700 dark:bg-gray-950">
                <SearchIcon tw-class="h-4 w-4 shrink-0 text-gray-400" />
                <input
                  v-model="query"
                  data-testid="encrypted-storage-search-input"
                  tw-class="min-w-0 flex-1 bg-transparent py-2 text-xs font-mono text-gray-800 outline-none placeholder:text-gray-400 dark:text-gray-100"
                  placeholder="ID, path, namespace:key"
                />
                <LoaderCircleIcon v-if="searching" tw-class="h-4 w-4 animate-spin text-blue-500" />
              </div>
              <button
                tw-class="flex shrink-0 items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
                :disabled="scanning"
                @click="runIntegrityScan"
              >
                <LoaderCircleIcon v-if="scanning" tw-class="h-4 w-4 animate-spin" />
                <ShieldCheckIcon v-else tw-class="h-4 w-4" />
                <span tw-class="hidden sm:inline">Run integrity scan</span>
              </button>
            </div>

            <div
              v-if="query.trim().length > 0 || integrityReport !== undefined"
              data-testid="encrypted-storage-navigation-results"
              tw-class="max-h-[min(240px,36vh)] shrink-0 overflow-auto border-b border-gray-200 p-2 dark:border-gray-800"
            >
              <div v-if="query.trim().length > 0">
                <div tw-class="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-gray-400">Search results</div>
                <button
                  v-for="result in searchResults"
                  :key="JSON.stringify(result.ref)"
                  tw-class="mb-1 w-full rounded-lg px-2 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-800"
                  @click="navigateFromSearch({ ref: result.ref })"
                >
                  <div tw-class="truncate text-xs font-medium text-gray-800 dark:text-gray-100">{{ result.label }}</div>
                  <div tw-class="truncate text-[10px] font-mono text-gray-500">{{ result.detail }}</div>
                </button>
                <div v-if="searchResults.length === 0 && !searching" tw-class="px-2 py-3 text-xs text-gray-400">
                  No matching nodes
                </div>
              </div>

              <template v-if="integrityReport">
                <div tw-class="mb-2 mt-3 text-[10px] font-bold uppercase tracking-wider text-gray-400">Integrity scan</div>
                <div tw-class="mb-2 grid grid-cols-2 gap-2 text-xs">
                  <div tw-class="rounded-lg bg-gray-50 p-2 dark:bg-gray-950">
                    <div tw-class="text-gray-400">Physical</div>
                    <div tw-class="font-mono text-gray-800 dark:text-gray-200">{{ integrityReport.scannedPhysicalObjects }}</div>
                  </div>
                  <div tw-class="rounded-lg bg-gray-50 p-2 dark:bg-gray-950">
                    <div tw-class="text-gray-400">Known logical</div>
                    <div tw-class="font-mono text-gray-800 dark:text-gray-200">{{ integrityReport.knownLogicalObjects }}</div>
                  </div>
                </div>
                <button
                  v-for="finding in integrityReport.findings"
                  :key="`${finding.severity}:${finding.message}`"
                  tw-class="mb-1 w-full rounded-lg border border-gray-100 p-2 text-left dark:border-gray-800"
                  :disabled="finding.ref === undefined"
                  @click="finding.ref && navigateFromSearch({ ref: finding.ref })"
                >
                  <div :tw-class="['text-[10px] font-bold uppercase', finding.severity === 'error' ? 'text-red-500' : finding.severity === 'warning' ? 'text-amber-500' : 'text-blue-500']">{{ finding.severity }}</div>
                  <div tw-class="mt-1 break-all font-mono text-[10px] text-gray-600 dark:text-gray-300">{{ finding.message }}</div>
                </button>
              </template>
            </div>

            <DebugEncryptedStorageColumnView
              tw-class="min-h-0 flex-1"
              :columns="navigationColumns"
              @navigate="navigateFromColumn"
            />
          </section>

          <aside
            data-testid="encrypted-storage-detail-pane"
            tw-class="relative flex min-h-0 min-w-0 flex-col overflow-hidden bg-gray-50 dark:bg-gray-950"
          >
            <div v-if="loading" tw-class="absolute inset-0 z-10 flex items-center justify-center bg-gray-50/75 backdrop-blur-[1px] dark:bg-gray-950/75">
              <LoaderCircleIcon tw-class="h-6 w-6 animate-spin text-blue-500" />
            </div>

            <div v-if="errorMessage" tw-class="m-3 mb-0 flex shrink-0 gap-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/70 dark:bg-red-950/40 dark:text-red-200">
              <AlertTriangleIcon tw-class="h-5 w-5 shrink-0" />
              <pre tw-class="min-w-0 whitespace-pre-wrap break-words font-mono text-xs">{{ errorMessage }}</pre>
            </div>

            <template v-if="currentNode">
              <header tw-class="shrink-0 border-b border-gray-200 bg-white px-4 py-3 dark:border-gray-800 dark:bg-gray-900">
                <div tw-class="min-w-0">
                  <div tw-class="mb-1 text-[10px] font-bold uppercase tracking-wider text-blue-600 dark:text-blue-400">{{ currentNode.kind }}</div>
                  <h2 tw-class="break-all text-lg font-semibold text-gray-900 dark:text-gray-100">{{ currentNode.title }}</h2>
                  <p v-if="currentNode.physicalPath" tw-class="mt-1 break-all font-mono text-[11px] text-gray-500">{{ currentNode.physicalPath }}</p>
                </div>
                <div v-if="currentNode.warnings.length > 0" tw-class="mt-3 max-h-28 space-y-2 overflow-auto">
                  <div v-for="warning in currentNode.warnings" :key="warning" tw-class="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-200">
                    <AlertTriangleIcon tw-class="h-4 w-4 shrink-0" />
                    <span tw-class="break-all font-mono">{{ warning }}</span>
                  </div>
                </div>
              </header>

              <section tw-class="flex min-h-0 flex-1 flex-col overflow-hidden bg-white dark:bg-gray-900">
                <header tw-class="flex shrink-0 flex-wrap items-center gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-800">
                  <div tw-class="min-w-0 flex-1">
                    <div tw-class="text-xs font-semibold text-gray-800 dark:text-gray-100">Persisted JSON</div>
                    <div v-if="persistedJsonSourceLabel" tw-class="truncate text-[10px] font-mono text-gray-400">{{ persistedJsonSourceLabel }}</div>
                  </div>
                  <template v-if="persistedJson">
                    <div tw-class="flex items-center rounded-lg border border-gray-200 p-0.5 text-[10px] dark:border-gray-700">
                      <button
                        :tw-class="['rounded-md px-2 py-1', jsonDisplayMode === 'formatted' ? 'bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-gray-100' : 'text-gray-500']"
                        @click="jsonDisplayMode = 'formatted'"
                      >
                        Formatted
                      </button>
                      <button
                        :tw-class="['rounded-md px-2 py-1', jsonDisplayMode === 'raw' ? 'bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-gray-100' : 'text-gray-500']"
                        @click="jsonDisplayMode = 'raw'"
                      >
                        Raw
                      </button>
                    </div>
                    <button
                      tw-class="rounded-lg border border-gray-200 px-2 py-1 text-[10px] text-gray-500 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
                      @click="jsonOverflowMode = jsonOverflowMode === 'scroll' ? 'wrap' : 'scroll'"
                    >
                      {{ jsonOverflowMode === 'scroll' ? 'Wrap' : 'No wrap' }}
                    </button>
                    <button tw-class="flex items-center gap-1.5 rounded-lg border border-gray-200 px-2 py-1 text-[10px] text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800" @click="copyPersistedJson">
                      <CheckCircle2Icon v-if="copied" tw-class="h-3.5 w-3.5 text-emerald-500" />
                      <ClipboardIcon v-else tw-class="h-3.5 w-3.5" />
                      {{ copied ? 'Copied' : 'Copy persisted JSON' }}
                    </button>
                  </template>
                </header>
                <JsonCodeView
                  v-if="persistedJson"
                  tw-class="min-h-0 flex-1"
                  :source="persistedJson.json"
                  :display-mode="jsonDisplayMode"
                  :overflow-mode="jsonOverflowMode"
                  height-mode="fill"
                />
                <div v-else tw-class="flex min-h-0 flex-1 items-center justify-center px-4 py-8 text-center text-xs text-gray-400">
                  This aggregate or binary node has no directly persisted JSON DTO. Follow a logical-object reference to inspect its stored structure.
                </div>
              </section>

              <!--
                Encrypted Storage Inspector is a protocol debugging tool. The
                persisted JSON above is the source of truth. Everything below
                is a runtime-only interpretation and stays collapsed so it
                cannot be mistaken for fields that were actually stored.
              -->
              <details data-testid="encrypted-storage-derived-details" tw-class="max-h-[42%] shrink-0 overflow-auto border-t border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
                <summary tw-class="cursor-pointer select-none px-4 py-3 text-xs font-semibold text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-800">
                  Derived runtime details — not persisted
                </summary>
                <div tw-class="border-t border-gray-200 p-3 dark:border-gray-800">
                  <div tw-class="mb-2 text-[10px] font-bold uppercase tracking-wider text-gray-400">Decoded fields</div>
                  <dl tw-class="mb-4 grid gap-2 sm:grid-cols-2">
                    <div v-for="item in currentNode.fields" :key="item.label" tw-class="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 dark:border-gray-800 dark:bg-gray-950">
                      <dt tw-class="text-[10px] font-medium uppercase tracking-wide text-gray-400">{{ item.label }}</dt>
                      <dd tw-class="mt-0.5 break-all font-mono text-xs text-gray-800 dark:text-gray-200">{{ item.value }}</dd>
                    </div>
                  </dl>
                  <div tw-class="mb-2 text-[10px] font-bold uppercase tracking-wider text-gray-400">Runtime preview</div>
                  <JsonCodeView
                    :source="derivedPreviewJson"
                    display-mode="formatted"
                    overflow-mode="scroll"
                    height-mode="content"
                  />
                </div>
              </details>
            </template>
          </aside>
        </div>
      </section>
    </div>
  </Teleport>
</template>
