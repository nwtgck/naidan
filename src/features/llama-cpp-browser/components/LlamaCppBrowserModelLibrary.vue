<script setup lang="ts">
import { getHostModelInventoryIssues, type HostModelInventoryIssue } from '@/features/llama-cpp-browser/runtime/host-model-store';
import LlamaCppBrowserDefaultModelDialog from './LlamaCppBrowserDefaultModelDialog.vue';
import type { ApplyDefaultModel, DefaultModelContext } from '@/features/llama-cpp-browser/default-model';
import LlamaCppBrowserDeletionDialog from './LlamaCppBrowserDeletionDialog.vue';
import { useModelRemoval } from '@/features/llama-cpp-browser/composables/useModelRemoval';
import { computed, onMounted, onUnmounted, ref, shallowRef, watch, useSlots } from 'vue';
import { AlertCircleIcon, CheckIcon, HardDriveIcon, Loader2Icon, RefreshCcwIcon, SearchIcon, XIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import { llamaCppBrowserModelFiles } from '@/features/llama-cpp-browser/model-files';
import { errorCode, type LocalModel, type ErrorCode } from '@/features/llama-cpp-browser/types';
import LlamaCppBrowserModelImport from './LlamaCppBrowserModelImport.vue';
import LlamaCppBrowserImportedModelRow from './LlamaCppBrowserImportedModelRow.vue';
import { listModelInventory, type ModelInventorySource } from '@/features/llama-cpp-browser/composables/model-inventory';
import { useRecentModelImports } from '@/features/llama-cpp-browser/composables/useRecentModelImports';

// Suspension is opt-in: an omitted Boolean prop is false in Vue. It must not
// disable model management in onboarding or other callers without this prop.
const props = defineProps<{ suspended?: boolean, inventory?: ModelInventorySource, externalBusy?: boolean, runtimeStatus?: 'idle' | 'working' | 'unavailable', defaultModel?: DefaultModelContext, applyDefaultModel?: ApplyDefaultModel, createChatGroup?: ({ model, signal }: { model: LocalModel, signal: AbortSignal }) => Promise<void> }>();
const emit = defineEmits<{ modelsChanged: [models: LocalModel[]], modelSelected: [modelId: string] }>();
const slots = useSlots();
defineSlots<{
  'model-actions'({ model, disabled }: { model: LocalModel, disabled: boolean }): unknown,
  header({ disabled, busy, refresh, selectReadyModel, invalidateModelSelection }: { disabled: boolean, busy: boolean, refresh: () => Promise<void>, selectReadyModel: ({ model }: { model: LocalModel }) => Promise<void>, invalidateModelSelection: () => void }): unknown,
  suggestions({ models, disabled, createChatGroup, creatingChatGroupModelId, selectDefault, refresh }: { models: LocalModel[], disabled: boolean, createChatGroup: (({ model }: { model: LocalModel }) => Promise<void>) | undefined, creatingChatGroupModelId: string | undefined, selectDefault: ({ model }: { model: LocalModel }) => void, refresh: () => Promise<void> }): unknown,
  footer({ disabled, releaseDisabled }: { disabled: boolean, releaseDisabled: boolean }): unknown,
}>();
const ownedModels = ref<LocalModel[]>([]);
const models = computed(() => props.inventory?.models ?? ownedModels.value);
const { recentModels, dismiss: dismissRecentModels } = useRecentModelImports();

const modelFilter = ref('');
const filteredModels = computed(() => {
  const query = modelFilter.value.trim().toLocaleLowerCase();
  return query ? models.value.filter(model => [model.modelId, model.source?.directoryName, model.source?.repository, model.source?.primaryRelativePath].some(value => value?.toLocaleLowerCase().includes(query))) : models.value;
});
const defaultSelection = shallowRef<LocalModel>();
const queuedDownloadBusy = computed(() => props.externalBusy === true);
const defaultActionDisabled = computed(() => !props.defaultModel || !props.applyDefaultModel);

const applyConfirmedDefault: ApplyDefaultModel = async ({ model, previous }) => {
  // Revalidate locally after confirmation: another tab may have removed it.
  // This check must not contact Hugging Face or initialize the model runtime.
  const selectionVersion = modelSelectionVersion;
  await refresh();
  const available = models.value.find(entry => entry.modelId === model.modelId);
  if (disposed || props.suspended || selectionVersion !== modelSelectionVersion || listError.value || !available || !props.applyDefaultModel) {
    throw new Error('Local model unavailable');
  }
  return props.applyDefaultModel({ model: available, previous });
};

const ownedListError = ref<ErrorCode>();
const listError = computed(() => props.inventory === undefined ? ownedListError.value : props.inventory.error);
const ownedHostIssues = ref<readonly HostModelInventoryIssue[]>([]);
const hostIssues = computed(() => props.inventory?.hostIssues ?? ownedHostIssues.value);
watch(() => props.inventory?.models, found => {
  if (found !== undefined) {
    emit('modelsChanged', found);
  }
}, { immediate: true });
const creatingChatGroup = shallowRef<{ modelId: string, controller: AbortController }>();
const chatGroupCreationFailed = ref(false);
const ownedRefreshing = ref(false);
const refreshing = computed(() => props.inventory?.refreshing ?? ownedRefreshing.value);
const downloading = computed(() => props.externalBusy === true);
const importing = ref(false);
const unavailable = computed(() => props.runtimeStatus === 'unavailable');
const busy = computed(() => active.value !== undefined || creatingChatGroup.value !== undefined || importing.value || downloading.value || queuedDownloadBusy.value || props.runtimeStatus === 'working');
const { active, error: localError, changed: removalChanged, request: deletionRequest, finish: finishDeletion, remove } = useModelRemoval({
  suspended: computed(() => props.suspended === true || unavailable.value),
  disabled: computed(() => creatingChatGroup.value !== undefined || importing.value || downloading.value || queuedDownloadBusy.value || refreshing.value),
  refresh,
});
const displayedError = computed(() => localError.value ?? listError.value);
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
  creatingChatGroup.value = { modelId: model.modelId, controller };
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
  if (props.inventory !== undefined) {
    return props.inventory.refresh();
  }
  refreshRequested = true;
  if (refreshPromise) {
    return refreshPromise;
  }
  const controller = new AbortController();
  refreshController = controller;
  ownedRefreshing.value = true;
  // Defer execution until refreshPromise is assigned, including synchronous failures.
  refreshPromise = Promise.resolve().then(async () => {
    while (refreshRequested && !disposed && !props.suspended && !controller.signal.aborted) {
      refreshRequested = false;
      ownedListError.value = undefined;
      try {
        const found = await listModelInventory({ signal: controller.signal });
        if (!disposed && !props.suspended && !controller.signal.aborted && !refreshRequested) {
          ownedModels.value = found;
          ownedHostIssues.value = [...getHostModelInventoryIssues()];
          emit('modelsChanged', found);
        }
      } catch (error) {
        if (!disposed && !props.suspended && !controller.signal.aborted) {
          ownedListError.value = errorCode({ error });
        }
      }
    }
  }).finally(() => {
    ownedRefreshing.value = false;
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
  const available = models.value.find(entry => entry.modelId === model.modelId);
  if (available) {
    emit('modelSelected', available.modelId);
  }
}

function invalidateModelSelection(): void {
  modelSelectionVersion++;
}

function selectDefault({ model }: { model: LocalModel }): void {
  defaultSelection.value = model;
}

watch(() => props.suspended, suspended => {
  if (suspended) {
    modelSelectionVersion++;
    defaultSelection.value = undefined;
    creatingChatGroup.value?.controller.abort();
    refreshRequested = false;
    refreshController?.abort();
  } else if (props.inventory === undefined) {
    void refresh();
  }
});

function refreshOnFocus(): void {
  void refresh();
}

onMounted(() => {
  // Prepared discovery tabs share their owner's live inventory. Mounting or
  // revealing them must not launch another filesystem scan.
  if (props.inventory !== undefined) {
    return;
  }
  window.addEventListener('focus', refreshOnFocus);
  unsubscribeModels = llamaCppBrowserModelFiles.subscribeModelList({
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
  creatingChatGroup.value?.controller.abort();
  refreshController?.abort();
  unsubscribeModels?.();
});
defineExpose({ refresh, selectReadyModel, invalidateModelSelection, ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <section tw-class="space-y-5" data-testid="llama-cpp-browser-model-library">
    <div v-if="unavailable" tw-class="flex items-start gap-3 p-5 rounded-2xl border border-amber-100 dark:border-amber-900/30 bg-amber-50 dark:bg-amber-900/10 text-sm text-amber-700 dark:text-amber-400" data-testid="llama-cpp-browser-unavailable">
      <AlertCircleIcon tw-class="w-5 h-5 shrink-0 mt-0.5" />
      <p>{{ lazyStrings.llamaCppBrowser__operation_failed() }}</p>
    </div>
    <slot name="header" :disabled="props.suspended || unavailable || importing || active !== undefined || creatingChatGroup !== undefined || refreshing" :busy="busy" :refresh="refresh" :select-ready-model="selectReadyModel" :invalidate-model-selection="invalidateModelSelection" />
    <LlamaCppBrowserModelImport :disabled="props.suspended || unavailable || busy" @busy="importing = $event" @changed="refresh" />
    <p v-if="removalChanged" role="alert" data-testid="llama-removal-changed" tw-class="text-xs text-red-500">{{ lazyStrings.llamaCppBrowser__files_changed_review_before_deleting() }}</p>
    <div v-if="displayedError" role="alert" tw-class="flex items-start gap-3 rounded-2xl p-4 border border-red-100 dark:border-red-900/30 bg-red-50 dark:bg-red-900/10 text-red-700 dark:text-red-400">
      <AlertCircleIcon tw-class="w-4 h-4 shrink-0 mt-0.5" /><div tw-class="text-xs space-y-1"><p>{{ displayedError === 'invalid-gguf' ? lazyStrings.llamaCppBrowser__gguf_files_only() : lazyStrings.llamaCppBrowser__operation_failed() }}</p><code tw-class="font-mono">{{ displayedError }}</code></div>
    </div>
    <p v-if="chatGroupCreationFailed" role="alert" data-testid="llama-cpp-browser-create-chat-group-error" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.LlamaCppBrowserModelLibrary__could_not_create_or_open_chat_group() }}</p>
    <slot name="suggestions" :models="models" :disabled="props.suspended || unavailable || importing || active !== undefined || creatingChatGroup !== undefined || refreshing" :create-chat-group="props.createChatGroup ? handleCreateChatGroup : undefined" :creating-chat-group-model-id="creatingChatGroup?.modelId" :select-default="selectDefault" :refresh="refresh" />
    <section v-if="recentModels.length" data-testid="llama-recent-imports" tw-class="space-y-2 rounded-2xl border border-blue-100 bg-blue-50/30 p-3 dark:border-blue-500/20 dark:bg-blue-500/5">
      <div tw-class="flex items-center justify-between gap-3">
        <h3 tw-class="inline-flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-100"><CheckIcon aria-hidden="true" tw-class="h-4 w-4 text-blue-500 dark:text-blue-400" />{{ lazyStrings.LlamaCppBrowserModelLibrary__just_added_models() }}<span tw-class="text-xs font-normal tabular-nums text-gray-400">{{ recentModels.length }}</span></h3>
        <button type="button" :aria-label="lazyStrings.LlamaCppBrowserModelLibrary__dismiss_just_added_models()" :title="lazyStrings.LlamaCppBrowserModelLibrary__dismiss_just_added_models()" data-testid="llama-dismiss-recent-imports" tw-class="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-gray-400 transition-colors hover:bg-blue-100/50 hover:text-gray-700 focus-visible:outline-2 focus-visible:outline-blue-500 dark:hover:bg-blue-500/10 dark:hover:text-gray-200" @click="dismissRecentModels"><XIcon aria-hidden="true" tw-class="h-3.5 w-3.5" /></button>
      </div>
      <ul tw-class="space-y-2">
        <LlamaCppBrowserImportedModelRow v-for="model in recentModels" :key="model.modelId" :model="model" :default-model="defaultModel" :disabled="props.suspended || unavailable || importing || active !== undefined || creatingChatGroup !== undefined || refreshing" :removal-disabled="props.suspended || unavailable || importing || active !== undefined || creatingChatGroup !== undefined || downloading || queuedDownloadBusy || refreshing" :default-action-disabled="defaultActionDisabled" :chat-group-action="props.createChatGroup ? 'available' : 'unavailable'" :creating="creatingChatGroup?.modelId === model.modelId" @create-chat-group="handleCreateChatGroup({ model })" @select-default="selectDefault({ model: $event })" @remove="remove({ modelId: model.modelId })"><template v-if="slots['model-actions']" #actions="{ disabled }"><slot name="model-actions" :model="model" :disabled="disabled" /></template></LlamaCppBrowserImportedModelRow>
      </ul>
    </section>
    <section tw-class="space-y-4">
      <div tw-class="flex items-center justify-between gap-3 pb-3 border-b border-gray-100 dark:border-gray-800">
        <h3 tw-class="flex items-center gap-2 text-sm font-bold text-gray-800 dark:text-white"><HardDriveIcon tw-class="w-4 h-4 text-blue-500" />{{ lazyStrings.llamaCppBrowser__imported_models() }}<span tw-class="text-xs text-gray-400 tabular-nums">{{ modelFilter.trim() ? `${filteredModels.length} / ${models.length}` : models.length }}</span></h3>
        <button type="button" data-testid="llama-cpp-browser-refresh" :disabled="props.suspended || unavailable || importing || active !== undefined || creatingChatGroup !== undefined || refreshing" :aria-label="lazyStrings.llamaCppBrowser__refresh_models()" :title="lazyStrings.llamaCppBrowser__refresh_models()" tw-class="p-2 rounded-xl text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-blue-600 dark:hover:text-blue-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors" @click="refresh"><RefreshCcwIcon :tw-class="['w-4 h-4', { 'animate-spin': refreshing }]" /></button>
      </div>
      <div tw-class="relative">
        <SearchIcon tw-class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
        <input v-model="modelFilter" type="search" data-testid="llama-imported-model-search" :aria-label="lazyStrings.LlamaCppBrowserModelLibrary__search_models()" :placeholder="lazyStrings.LlamaCppBrowserModelLibrary__search_models()" tw-class="w-full pl-9 pr-10 py-2.5 text-xs rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 outline-none focus:ring-4 focus:ring-blue-500/10 focus:border-blue-400 transition-colors" />
        <button v-if="modelFilter" type="button" data-testid="llama-imported-model-clear-search" :aria-label="lazyStrings.llamaCppBrowserDownloads__clear_search()" tw-class="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-lg text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800" @click="modelFilter = ''"><XIcon tw-class="w-4 h-4" /></button>
      </div>
      <ul v-if="hostIssues.length" data-testid="llama-host-model-inventory-issues" tw-class="space-y-1 text-xs text-amber-700 dark:text-amber-400">
        <li v-for="issue in hostIssues" :key="issue.directoryId">{{ issue.directoryName }}: {{ issue.message }} · {{ lazyStrings.LlamaCppBrowserDownloadDestination__reconnect_in_folder_settings() }}</li>
      </ul>
      <p v-if="refreshing && models.length === 0" role="status" data-testid="llama-cpp-browser-list-loading" tw-class="flex items-center justify-center gap-2 py-8 text-xs text-gray-500"><Loader2Icon tw-class="w-4 h-4 animate-spin" />{{ lazyStrings.llamaCppBrowser__loading_model_list() }}</p>
      <div v-else-if="models.length === 0" tw-class="rounded-2xl border border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/20 p-6 text-center text-sm text-gray-500 dark:text-gray-400"><p>{{ lazyStrings.llamaCppBrowser__no_imported_models() }}</p></div>
      <p v-else-if="filteredModels.length === 0" role="status" data-testid="llama-imported-model-no-results" tw-class="py-6 text-center text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.llamaCppBrowserDownloads__no_matching_models() }}</p>
      <ul v-else data-testid="llama-cpp-browser-model-list" tw-class="space-y-2">
        <LlamaCppBrowserImportedModelRow v-for="model in filteredModels" :key="model.modelId" :model="model" :default-model="defaultModel" :disabled="props.suspended || unavailable || importing || active !== undefined || creatingChatGroup !== undefined || refreshing" :removal-disabled="props.suspended || unavailable || importing || active !== undefined || creatingChatGroup !== undefined || downloading || queuedDownloadBusy || refreshing" :default-action-disabled="defaultActionDisabled" :chat-group-action="props.createChatGroup ? 'available' : 'unavailable'" :creating="creatingChatGroup?.modelId === model.modelId" @create-chat-group="handleCreateChatGroup({ model })" @select-default="selectDefault({ model: $event })" @remove="remove({ modelId: model.modelId })"><template v-if="slots['model-actions']" #actions="{ disabled }"><slot name="model-actions" :model="model" :disabled="disabled" /></template></LlamaCppBrowserImportedModelRow>
      </ul>
      <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.llamaCppBrowser__import_then_select() }}</p>
    </section>
    <slot name="footer" :disabled="unavailable || busy" :release-disabled="unavailable || active !== undefined || creatingChatGroup !== undefined || importing" />
  </section>
  <LlamaCppBrowserDefaultModelDialog :model="defaultSelection" :current="defaultModel" :apply="applyConfirmedDefault" @close="defaultSelection = undefined" />
  <LlamaCppBrowserDeletionDialog :request="deletionRequest" @confirm="finishDeletion({ plan: $event })" @cancel="finishDeletion({ plan: undefined })" />
</template>
