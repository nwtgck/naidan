<script setup lang="ts">
defineProps<{ disabled: boolean, appearance: 'primary' | 'secondary' | 'danger' }>();
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <button type="button" :disabled="disabled" :tw-class="[
    'inline-flex min-h-9 min-w-0 max-w-full items-center justify-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:cursor-not-allowed disabled:text-slate-400 dark:disabled:text-slate-500 motion-reduce:transition-none',
    appearance === 'primary'
      ? 'border-slate-200 bg-white text-slate-700 enabled:hover:bg-slate-50 dark:border-slate-700/70 dark:bg-slate-800/45 dark:text-slate-200 dark:enabled:hover:bg-slate-800 [&>svg]:text-blue-500 dark:[&>svg]:text-blue-400 disabled:[&>svg]:text-slate-400 dark:disabled:[&>svg]:text-slate-500'
      : appearance === 'danger'
        ? 'border-red-200 bg-white text-red-600 enabled:hover:border-red-300 enabled:hover:bg-red-50 focus-visible:ring-red-500/30 dark:border-red-500/30 dark:bg-slate-800/45 dark:text-red-400 dark:enabled:hover:border-red-500/50 dark:enabled:hover:bg-red-500/10 [&>svg]:text-red-500 dark:[&>svg]:text-red-400 disabled:[&>svg]:text-slate-400 dark:disabled:[&>svg]:text-slate-500'
        : 'border-gray-200/80 bg-white/70 text-gray-600 enabled:hover:border-gray-300 enabled:hover:bg-gray-50 dark:border-gray-700/70 dark:bg-gray-800/40 dark:text-gray-300 dark:enabled:hover:border-gray-600 dark:enabled:hover:bg-gray-800',
  ]"><slot /></button>
</template>
