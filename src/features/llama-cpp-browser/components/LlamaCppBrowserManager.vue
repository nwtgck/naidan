<script setup lang="ts">
import { getHostModelInventoryIssues, type HostModelInventoryIssue } from '@/features/llama-cpp-browser/runtime/host-model-store';
import LlamaCppBrowserModelSuggestions from './LlamaCppBrowserModelSuggestions.vue';
import LlamaCppBrowserDefaultModelAction from './LlamaCppBrowserDefaultModelAction.vue';
import LlamaCppBrowserModelAction from './LlamaCppBrowserModelAction.vue';
import LlamaCppBrowserDefaultModelDialog from './LlamaCppBrowserDefaultModelDialog.vue';
import type { ApplyDefaultModel, DefaultModelContext } from '@/features/llama-cpp-browser/default-model';
import { getDownloadQueue, jobIsBusy } from '@/features/llama-cpp-browser/hugging-face/download-queue';
import LlamaCppBrowserDeletionDialog from './LlamaCppBrowserDeletionDialog.vue';
import { useModelDeletionConfirm } from './useModelDeletionConfirm';
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import { AlertCircleIcon, BrainCircuitIcon, ChevronDownIcon, HardDriveIcon, Loader2Icon, RefreshCcwIcon, Trash2Icon, SearchIcon, XIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import { llamaCppBrowserService } from '@/features/llama-cpp-browser';
import { errorCode, type EngineState, type LocalModel, type ErrorCode } from '@/features/llama-cpp-browser/types';
import LlamaCppBrowserHuggingFaceManager from './LlamaCppBrowserHuggingFaceManager.vue';
import LlamaCppBrowserModelImport from './LlamaCppBrowserModelImport.vue';
import LlamaCppBrowserRuntimeSettings from './LlamaCppBrowserRuntimeSettings.vue';

import type { ModelPreset } from '@/features/llama-cpp-browser/model-preset';
// Suspension is opt-in: an omitted Boolean prop is false in Vue. It must not
// disable model management in onboarding or other callers without this prop.
const props = defineProps<{ suspended?: boolean, suggestions?: 'chat' | 'none', modelPreset?: ModelPreset, defaultModel?: DefaultModelContext, applyDefaultModel?: ApplyDefaultModel, createChatGroup?: ({ model, signal }: { model: LocalModel, signal: AbortSignal }) => Promise<void> }>();
const repositoryManager = ref<InstanceType<typeof LlamaCppBrowserHuggingFaceManager>>();

async function inspectRepository({ input }: { input: string }): Promise<void> {
  if (unavailable.value || active.value || creatingChatGroup.value || importing.value || refreshing.value) {
    return;
  }
  await repositoryManager.value?.inspectRepository({ input });
}

defineSlots<{ catalog({ disabled, inspect }: { disabled: boolean, inspect: typeof inspectRepository }): unknown }>();
const emit = defineEmits<{ modelsChanged: [models: LocalModel[]], modelSelected: [name: string], runtimeReady: [ready: boolean] }>();
const state = shallowRef<EngineState>(llamaCppBrowserService.getState());
const models = ref<LocalModel[]>([]);

const nameFilter = ref('');
const filteredModels = computed(() => {
  const query = nameFilter.value.trim().toLocaleLowerCase();
  return query ? models.value.filter(model => [model.name, model.source?.directoryName, model.source?.repository, model.source?.path].some(value => value?.toLocaleLowerCase().includes(query))) : models.value;
});
const defaultSelection = shallowRef<LocalModel>();
const queue = getDownloadQueue();
const queuedDownloadBusy = computed(() => queue.jobs.value.some(job => jobIsBusy({ job })));
const defaultActionDisabled = computed(() => !props.defaultModel || !props.applyDefaultModel);

const applyConfirmedDefault: ApplyDefaultModel = async ({ model, previous }) => {
  // Revalidate locally after confirmation: another tab may have removed it.
  // This check must not contact Hugging Face or initialize the model runtime.
  await refresh();
  const available = models.value.find(entry => entry.id === model.id);
  if (listError.value || !available || !props.applyDefaultModel) {
    throw new Error('Local model unavailable');
  }
  return props.applyDefaultModel({ model: available, previous });
};

const localError = ref<ErrorCode>();
const removalChanged = ref(false);
const listError = ref<ErrorCode>();
const hostIssues = ref<readonly HostModelInventoryIssue[]>([]);
const displayedError = computed(() => localError.value ?? listError.value);
const active = ref<AbortController>();
const creatingChatGroup = shallowRef<{ modelId: string, controller: AbortController }>();
const chatGroupCreationFailed = ref(false);
const refreshing = ref(false);
const downloading = ref(false);
const importing = ref(false);
const unavailable = computed(() => state.value.status === 'unavailable');
const busy = computed(() => active.value !== undefined || creatingChatGroup.value !== undefined || importing.value || downloading.value || queuedDownloadBusy.value || state.value.status === 'working');
const { request: deletionRequest, finish: finishDeletion, confirmRemoval } = useModelDeletionConfirm();
let unsubscribe: (() => void) | undefined;
let unsubscribeModels: (() => void) | undefined;
let refreshController: AbortController | undefined;
let refreshPromise: Promise<void> | undefined;
let refreshRequested = false;
let disposed = false;

async function handleCreateChatGroup({ model }: { model: LocalModel }): Promise<void> {
  if (disposed || props.suspended || unavailable.value || active.value || creatingChatGroup.value || importing.value || refreshing.value || !props.createChatGroup) {
    return;
  }
  const controller = new AbortController();
  creatingChatGroup.value = { modelId: model.id, controller };
  chatGroupCreationFailed.value = false;
  try {
    await props.createChatGroup({ model, signal: controller.signal });
  } catch {
    if (!disposed && !controller.signal.aborted) {
      chatGroupCreationFailed.value = true;
    }
  } finally {
    creatingChatGroup.value = undefined;
  }
}

function refresh(): Promise<void> {
  if (unavailable.value || disposed || props.suspended) {
    return Promise.resolve();
  }
  refreshRequested = true;
  if (refreshPromise) {
    return refreshPromise;
  }
  const controller = new AbortController();
  refreshController = controller;
  refreshing.value = true;
  // Defer execution until refreshPromise is assigned, including synchronous failures.
  refreshPromise = Promise.resolve().then(async () => {
    while (refreshRequested && !disposed && !props.suspended && !controller.signal.aborted) {
      refreshRequested = false;
      listError.value = undefined;
      try {
        const found = await llamaCppBrowserService.listModels({ signal: controller.signal });
        if (!disposed && !props.suspended && !controller.signal.aborted && !refreshRequested) {
          models.value = found;
          hostIssues.value = [...getHostModelInventoryIssues()];
          emit('modelsChanged', found);
        }
      } catch (error) {
        if (!disposed && !props.suspended && !controller.signal.aborted) {
          listError.value = errorCode({ error });
        }
      }
    }
  }).finally(() => {
    refreshing.value = false;
    refreshController = undefined;
    refreshPromise = undefined;
    // A list notification or resume can arrive before this cleanup. Resume must
    // drain its queued refresh even if the previous controller was aborted.
    return refreshRequested && !disposed && !props.suspended ? refresh() : undefined;
  });
  return refreshPromise;
}

let modelSelectionVersion = 0;

async function selectReadyModel({ model }: { model: LocalModel }): Promise<void> {
  const version = ++modelSelectionVersion;
  await refresh();
  if (disposed || props.suspended || version !== modelSelectionVersion) {
    return;
  }
  const available = models.value.find(entry => entry.id === model.id);
  if (available) {
    emit('modelSelected', available.name);
  }
}

async function remove({ id }: { id: string }): Promise<void> {
  if (disposed || unavailable.value || active.value || creatingChatGroup.value || importing.value || downloading.value || queuedDownloadBusy.value || refreshing.value) {
    return;
  }
  const controller = new AbortController();
  active.value = controller;
  localError.value = undefined;
  removalChanged.value = false;
  try {
    const plan = await confirmRemoval({ id });
    if (!plan || disposed || controller.signal.aborted) {
      return;
    }
    removalChanged.value = await llamaCppBrowserService.removeModel({ plan, signal: controller.signal }) === 'changed';
    await refresh();
  } catch (error) {
    if (!controller.signal.aborted) {
      localError.value = errorCode({ error });
    }
  } finally {
    active.value = undefined;
  }
}

function formatSize({ bytes }: { bytes: number }): string {
  if (bytes < 1024 ** 2) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  if (bytes < 1024 ** 3) {
    return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  }
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

watch(() => props.suspended, suspended => {
  if (suspended) {
    modelSelectionVersion++;
    creatingChatGroup.value?.controller.abort();
    refreshRequested = false;
    refreshController?.abort();
  } else {
    void refresh();
  }
});
watch(queue.changed, () => {
  void refresh();
});

function refreshOnFocus(): void {
  void refresh();
}

onMounted(() => {
  window.addEventListener('focus', refreshOnFocus);
  unsubscribe = llamaCppBrowserService.subscribe({
    listener: ({ state: next }) => {
      state.value = next;
    },
  });
  unsubscribeModels = llamaCppBrowserService.subscribeModelList({
    listener: () => {
      void refresh();
    },
  });
  // The authoritative list combines browser storage and linked folders on every mount, not module-local state.
  void refresh();
});
onUnmounted(() => {
  window.removeEventListener('focus', refreshOnFocus);
  disposed = true;
  emit('runtimeReady', false);
  active.value?.abort();
  creatingChatGroup.value?.controller.abort();
  refreshController?.abort();
  unsubscribe?.();
  unsubscribeModels?.();
});
defineExpose({ refresh, ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <section tw-class="space-y-5" data-testid="llama-cpp-browser-manager">
    <div v-if="unavailable" tw-class="flex items-start gap-3 p-5 rounded-2xl border border-amber-100 dark:border-amber-900/30 bg-amber-50 dark:bg-amber-900/10 text-sm text-amber-700 dark:text-amber-400" data-testid="llama-cpp-browser-unavailable">
      <AlertCircleIcon tw-class="w-5 h-5 shrink-0 mt-0.5" />
      <p>{{ lazyStrings.llamaCppBrowser__operation_failed() }}</p>
    </div>
    <slot name="catalog" :disabled="unavailable || importing || active !== undefined || creatingChatGroup !== undefined || refreshing || downloading" :inspect="inspectRepository" />
    <LlamaCppBrowserHuggingFaceManager ref="repositoryManager" :model-preset="props.modelPreset" :disabled="props.suspended || unavailable || importing || active !== undefined || creatingChatGroup !== undefined || refreshing" @busy="downloading = $event" @changed="refresh" @model-ready="selectReadyModel({ model: $event })" @selection-changed="modelSelectionVersion++" />
    <LlamaCppBrowserModelImport :disabled="unavailable || busy" @busy="importing = $event" @changed="refresh" />
    <p v-if="removalChanged" role="alert" data-testid="llama-removal-changed" tw-class="text-xs text-red-500">{{ lazyStrings.llamaCppBrowser__files_changed_review_before_deleting() }}</p>
    <div v-if="displayedError" role="alert" tw-class="flex items-start gap-3 rounded-2xl p-4 border border-red-100 dark:border-red-900/30 bg-red-50 dark:bg-red-900/10 text-red-700 dark:text-red-400">
      <AlertCircleIcon tw-class="w-4 h-4 shrink-0 mt-0.5" /><div tw-class="text-xs space-y-1"><p>{{ displayedError === 'invalid-gguf' ? lazyStrings.llamaCppBrowser__gguf_files_only() : lazyStrings.llamaCppBrowser__operation_failed() }}</p><code tw-class="font-mono">{{ displayedError }}</code></div>
    </div>
    <p v-if="chatGroupCreationFailed" role="alert" data-testid="llama-cpp-browser-create-chat-group-error" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.LlamaCppBrowserManager__could_not_create_or_open_chat_group() }}</p>
    <!-- Privacy: bundled suggestions render without external I/O. Only explicit
         inspect/download actions (or a model-preset URL) authorize Hugging Face. -->
    <LlamaCppBrowserModelSuggestions v-if="props.suggestions !== 'none'" :models="models" :disabled="props.suspended || unavailable || importing || active !== undefined || creatingChatGroup !== undefined || refreshing" :default-model="defaultModel" :default-action-disabled="defaultActionDisabled" :create-chat-group="props.createChatGroup ? handleCreateChatGroup : undefined" :creating-chat-group-model-id="creatingChatGroup?.modelId" @select-default="defaultSelection = $event" @changed="refresh" />
    <section tw-class="space-y-4">
      <div tw-class="flex items-center justify-between gap-3 pb-3 border-b border-gray-100 dark:border-gray-800">
        <h3 tw-class="flex items-center gap-2 text-sm font-bold text-gray-800 dark:text-white"><HardDriveIcon tw-class="w-4 h-4 text-blue-500" />{{ lazyStrings.llamaCppBrowser__imported_models() }}<span tw-class="text-xs text-gray-400 tabular-nums">{{ nameFilter.trim() ? `${filteredModels.length} / ${models.length}` : models.length }}</span></h3>
        <button type="button" data-testid="llama-cpp-browser-refresh" :disabled="unavailable || importing || active !== undefined || creatingChatGroup !== undefined || refreshing" :aria-label="lazyStrings.llamaCppBrowser__refresh_models()" :title="lazyStrings.llamaCppBrowser__refresh_models()" tw-class="p-2 rounded-xl text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-blue-600 dark:hover:text-blue-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors" @click="refresh"><RefreshCcwIcon :tw-class="['w-4 h-4', { 'animate-spin': refreshing }]" /></button>
      </div>
      <div tw-class="relative">
        <SearchIcon tw-class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
        <input v-model="nameFilter" type="search" data-testid="llama-imported-model-search" :aria-label="lazyStrings.llamaCppBrowserDownloads__search_model_names()" :placeholder="lazyStrings.llamaCppBrowserDownloads__search_model_names()" tw-class="w-full pl-9 pr-10 py-2.5 text-xs rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 outline-none focus:ring-4 focus:ring-blue-500/10 focus:border-blue-400 transition-colors" />
        <button v-if="nameFilter" type="button" data-testid="llama-imported-model-clear-search" :aria-label="lazyStrings.llamaCppBrowserDownloads__clear_search()" tw-class="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-lg text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800" @click="nameFilter = ''"><XIcon tw-class="w-4 h-4" /></button>
      </div>
      <ul v-if="hostIssues.length" data-testid="llama-host-model-inventory-issues" tw-class="space-y-1 text-xs text-amber-700 dark:text-amber-400">
        <li v-for="issue in hostIssues" :key="issue.directoryId">{{ issue.directoryName }}: {{ issue.message }} · {{ lazyStrings.LlamaCppBrowserDownloadDestination__reconnect_in_folder_settings() }}</li>
      </ul>
      <p v-if="refreshing && models.length === 0" role="status" data-testid="llama-cpp-browser-list-loading" tw-class="flex items-center justify-center gap-2 py-8 text-xs text-gray-500"><Loader2Icon tw-class="w-4 h-4 animate-spin" />{{ lazyStrings.llamaCppBrowser__loading_model_list() }}</p>
      <div v-else-if="models.length === 0" tw-class="rounded-2xl border border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/20 p-6 text-center text-sm text-gray-500 dark:text-gray-400"><p>{{ lazyStrings.llamaCppBrowser__no_imported_models() }}</p></div>
      <p v-else-if="filteredModels.length === 0" role="status" data-testid="llama-imported-model-no-results" tw-class="py-6 text-center text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.llamaCppBrowserDownloads__no_matching_models() }}</p>
      <ul v-else data-testid="llama-cpp-browser-model-list" tw-class="space-y-2">
        <li v-for="model in filteredModels" :key="model.id" tw-class="flex flex-wrap items-start gap-3 p-4 rounded-2xl border border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900/30">
          <div tw-class="w-9 h-9 rounded-xl bg-blue-50 dark:bg-blue-900/20 text-blue-500 flex items-center justify-center shrink-0"><BrainCircuitIcon tw-class="w-4 h-4" /></div>
          <div tw-class="min-w-0 flex-[1_1_10rem]">
            <p data-testid="llama-imported-model-name" :title="model.source?.path" tw-class="text-sm font-bold text-gray-800 dark:text-gray-100 break-all">{{ model.name }}</p>
            <details :data-testid="`llama-imported-model-details-${model.id}`" tw-class="group mt-1">
              <summary :data-testid="`llama-imported-model-details-toggle-${model.id}`" tw-class="flex flex-wrap items-center gap-x-3 gap-y-1 list-none cursor-pointer rounded text-[10px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
                <span tw-class="text-gray-400 font-mono tabular-nums">{{ formatSize({ bytes: model.size }) }} · GGUF</span>
                <span tw-class="inline-flex items-center gap-1 font-medium text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400">{{ lazyStrings.LlamaCppBrowserManager__details() }}<ChevronDownIcon aria-hidden="true" tw-class="w-3 h-3 shrink-0 transition-transform group-open:rotate-180" /></span>
              </summary>
              <div :data-testid="`llama-imported-model-details-content-${model.id}`" tw-class="mt-3 space-y-3 border-t border-gray-100 dark:border-gray-800 pt-3">
                <dl tw-class="space-y-2 text-xs">
                  <div><dt tw-class="text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserManager__model_name() }}</dt><dd data-testid="llama-imported-model-detail-name" tw-class="mt-0.5 break-all text-gray-700 dark:text-gray-200">{{ model.name }}</dd></div>
                  <template v-if="model.source">
                    <div><dt tw-class="text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserManager__folder() }}</dt><dd data-testid="llama-imported-model-detail-folder" tw-class="mt-0.5 break-all text-gray-700 dark:text-gray-200">{{ model.source.directoryName }}</dd></div>
                    <div><dt tw-class="text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserManager__repository() }}</dt><dd data-testid="llama-imported-model-detail-repository" tw-class="mt-0.5 break-all text-gray-700 dark:text-gray-200">{{ model.source.repository }}</dd></div>
                    <div><dt tw-class="text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserManager__file() }}</dt><dd data-testid="llama-imported-model-detail-file" tw-class="mt-0.5 break-all font-mono text-gray-700 dark:text-gray-200">{{ model.source.path }}</dd></div>
                  </template>
                </dl>
                <button type="button" :disabled="unavailable || importing || active !== undefined || creatingChatGroup !== undefined || downloading || queuedDownloadBusy || refreshing" :data-testid="`llama-cpp-browser-delete-${model.id}`" :aria-label="lazyStrings.llamaCppBrowser__delete_model()" :title="lazyStrings.llamaCppBrowser__delete_model()" tw-class="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors" @click="remove({ id: model.id })"><Trash2Icon aria-hidden="true" tw-class="w-3.5 h-3.5 shrink-0" />{{ lazyStrings.llamaCppBrowser__delete_model() }}</button>
              </div>
            </details>
          </div>
          <div tw-class="flex flex-wrap items-center justify-end gap-1 ml-auto">
            <LlamaCppBrowserModelAction v-if="props.createChatGroup" :model="model" :current="defaultModel" :disabled="props.suspended || unavailable || importing || active !== undefined || creatingChatGroup !== undefined || refreshing" :default-action-disabled="defaultActionDisabled" :creating="creatingChatGroup?.modelId === model.id" @create-chat-group="handleCreateChatGroup({ model })" @select-default="defaultSelection = $event" />
            <LlamaCppBrowserDefaultModelAction v-else :model="model" :current="defaultModel" :disabled="unavailable || importing || active !== undefined || creatingChatGroup !== undefined || refreshing || defaultActionDisabled" @select="defaultSelection = $event" />
          </div>
        </li>
      </ul>
      <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.llamaCppBrowser__import_then_select() }}</p>
    </section>
    <LlamaCppBrowserRuntimeSettings :disabled="unavailable || busy" :release-disabled="unavailable || active !== undefined || creatingChatGroup !== undefined || importing" @runtime-ready="emit('runtimeReady', $event)" />
  </section>
  <LlamaCppBrowserDefaultModelDialog :model="defaultSelection" :current="defaultModel" :models="models" :apply="applyConfirmedDefault" @close="defaultSelection = undefined" />
  <LlamaCppBrowserDeletionDialog :request="deletionRequest" @confirm="finishDeletion({ plan: $event })" @cancel="finishDeletion({ plan: undefined })" />
</template>
