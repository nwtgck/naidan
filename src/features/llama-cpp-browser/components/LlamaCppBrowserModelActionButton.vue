<script setup lang="ts">
defineProps<{ disabled: boolean, size?: 'compact' | 'regular' }>();
defineSlots<{ default(): unknown }>();
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <button type="button" :disabled="disabled" :tw-class="['group inline-flex min-w-0 max-w-full items-center justify-center rounded-lg border border-gray-200/80 bg-white/70 font-medium text-gray-600 transition-[background-color,border-color,color] duration-200 hover:border-blue-200/80 hover:bg-blue-50/60 hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 aria-pressed:border-blue-200/80 aria-pressed:bg-blue-50/70 aria-pressed:text-blue-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:aria-pressed:opacity-100 dark:border-gray-700/70 dark:bg-gray-800/50 dark:text-gray-300 dark:hover:border-blue-500/30 dark:hover:bg-blue-500/10 dark:hover:text-gray-100 dark:aria-pressed:border-blue-500/30 dark:aria-pressed:bg-blue-500/10 dark:aria-pressed:text-blue-400 motion-reduce:transition-none', size === 'regular' ? 'min-h-10 gap-2 px-4 py-2 text-[13px]' : 'min-h-8 gap-1.5 px-2.5 py-1.5 text-xs']"><slot /></button>
</template>
