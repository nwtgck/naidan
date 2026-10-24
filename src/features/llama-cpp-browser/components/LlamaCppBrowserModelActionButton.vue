<script setup lang="ts">
defineProps<{ disabled: boolean, size?: 'compact' | 'regular' | 'large', appearance?: 'secondary' | 'primary' }>();
defineSlots<{ default(): unknown }>();
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <button type="button" :disabled="disabled" :tw-class="[
    'group inline-flex min-w-0 max-w-full items-center justify-center border transition-[background-color,border-color,color] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-40 disabled:aria-pressed:opacity-100 disabled:aria-busy:cursor-progress disabled:aria-busy:opacity-100 motion-reduce:transition-none',
    appearance === 'primary'
      ? 'rounded-xl border-gray-200/90 bg-white text-gray-800 shadow-sm shadow-gray-950/5 enabled:hover:border-blue-300/70 enabled:hover:bg-blue-50/40 enabled:active:bg-blue-50/70 dark:border-gray-700/80 dark:bg-gray-800/70 dark:text-gray-100 dark:shadow-black/10 dark:enabled:hover:border-blue-400/40 dark:enabled:hover:bg-gray-800 dark:enabled:active:bg-gray-700/70'
      : 'rounded-lg border-gray-200/80 bg-white/70 text-gray-600 hover:border-blue-200/80 hover:bg-blue-50/60 hover:text-gray-900 aria-pressed:border-blue-200/80 aria-pressed:bg-blue-50/70 aria-pressed:text-blue-600 dark:border-gray-700/70 dark:bg-gray-800/50 dark:text-gray-300 dark:hover:border-blue-500/30 dark:hover:bg-blue-500/10 dark:hover:text-gray-100 dark:aria-pressed:border-blue-500/30 dark:aria-pressed:bg-blue-500/10 dark:aria-pressed:text-blue-400',
    size === 'large' ? 'min-h-12 gap-3 px-4 py-2.5 text-sm font-semibold' : size === 'regular' ? 'min-h-10 gap-2 px-4 py-2 text-[13px] font-medium' : 'min-h-8 gap-1.5 px-2.5 py-1.5 text-xs font-medium',
  ]"><slot /></button>
</template>
