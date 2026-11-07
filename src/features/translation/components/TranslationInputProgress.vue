<script setup lang="ts">
import { computed } from 'vue';
import { Loader2Icon } from 'lucide-vue-next';
import type { Progress } from '@/features/llama-cpp-browser/types';
import { lazyStrings } from '@/strings';
const props = defineProps<{ progress: Progress | undefined }>();
const percentage = computed(() => {
  const value = props.progress;
  return value?.phase === 'prefill' && Number.isFinite(value.total) && value.total > 0 && Number.isFinite(value.completed)
    ? Math.floor(Math.min(1, Math.max(0, value.completed / value.total)) * 100) : undefined;
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div data-testid="translation-input-progress" tw-class="min-w-0 flex-1 space-y-1.5">
    <div tw-class="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400"><Loader2Icon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" /><span role="status" tw-class="min-w-0 flex-1 truncate">{{ lazyStrings.translation__processing_source() }}</span><span v-if="percentage !== undefined" tw-class="text-[10px] tabular-nums">{{ percentage }}%</span></div>
    <div role="progressbar" :aria-label="lazyStrings.translation__processing_source()" :aria-valuenow="percentage" :aria-valuemin="percentage === undefined ? undefined : 0" :aria-valuemax="percentage === undefined ? undefined : 100" tw-class="h-1 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800"><div :class="{ indeterminate: percentage === undefined }" :style="{ width: percentage === undefined ? '28%' : `${percentage}%` }" tw-class="h-full rounded-full bg-blue-600 transition-[width] duration-150 motion-reduce:transition-none dark:bg-blue-500" /></div>
  </div>
</template>
<style scoped>
.indeterminate {
  animation: translation-input-progress 1.5s ease-in-out infinite alternate;
}
@keyframes translation-input-progress {
  from {
    transform: translateX(0);
  }
  to {
    transform: translateX(250%);
  }
}
@media (prefers-reduced-motion: reduce) {
  .indeterminate {
    animation: none;
  }
}
</style>
