<script setup lang="ts">
import { computed, onUnmounted, ref, shallowRef } from 'vue';
import { lazyStrings } from '@/strings';
import { advanceThroughputSample, remainingEstimate, startThroughputSample } from '@/features/llama-cpp-browser/hugging-face/download-estimate';
import { formatDownloadBytes } from '@/features/llama-cpp-browser/hugging-face/download-plan';
import type { DownloadProgress } from '@/features/llama-cpp-browser/hugging-face/types';
const props = defineProps<{ progress: DownloadProgress | undefined }>();
const sampledNow = ref(performance.now());
// When remounted, baseline cumulative bytes already processed by the queue.
// Resumed bytes and bytes transferred while hidden must not inflate the rate.
const throughput = shallowRef({ ...startThroughputSample({ now: sampledNow.value }), processed: props.progress?.processed ?? 0 });
const timer = setInterval(() => {
  sampledNow.value = performance.now();
  throughput.value = advanceThroughputSample({ sample: throughput.value, now: sampledNow.value, processed: props.progress?.processed ?? 0 });
}, 1000);
onUnmounted(() => clearInterval(timer));
const percentage = computed(() => props.progress ? Math.min(100, Math.max(0, Math.floor(props.progress.completed / props.progress.total * 100))) : undefined);
const speed = computed(() => {
  const sample = throughput.value;
  if (props.progress?.phase !== 'transferring' || sample.bytesPerSecond === undefined) return undefined;
  const bytes = sample.lastAdvanceAt !== undefined && sampledNow.value - sample.lastAdvanceAt >= 10000 ? 0 : sample.bytesPerSecond;
  return `${formatDownloadBytes({ bytes })}/s`;
});
const estimateText = computed(() => {
  if (!props.progress) return undefined;
  const estimate = remainingEstimate({ sample: throughput.value, now: sampledNow.value, remaining: props.progress.total - props.progress.completed, phase: props.progress.phase });
  switch (estimate.status) {
  case 'estimating': return lazyStrings.LlamaCppBrowserHuggingFaceManager__estimating_remaining_time();
  case 'verifying': return lazyStrings.LlamaCppBrowserHuggingFaceManager__performing_final_checks();
  case 'remaining': {
    if (estimate.seconds < 60) return lazyStrings.LlamaCppBrowserHuggingFaceManager__about_seconds_remaining({ seconds: Math.max(5, Math.ceil(estimate.seconds / 5) * 5) });
    if (estimate.seconds < 3600) return lazyStrings.LlamaCppBrowserHuggingFaceManager__about_minutes_remaining({ minutes: Math.ceil(estimate.seconds / 60) });
    const minutes = Math.ceil(estimate.seconds / 600) * 10; const hours = Math.floor(minutes / 60);
    return minutes % 60 === 0 ? lazyStrings.LlamaCppBrowserHuggingFaceManager__about_hours_remaining({ hours }) : lazyStrings.LlamaCppBrowserHuggingFaceManager__about_hours_and_minutes_remaining({ hours, minutes: minutes % 60 });
  }
  default: { const exhaustive: never = estimate; throw new Error(String(exhaustive)); }
  }
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div tw-class="space-y-2" data-testid="llama-download-progress">
    <div tw-class="flex items-center justify-between gap-3 text-[10px] tabular-nums text-gray-500 dark:text-gray-400">
      <span v-if="progress">{{ formatDownloadBytes({ bytes: progress.completed }) }} / {{ formatDownloadBytes({ bytes: progress.total }) }}</span>
      <span v-if="percentage !== undefined" tw-class="font-bold text-purple-600 dark:text-purple-400">{{ percentage }}%</span>
    </div>
    <div v-if="percentage !== undefined" role="progressbar" :aria-label="lazyStrings.LlamaCppBrowserHuggingFaceManager__downloading_model()" :aria-valuemin="0" :aria-valuemax="100" :aria-valuenow="percentage" tw-class="h-1.5 w-full bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
      <div tw-class="h-full rounded-full bg-purple-500 dark:bg-purple-400 transition-all duration-300 motion-reduce:transition-none" :style="{ width: `${percentage}%` }" />
    </div>
    <div tw-class="flex flex-wrap gap-x-2 gap-y-1 text-[10px] text-gray-500 dark:text-gray-400 tabular-nums">
      <span v-if="speed" data-testid="llama-download-speed">{{ speed }}</span>
      <span v-if="speed && estimateText" aria-hidden="true">·</span>
      <span v-if="estimateText" data-testid="llama-hf-remaining">{{ estimateText }}</span>
    </div>
  </div>
</template>
