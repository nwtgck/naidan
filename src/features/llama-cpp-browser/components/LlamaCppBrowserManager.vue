<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, useId } from 'vue';
import { AlertCircleIcon, BrainCircuitIcon, ChevronDownIcon, FileUpIcon, FolderOpenIcon, HardDriveIcon, Loader2Icon, PowerOffIcon, RefreshCcwIcon, SlidersHorizontalIcon, Trash2Icon } from 'lucide-vue-next';
import { ensureStrings, lazyStrings } from '@/strings';
import { useConfirm } from '@/composables/useConfirm';
import { llamaCppBrowserService } from '@/features/llama-cpp-browser';
import { errorCode, runtimeOptionsSchema, type EngineState, type LocalModel, type ErrorCode } from '@/features/llama-cpp-browser/types';
import LlamaCppBrowserLoadingIndicator from './LlamaCppBrowserLoadingIndicator.vue';

const id = useId();
const state = shallowRef<EngineState>(llamaCppBrowserService.getState());
const models = ref<LocalModel[]>([]);
const options = ref(llamaCppBrowserService.getOptions());
const localError = ref<ErrorCode>();
const listError = ref<ErrorCode>();
const displayedError = computed(() => localError.value ?? listError.value);
const active = ref<AbortController>();
const refreshing = ref(false);
const dragDepth = ref(0);
const fileInput = ref<HTMLInputElement>();
const unavailable = computed(() => __BUILD_MODE_IS_STANDALONE__ || state.value.status === 'unavailable');
const busy = computed(() => active.value !== undefined || state.value.status === 'working');
const { showConfirm } = useConfirm();
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
        if (!disposed && !controller.signal.aborted && !refreshRequested) models.value = found;
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
async function importFiles({ files }: { files: File[] }): Promise<void> {
  if (disposed || unavailable.value || busy.value || refreshing.value || files.length === 0) return;
  localError.value = undefined;
  if (files.some(file => !file.name.toLowerCase().endsWith('.gguf'))) {
    localError.value = 'invalid-gguf'; return;
  }
  const controller = new AbortController(); active.value = controller;
  try {
    for (const file of files) {
      if (controller.signal.aborted) break;
      await llamaCppBrowserService.importModel({ file, signal: controller.signal });
    }
  } catch (error) {
    if (!controller.signal.aborted) localError.value = errorCode({ error });
  } finally {
    if (!disposed) await refresh();
    active.value = undefined;
  }
}
async function importFile({ event }: { event: Event }): Promise<void> {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;
  const files = Array.from(input.files ?? []); input.value = '';
  await importFiles({ files });
}
function dragEnter({ event }: { event: DragEvent }): void {
  if (unavailable.value || busy.value || refreshing.value || !event.dataTransfer?.types.includes('Files')) return;
  dragDepth.value++;
}
function dragOver({ event }: { event: DragEvent }): void {
  if (event.dataTransfer) event.dataTransfer.dropEffect = unavailable.value || busy.value || refreshing.value ? 'none' : 'copy';
}
async function dropFiles({ event }: { event: DragEvent }): Promise<void> {
  dragDepth.value = 0;
  await importFiles({ files: Array.from(event.dataTransfer?.files ?? []) });
}
async function remove({ id }: { id: string }): Promise<void> {
  if (disposed || unavailable.value || busy.value || refreshing.value) return;
  if (!await showConfirm({ message: await ensureStrings.llamaCppBrowser__delete_model_confirmation(), confirmButtonVariant: 'danger' })) return;
  if (disposed || unavailable.value || busy.value || refreshing.value) return;
  const controller = new AbortController(); active.value = controller; localError.value = undefined;
  try {
    await llamaCppBrowserService.removeModel({ id, signal: controller.signal }); await refresh();
  } catch (error) {
    if (!controller.signal.aborted) localError.value = errorCode({ error });
  } finally {
    active.value = undefined;
  }
}
function applyOptions(): void {
  const parsed = runtimeOptionsSchema.safeParse(options.value);
  if (parsed.success) llamaCppBrowserService.setOptions({ options: parsed.data });
}
function formatSize({ bytes }: { bytes: number }): string {
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}
function cancel(): void {
  active.value?.abort();
}
onMounted(() => {
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
  disposed = true; active.value?.abort(); refreshController?.abort(); unsubscribe?.(); unsubscribeModels?.();
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <section tw-class="space-y-8" data-testid="llama-cpp-browser-manager">
    <div v-if="unavailable" tw-class="flex items-start gap-3 p-5 rounded-2xl border border-amber-100 dark:border-amber-900/30 bg-amber-50 dark:bg-amber-900/10 text-sm text-amber-700 dark:text-amber-400" data-testid="llama-cpp-browser-unavailable">
      <AlertCircleIcon tw-class="w-5 h-5 shrink-0 mt-0.5" />
      <p>{{ lazyStrings.llamaCppBrowser__unavailable_in_standalone() }}</p>
    </div>
    <fieldset :disabled="unavailable || busy || refreshing" tw-class="space-y-5 disabled:opacity-50">
      <legend tw-class="w-full flex items-center gap-2 pb-3 mb-5 border-b border-gray-100 dark:border-gray-800">
        <FileUpIcon tw-class="w-5 h-5 text-purple-500" />
        <span tw-class="text-lg font-bold text-gray-800 dark:text-white tracking-tight">{{ lazyStrings.llamaCppBrowser__gguf_model_files() }}</span>
      </legend>
      <div
        data-testid="llama-cpp-browser-drop-zone"
        :tw-class="['rounded-3xl border-2 border-dashed p-6 md:p-8 text-center transition-colors', dragDepth > 0 ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20' : 'border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-800/30']"
        @dragenter.prevent.stop="dragEnter({ event: $event })"
        @dragover.prevent.stop="dragOver({ event: $event })"
        @dragleave.prevent.stop="dragDepth = Math.max(0, dragDepth - 1)"
        @drop.prevent.stop="dropFiles({ event: $event })"
      >
        <div tw-class="w-12 h-12 rounded-2xl bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400 flex items-center justify-center mx-auto mb-4"><FileUpIcon tw-class="w-6 h-6" /></div>
        <p tw-class="text-sm font-bold text-gray-800 dark:text-white">{{ lazyStrings.llamaCppBrowser__drop_gguf_files_here() }}</p>
        <p :id="`${id}-file-help`" tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400 mt-2 mb-5">{{ lazyStrings.llamaCppBrowser__or_choose_files_from_your_device() }}</p>
        <input ref="fileInput" type="file" accept=".gguf" multiple tabindex="-1" :aria-label="lazyStrings.llamaCppBrowser__choose_gguf_files()" :aria-describedby="`${id}-file-help`" data-testid="llama-cpp-browser-file" tw-class="sr-only" @change="importFile({ event: $event })" />
        <button type="button" data-testid="llama-cpp-browser-choose-files" tw-class="inline-flex items-center justify-center gap-2 px-5 py-3 text-xs font-bold rounded-xl bg-purple-600 text-white hover:bg-purple-700 shadow-lg shadow-purple-500/20 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-purple-500/20 transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed" @click="fileInput?.click()">
          <FolderOpenIcon tw-class="w-4 h-4" />{{ lazyStrings.llamaCppBrowser__choose_gguf_files() }}
        </button>
      </div>
    </fieldset>
    <div v-if="active" tw-class="rounded-2xl border border-purple-100 dark:border-purple-900/30 p-4 space-y-3">
      <LlamaCppBrowserLoadingIndicator scope="import" />
      <div tw-class="flex justify-end"><button type="button" data-testid="llama-cpp-browser-cancel" tw-class="px-3 py-1.5 rounded-lg text-xs font-bold text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors" @click="cancel">{{ lazyStrings.SHARED__cancel() }}</button></div>
    </div>
    <div v-if="displayedError" role="alert" tw-class="flex items-start gap-3 rounded-2xl p-4 border border-red-100 dark:border-red-900/30 bg-red-50 dark:bg-red-900/10 text-red-700 dark:text-red-400">
      <AlertCircleIcon tw-class="w-4 h-4 shrink-0 mt-0.5" /><div tw-class="text-xs space-y-1"><p>{{ displayedError === 'invalid-gguf' ? lazyStrings.llamaCppBrowser__gguf_files_only() : lazyStrings.llamaCppBrowser__operation_failed() }}</p><code tw-class="font-mono">{{ displayedError }}</code></div>
    </div>
    <section tw-class="space-y-4">
      <div tw-class="flex items-center justify-between gap-3 pb-3 border-b border-gray-100 dark:border-gray-800">
        <h3 tw-class="flex items-center gap-2 text-sm font-bold text-gray-800 dark:text-white"><HardDriveIcon tw-class="w-4 h-4 text-purple-500" />{{ lazyStrings.llamaCppBrowser__imported_models() }}<span tw-class="text-xs text-gray-400 tabular-nums">{{ models.length }}</span></h3>
        <button type="button" data-testid="llama-cpp-browser-refresh" :disabled="unavailable || busy || refreshing" :aria-label="lazyStrings.llamaCppBrowser__refresh_models()" :title="lazyStrings.llamaCppBrowser__refresh_models()" tw-class="p-2 rounded-xl text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-purple-600 dark:hover:text-purple-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors" @click="refresh"><RefreshCcwIcon :tw-class="['w-4 h-4', { 'animate-spin': refreshing }]" /></button>
      </div>
      <p v-if="refreshing && models.length === 0" role="status" data-testid="llama-cpp-browser-list-loading" tw-class="flex items-center justify-center gap-2 py-8 text-xs text-gray-500"><Loader2Icon tw-class="w-4 h-4 animate-spin" />{{ lazyStrings.llamaCppBrowser__loading_model_list() }}</p>
      <div v-else-if="models.length === 0" tw-class="rounded-2xl border border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/20 p-6 text-center text-sm text-gray-500 dark:text-gray-400"><p>{{ lazyStrings.llamaCppBrowser__no_imported_models() }}</p></div>
      <ul v-else data-testid="llama-cpp-browser-model-list" tw-class="space-y-2">
        <li v-for="model in models" :key="model.id" tw-class="flex items-center gap-3 p-4 rounded-2xl border border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900/30">
          <div tw-class="w-9 h-9 rounded-xl bg-purple-50 dark:bg-purple-900/20 text-purple-500 flex items-center justify-center shrink-0"><BrainCircuitIcon tw-class="w-4 h-4" /></div>
          <div tw-class="min-w-0 flex-1"><p tw-class="text-sm font-bold text-gray-800 dark:text-gray-100 break-all">{{ model.name }}</p><p tw-class="text-[10px] text-gray-400 font-mono tabular-nums mt-1">{{ formatSize({ bytes: model.size }) }} · GGUF</p></div>
          <button type="button" :disabled="unavailable || busy || refreshing" :data-testid="`llama-cpp-browser-delete-${model.id}`" :aria-label="lazyStrings.llamaCppBrowser__delete_model()" :title="lazyStrings.llamaCppBrowser__delete_model()" tw-class="p-2 rounded-xl text-gray-400 hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors" @click="remove({ id: model.id })"><Trash2Icon tw-class="w-4 h-4" /></button>
        </li>
      </ul>
      <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.llamaCppBrowser__import_then_select() }}</p>
    </section>
    <section tw-class="rounded-2xl border border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/20 p-5 space-y-4">
      <h3 tw-class="flex items-center gap-2 text-sm font-bold text-gray-800 dark:text-white"><SlidersHorizontalIcon tw-class="w-4 h-4 text-purple-500" />{{ lazyStrings.llamaCppBrowser__inference_settings() }}</h3>
      <fieldset :disabled="unavailable || busy" tw-class="grid grid-cols-1 sm:grid-cols-2 gap-4 disabled:opacity-50">
        <div tw-class="space-y-2">
          <label :for="`${id}-profile`" tw-class="block text-xs font-bold text-gray-500 dark:text-gray-400">{{ lazyStrings.llamaCppBrowser__profile() }}</label>
          <div tw-class="relative"><select :id="`${id}-profile`" v-model="options.profile" data-testid="llama-cpp-browser-profile" tw-class="appearance-none block w-full pl-3 pr-9 py-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm font-medium text-gray-800 dark:text-gray-100 focus:ring-4 focus:ring-purple-500/10 outline-none transition-all" @change="applyOptions">
            <option value="auto">{{ lazyStrings.llamaCppBrowser__automatic_recommended() }}</option><option value="webgpu-wasm64-jspi">WebGPU / wasm64</option><option value="cpu-wasm64">CPU / wasm64</option><option value="cpu-wasm32">CPU / wasm32</option>
          </select><ChevronDownIcon tw-class="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" /></div>
        </div>
        <div tw-class="space-y-2"><label :for="`${id}-context`" tw-class="block text-xs font-bold text-gray-500 dark:text-gray-400">{{ lazyStrings.llamaCppBrowser__context_size() }}</label><input :id="`${id}-context`" v-model.number="options.contextSize" type="number" min="128" max="32768" step="128" data-testid="llama-cpp-browser-context" tw-class="block w-full p-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm font-medium text-gray-800 dark:text-gray-100 focus:ring-4 focus:ring-purple-500/10 outline-none transition-all" @change="applyOptions" /></div>
      </fieldset>
      <p v-if="options.profile === 'auto'" tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.llamaCppBrowser__automatic_profile_description() }}</p>
      <div tw-class="flex flex-col sm:flex-row sm:items-center gap-3 pt-3 border-t border-gray-100 dark:border-gray-800"><p tw-class="text-xs text-gray-500 dark:text-gray-400 flex-1">{{ lazyStrings.llamaCppBrowser__text_chat_only() }}</p><button type="button" :disabled="unavailable || active !== undefined" data-testid="llama-cpp-browser-release" tw-class="inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-bold rounded-xl text-gray-500 hover:text-purple-600 dark:hover:text-purple-400 hover:bg-white dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors" @click="llamaCppBrowserService.release()"><PowerOffIcon tw-class="w-4 h-4" />{{ lazyStrings.llamaCppBrowser__release_runtime() }}</button></div>
    </section>
  </section>
</template>
