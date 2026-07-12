<script setup lang="ts">
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
  BracesIcon,
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
import { useFileExplorerModal } from '@/features/file-explorer/composables/useFileExplorerModal';
import { createDebugEncryptedStorageWorkerClient } from '@/features/debug-encrypted-storage/worker/client';
import type {
  DebugEncryptedStorageWorkerClient,
  EncryptedStorageDebugIntegrityReport,
  EncryptedStorageDebugNode,
  EncryptedStorageDebugNodeRef,
  EncryptedStorageDebugSearchResult,
} from '@/features/debug-encrypted-storage/worker/types';
import { useDebugEncryptedStorageInspector } from '@/features/debug-encrypted-storage/composables/useDebugEncryptedStorageInspector';

const {
  debugEncryptedStorageInitialNode,
  closeDebugEncryptedStorageInspector,
} = useDebugEncryptedStorageInspector();
const { openFileExplorer } = useFileExplorerModal();

const client = ref<DebugEncryptedStorageWorkerClient>();
const currentNode = ref<EncryptedStorageDebugNode>();
const history = ref<EncryptedStorageDebugNodeRef[]>([]);
const historyIndex = ref(-1);
const loading = ref(true);
const errorMessage = ref<string>();
const query = ref('');
const searchResults = ref<EncryptedStorageDebugSearchResult[]>([]);
const searching = ref(false);
const integrityReport = ref<EncryptedStorageDebugIntegrityReport>();
const scanning = ref(false);
const copied = ref(false);
let disposed = false;
let navigationRequestId = 0;
let searchRequestId = 0;
let integrityRequestId = 0;

const canGoBack = computed(() => historyIndex.value > 0);
const canGoForward = computed(() => historyIndex.value >= 0 && historyIndex.value < history.value.length - 1);
const formattedValue = computed(() => JSON.stringify(currentNode.value?.value ?? null, null, 2));

onMounted(async () => {
  try {
    const createdClient = await createDebugEncryptedStorageWorkerClient();
    if (disposed) {
      await createdClient.dispose();
      return;
    }
    client.value = createdClient;
    await navigate({ ref: debugEncryptedStorageInitialNode.value, recordHistory: true });
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
    await navigate({ ref: refValue, recordHistory: true });
  }
});

async function navigate({
  ref: targetRef,
  recordHistory,
}: {
  ref: EncryptedStorageDebugNodeRef,
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
    if (disposed || requestId !== navigationRequestId) {
      return;
    }
    currentNode.value = node;
    if (recordHistory) {
      history.value = history.value.slice(0, historyIndex.value + 1);
      history.value.push(targetRef);
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
  const target = history.value[historyIndex.value];
  if (target !== undefined) {
    await navigate({ ref: target, recordHistory: false });
  }
}

async function goForward(): Promise<void> {
  if (!canGoForward.value) {
    return;
  }
  historyIndex.value += 1;
  const target = history.value[historyIndex.value];
  if (target !== undefined) {
    await navigate({ ref: target, recordHistory: false });
  }
}

async function runSearch(): Promise<void> {
  const activeClient = client.value;
  if (activeClient === undefined) {
    return;
  }
  const requestId = ++searchRequestId;
  searching.value = true;
  errorMessage.value = undefined;
  try {
    const results = await activeClient.search({ query: query.value });
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

async function copyCurrentJson(): Promise<void> {
  await navigator.clipboard.writeText(formattedValue.value);
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
      <section tw-class="flex h-[min(920px,calc(100vh-1.5rem))] w-[min(1540px,calc(100vw-1.5rem))] min-w-0 flex-col overflow-hidden rounded-2xl border border-gray-200 bg-gray-50 shadow-2xl dark:border-gray-700 dark:bg-gray-950">
        <header tw-class="flex min-h-14 items-center gap-2 border-b border-gray-200 bg-white px-3 dark:border-gray-800 dark:bg-gray-900 sm:px-4">
          <div tw-class="flex min-w-0 items-center gap-2">
            <div tw-class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600 dark:bg-blue-950/60 dark:text-blue-300">
              <DatabaseIcon tw-class="h-4 w-4" />
            </div>
            <div tw-class="min-w-0">
              <h1 tw-class="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">Encrypted Storage Inspector</h1>
              <p tw-class="truncate text-[11px] font-mono text-gray-500 dark:text-gray-400">read-only · decrypted session · worker-backed</p>
            </div>
          </div>
          <div tw-class="ml-auto flex items-center gap-1">
            <button :disabled="!canGoBack" tw-class="rounded-lg p-2 text-gray-500 hover:bg-gray-100 disabled:opacity-30 dark:hover:bg-gray-800" title="Back" @click="goBack">
              <ArrowLeftIcon tw-class="h-4 w-4" />
            </button>
            <button :disabled="!canGoForward" tw-class="rounded-lg p-2 text-gray-500 hover:bg-gray-100 disabled:opacity-30 dark:hover:bg-gray-800" title="Forward" @click="goForward">
              <ArrowRightIcon tw-class="h-4 w-4" />
            </button>
            <button tw-class="rounded-lg p-2 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800" title="Reload current node" @click="currentNode && navigate({ ref: currentNode.ref, recordHistory: false })">
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

        <div tw-class="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(180px,0.7fr)_minmax(300px,1.3fr)_minmax(180px,0.7fr)] overflow-hidden lg:grid-cols-[310px_minmax(0,1fr)_340px] lg:grid-rows-1">
          <aside tw-class="flex min-h-0 flex-col border-b border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900 lg:border-b-0 lg:border-r">
            <form tw-class="border-b border-gray-200 p-3 dark:border-gray-800" @submit.prevent="runSearch">
              <div tw-class="flex items-center gap-2 rounded-xl border border-gray-200 bg-gray-50 px-3 dark:border-gray-700 dark:bg-gray-950">
                <SearchIcon tw-class="h-4 w-4 shrink-0 text-gray-400" />
                <input
                  v-model="query"
                  tw-class="min-w-0 flex-1 bg-transparent py-2 text-xs font-mono text-gray-800 outline-none placeholder:text-gray-400 dark:text-gray-100"
                  placeholder="ID, path, namespace:key"
                />
                <LoaderCircleIcon v-if="searching" tw-class="h-4 w-4 animate-spin text-blue-500" />
              </div>
            </form>

            <div tw-class="min-h-0 flex-1 overflow-auto p-2">
              <div v-if="searchResults.length > 0" tw-class="mb-3">
                <div tw-class="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-gray-400">Search results</div>
                <button
                  v-for="result in searchResults"
                  :key="JSON.stringify(result.ref)"
                  tw-class="mb-1 w-full rounded-lg px-2 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-800"
                  @click="navigate({ ref: result.ref, recordHistory: true })"
                >
                  <div tw-class="truncate text-xs font-medium text-gray-800 dark:text-gray-100">{{ result.label }}</div>
                  <div tw-class="truncate text-[10px] font-mono text-gray-500">{{ result.detail }}</div>
                </button>
              </div>

              <div tw-class="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-gray-400">References</div>
              <button
                v-for="reference in currentNode?.references ?? []"
                :key="`${reference.label}:${JSON.stringify(reference.ref)}`"
                tw-class="mb-1 flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-800"
                @click="navigate({ ref: reference.ref, recordHistory: true })"
              >
                <BracesIcon tw-class="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-500" />
                <span tw-class="min-w-0 truncate text-xs text-gray-700 dark:text-gray-200">{{ reference.label }}</span>
              </button>
            </div>

            <div tw-class="border-t border-gray-200 p-3 dark:border-gray-800">
              <button
                tw-class="flex w-full items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
                :disabled="scanning"
                @click="runIntegrityScan"
              >
                <LoaderCircleIcon v-if="scanning" tw-class="h-4 w-4 animate-spin" />
                <ShieldCheckIcon v-else tw-class="h-4 w-4" />
                Run integrity scan
              </button>
            </div>
          </aside>

          <main tw-class="relative min-h-0 overflow-auto bg-gray-50 p-3 dark:bg-gray-950 sm:p-4">
            <div v-if="loading" tw-class="absolute inset-0 z-10 flex items-center justify-center bg-gray-50/75 backdrop-blur-[1px] dark:bg-gray-950/75">
              <LoaderCircleIcon tw-class="h-6 w-6 animate-spin text-blue-500" />
            </div>

            <div v-if="errorMessage" tw-class="mb-4 flex gap-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/70 dark:bg-red-950/40 dark:text-red-200">
              <AlertTriangleIcon tw-class="h-5 w-5 shrink-0" />
              <pre tw-class="min-w-0 whitespace-pre-wrap break-words font-mono text-xs">{{ errorMessage }}</pre>
            </div>

            <template v-if="currentNode">
              <div tw-class="mb-4 flex flex-wrap items-start gap-3">
                <div tw-class="min-w-0 flex-1">
                  <div tw-class="mb-1 text-[10px] font-bold uppercase tracking-wider text-blue-600 dark:text-blue-400">{{ currentNode.kind }}</div>
                  <h2 tw-class="break-all text-lg font-semibold text-gray-900 dark:text-gray-100">{{ currentNode.title }}</h2>
                  <p v-if="currentNode.physicalPath" tw-class="mt-1 break-all font-mono text-[11px] text-gray-500">{{ currentNode.physicalPath }}</p>
                </div>
                <button tw-class="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800" @click="copyCurrentJson">
                  <CheckCircle2Icon v-if="copied" tw-class="h-4 w-4 text-green-500" />
                  <ClipboardIcon v-else tw-class="h-4 w-4" />
                  {{ copied ? 'Copied' : 'Copy JSON' }}
                </button>
              </div>

              <div v-if="currentNode.warnings.length > 0" tw-class="mb-4 space-y-2">
                <div v-for="warning in currentNode.warnings" :key="warning" tw-class="flex gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-200">
                  <AlertTriangleIcon tw-class="h-4 w-4 shrink-0" />
                  <span tw-class="break-all font-mono">{{ warning }}</span>
                </div>
              </div>

              <pre tw-class="min-h-[280px] overflow-auto rounded-xl border border-gray-200 bg-white p-4 font-mono text-[11px] leading-5 text-gray-800 shadow-sm dark:border-gray-800 dark:bg-gray-900 dark:text-gray-200">{{ formattedValue }}</pre>
            </template>
          </main>

          <aside tw-class="min-h-0 overflow-auto border-t border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-900 lg:border-l lg:border-t-0">
            <div tw-class="mb-2 text-[10px] font-bold uppercase tracking-wider text-gray-400">Decoded fields</div>
            <dl tw-class="space-y-1.5">
              <div v-for="item in currentNode?.fields ?? []" :key="item.label" tw-class="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 dark:border-gray-800 dark:bg-gray-950">
                <dt tw-class="text-[10px] font-medium uppercase tracking-wide text-gray-400">{{ item.label }}</dt>
                <dd tw-class="mt-0.5 break-all font-mono text-xs text-gray-800 dark:text-gray-200">{{ item.value }}</dd>
              </div>
            </dl>

            <template v-if="integrityReport">
              <div tw-class="mb-2 mt-5 text-[10px] font-bold uppercase tracking-wider text-gray-400">Integrity scan</div>
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
                @click="finding.ref && navigate({ ref: finding.ref, recordHistory: true })"
              >
                <div :tw-class="['text-[10px] font-bold uppercase', finding.severity === 'error' ? 'text-red-500' : finding.severity === 'warning' ? 'text-amber-500' : 'text-blue-500']">{{ finding.severity }}</div>
                <div tw-class="mt-1 break-all font-mono text-[10px] text-gray-600 dark:text-gray-300">{{ finding.message }}</div>
              </button>
            </template>
          </aside>
        </div>
      </section>
    </div>
  </Teleport>
</template>
