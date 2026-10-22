<script setup lang="ts">
import { BrainCircuitIcon, ChevronDownIcon, Trash2Icon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import type { LocalModel } from '@/features/llama-cpp-browser/types';
import type { DefaultModelContext } from '@/features/llama-cpp-browser/default-model';
import LlamaCppBrowserModelAction from './LlamaCppBrowserModelAction.vue';
import LlamaCppBrowserDefaultModelAction from './LlamaCppBrowserDefaultModelAction.vue';

defineProps<{ model: LocalModel, defaultModel: DefaultModelContext | undefined, disabled: boolean, removalDisabled: boolean, defaultActionDisabled: boolean, chatGroupAction: 'available' | 'unavailable', creating: boolean }>();
const emit = defineEmits<{ createChatGroup: [], selectDefault: [model: LocalModel], remove: [] }>();

function formatSize({ bytes }: { bytes: number }): string {
  if (bytes < 1024 ** 2) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  if (bytes < 1024 ** 3) {
    return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  }
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <li tw-class="flex flex-wrap items-start gap-3 p-4 rounded-2xl border border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900/30">
    <div tw-class="w-9 h-9 rounded-xl bg-blue-50 dark:bg-blue-900/20 text-blue-500 flex items-center justify-center shrink-0"><BrainCircuitIcon tw-class="w-4 h-4" /></div>
    <div tw-class="min-w-0 flex-[1_1_10rem]">
      <p data-testid="llama-imported-model-name" :title="model.source?.primaryRelativePath" tw-class="text-sm font-bold text-gray-800 dark:text-gray-100 break-all">{{ model.modelId }}</p><span v-if="model.modelId.startsWith('temp/')" data-testid="llama-temporary-model-badge" tw-class="text-[10px] text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserImportedModelRow__temporary() }}</span>
      <details :data-testid="`llama-imported-model-details-${model.modelId}`" tw-class="group mt-1">
        <summary :data-testid="`llama-imported-model-details-toggle-${model.modelId}`" tw-class="flex flex-wrap items-center gap-x-3 gap-y-1 list-none cursor-pointer rounded text-[10px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
          <span tw-class="text-gray-400 font-mono tabular-nums">{{ formatSize({ bytes: model.size }) }} · GGUF</span>
          <span tw-class="inline-flex items-center gap-1 font-medium text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400">{{ lazyStrings.LlamaCppBrowserImportedModelRow__details() }}<ChevronDownIcon aria-hidden="true" tw-class="w-3 h-3 shrink-0 transition-transform group-open:rotate-180" /></span>
        </summary>
        <div :data-testid="`llama-imported-model-details-content-${model.modelId}`" tw-class="mt-3 space-y-3 border-t border-gray-100 dark:border-gray-800 pt-3">
          <dl tw-class="space-y-2 text-xs">
            <div><dt tw-class="text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserImportedModelRow__model_id() }}</dt><dd data-testid="llama-imported-model-detail-name" tw-class="mt-0.5 break-all text-gray-700 dark:text-gray-200">{{ model.modelId }}</dd></div>
            <template v-if="model.source">
              <div><dt tw-class="text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserImportedModelRow__folder() }}</dt><dd data-testid="llama-imported-model-detail-folder" tw-class="mt-0.5 break-all text-gray-700 dark:text-gray-200">{{ model.source.directoryName }}</dd></div>
              <div><dt tw-class="text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserImportedModelRow__repository() }}</dt><dd data-testid="llama-imported-model-detail-repository" tw-class="mt-0.5 break-all text-gray-700 dark:text-gray-200">{{ model.source.repository }}</dd></div>
              <div><dt tw-class="text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserImportedModelRow__file() }}</dt><dd data-testid="llama-imported-model-detail-file" tw-class="mt-0.5 break-all font-mono text-gray-700 dark:text-gray-200">{{ model.source.primaryRelativePath }}</dd></div>
            </template>
          </dl>
          <button type="button" :disabled="removalDisabled" :data-testid="`llama-cpp-browser-delete-${model.modelId}`" :aria-label="model.modelId.startsWith('temp/') ? lazyStrings.LlamaCppBrowserImportedModelRow__remove_temporary_model() : lazyStrings.llamaCppBrowser__delete_model()" :title="model.modelId.startsWith('temp/') ? lazyStrings.LlamaCppBrowserImportedModelRow__remove_temporary_model() : lazyStrings.llamaCppBrowser__delete_model()" tw-class="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors" @click="emit('remove')"><Trash2Icon aria-hidden="true" tw-class="w-3.5 h-3.5 shrink-0" />{{ model.modelId.startsWith('temp/') ? lazyStrings.LlamaCppBrowserImportedModelRow__remove_temporary_model() : lazyStrings.llamaCppBrowser__delete_model() }}</button>
        </div>
      </details>
    </div>
    <div tw-class="flex flex-wrap items-center justify-end gap-1 ml-auto">
      <LlamaCppBrowserModelAction v-if="chatGroupAction === 'available'" :model="model" :current="defaultModel" :disabled="disabled" :default-action-disabled="defaultActionDisabled" :creating="creating" @create-chat-group="emit('createChatGroup')" @select-default="emit('selectDefault', $event)" />
      <LlamaCppBrowserDefaultModelAction v-else :model="model" :current="defaultModel" :disabled="disabled || defaultActionDisabled" @select="emit('selectDefault', $event)" />
    </div>
  </li>
</template>
