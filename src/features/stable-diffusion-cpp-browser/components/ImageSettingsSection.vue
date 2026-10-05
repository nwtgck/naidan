<script setup lang="ts">
import { ChevronRightIcon } from 'lucide-vue-next';
defineProps<{ title: string | undefined, summary: string | undefined, embedded?: boolean, compact?: boolean }>();
const open = defineModel<boolean>('open', { default: false });
function toggle({ event }: { event: Event }): void {
  if (event.target instanceof HTMLDetailsElement) open.value = event.target.open;
}
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <details :open="open" @toggle="toggle({ event: $event })" :tw-class="['group min-w-0 max-w-full overflow-hidden', embedded ? 'rounded-xl' : 'rounded-2xl border border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/20']">
    <summary :tw-class="[compact ? 'min-h-8 px-3 py-2' : 'min-h-12 px-4 py-3', 'flex min-w-0 items-center gap-3 cursor-pointer list-none select-none hover:bg-gray-100/50 dark:hover:bg-gray-800/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 transition-colors [&::-webkit-details-marker]:hidden']">
      <span :tw-class="['min-w-0 [overflow-wrap:anywhere] font-bold text-gray-800 dark:text-gray-100', compact ? 'text-xs' : 'text-sm']">{{ title }}</span>
      <span :title="summary" tw-class="ml-auto min-w-0 flex-1 truncate text-right text-xs text-gray-500 dark:text-gray-400"><slot name="summary">{{ summary }}</slot></span>
      <ChevronRightIcon aria-hidden="true" :tw-class="['w-4 h-4 shrink-0 text-gray-400 transition-transform', open ? 'rotate-90' : '']" />
    </summary>
    <div :tw-class="['min-w-0 border-t border-gray-100 dark:border-gray-800', compact ? 'p-3 space-y-2 text-xs' : 'p-4 space-y-4']"><slot /></div>
  </details>
</template>
