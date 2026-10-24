<script setup lang="ts">
import { FileUpIcon } from 'lucide-vue-next';

// File formats, import policy and synchronous drag-data capture belong to the
// caller. Share the model-file entry surface without sharing those operations.
defineProps<{
  disabled: boolean,
  active: boolean,
  layout: 'compact' | 'expanded' | 'fill',
  title: string | undefined,
  description: string | undefined,
  descriptionId?: string,
}>();
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div :aria-disabled="disabled" :tw-class="['flex w-full flex-col items-center justify-center rounded-2xl border-2 border-dashed text-center transition-colors duration-200 motion-reduce:transition-none', layout === 'expanded' ? 'min-h-[clamp(240px,34dvh,360px)] px-5 py-8 sm:px-10' : layout === 'fill' ? 'min-h-56 h-full px-5 py-8 sm:px-10' : 'min-h-44 px-4 py-5', active ? 'border-blue-400 bg-blue-50/70 dark:border-blue-500 dark:bg-blue-500/10' : 'border-gray-200 bg-gray-50/50 dark:border-gray-700 dark:bg-gray-800/30']">
    <div class="model-file-drop-accent" tw-class="mb-3 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400"><FileUpIcon aria-hidden="true" tw-class="h-4 w-4" /></div>
    <p :tw-class="['max-w-lg font-medium leading-relaxed tracking-tight text-gray-700 dark:text-gray-200', layout !== 'compact' ? 'text-sm sm:text-base' : 'text-sm']">{{ title }}</p>
    <p :id="descriptionId" tw-class="mb-4 mt-1 max-w-md text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ description }}</p>
    <slot />
  </div>
</template>
<style scoped>
.model-file-drop-accent {
  box-shadow: 0 0 20px rgb(59 130 246 / 0.14);
}
</style>
