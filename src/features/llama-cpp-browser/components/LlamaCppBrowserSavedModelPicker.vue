<script setup lang="ts">
import { computed, onUnmounted, ref, shallowRef, watch } from 'vue';
import { ArrowRightIcon, Loader2Icon, RefreshCcwIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import { listModelInventory } from '@/features/llama-cpp-browser/composables/model-inventory';
import { llamaCppBrowserModelFiles } from '@/features/llama-cpp-browser/model-files';
import { useModelRemoval } from '@/features/llama-cpp-browser/composables/useModelRemoval';
import LlamaCppBrowserDeletionDialog from './LlamaCppBrowserDeletionDialog.vue';
import LlamaCppBrowserModelActionButton from './LlamaCppBrowserModelActionButton.vue';
import LlamaCppBrowserModelRow from './LlamaCppBrowserModelRow.vue';
import type { LocalModel } from '@/features/llama-cpp-browser/types';

const props = defineProps<{ disabled: boolean }>();
const emit = defineEmits<{ select: [model: LocalModel], source: [tab: 'files' | 'hugging-face'] }>();
const models = shallowRef<LocalModel[]>([]);
const query = ref('');
const loading = ref(false);
const error = ref(false);
const removal = useModelRemoval({ suspended: computed(() => props.disabled), disabled: computed(() => loading.value), refresh });
const busy = computed(() => props.disabled || loading.value || removal.active.value !== undefined);
let controller: AbortController | undefined;
const filtered = computed(() => {
  const text = query.value.trim().toLocaleLowerCase();
  return models.value.filter(model => [model.modelId, model.source?.directoryName, model.source?.repository, model.source?.primaryRelativePath].some(value => value?.toLocaleLowerCase().includes(text)));
});

async function refresh(): Promise<void> {
  if (props.disabled) {
    return;
  }
  controller?.abort();
  const current = new AbortController();
  controller = current;
  loading.value = true;
  error.value = false;
  try {
    const found = await listModelInventory({ signal: current.signal });
    if (!current.signal.aborted) {
      models.value = found;
    }
  } catch {
    if (!current.signal.aborted) {
      error.value = true;
    }
  } finally {
    if (controller === current) {
      loading.value = false;
    }
  }
}

const unsubscribe = llamaCppBrowserModelFiles.subscribeModelList({
  listener: () => {
    void refresh();
  },
});
watch(() => props.disabled, disabled => {
  if (disabled) {
    controller?.abort();
  } else {
    void refresh();
  }
}, { immediate: true });
onUnmounted(() => {
  controller?.abort();
  unsubscribe();
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div data-testid="chat-saved-model-picker" tw-class="flex h-full min-h-0 flex-col gap-3 text-left">
    <div tw-class="flex items-center gap-2"><input v-model="query" type="search" data-testid="chat-saved-model-filter" :aria-label="lazyStrings.LlamaCppBrowserSavedModelPicker__filter_models()" :placeholder="lazyStrings.LlamaCppBrowserSavedModelPicker__filter_models()" tw-class="min-w-0 flex-1 rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-xs outline-none focus:ring-4 focus:ring-blue-500/10 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100" /><button type="button" :disabled="busy" :aria-label="lazyStrings.LlamaCppBrowserSavedModelPicker__refresh()" tw-class="grid h-9 w-9 place-items-center rounded-lg text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 focus-visible:outline-2 focus-visible:outline-blue-500" @click="refresh"><Loader2Icon v-if="loading" tw-class="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /><RefreshCcwIcon v-else tw-class="h-3.5 w-3.5" /></button></div>
    <p v-if="removal.changed.value" role="alert" data-testid="chat-model-removal-changed" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.llamaCppBrowser__files_changed_review_before_deleting() }}</p>
    <p v-if="removal.error.value" role="alert" data-testid="chat-model-removal-error" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.llamaCppBrowser__operation_failed() }}</p>
    <p v-if="error" role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.LlamaCppBrowserSavedModelPicker__could_not_read_models() }}</p>
    <p v-else-if="!loading && models.length === 0" tw-class="py-5 text-center text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserSavedModelPicker__no_saved_models_yet() }}</p>
    <div v-if="!loading && models.length === 0" tw-class="flex justify-center gap-3"><button type="button" tw-class="rounded-lg px-3 py-2 text-xs text-blue-600 hover:bg-gray-50 dark:text-blue-400 dark:hover:bg-gray-800" @click="emit('source', 'hugging-face')">{{ lazyStrings.LlamaCppBrowserSavedModelPicker__find_on_hugging_face() }}</button><button type="button" tw-class="rounded-lg px-3 py-2 text-xs text-gray-500 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-800" @click="emit('source', 'files')">{{ lazyStrings.LlamaCppBrowserSavedModelPicker__use_files() }}</button></div>
    <p v-if="loading && models.length === 0" role="status" tw-class="py-6 text-center text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.llamaCppBrowser__loading_model_list() }}</p>
    <p v-else-if="models.length && filtered.length === 0" role="status" tw-class="py-6 text-center text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.llamaCppBrowserDownloads__no_matching_models() }}</p>
    <ul :aria-label="lazyStrings.LlamaCppBrowserSavedModelPicker__available_models()" data-testid="chat-saved-model-list" tw-class="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain pb-1">
      <LlamaCppBrowserModelRow v-for="model in filtered" :key="model.modelId" :model="model" :removal-disabled="busy" :data-testid="`chat-saved-model-${model.modelId}`" @remove="removal.remove({ modelId: model.modelId })">
        <template #actions>
          <LlamaCppBrowserModelActionButton :data-testid="`chat-use-saved-model-${model.modelId}`" :disabled="busy" @click="emit('select', model)">{{ lazyStrings.SHARED__use_model_in_this_chat() }}<ArrowRightIcon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 text-gray-400 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-blue-500 dark:text-gray-500 dark:group-hover:text-blue-400 motion-reduce:transform-none" /></LlamaCppBrowserModelActionButton>
        </template>
      </LlamaCppBrowserModelRow>
    </ul>
  </div>
  <LlamaCppBrowserDeletionDialog :request="removal.request.value" @confirm="removal.finish({ plan: $event })" @cancel="removal.finish({ plan: undefined })" />
</template>
