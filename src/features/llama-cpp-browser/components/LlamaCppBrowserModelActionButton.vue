<script setup lang="ts">
defineProps<{ disabled: boolean }>();
defineSlots<{ default(): unknown }>();
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <button type="button" :disabled="disabled" tw-class="group inline-flex min-h-8 min-w-0 max-w-full items-center justify-center gap-2 px-3 py-1.5 text-xs font-semibold text-gray-600 transition-[background-color,border-color,color,box-shadow] duration-200 hover:bg-blue-50/80 hover:text-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 aria-pressed:bg-blue-50 aria-pressed:text-blue-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:aria-pressed:opacity-100 dark:aria-pressed:bg-blue-500/10 dark:aria-pressed:text-blue-400 dark:text-gray-300 dark:hover:bg-blue-500/10 dark:hover:text-blue-300 motion-reduce:transition-none rounded-xl border border-gray-200/80 bg-gray-50/80 shadow-sm shadow-gray-900/[0.02] hover:border-blue-200 dark:border-gray-700/80 dark:bg-gray-800/60 dark:shadow-none dark:hover:border-blue-500/30"><slot /></button>
</template>
