<script setup lang="ts">
import { ChevronRightIcon } from 'lucide-vue-next';
defineProps<{ title: string | undefined, summary: string | undefined, embedded?: boolean }>();
const open = defineModel<boolean>('open', { default: false });
function toggle({ event }: { event: Event }): void {
  if (event.target instanceof HTMLDetailsElement) open.value = event.target.open;
}
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <details :open="open" @toggle="toggle({ event: $event })" :tw-class="['group overflow-hidden', embedded ? 'rounded-lg' : 'rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900']">
    <summary tw-class="flex min-h-12 items-center gap-3 px-4 py-3 cursor-pointer list-none select-none hover:bg-gray-50 dark:hover:bg-gray-800/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-purple-500 [&::-webkit-details-marker]:hidden">
      <span tw-class="min-w-0 text-sm font-medium">{{ title }}</span>
      <span tw-class="ml-auto min-w-0 truncate text-xs text-gray-500 dark:text-gray-400"><slot name="summary">{{ summary }}</slot></span>
      <ChevronRightIcon aria-hidden="true" :tw-class="['w-4 h-4 shrink-0 text-gray-400 transition-transform', open ? 'rotate-90' : '']" />
    </summary>
    <div tw-class="border-t border-gray-100 dark:border-gray-800 p-4 space-y-4"><slot /></div>
  </details>
</template>
