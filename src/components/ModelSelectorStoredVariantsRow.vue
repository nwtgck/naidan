<script setup lang="ts">
import { lazyStrings } from '@/strings';
import { ChevronDownIcon } from 'lucide-vue-next';

defineProps<{
  name: string,
  source: string,
  count: number,
  expanded: boolean,
  selected: boolean,
  highlighted?: boolean,
  index?: number,
}>();
const emit = defineEmits<{ toggle: [] }>();


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
  <button type="button" :aria-expanded="expanded" :data-index="index" data-testid="model-selector-stored-variant-group" :tw-class="['flex min-h-10 w-full min-w-0 items-center gap-2 rounded-lg px-2 py-2 text-left text-xs transition-colors focus-visible:outline-2 focus-visible:outline-blue-500 motion-reduce:transition-none', selected ? 'bg-gray-100 ring-1 ring-inset ring-gray-300 text-blue-600 dark:bg-gray-700/50 dark:ring-gray-600 dark:text-blue-400' : 'hover:bg-gray-50 dark:hover:bg-gray-700/50', highlighted && 'ring-1 ring-inset ring-gray-300 dark:ring-gray-600']" @click="emit('toggle')">
    <span tw-class="min-w-0 flex-1">
      <span :title="name" tw-class="block truncate font-medium">{{ name }}</span>
      <span :title="source" tw-class="mt-0.5 block truncate text-[11px] text-gray-500 dark:text-gray-400">{{ source }}</span>
    </span>
    <span tw-class="whitespace-nowrap text-[10px] tabular-nums text-gray-500 dark:text-gray-400">{{ lazyStrings.ModelSelectorStoredVariantsRow__variant_count({ count }) }}</span>
    <ChevronDownIcon aria-hidden="true" :tw-class="['h-3.5 w-3.5 shrink-0 text-gray-400 transition-transform motion-reduce:transition-none', expanded && 'rotate-180']" />
  </button>
</template>
