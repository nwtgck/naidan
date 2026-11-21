<script setup lang="ts">
import { lazyStrings } from '@/strings';
import { computed } from 'vue';
import { CheckIcon, ChevronDownIcon } from 'lucide-vue-next';
import { formatDownloadBytes } from '@/features/llama-cpp-browser/hugging-face/presentation';

const props = defineProps<{
  status: 'standard' | 'selected' | 'missing',
  bytes: number | undefined,
  quantization?: string,
  multimodal?: 'included' | 'excluded',
  expanded: boolean,
  selectable?: boolean,
  checked?: boolean,
  selectionDisabled?: boolean,
}>();
const emit = defineEmits<{ toggle: [], choose: [] }>();
const label = computed(() => ({ standard: lazyStrings.ModelSelectorConfigurationSummary__standard(), selected: lazyStrings.ModelSelectorConfigurationSummary__selected(), missing: lazyStrings.ModelSelectorConfigurationSummary__choose() })[props.status]);


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
  <div tw-class="flex min-w-0 items-center justify-between gap-1 rounded-lg bg-gray-50 pr-1.5 dark:bg-gray-800/50">
    <component :is="selectable ? 'button' : 'div'" :type="selectable ? 'button' : undefined" :disabled="selectable ? selectionDisabled : undefined" :aria-pressed="selectable ? checked === true : undefined" :data-testid="selectable ? 'model-selector-choose-configuration' : undefined" :tw-class="['flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left', selectable && 'hover:bg-gray-100 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-blue-500 disabled:opacity-50 dark:hover:bg-gray-800']" @click="selectable && emit('choose')">
      <span v-if="selectable" aria-hidden="true" tw-class="grid h-4 w-4 shrink-0 place-items-center text-blue-600 dark:text-blue-400">
        <CheckIcon v-if="checked" tw-class="h-4 w-4" />
        <span v-else tw-class="h-3.5 w-3.5 rounded-full border border-gray-400/70 dark:border-gray-500" />
      </span>
      <span tw-class="min-w-0">
        <span tw-class="flex flex-wrap items-baseline gap-x-2 text-xs">
          <span tw-class="font-medium text-gray-700 dark:text-gray-200">{{ label }}</span>
          <span v-if="bytes !== undefined" tw-class="whitespace-nowrap font-medium tabular-nums text-gray-600 dark:text-gray-300">{{ lazyStrings.llamaCppBrowserDownloads__approximately_size({ size: formatDownloadBytes({ bytes }) }) }}</span>
        </span>
        <span v-if="quantization || multimodal" tw-class="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-gray-500 dark:text-gray-400">
          <span v-if="quantization" tw-class="whitespace-nowrap">{{ quantization }}</span>
          <span v-if="multimodal">{{ multimodal === 'included' ? lazyStrings.ModelSelectorConfigurationSummary__multimodal_included() : lazyStrings.ModelSelectorConfigurationSummary__multimodal_excluded() }}</span>
        </span>
      </span>
    </component>
    <button type="button" :aria-label="lazyStrings.ModelSelectorConfigurationSummary__change_configuration()" :aria-expanded="expanded" data-testid="model-selector-edit-configuration" tw-class="inline-flex min-h-8 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-gray-600 hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-gray-300 dark:hover:bg-gray-700" @click="emit('toggle')">
      {{ lazyStrings.ModelSelectorConfigurationSummary__change() }}
      <ChevronDownIcon aria-hidden="true" :tw-class="['h-3.5 w-3.5 transition-transform motion-reduce:transition-none', expanded && 'rotate-180']" />
    </button>
  </div>
</template>
