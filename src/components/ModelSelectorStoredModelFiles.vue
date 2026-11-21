<script setup lang="ts">
import { ref, shallowRef, watch } from 'vue';
import { FileIcon, FolderOpenIcon, FolderTreeIcon } from 'lucide-vue-next';
import { ensureStrings, lazyStrings } from '@/strings';
import { useFileExplorerModal } from '@/features/file-explorer/composables/useFileExplorerModal';
import type { ResolvedModel } from '@/features/llama-cpp-browser/runtime/model-directory';

const props = defineProps<{ modelId: string }>();
const emit = defineEmits<{ openFileExplorer: [] }>();
const { openFileExplorer } = useFileExplorerModal();
const resolved = shallowRef<ResolvedModel>();
const status = ref<'loading' | 'ready' | 'unavailable'>('loading');
const opening = ref<'folder' | 'models'>();
const openFailed = ref(false);
let activeSignal: AbortSignal;

watch(() => props.modelId, async (modelId, _oldModelId, onCleanup) => {
  const controller = new AbortController();
  const { signal } = controller;
  activeSignal = signal;
  onCleanup(() => controller.abort());
  resolved.value = undefined;
  status.value = 'loading';
  opening.value = undefined;
  openFailed.value = false;
  try {
    const { llamaCppBrowserModelFiles } = await import('@/features/llama-cpp-browser/model-files');
    const model = await llamaCppBrowserModelFiles.inspectModelFiles({ modelId, signal });
    if (!signal.aborted) {
      resolved.value = model;
      status.value = 'ready';
    }
  } catch {
    if (!signal.aborted) {
      status.value = 'unavailable';
    }
  }
}, { immediate: true });

async function open({ view }: { view: 'folder' | 'models' }): Promise<void> {
  const model = resolved.value;
  if (!model || opening.value !== undefined) {
    return;
  }
  const signal = activeSignal;
  opening.value = view;
  openFailed.value = false;
  try {
    const { createModelFileExplorerOptions, refreshModelFiles } = await import('@/features/llama-cpp-browser/model-file-explorer');
    const options = await createModelFileExplorerOptions({ model, view, title: await ensureStrings.ModelSelectorStoredModelFiles__model_folders(), signal });
    signal.throwIfAborted();
    // Release the selector's native dialog before opening the Explorer overlay.
    emit('openFileExplorer');
    openFileExplorer({ options, onClose: refreshModelFiles });
  } catch {
    if (!signal.aborted) {
      openFailed.value = true;
    }
  } finally {
    if (!signal.aborted) {
      opening.value = undefined;
    }
  }
}

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {},
  }) || {}),
});
</script>

<template>
  <div tw-class="space-y-1.5 pb-1.5 text-[11px] text-gray-500 dark:text-gray-400" data-testid="model-selector-stored-model-files">
    <p v-if="status === 'loading'" role="status">{{ lazyStrings.ModelSelectorStoredModelFiles__checking_model_files() }}</p>
    <p v-else-if="status === 'unavailable'" role="status">{{ lazyStrings.ModelSelectorStoredModelFiles__could_not_find_model_files() }}</p>
    <template v-else-if="resolved">
      <p tw-class="font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.ModelSelectorStoredModelFiles__model_files() }}</p>
      <ul tw-class="max-h-28 space-y-1 overflow-y-auto">
        <li v-for="file in resolved.directory.files" :key="file.relativePath" :title="file.relativePath" tw-class="flex min-w-0 items-baseline gap-1.5">
          <FileIcon aria-hidden="true" tw-class="size-3 shrink-0 self-center" />
          <span tw-class="min-w-0 break-all">{{ file.relativePath }}</span>
        </li>
      </ul>
      <div tw-class="flex flex-wrap gap-x-3 gap-y-1">
        <button v-if="resolved.location.kind !== 'temp' && (resolved.location.kind !== 'local-files' || resolved.location.savedRootName !== undefined)" type="button" :disabled="opening !== undefined" data-testid="model-selector-open-model-folder" tw-class="inline-flex items-center gap-1.5 rounded py-1 font-medium hover:text-gray-900 focus-visible:outline-2 focus-visible:outline-blue-500 dark:hover:text-gray-100" @click="open({ view: 'folder' })">
          <FolderOpenIcon aria-hidden="true" tw-class="size-3.5" />
          {{ lazyStrings.ModelSelectorStoredModelFiles__open_storage_folder() }}
        </button>
        <button type="button" :disabled="opening !== undefined" data-testid="model-selector-open-model-folders" tw-class="inline-flex items-center gap-1.5 rounded py-1 font-medium hover:text-gray-900 focus-visible:outline-2 focus-visible:outline-blue-500 dark:hover:text-gray-100" @click="open({ view: 'models' })">
          <FolderTreeIcon aria-hidden="true" tw-class="size-3.5" />
          {{ lazyStrings.ModelSelectorStoredModelFiles__browse_by_model_id() }}
        </button>
      </div>
      <p v-if="openFailed" role="alert">{{ lazyStrings.ModelSelectorStoredModelFiles__could_not_open_model_folder() }}</p>
    </template>
  </div>
</template>
