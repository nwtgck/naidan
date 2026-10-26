<script setup lang="ts">
import { useLlamaCppBrowserSettingsTypography } from '@/features/llama-cpp-browser/composables/useLlamaCppBrowserSettingsTypography';
import { ref, useId } from 'vue';
import { BrainCircuitIcon, ChevronDownIcon, HardDriveIcon, Trash2Icon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import type { LocalModel } from '@/features/llama-cpp-browser/types';

defineProps<{ model: LocalModel, removalDisabled: boolean }>();
defineSlots<{ actions(): unknown }>();
const emit = defineEmits<{ remove: [] }>();
const id = useId();
const expansion = ref<'closed' | 'open'>('closed');

function toggleDetails(): void {
  switch (expansion.value) {
  case 'closed': expansion.value = 'open';
    break;
  case 'open': expansion.value = 'closed';
    break;
  default: {
    const exhaustive: never = expansion.value;
    throw new Error(String(exhaustive));
  }
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

const isSettingsTypography = useLlamaCppBrowserSettingsTypography();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <li tw-class="group/model rounded-xl border border-gray-200/70 bg-white/60 p-3 transition-[background-color,border-color] duration-200 hover:border-gray-300/80 hover:bg-gray-50/80 focus-within:border-blue-300/70 dark:border-gray-800/80 dark:bg-gray-900/20 dark:hover:border-gray-700/80 dark:hover:bg-gray-800/30 dark:focus-within:border-blue-500/30 motion-reduce:transition-none">
    <div tw-class="flex flex-wrap items-start gap-x-3 gap-y-2">
      <div tw-class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gray-100/80 text-gray-400 transition-colors duration-200 group-hover/model:bg-blue-50/80 group-hover/model:text-blue-500 group-focus-within/model:text-blue-500 dark:bg-gray-800/70 dark:text-gray-500 dark:group-hover/model:bg-blue-500/10 dark:group-hover/model:text-blue-400 dark:group-focus-within/model:text-blue-400 motion-reduce:transition-none"><BrainCircuitIcon aria-hidden="true" tw-class="h-4 w-4" /></div>
      <div tw-class="min-w-0 flex-[1_1_10rem]">
        <p :id="`${id}-name`" data-testid="llama-imported-model-name" :title="model.source?.primaryRelativePath" :tw-class="['break-all font-semibold leading-5 text-gray-700 transition-colors duration-200 group-hover/model:text-gray-900 dark:group-hover/model:text-gray-100 motion-reduce:transition-none', isSettingsTypography ? 'text-sm dark:text-gray-300' : 'text-[13px] dark:text-gray-200']">{{ model.modelId }}</p>
        <button type="button" :data-testid="`llama-imported-model-details-toggle-${model.modelId}`" :aria-expanded="expansion === 'open'" :aria-controls="`${id}-details`" :aria-labelledby="`${id}-name ${id}-details-label`" :tw-class="['mt-1 flex w-fit max-w-full flex-wrap items-center gap-x-2.5 gap-y-1 rounded-md text-gray-400 transition-colors duration-200 hover:text-gray-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:text-gray-300 motion-reduce:transition-none', isSettingsTypography ? 'text-xs leading-4 dark:text-gray-400' : 'text-[11px] leading-4 dark:text-gray-500']" @click="toggleDetails">
          <span tw-class="inline-flex items-center gap-1.5 tabular-nums"><HardDriveIcon aria-hidden="true" tw-class="h-3 w-3 shrink-0 opacity-70" />{{ formatSize({ bytes: model.size }) }}</span>
          <span :tw-class="['tracking-wide', isSettingsTypography ? 'text-xs' : 'text-[10px]']">GGUF</span>
          <span v-if="model.modelId.startsWith('temp/')" data-testid="llama-temporary-model-badge" :tw-class="['rounded bg-gray-100 px-1.5 text-gray-500 dark:bg-gray-800 dark:text-gray-400', isSettingsTypography ? 'text-xs' : 'text-[10px]']">{{ lazyStrings.LlamaCppBrowserImportedModelRow__temporary() }}</span>
          <span :id="`${id}-details-label`" tw-class="inline-flex items-center gap-1 border-l border-gray-200 pl-2.5 font-medium text-gray-500 dark:border-gray-700 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserImportedModelRow__details() }}<ChevronDownIcon aria-hidden="true" :tw-class="['h-3 w-3 shrink-0 transition-transform duration-200 motion-reduce:transition-none', expansion === 'open' && 'rotate-180']" /></span>
        </button>
      </div>
      <div tw-class="ml-auto flex max-w-full flex-wrap items-center justify-end gap-1 pt-0.5">
        <slot name="actions" />
      </div>
    </div>
    <div :id="`${id}-details`" role="region" :aria-labelledby="`${id}-name`" :aria-hidden="expansion === 'closed'" :inert="expansion === 'closed' || undefined" :data-testid="`llama-imported-model-details-${model.modelId}`" :tw-class="['grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none', expansion === 'open' ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0']">
      <div tw-class="min-h-0 overflow-hidden">
        <div :data-testid="`llama-imported-model-details-content-${model.modelId}`" tw-class="mt-3 border-t border-gray-200/70 pt-3 dark:border-gray-800">
          <dl :tw-class="['grid grid-cols-[minmax(0,5rem)_minmax(0,1fr)] gap-x-4 gap-y-2.5 leading-5', isSettingsTypography ? 'text-xs' : 'text-[11px]']">
            <dt tw-class="text-gray-400 dark:text-gray-500">{{ lazyStrings.LlamaCppBrowserImportedModelRow__model_id() }}</dt><dd data-testid="llama-imported-model-detail-name" tw-class="min-w-0 select-text break-all text-gray-600 dark:text-gray-300">{{ model.modelId }}</dd>
            <template v-if="model.source">
              <dt tw-class="text-gray-400 dark:text-gray-500">{{ lazyStrings.LlamaCppBrowserImportedModelRow__folder() }}</dt><dd data-testid="llama-imported-model-detail-folder" tw-class="min-w-0 select-text break-all text-gray-600 dark:text-gray-300">{{ model.source.directoryName }}</dd>
              <dt tw-class="text-gray-400 dark:text-gray-500">{{ lazyStrings.LlamaCppBrowserImportedModelRow__repository() }}</dt><dd data-testid="llama-imported-model-detail-repository" tw-class="min-w-0 select-text break-all text-gray-600 dark:text-gray-300">{{ model.source.repository }}</dd>
              <dt tw-class="text-gray-400 dark:text-gray-500">{{ lazyStrings.LlamaCppBrowserImportedModelRow__file() }}</dt><dd data-testid="llama-imported-model-detail-file" tw-class="min-w-0 select-text break-all font-mono text-gray-600 dark:text-gray-300">{{ model.source.primaryRelativePath }}</dd>
            </template>
          </dl>
          <div tw-class="mt-3 flex justify-end"><button type="button" :disabled="removalDisabled" :data-testid="`llama-cpp-browser-delete-${model.modelId}`" :aria-label="model.modelId.startsWith('temp/') ? lazyStrings.LlamaCppBrowserImportedModelRow__remove_temporary_model() : lazyStrings.llamaCppBrowser__delete_model()" :title="model.modelId.startsWith('temp/') ? lazyStrings.LlamaCppBrowserImportedModelRow__remove_temporary_model() : lazyStrings.llamaCppBrowser__delete_model()" :tw-class="['inline-flex min-h-8 items-center justify-center gap-1.5 rounded-lg border border-gray-200/80 bg-white/70 px-2.5 py-1.5 font-medium text-gray-500 transition-colors duration-200 hover:border-red-200 hover:bg-red-50 hover:text-red-600 focus-visible:border-red-200 focus-visible:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/30 disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-700/70 dark:bg-gray-900/30 dark:text-gray-400 dark:hover:border-red-500/30 dark:hover:bg-red-500/10 dark:hover:text-red-400 dark:focus-visible:border-red-500/30 dark:focus-visible:text-red-400 motion-reduce:transition-none', isSettingsTypography ? 'text-sm' : 'text-[11px]']" @click="emit('remove')"><Trash2Icon aria-hidden="true" tw-class="h-3 w-3 shrink-0" />{{ model.modelId.startsWith('temp/') ? lazyStrings.LlamaCppBrowserImportedModelRow__remove_temporary_model() : lazyStrings.llamaCppBrowser__delete_model() }}</button></div>
        </div>
      </div>
    </div>
  </li>
</template>
