<script setup lang="ts">
import type { LocalModelImportRequest } from '@/features/llama-cpp-browser/logic/local-model-input';
import { lazyStrings } from '@/strings';
import { computed, onScopeDispose, ref } from 'vue';
import { FilePlusIcon, FolderPlusIcon, Loader2Icon } from 'lucide-vue-next';
import LinkedModelDirectories from '@/components/LinkedModelDirectories.vue';
import LlamaCppBrowserLocalFiles from '@/features/llama-cpp-browser/components/LlamaCppBrowserLocalFiles.vue';
import { useModelDownloadDestination } from '@/features/llama-cpp-browser/composables/useModelDownloadDestination';
import { listModelInventory } from '@/features/llama-cpp-browser/composables/model-inventory';
import { llamaCppBrowserModelFiles } from '@/features/llama-cpp-browser/model-files';
import { LlamaCppBrowserError, type LocalModel } from '@/features/llama-cpp-browser/types';
import { splitModelName } from '@/utils/model-name';
import { localRepositories } from '@/features/llama-cpp-browser/runtime/local-repository-store';

const props = defineProps<{
  disabled: boolean,
  availableModelIds: readonly string[],
  selectedModelId?: string,
  importFiles?: ({ request }: { request: LocalModelImportRequest }) => Promise<{ models: readonly LocalModel[], skipped: readonly string[] }>,
}>();
const added = defineModel<readonly LocalModel[]>('added', { required: true });
const emit = defineEmits<{ choose: [model: LocalModel], 'inventory-changed': [] }>();
const mode = ref<'file' | 'linked_folder'>('file');
const importing = ref<AbortController>();
const failures = {
  empty_folder: () => lazyStrings.ModelSelectorFileImport__empty_folder(),
  folder_check_failed: () => lazyStrings.ModelSelectorFileImport__folder_check_failed(),
  no_models: () => lazyStrings.ModelSelectorFileImport__no_models(),
  import_failed: () => lazyStrings.ModelSelectorFileImport__import_failed(),
};
const failure = ref<keyof typeof failures>();
const failureDetail = ref<string>();
const skippedFiles = ref<string[]>([]);
const lifetime = new AbortController();
const linked = useModelDownloadDestination({
  blocked: () => props.disabled || importing.value !== undefined,
  changed: () => {},
  folderLinked: async ({ id }) => {
    failure.value = undefined;
    try {
      const inventory = await listModelInventory({ signal: lifetime.signal });
      const models = inventory.filter(model => model.source?.directoryId === id);
      if (models.length) {
        remember({ models });
        emit('inventory-changed');
      } else if (!lifetime.signal.aborted) {
        failure.value = 'empty_folder';
      }
    } catch {
      if (!lifetime.signal.aborted) {
        failure.value = 'folder_check_failed';
      }
    }
  },
});
const importModes = computed(() => [
  { id: 'file', label: lazyStrings.ModelSelectorFileImport__choose_files(), icon: FilePlusIcon },
  { id: 'linked_folder', label: lazyStrings.SHARED__model_import_link_folder(), icon: FolderPlusIcon },
] as const);

function remember({ models }: { models: readonly LocalModel[] }): void {
  if (!lifetime.signal.aborted) {
    added.value = [...new Map([...added.value, ...models].map(model => [model.modelId, model])).values()];
  }
}

// This tab remembers which models were added here. The live inventory owns
// their availability, including after File Explorer removes a GGUF or shard.
const availableAddedModels = computed(() => {
  const available = new Set(props.availableModelIds);
  const result = new Map<string, LocalModel>();
  for (const model of added.value) {
    const modelId = localRepositories.savedModelId({ modelId: model.modelId });
    if (available.has(modelId)) {
      result.set(modelId, { ...model, modelId });
    }
  }
  return [...result.values()];
});

async function accept({ request }: { request: LocalModelImportRequest }): Promise<void> {
  const { controller, directories, save } = request;
  if (props.disabled || importing.value || linked.linkedFolders.busy.value || lifetime.signal.aborted) {
    controller.abort();
    return;
  }
  importing.value = controller;
  failure.value = undefined;
  failureDetail.value = undefined;
  skippedFiles.value = [];
  let addedAny = false;
  try {
    if (props.importFiles) {
      const { models, skipped } = await props.importFiles({ request });
      skippedFiles.value = [...new Set([...skippedFiles.value, ...skipped])];
      controller.signal.throwIfAborted();
      if (!models.length) {
        failure.value = 'no_models';
      }
      remember({ models });
      addedAny = models.length > 0;
    } else {
      const inputs = await directories;
      if (!inputs.length) {
        throw new LlamaCppBrowserError({ code: 'unsupported-input' });
      }
      for (const directory of inputs) {
        controller.signal.throwIfAborted();
        const receipt = await llamaCppBrowserModelFiles.importLocalDirectory({ directory, save, signal: controller.signal });
        remember({ models: receipt.models.filter(model => receipt.publication.isCurrent({ modelId: model.modelId })) });
        addedAny ||= receipt.models.length > 0;
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      failure.value = 'import_failed';
      failureDetail.value = error instanceof Error ? error.message : undefined;
    }
  } finally {
    importing.value = undefined;
    if (addedAny && !lifetime.signal.aborted) {
      emit('inventory-changed');
    }
  }
}

onScopeDispose(() => {
  lifetime.abort();
  importing.value?.abort();
});


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
  <section data-testid="model-selector-file-import" tw-class="w-full min-w-0 space-y-3 text-left">
    <div role="group" :aria-label="lazyStrings.ModelSelectorFileImport__add_model_options()" tw-class="inline-flex flex-wrap gap-0.5 rounded-lg bg-gray-100 p-0.5 dark:bg-gray-800">
      <button v-for="choice in importModes" :key="choice.id" type="button" :aria-pressed="mode === choice.id" :disabled="importing !== undefined || linked.linkedFolders.busy.value" :tw-class="['flex min-h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium focus-visible:outline-2 focus-visible:outline-blue-500', mode === choice.id ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-700 dark:text-gray-100' : 'text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200']" @click="mode = choice.id; failure = undefined; failureDetail = undefined"><component :is="choice.icon" aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ choice.label }}</button>
    </div>
    <LlamaCppBrowserLocalFiles v-if="mode === 'file'" :disabled="disabled || importing !== undefined" layout="compact" intent="add" @accept="accept({ request: $event })" @skipped="skippedFiles = $event" />
    <LinkedModelDirectories v-else :view="linked.linkedFolders" :disabled="disabled || importing !== undefined" width="full" />
    <div v-if="importing" tw-class="flex items-center justify-between gap-2">
      <span role="status" tw-class="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400"><Loader2Icon aria-hidden="true" tw-class="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />{{ lazyStrings.ModelSelectorFileImport__checking_files() }}</span>
      <button type="button" tw-class="rounded-md px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800" @click="importing.abort()">{{ lazyStrings.ModelSelectorFileImport__cancel_import() }}</button>
    </div>
    <p v-if="failure || (mode === 'linked_folder' && linked.failure.value)" role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ failure ? failures[failure]() : lazyStrings.ModelSelectorFileImport__folder_link_failed() }}</p>
    <details v-if="failureDetail" tw-class="break-words text-xs text-gray-500 dark:text-gray-400">
      <summary tw-class="cursor-pointer">{{ lazyStrings.llamaCppBrowserDownloads__details() }}</summary>
      <p tw-class="mt-1">{{ failureDetail }}</p>
    </details>
    <details v-if="skippedFiles.length" tw-class="break-words text-xs text-gray-600 dark:text-gray-300">
      <summary tw-class="cursor-pointer">{{ lazyStrings.ModelSelectorFileImport__skipped_files({ count: skippedFiles.length }) }}</summary>
      <ul tw-class="mt-1 space-y-1 ps-4">
        <li v-for="file in skippedFiles" :key="file">{{ file }}</li>
      </ul>
    </details>
    <section v-if="availableAddedModels.length" :aria-label="lazyStrings.ModelSelectorFileImport__added_models()">
      <h3 tw-class="px-2 pb-1.5 text-[11px] font-medium text-gray-500 dark:text-gray-400">{{ lazyStrings.ModelSelectorFileImport__added_models() }}</h3>
      <ul tw-class="space-y-0.5">
        <li v-for="model in availableAddedModels" :key="model.modelId">
          <button type="button" :title="model.modelId" :aria-label="model.modelId" :aria-pressed="model.modelId === selectedModelId" :disabled="disabled" :tw-class="['block min-w-0 w-full rounded-lg px-2.5 py-2 text-left text-xs focus-visible:outline-2 focus-visible:outline-blue-500 disabled:opacity-50', model.modelId === selectedModelId ? 'bg-blue-50 text-blue-800 dark:bg-blue-500/15 dark:text-blue-200' : 'hover:bg-gray-100 dark:hover:bg-gray-800']" @click="emit('choose', model)">
            <span tw-class="block truncate font-medium">{{ splitModelName({ name: model.modelId }).suffix }}</span>
            <span v-if="splitModelName({ name: model.modelId }).prefix" tw-class="block truncate text-[11px] text-gray-500 dark:text-gray-400">{{ splitModelName({ name: model.modelId }).prefix.slice(0, -1) }}</span>
          </button>
        </li>
      </ul>
    </section>
  </section>
</template>
