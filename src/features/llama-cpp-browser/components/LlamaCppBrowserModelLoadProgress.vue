<script setup lang="ts">
import { computed } from 'vue';
import { Loader2Icon } from 'lucide-vue-next';
import type { Progress } from '@/features/llama-cpp-browser/types';
import { lazyStrings } from '@/strings';
const props = defineProps<{ progress: Progress | undefined }>();
// Native loading counts model weights, not all runtime/context setup. Unknown
// work must remain indeterminate; never invent a timer-derived percentage.
const percentage = computed(() => {
  const progress = props.progress;
  if (progress?.phase !== 'loading' || !Number.isFinite(progress.total) || progress.total <= 0 || !Number.isFinite(progress.completed)) return undefined;
  return Math.floor(Math.min(1, Math.max(0, progress.completed / progress.total)) * 100);
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div data-testid="model-launch-loading" tw-class="min-h-14 space-y-2 text-left">
    <p role="status" tw-class="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-200">
      <Loader2Icon aria-hidden="true" tw-class="w-4 h-4 text-blue-500 animate-spin motion-reduce:animate-none" />
      {{ lazyStrings.LlamaCppBrowserModelLaunch__loading_model() }}
    </p>
    <div tw-class="flex items-center justify-between gap-3 text-xs text-gray-500 dark:text-gray-400">
      <span>{{ percentage === undefined ? lazyStrings.LlamaCppBrowserModelLaunch__initializing_runtime_and_context() : lazyStrings.LlamaCppBrowserModelLaunch__loading_model_weights() }}</span>
      <span v-if="percentage !== undefined" data-testid="model-load-percentage" tw-class="tabular-nums text-blue-600 dark:text-blue-400">{{ percentage }}%</span>
    </div>
    <div role="progressbar" :aria-label="percentage === undefined ? lazyStrings.LlamaCppBrowserModelLaunch__loading_model() : lazyStrings.LlamaCppBrowserModelLaunch__loading_model_weights()" :aria-valuenow="percentage" :aria-valuemin="percentage === undefined ? undefined : 0" :aria-valuemax="percentage === undefined ? undefined : 100" tw-class="h-1.5 rounded-full overflow-hidden bg-gray-200/70 dark:bg-gray-700/60">
      <div :class="{ 'indeterminate': percentage === undefined }" tw-class="h-full rounded-full bg-blue-600 dark:bg-blue-500 transition-[width] duration-150 motion-reduce:transition-none" :style="{ width: percentage === undefined ? '28%' : `${percentage}%` }" />
    </div>
  </div>
</template>
<style scoped>
.indeterminate { animation: model-load-indeterminate 1.5s ease-in-out infinite alternate; }
@keyframes model-load-indeterminate { from { transform: translateX(0); } to { transform: translateX(250%); } }
@media (prefers-reduced-motion: reduce) { .indeterminate { animation: none; } }
</style>
