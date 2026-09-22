<script setup lang="ts">
import LlamaCppBrowserModelSuggestions from './LlamaCppBrowserModelSuggestions.vue';
import LlamaCppBrowserDefaultModelAction from './LlamaCppBrowserDefaultModelAction.vue';
import LlamaCppBrowserDefaultModelDialog from './LlamaCppBrowserDefaultModelDialog.vue';
import type { ApplyDefaultModel, DefaultModelContext } from '@/features/llama-cpp-browser/default-model';
import { getDownloadQueue, jobIsBusy } from '@/features/llama-cpp-browser/hugging-face/download-queue';
import LlamaCppBrowserDeletionDialog from './LlamaCppBrowserDeletionDialog.vue';
import { useModelDeletionConfirm } from './useModelDeletionConfirm';
import { computed, onMounted, onUnmounted, ref, shallowRef, useId, watch } from 'vue';
import { AlertCircleIcon, BrainCircuitIcon, ChevronDownIcon, FileUpIcon, FolderOpenIcon, HardDriveIcon, Loader2Icon, PowerOffIcon, RefreshCcwIcon, SlidersHorizontalIcon, Trash2Icon, SearchIcon, XIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import { llamaCppBrowserService } from '@/features/llama-cpp-browser';
import { selectableProfiles } from '@/features/llama-cpp-browser/runtime/profile-policy';
import { errorCode, runtimeOptionsSchema, type EngineState, type LocalModel, type ErrorCode } from '@/features/llama-cpp-browser/types';
import { directoryFromFiles, droppedModels } from '@/features/llama-cpp-browser/runtime/directory-input';
import type { ModelDirectoryInput } from '@/features/llama-cpp-browser/types';
import LlamaCppBrowserHuggingFaceManager from './LlamaCppBrowserHuggingFaceManager.vue';
import LlamaCppBrowserLoadingIndicator from './LlamaCppBrowserLoadingIndicator.vue';

import { resolveProfilePreference, type ProfileCapabilities, type ProfileState, type ProfileUnavailableReason } from '@/features/llama-cpp-browser/runtime/profile-capabilities';
import type { ModelPreset } from '@/features/llama-cpp-browser/model-preset';
const props = defineProps<{ modelPreset?: ModelPreset, defaultModel?: DefaultModelContext, applyDefaultModel?: ApplyDefaultModel }>();
const emit = defineEmits<{ modelsChanged: [models: LocalModel[]], modelSelected: [name: string], runtimeReady: [ready: boolean] }>();
const id = useId();
const state = shallowRef<EngineState>(llamaCppBrowserService.getState());
const profileState = shallowRef<ProfileState>(llamaCppBrowserService.getProfileState());
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
const options = ref(llamaCppBrowserService.getOptions());
const localError = ref<ErrorCode>();
const removalChanged = ref(false);
const listError = ref<ErrorCode>();
const displayedError = computed(() => localError.value ?? listError.value);
const active = ref<AbortController>();
const refreshing = ref(false);
const downloading = ref(false);
const dragDepth = ref(0);
const fileInput = ref<HTMLInputElement>();
const directoryInput = ref<HTMLInputElement>();
const profileLabels = {
  'webgpu-wasm64-jspi': 'WebGPU / wasm64',
  'webgpu-wasm32-jspi': 'WebGPU / wasm32 / JSPI',
  'webgpu-wasm32-asyncify': 'WebGPU / wasm32 / Asyncify',
  'cpu-wasm64': 'CPU / wasm64',
  'cpu-wasm32': 'CPU / wasm32',
} satisfies Record<Exclude<typeof options.value.profile, 'auto'>, string>;
const profileFeatures = {
  wasm: 'WebAssembly', memory64: 'WebAssembly memory64', jspi: 'WebAssembly JSPI',
  webgpu: 'WebGPU', 'shader-f16': 'WebGPU shader-f16', brotli: 'Brotli', storage: 'OPFS', worker: 'Worker',
} satisfies Record<ProfileUnavailableReason, string>;
const capabilities = computed(() => {
  const current = profileState.value;
  switch (current.status) {
  case 'ready': return current.capabilities;
  case 'idle': case 'checking': case 'error': return undefined;
  default: { const exhaustive: never = current; throw new Error(`Unhandled profile state: ${exhaustive}`); }
  }
});
const selectedProfile = computed(() => resolveProfilePreference({ preference: options.value.profile, capabilities: capabilities.value }));
const runtimeReady = computed(() => capabilities.value?.profiles.some(entry => entry.profile === selectedProfile.value && entry.status === 'available') === true);
function failureReason({ entry }: { entry: ProfileCapabilities['profiles'][number] | undefined }): ProfileUnavailableReason | undefined {
  if (!entry) return undefined;
  switch (entry.status) {
  case 'unavailable': return entry.reason;
  case 'available': return undefined;
  default: { const exhaustive: never = entry; throw new Error(`Unhandled profile availability: ${exhaustive}`); }
  }
}
const selectedFailure = computed(() => failureReason({ entry: capabilities.value?.profiles.find(entry => entry.profile === selectedProfile.value) }));
watch(runtimeReady, ready => emit('runtimeReady', ready), { immediate: true });
function profileDisabled({ profile }: { profile: typeof options.value.profile }): boolean {
  const resolved = resolveProfilePreference({ preference: profile, capabilities: capabilities.value });
  return !capabilities.value?.profiles.some(entry => entry.profile === resolved && entry.status === 'available');
}
const profileChoices = computed(() => {
  const labels = { ...profileLabels,
    auto: lazyStrings.llamaCppBrowser__automatic_profile({ profile: capabilities.value?.recommended === undefined ? undefined : profileLabels[capabilities.value.recommended] }),
  };
  return selectableProfiles.map(profile => {
    const reason = failureReason({ entry: capabilities.value?.profiles.find(entry => entry.profile === profile) });
    return { profile, label: labels[profile], disabled: profileDisabled({ profile }),
      reason: reason === undefined ? undefined : lazyStrings.llamaCppBrowser__unavailable_feature({ feature: profileFeatures[reason] }),
    };
  });
});
let profileController: AbortController | undefined;
let unsubscribeProfiles: (() => void) | undefined;
async function probeProfiles(): Promise<void> {
  profileController?.abort();
  const controller = new AbortController(); profileController = controller;
  try {
    await llamaCppBrowserService.probeProfiles({ signal: controller.signal });
  } catch (error) {
    if (!disposed && !controller.signal.aborted) profileState.value = { status: 'error', code: errorCode({ error }) };
  }
}
const unavailable = computed(() => state.value.status === 'unavailable');
const busy = computed(() => active.value !== undefined || downloading.value || queuedDownloadBusy.value || state.value.status === 'working');
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
type ImportInput = { files: File[], directories: ModelDirectoryInput[] };
async function importFiles({ collect }: { collect: () => ImportInput | Promise<ImportInput> }): Promise<void> {
  // Returning focus from a native drag or file picker starts a read-only list
  // refresh. That refresh must not disable imports or silently discard the input.
  if (disposed || unavailable.value || busy.value) return;
  localError.value = undefined;
  // Reserve the operation before asynchronous entry traversal, not just before
  // writing files. Cancellation/unmount must prevent late writes, and a second
  // drop, download, or deletion must not take over while an entry callback is pending.
  const controller = new AbortController(); active.value = controller;
  let needsRefresh = false;
  try {
    // Invoke collect during dispatch, before the first await: DataTransfer entries
    // must be captured while the browser still exposes the drop's data store.
    const { files, directories } = await collect();
    if (disposed || controller.signal.aborted) return;
    if (files.some(file => !file.name.toLowerCase().endsWith('.gguf'))) {
      localError.value = 'invalid-gguf'; return;
    }
    for (const directory of directories) {
      if (controller.signal.aborted) break;
      needsRefresh = true;
      await llamaCppBrowserService.importDirectory({ directory, signal: controller.signal });
    }
    for (const file of files) {
      if (controller.signal.aborted) break;
      needsRefresh = true;
      await llamaCppBrowserService.importModel({ file, signal: controller.signal });
    }
  } catch (error) {
    if (!disposed && !controller.signal.aborted) localError.value = errorCode({ error });
  } finally {
    if (!disposed && needsRefresh) await refresh();
    active.value = undefined;
  }
}
async function importFile({ event }: { event: Event }): Promise<void> {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;
  const files = Array.from(input.files ?? []); input.value = '';
  if (!files.length) return;
  await importFiles({ collect: () => ({ files, directories: [] }) });
}
async function importDirectory({ event }: { event: Event }): Promise<void> {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;
  const files = Array.from(input.files ?? []); input.value = '';
  if (!files.length) return;
  await importFiles({ collect: () => ({ files: [], directories: [directoryFromFiles({ files })] }) });
}
function dragEnter({ event }: { event: DragEvent }): void {
  if (unavailable.value || busy.value || !event.dataTransfer?.types.includes('Files')) return;
  dragDepth.value++;
}
function dragOver({ event }: { event: DragEvent }): void {
  if (event.dataTransfer) event.dataTransfer.dropEffect = unavailable.value || busy.value ? 'none' : 'copy';
}
async function dropFiles({ event }: { event: DragEvent }): Promise<void> {
  dragDepth.value = 0;
  const transfer = event.dataTransfer;
  if (!transfer) return;
  await importFiles({ collect: () => droppedModels({ transfer }) });
}
async function remove({ id }: { id: string }): Promise<void> {
  if (disposed || unavailable.value || active.value || downloading.value || queuedDownloadBusy.value || refreshing.value) return;
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
function applyOptions(): void {
  const parsed = runtimeOptionsSchema.safeParse(options.value);
  if (parsed.success && !profileDisabled({ profile: parsed.data.profile })) llamaCppBrowserService.setOptions({ options: parsed.data });
}
function formatSize({ bytes }: { bytes: number }): string {
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}
function cancel(): void {
  active.value?.abort();
}
watch(queue.changed, () => {
  void refresh();
});
function refreshOnFocus(): void {
  void refresh();
}
onMounted(() => {
  window.addEventListener('focus', refreshOnFocus);
  unsubscribeProfiles = llamaCppBrowserService.subscribeProfiles({ listener: ({ state: next }) => {
    profileState.value = next;
  } });
  void probeProfiles();
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
  disposed = true; profileController?.abort(); unsubscribeProfiles?.(); emit('runtimeReady', false); active.value?.abort(); refreshController?.abort(); unsubscribe?.(); unsubscribeModels?.();
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <section tw-class="space-y-5" data-testid="llama-cpp-browser-manager">
    <div v-if="unavailable" tw-class="flex items-start gap-3 p-5 rounded-2xl border border-amber-100 dark:border-amber-900/30 bg-amber-50 dark:bg-amber-900/10 text-sm text-amber-700 dark:text-amber-400" data-testid="llama-cpp-browser-unavailable">
      <AlertCircleIcon tw-class="w-5 h-5 shrink-0 mt-0.5" />
      <p>{{ lazyStrings.llamaCppBrowser__operation_failed() }}</p>
    </div>
    <LlamaCppBrowserHuggingFaceManager :model-preset="props.modelPreset" :disabled="unavailable || active !== undefined || refreshing" @busy="downloading = $event" @changed="refresh" @model-ready="selectReadyModel({ model: $event })" @selection-changed="modelSelectionVersion++" />
    <fieldset :disabled="unavailable || busy" tw-class="space-y-3 disabled:opacity-50">
      <legend tw-class="w-full flex items-center gap-2 pb-2 mb-3 border-b border-gray-100 dark:border-gray-800">
        <FileUpIcon tw-class="w-5 h-5 text-purple-500" />
        <span tw-class="text-sm font-bold text-gray-800 dark:text-white tracking-tight">{{ lazyStrings.llamaCppBrowser__gguf_model_files() }}</span>
      </legend>
      <div
        data-testid="llama-cpp-browser-drop-zone"
        :tw-class="['rounded-2xl border-2 border-dashed p-4 text-center transition-colors', dragDepth > 0 ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20' : 'border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-800/30']"
        @dragenter.prevent.stop="dragEnter({ event: $event })"
        @dragover.prevent.stop="dragOver({ event: $event })"
        @dragleave.prevent.stop="dragDepth = Math.max(0, dragDepth - 1)"
        @drop.prevent.stop="dropFiles({ event: $event })"
      >
        <div tw-class="w-8 h-8 rounded-xl bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400 flex items-center justify-center mx-auto mb-2"><FileUpIcon tw-class="w-4 h-4" /></div>
        <p tw-class="text-sm font-bold text-gray-800 dark:text-white">{{ lazyStrings.llamaCppBrowser__drop_model_folders_or_gguf_files_here() }}</p>
        <p :id="`${id}-file-help`" tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400 mt-1 mb-3">{{ lazyStrings.llamaCppBrowser__or_choose_files_from_your_device() }}</p>
        <input ref="fileInput" type="file" accept=".gguf" multiple tabindex="-1" :aria-label="lazyStrings.llamaCppBrowser__choose_gguf_files()" :aria-describedby="`${id}-file-help`" data-testid="llama-cpp-browser-file" tw-class="sr-only" @change="importFile({ event: $event })" />
        <input ref="directoryInput" type="file" webkitdirectory multiple tabindex="-1" :aria-label="lazyStrings.llamaCppBrowser__choose_model_folder()" data-testid="llama-cpp-browser-directory" tw-class="sr-only" @change="importDirectory({ event: $event })" />
        <button type="button" data-testid="llama-cpp-browser-choose-directory" tw-class="inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-bold rounded-xl bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 text-purple-600 dark:text-purple-400 border border-gray-200 dark:border-gray-700 shadow-sm focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-purple-500/20 transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed" @click="directoryInput?.click()"><FolderOpenIcon tw-class="w-4 h-4" />{{ lazyStrings.llamaCppBrowser__choose_model_folder() }}</button>
        <button type="button" data-testid="llama-cpp-browser-choose-files" tw-class="inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-bold rounded-xl bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 text-purple-600 dark:text-purple-400 border border-gray-200 dark:border-gray-700 shadow-sm focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-purple-500/20 transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed" @click="fileInput?.click()">
          <FolderOpenIcon tw-class="w-4 h-4" />{{ lazyStrings.llamaCppBrowser__choose_gguf_files() }}
        </button>
      </div>
    </fieldset>
    <p v-if="removalChanged" role="alert" data-testid="llama-removal-changed" tw-class="text-xs text-red-500">{{ lazyStrings.llamaCppBrowser__files_changed_review_before_deleting() }}</p>
    <div v-if="active" tw-class="rounded-2xl border border-purple-100 dark:border-purple-900/30 p-4 space-y-3">
      <LlamaCppBrowserLoadingIndicator scope="import" />
      <div tw-class="flex justify-end"><button type="button" data-testid="llama-cpp-browser-cancel" tw-class="px-3 py-1.5 rounded-lg text-xs font-bold text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors" @click="cancel">{{ lazyStrings.SHARED__cancel() }}</button></div>
    </div>
    <div v-if="displayedError" role="alert" tw-class="flex items-start gap-3 rounded-2xl p-4 border border-red-100 dark:border-red-900/30 bg-red-50 dark:bg-red-900/10 text-red-700 dark:text-red-400">
      <AlertCircleIcon tw-class="w-4 h-4 shrink-0 mt-0.5" /><div tw-class="text-xs space-y-1"><p>{{ displayedError === 'invalid-gguf' ? lazyStrings.llamaCppBrowser__gguf_files_only() : lazyStrings.llamaCppBrowser__operation_failed() }}</p><code tw-class="font-mono">{{ displayedError }}</code></div>
    </div>
    <!-- Privacy: bundled suggestions render without external I/O. Only explicit
         inspect/download actions (or a model-preset URL) authorize Hugging Face. -->
    <LlamaCppBrowserModelSuggestions :models="models" :disabled="unavailable || active !== undefined || refreshing" :default-model="defaultModel" :default-action-disabled="defaultActionDisabled" @select-default="defaultSelection = $event" />
    <section tw-class="space-y-4">
      <div tw-class="flex items-center justify-between gap-3 pb-3 border-b border-gray-100 dark:border-gray-800">
        <h3 tw-class="flex items-center gap-2 text-sm font-bold text-gray-800 dark:text-white"><HardDriveIcon tw-class="w-4 h-4 text-purple-500" />{{ lazyStrings.llamaCppBrowser__imported_models() }}<span tw-class="text-xs text-gray-400 tabular-nums">{{ nameFilter.trim() ? `${filteredModels.length} / ${models.length}` : models.length }}</span></h3>
        <button type="button" data-testid="llama-cpp-browser-refresh" :disabled="unavailable || active !== undefined || refreshing" :aria-label="lazyStrings.llamaCppBrowser__refresh_models()" :title="lazyStrings.llamaCppBrowser__refresh_models()" tw-class="p-2 rounded-xl text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-purple-600 dark:hover:text-purple-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors" @click="refresh"><RefreshCcwIcon :tw-class="['w-4 h-4', { 'animate-spin': refreshing }]" /></button>
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
            <LlamaCppBrowserDefaultModelAction :model="model" :current="defaultModel" :disabled="unavailable || active !== undefined || refreshing || defaultActionDisabled" @select="defaultSelection = $event" />
            <button type="button" :disabled="unavailable || active !== undefined || downloading || queuedDownloadBusy || refreshing" :data-testid="`llama-cpp-browser-delete-${model.id}`" :aria-label="lazyStrings.llamaCppBrowser__delete_model()" :title="lazyStrings.llamaCppBrowser__delete_model()" tw-class="p-2 rounded-xl text-gray-400 hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors" @click="remove({ id: model.id })"><Trash2Icon tw-class="w-4 h-4" /></button>
          </div>
        </li>
      </ul>
      <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.llamaCppBrowser__import_then_select() }}</p>
    </section>
    <section tw-class="rounded-2xl border border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/20 p-5 space-y-4">
      <h3 tw-class="flex items-center gap-2 text-sm font-bold text-gray-800 dark:text-white"><SlidersHorizontalIcon tw-class="w-4 h-4 text-purple-500" />{{ lazyStrings.llamaCppBrowser__inference_settings() }}</h3>
      <fieldset :disabled="unavailable || busy" tw-class="grid grid-cols-1 sm:grid-cols-2 gap-4 disabled:opacity-50">
        <div tw-class="space-y-2">
          <label :for="`${id}-profile`" tw-class="block text-xs font-bold text-gray-500 dark:text-gray-400">{{ lazyStrings.llamaCppBrowser__profile() }}</label>
          <div tw-class="relative"><select :id="`${id}-profile`" v-model="options.profile" :disabled="profileState.status === 'checking'" data-testid="llama-cpp-browser-profile" tw-class="appearance-none block w-full pl-3 pr-9 py-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm font-medium text-gray-800 dark:text-gray-100 focus:ring-4 focus:ring-purple-500/10 outline-none transition-all" @change="applyOptions">
            <option v-for="choice in profileChoices" :key="choice.profile" :value="choice.profile" :disabled="choice.disabled">{{ choice.label }}<template v-if="choice.reason"> — {{ choice.reason }}</template></option>
          </select><ChevronDownIcon tw-class="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" /></div>
        </div>
      </fieldset>
      <p v-if="profileState.status === 'checking'" role="status" data-testid="llama-cpp-browser-profile-checking" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.llamaCppBrowser__checking_browser_support() }}</p>
      <p v-else-if="profileState.status === 'ready' && selectedProfile === undefined" role="status" tw-class="text-xs text-amber-600 dark:text-amber-400">{{ lazyStrings.llamaCppBrowser__no_compatible_runtime() }}</p>
      <p v-else-if="selectedFailure" role="status" data-testid="llama-cpp-browser-profile-unavailable" tw-class="text-xs text-amber-600 dark:text-amber-400">{{ lazyStrings.llamaCppBrowser__unavailable_feature({ feature: profileFeatures[selectedFailure] }) }}</p>
      <p v-else-if="profileState.status === 'error'" role="alert" tw-class="text-xs text-red-500">{{ lazyStrings.llamaCppBrowser__operation_failed() }}</p>
      <button v-if="profileState.status !== 'checking' && !runtimeReady" type="button" data-testid="llama-cpp-browser-probe-profiles" tw-class="text-xs text-purple-600 dark:text-purple-400" @click="probeProfiles">{{ lazyStrings.llamaCppBrowser__check_browser_support() }}</button>
      <div tw-class="flex flex-col sm:flex-row sm:items-center gap-3 pt-3 border-t border-gray-100 dark:border-gray-800"><p tw-class="text-xs text-gray-500 dark:text-gray-400 flex-1">{{ lazyStrings.llamaCppBrowser__image_chat_requires_matching_projector() }}</p><button type="button" :disabled="unavailable || active !== undefined" data-testid="llama-cpp-browser-release" tw-class="inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-bold rounded-xl text-gray-500 hover:text-purple-600 dark:hover:text-purple-400 hover:bg-white dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors" @click="llamaCppBrowserService.release()"><PowerOffIcon tw-class="w-4 h-4" />{{ lazyStrings.llamaCppBrowser__release_runtime() }}</button></div>
    </section>
  </section>
  <LlamaCppBrowserDefaultModelDialog :model="defaultSelection" :current="defaultModel" :models="models" :apply="applyConfirmedDefault" @close="defaultSelection = undefined" />
  <LlamaCppBrowserDeletionDialog :request="deletionRequest" @confirm="finishDeletion({ plan: $event })" @cancel="finishDeletion({ plan: undefined })" />
</template>
