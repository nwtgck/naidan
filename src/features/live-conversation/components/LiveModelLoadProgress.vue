<script setup lang="ts">
import { computed } from 'vue';
import { currentLocale, lazyStrings } from '@/strings';
import type { SpeechLoadProgress } from '@/features/speech-cpp-browser/types';

const props = defineProps<{ progress: SpeechLoadProgress | undefined }>();
const label = computed(() => {
  const progress = props.progress;
  switch (progress?.stage) {
  case 'preparing_runtime': return lazyStrings.liveConversation__preparing_runtime();
  case 'loading_runtime': return lazyStrings.liveConversation__loading_runtime();
  case 'preparing_model': return lazyStrings.liveConversation__preparing_model();
  case 'reading_model': return lazyStrings.liveConversation__reading_model_file();
  case undefined: return lazyStrings.liveConversation__loading();
  default: {
    const exhaustive: never = progress;
    throw new Error(String(exhaustive));
  }
  }
});
const meter = computed(() => {
  const progress = props.progress;
  if (!progress) {
    return undefined;
  }
  switch (progress.stage) {
  case 'loading_runtime': return { bytes: progress.decompressedBytes, total: progress.totalDecompressedBytes };
  case 'reading_model': return { bytes: progress.readBytes, total: progress.totalBytes };
  case 'preparing_runtime': case 'preparing_model': return undefined;
  default: {
    const exhaustive: never = progress;
    throw new Error(String(exhaustive));
  }
  }
});
const percentage = computed(() => meter.value && meter.value.total > 0 ? Math.min(100, Math.max(0, Math.floor(meter.value.bytes / meter.value.total * 100))) : undefined);

function mib({ bytes }: { bytes: number }): string {
  return new Intl.NumberFormat(currentLocale.value, { maximumFractionDigits: 1 }).format(bytes / 1024 / 1024);
}

const detail = computed(() => {
  const progress = props.progress;
  if (!progress) {
    return undefined;
  }
  switch (progress.stage) {
  case 'loading_runtime': return lazyStrings.liveConversation__runtime_loading_bytes({ fetched: mib({ bytes: progress.fetchedBytes }), loaded: mib({ bytes: progress.decompressedBytes }), total: mib({ bytes: progress.totalDecompressedBytes }) });
  case 'reading_model': return lazyStrings.liveConversation__model_read_bytes({ loaded: mib({ bytes: progress.readBytes }), total: mib({ bytes: progress.totalBytes }) });
  case 'preparing_runtime': case 'preparing_model': return undefined;
  default: {
    const exhaustive: never = progress;
    throw new Error(String(exhaustive));
  }
  }
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div tw-class="w-full space-y-2" data-testid="live-model-load-progress">
    <div tw-class="flex items-center justify-between gap-3 text-xs text-gray-600 dark:text-gray-300"><span role="status" data-testid="live-load-stage">{{ label }}</span><span v-if="percentage !== undefined" tw-class="tabular-nums" data-testid="live-load-percent">{{ percentage }}%</span></div>
    <div role="progressbar" :aria-label="label" :aria-valuemin="0" :aria-valuemax="100" :aria-valuenow="percentage" :aria-valuetext="detail" tw-class="h-1.5 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800" data-testid="live-load-bar"><div v-if="percentage !== undefined" :style="{ width: `${percentage}%` }" tw-class="h-full rounded-full bg-blue-500 transition-[width] motion-reduce:transition-none" /><div v-else tw-class="h-full w-1/3 animate-pulse rounded-full bg-blue-500/70 motion-reduce:animate-none" /></div>
    <p v-if="detail" tw-class="text-[11px] tabular-nums text-gray-400 dark:text-gray-500" data-testid="live-load-bytes">{{ detail }}</p>
  </div>
</template>
