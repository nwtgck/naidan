<script setup lang="ts">
import { lazyStrings } from '@/strings';
import { ChevronUpIcon } from 'lucide-vue-next';

const emit = defineEmits<{ collapse: [] }>();
defineSlots<{ default(): unknown, summary?(): unknown, source?(): unknown }>();


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
  <div tw-class="mb-2 ms-4 me-1 border-s border-gray-200 pb-1 pe-1 ps-3 pt-2 dark:border-gray-800">
    <div v-if="$slots.summary" tw-class="mb-1.5"><slot name="summary" /></div>
    <div :class="{ 'model-configuration-with-source': $slots.source }" tw-class="grid gap-3">
      <div tw-class="min-w-0"><slot /></div>
      <slot name="source" />
    </div>
    <div tw-class="mt-1 flex justify-end">
      <button type="button" :aria-label="lazyStrings.ModelSelectorConfiguration__collapse()" :title="lazyStrings.ModelSelectorConfiguration__collapse()" tw-class="grid h-8 w-8 place-items-center rounded-lg text-gray-500 transition-colors hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-gray-400 dark:hover:bg-gray-800 motion-reduce:transition-none" @click="emit('collapse')">
        <ChevronUpIcon aria-hidden="true" tw-class="h-4 w-4" />
      </button>
    </div>
  </div>
</template>

<style scoped>
@container model-picker (min-width: 42rem) {
  .model-configuration-with-source {
    grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
    align-items: start;
  }
}
</style>
