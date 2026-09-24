<script setup lang="ts">
import LlamaCppBrowserModelSuggestions from './LlamaCppBrowserModelSuggestions.vue';
import LlamaCppBrowserDefaultModelAction from './LlamaCppBrowserDefaultModelAction.vue';
import LlamaCppBrowserDefaultModelDialog from './LlamaCppBrowserDefaultModelDialog.vue';
import type { ApplyDefaultModel, DefaultModelContext } from '@/features/llama-cpp-browser/default-model';
import { getDownloadQueue, jobIsBusy } from '@/features/llama-cpp-browser/hugging-face/download-queue';
import LlamaCppBrowserDeletionDialog from './LlamaCppBrowserDeletionDialog.vue';
import { useModelDeletionConfirm } from './useModelDeletionConfirm';
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import { AlertCircleIcon, BrainCircuitIcon, HardDriveIcon, Loader2Icon, RefreshCcwIcon, Trash2Icon, SearchIcon, XIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import { llamaCppBrowserService } from '@/features/llama-cpp-browser';
import { errorCode, type EngineState, type LocalModel, type ErrorCode } from '@/features/llama-cpp-browser/types';
import LlamaCppBrowserHuggingFaceManager from './LlamaCppBrowserHuggingFaceManager.vue';
import LlamaCppBrowserModelImport from './LlamaCppBrowserModelImport.vue';
import LlamaCppBrowserRuntimeSettings from './LlamaCppBrowserRuntimeSettings.vue';

import type { ModelPreset } from '@/features/llama-cpp-browser/model-preset';
const props = defineProps<{ suggestions?: 'chat' | 'none', modelPreset?: ModelPreset, defaultModel?: DefaultModelContext, applyDefaultModel?: ApplyDefaultModel }>();
const repositoryManager = ref<InstanceType<typeof LlamaCppBrowserHuggingFaceManager>>();
async function inspectRepository({ input }: { input: string }): Promise<void> {
  if (unavailable.value || active.value || importing.value || refreshing.value) return;
  await repositoryManager.value?.inspectRepository({ input });
}
defineSlots<{ catalog({ disabled, inspect }: { disabled: boolean, inspect: typeof inspectRepository }): unknown }>();
const emit = defineEmits<{ modelsChanged: [models: LocalModel[]], modelSelected: [name: string], runtimeReady: [ready: boolean] }>();
const state = shallowRef<EngineState>(llamaCppBrowserService.getState());
const models = ref<LocalModel[]>([]);
const nameFilter = ref('');
const filteredModels = computed(() => {
  const query = nameFilter.value.trim().toLocaleLowerCase();
  return query ? models.value.filter(model => model.name.toLocaleLowerCase().includes(query)) : models.value;
});
const defaultSelection = shallowRef<LocalModel>();
const queue = getDownloadQueue();
const queuedDownloadBusy = computed(() => queue.jobs.value.some(job => jobIsBusy({ job })));
const defaultActionDisabled = computed(() => !props.defaultModel || !props.applyDefaultModel);
const applyConfirmedDefault: ApplyDefaultModel = async ({ model, previous }) => {
  // Revalidate locally after confirmation: another tab may have removed it.
  // This check must not contact Hugging Face or initialize the model runtime.
  await refresh();
  if (listError.value || !models.value.some(entry => entry.id === model.id) || !props.applyDefaultModel) throw new Error('Local model unavailable');
  return props.applyDefaultModel({ model, previous });
};
const localError = ref<ErrorCode>();
const removalChanged = ref(false);
const listError = ref<ErrorCode>();
const displayedError = computed(() => localError.value ?? listError.value);
const active = ref<AbortController>();
const refreshing = ref(false);
const downloading = ref(false);
const importing = ref(false);
const unavailable = computed(() => state.value.status === 'unavailable');
const busy = computed(() => active.value !== undefined || importing.value || downloading.value || queuedDownloadBusy.value || state.value.status === 'working');
const { request: deletionRequest, finish: finishDeletion, confirmRemoval } = useModelDeletionConfirm();
let unsubscribe: (() => void) | undefined;
let unsubscribeModels: (() => void) | undefined;
let refreshController: AbortController | undefined;
let refreshPromise: Promise<void> | undefined;
let refreshRequested = false;
let disposed = false;

function refresh(): Promise<void> {
  if (unavailable.value || disposed) return Promise.resolve();
  refreshRequested = true;
  if (refreshPromise) return refreshPromise;
  const controller = new AbortController(); refreshController = controller; refreshing.value = true;
  // Defer execution until refreshPromise is assigned, including synchronous failures.
  refreshPromise = Promise.resolve().then(async () => {
    while (refreshRequested && !disposed && !controller.signal.aborted) {
      refreshRequested = false; listError.value = undefined;
      try {
        const found = await llamaCppBrowserService.listModels({ signal: controller.signal });
        if (!disposed && !controller.signal.aborted && !refreshRequested) {
          models.value = found; emit('modelsChanged', found);
        }
      } catch (error) {
        if (!disposed && !controller.signal.aborted) listError.value = errorCode({ error });
      }
    }
  }).finally(() => {
    refreshing.value = false; refreshController = undefined; refreshPromise = undefined;
    // A list notification can arrive after the loop exits but before this cleanup.
    return refreshRequested && !disposed && !controller.signal.aborted ? refresh() : undefined;
  });
  return refreshPromise;
}
let modelSelectionVersion = 0;
async function selectReadyModel({ model }: { model: LocalModel }): Promise<void> {
  const version = ++modelSelectionVersion;
  await refresh();
  if (disposed || version !== modelSelectionVersion) return;
  const available = models.value.find(entry => entry.id === model.id);
  if (available) emit('modelSelected', available.name);
}
async function remove({ id }: { id: string }): Promise<void> {
  if (disposed || unavailable.value || active.value || importing.value || downloading.value || queuedDownloadBusy.value || refreshing.value) return;
  const controller = new AbortController(); active.value = controller; localError.value = undefined; removalChanged.value = false;
  try {
    const plan = await confirmRemoval({ id });
    if (!plan || disposed || controller.signal.aborted) return;
    removalChanged.value = await llamaCppBrowserService.removeModel({ plan, signal: controller.signal }) === 'changed'; await refresh();
  } catch (error) {
    if (!controller.signal.aborted) localError.value = errorCode({ error });
  } finally {
    active.value = undefined;
  }
}
function formatSize({ bytes }: { bytes: number }): string {
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}
watch(queue.changed, () => {
  void refresh();
});
function refreshOnFocus(): void {
  void refresh();
}
onMounted(() => {
  window.addEventListener('focus', refreshOnFocus);
  unsubscribe = llamaCppBrowserService.subscribe({ listener: ({ state: next }) => {
    state.value = next;
  } });
  unsubscribeModels = llamaCppBrowserService.subscribeModelList({ listener: () => {
    void refresh();
  } });
  // The authoritative list comes from OPFS on every mount, not module-local state.
  void refresh();
});
onUnmounted(() => {
  window.removeEventListener('focus', refreshOnFocus);
  disposed = true; emit('runtimeReady', false); active.value?.abort(); refreshController?.abort(); unsubscribe?.(); unsubscribeModels?.();
});
defineExpose({ refresh, ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <section tw-class="space-y-5" data-testid="llama-cpp-browser-manager">
    <div v-if="unavailable" tw-class="flex items-start gap-3 p-5 rounded-2xl border border-amber-100 dark:border-amber-900/30 bg-amber-50 dark:bg-amber-900/10 text-sm text-amber-700 dark:text-amber-400" data-testid="llama-cpp-browser-unavailable">
      <AlertCircleIcon tw-class="w-5 h-5 shrink-0 mt-0.5" />
      <p>{{ lazyStrings.llamaCppBrowser__operation_failed() }}</p>
    </div>
    <slot name="catalog" :disabled="unavailable || importing || active !== undefined || refreshing || downloading" :inspect="inspectRepository" />
    <LlamaCppBrowserHuggingFaceManager ref="repositoryManager" :model-preset="props.modelPreset" :disabled="unavailable || importing || active !== undefined || refreshing" @busy="downloading = $event" @changed="refresh" @model-ready="selectReadyModel({ model: $event })" @selection-changed="modelSelectionVersion++" />
    <LlamaCppBrowserModelImport :disabled="unavailable || busy" @busy="importing = $event" @changed="refresh" />
    <p v-if="removalChanged" role="alert" data-testid="llama-removal-changed" tw-class="text-xs text-red-500">{{ lazyStrings.llamaCppBrowser__files_changed_review_before_deleting() }}</p>
    <div v-if="displayedError" role="alert" tw-class="flex items-start gap-3 rounded-2xl p-4 border border-red-100 dark:border-red-900/30 bg-red-50 dark:bg-red-900/10 text-red-700 dark:text-red-400">
      <AlertCircleIcon tw-class="w-4 h-4 shrink-0 mt-0.5" /><div tw-class="text-xs space-y-1"><p>{{ displayedError === 'invalid-gguf' ? lazyStrings.llamaCppBrowser__gguf_files_only() : lazyStrings.llamaCppBrowser__operation_failed() }}</p><code tw-class="font-mono">{{ displayedError }}</code></div>
    </div>
    <!-- Privacy: bundled suggestions render without external I/O. Only explicit
         inspect/download actions (or a model-preset URL) authorize Hugging Face. -->
    <LlamaCppBrowserModelSuggestions v-if="props.suggestions !== 'none'" :models="models" :disabled="unavailable || importing || active !== undefined || refreshing" :default-model="defaultModel" :default-action-disabled="defaultActionDisabled" @select-default="defaultSelection = $event" />
    <section tw-class="space-y-4">
      <div tw-class="flex items-center justify-between gap-3 pb-3 border-b border-gray-100 dark:border-gray-800">
        <h3 tw-class="flex items-center gap-2 text-sm font-bold text-gray-800 dark:text-white"><HardDriveIcon tw-class="w-4 h-4 text-purple-500" />{{ lazyStrings.llamaCppBrowser__imported_models() }}<span tw-class="text-xs text-gray-400 tabular-nums">{{ nameFilter.trim() ? `${filteredModels.length} / ${models.length}` : models.length }}</span></h3>
        <button type="button" data-testid="llama-cpp-browser-refresh" :disabled="unavailable || importing || active !== undefined || refreshing" :aria-label="lazyStrings.llamaCppBrowser__refresh_models()" :title="lazyStrings.llamaCppBrowser__refresh_models()" tw-class="p-2 rounded-xl text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-purple-600 dark:hover:text-purple-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors" @click="refresh"><RefreshCcwIcon :tw-class="['w-4 h-4', { 'animate-spin': refreshing }]" /></button>
      </div>
      <div tw-class="relative">
        <SearchIcon tw-class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
        <input v-model="nameFilter" type="search" data-testid="llama-imported-model-search" :aria-label="lazyStrings.llamaCppBrowserDownloads__search_model_names()" :placeholder="lazyStrings.llamaCppBrowserDownloads__search_model_names()" tw-class="w-full pl-9 pr-10 py-2.5 text-xs rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 outline-none focus:ring-4 focus:ring-purple-500/10 focus:border-purple-400 transition-colors" />
        <button v-if="nameFilter" type="button" data-testid="llama-imported-model-clear-search" :aria-label="lazyStrings.llamaCppBrowserDownloads__clear_search()" tw-class="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-lg text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800" @click="nameFilter = ''"><XIcon tw-class="w-4 h-4" /></button>
      </div>
      <p v-if="refreshing && models.length === 0" role="status" data-testid="llama-cpp-browser-list-loading" tw-class="flex items-center justify-center gap-2 py-8 text-xs text-gray-500"><Loader2Icon tw-class="w-4 h-4 animate-spin" />{{ lazyStrings.llamaCppBrowser__loading_model_list() }}</p>
      <div v-else-if="models.length === 0" tw-class="rounded-2xl border border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/20 p-6 text-center text-sm text-gray-500 dark:text-gray-400"><p>{{ lazyStrings.llamaCppBrowser__no_imported_models() }}</p></div>
      <p v-else-if="filteredModels.length === 0" role="status" data-testid="llama-imported-model-no-results" tw-class="py-6 text-center text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.llamaCppBrowserDownloads__no_matching_models() }}</p>
      <ul v-else data-testid="llama-cpp-browser-model-list" tw-class="space-y-2">
        <li v-for="model in filteredModels" :key="model.id" tw-class="flex flex-wrap items-center gap-3 p-4 rounded-2xl border border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900/30">
          <div tw-class="w-9 h-9 rounded-xl bg-purple-50 dark:bg-purple-900/20 text-purple-500 flex items-center justify-center shrink-0"><BrainCircuitIcon tw-class="w-4 h-4" /></div>
          <div tw-class="min-w-0 flex-1"><p tw-class="text-sm font-bold text-gray-800 dark:text-gray-100 break-all">{{ model.name }}</p><p tw-class="text-[10px] text-gray-400 font-mono tabular-nums mt-1">{{ formatSize({ bytes: model.size }) }} · GGUF</p></div>
          <div tw-class="flex items-center justify-end gap-1 ml-auto">
            <LlamaCppBrowserDefaultModelAction :model="model" :current="defaultModel" :disabled="unavailable || importing || active !== undefined || refreshing || defaultActionDisabled" @select="defaultSelection = $event" />
            <button type="button" :disabled="unavailable || importing || active !== undefined || downloading || queuedDownloadBusy || refreshing" :data-testid="`llama-cpp-browser-delete-${model.id}`" :aria-label="lazyStrings.llamaCppBrowser__delete_model()" :title="lazyStrings.llamaCppBrowser__delete_model()" tw-class="p-2 rounded-xl text-gray-400 hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors" @click="remove({ id: model.id })"><Trash2Icon tw-class="w-4 h-4" /></button>
          </div>
        </li>
      </ul>
      <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.llamaCppBrowser__import_then_select() }}</p>
    </section>
    <LlamaCppBrowserRuntimeSettings :disabled="unavailable || busy" :release-disabled="unavailable || active !== undefined || importing" @runtime-ready="emit('runtimeReady', $event)" />
  </section>
  <LlamaCppBrowserDefaultModelDialog :model="defaultSelection" :current="defaultModel" :models="models" :apply="applyConfirmedDefault" @close="defaultSelection = undefined" />
  <LlamaCppBrowserDeletionDialog :request="deletionRequest" @confirm="finishDeletion({ plan: $event })" @cancel="finishDeletion({ plan: undefined })" />
</template>
