<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { currentLocale, lazyStrings } from '@/strings';
import type { SpeechLoadProgress } from '@/features/speech-cpp-browser/types';
import { createModelLoadEstimate } from '@/features/live-conversation/logic/model-load-progress';

const props = defineProps<{ progress: SpeechLoadProgress | undefined, ready?: boolean, generation?: number }>();
const estimator = createModelLoadEstimate();
const overall = ref<number>();
watch([() => props.progress, () => props.ready, () => props.generation], ([progress, ready, generation], previous) => {
  if (generation !== previous[2]) {
    estimator.reset();
  }
  overall.value = estimator.update({ progress, ready: ready === true });
}, { immediate: true });
const overallText = computed(() => overall.value === undefined ? undefined : new Intl.NumberFormat(currentLocale.value, { maximumFractionDigits: 1 }).format(overall.value));
const label = computed(() => {
  if (props.ready) {
    return lazyStrings.liveConversation__ready();
  }
  const progress = props.progress;
  switch (progress?.stage) {
  case 'preparing_runtime': return lazyStrings.liveConversation__preparing_runtime();
  case 'loading_runtime': return lazyStrings.liveConversation__loading_runtime();
  case 'checking_model': return lazyStrings.liveConversation__checking_model();
  case 'checking_loaded_model': return lazyStrings.liveConversation__checking_loaded_model();
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
  case 'preparing_runtime': case 'checking_model': case 'checking_loaded_model': case 'preparing_model': return undefined;
  default: {
    const exhaustive: never = progress;
    throw new Error(String(exhaustive));
  }
  }
});
const percentage = computed(() => meter.value && meter.value.total > 0 ? Math.min(100, Math.max(0, meter.value.bytes / meter.value.total * 100)) : undefined);
const percentageText = computed(() => {
  const value = percentage.value;
  if (value === undefined) {
    return undefined;
  }
  const format = new Intl.NumberFormat(currentLocale.value, { maximumFractionDigits: value < 1 ? 3 : 1 });
  return value > 0 && value < 0.001 ? `<${format.format(0.001)}` : format.format(value);
});

function mib({ bytes }: { bytes: number }): string {
  const format = new Intl.NumberFormat(currentLocale.value, { maximumFractionDigits: bytes > 0 && bytes < 1024 * 1024 ? 3 : 1 });
  return bytes > 0 && bytes < 1024 * 1024 * 0.001 ? `<${format.format(0.001)}` : format.format(bytes / 1024 / 1024);
}

const detail = computed(() => {
  const progress = props.progress;
  if (!progress) {
    return undefined;
  }
  switch (progress.stage) {
  case 'loading_runtime': return lazyStrings.liveConversation__runtime_loading_bytes({ fetched: mib({ bytes: progress.fetchedBytes }), loaded: mib({ bytes: progress.decompressedBytes }), total: mib({ bytes: progress.totalDecompressedBytes }) });
  case 'reading_model': return lazyStrings.liveConversation__model_read_bytes({ loaded: mib({ bytes: progress.readBytes }), total: mib({ bytes: progress.totalBytes }) });
  case 'preparing_runtime': case 'checking_model': case 'checking_loaded_model': case 'preparing_model': return undefined;
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
    <div tw-class="flex flex-wrap items-center justify-between gap-3 text-xs text-gray-600 dark:text-gray-300"><span role="status" data-testid="live-load-stage">{{ label }}</span><span v-if="overallText !== undefined" tw-class="tabular-nums" data-testid="live-overall-load-percent">{{ lazyStrings.liveConversation__overall_model_load_estimate() }} {{ overallText }}%</span></div>
    <div role="progressbar" :aria-label="lazyStrings.liveConversation__overall_model_load_estimate()" :aria-valuemin="0" :aria-valuemax="100" :aria-valuenow="overall" tw-class="h-1.5 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800" data-testid="live-load-bar"><div v-if="overall !== undefined" :style="{ width: `${overall}%` }" tw-class="h-full rounded-full bg-blue-500 transition-[width] motion-reduce:transition-none" /><div v-else tw-class="h-full w-1/3 animate-pulse rounded-full bg-blue-500/70 motion-reduce:animate-none" /></div>
    <div v-if="detail" tw-class="flex flex-wrap justify-between gap-2 text-[11px] tabular-nums text-gray-400 dark:text-gray-500"><span data-testid="live-load-bytes">{{ detail }}</span><span v-if="percentageText !== undefined" data-testid="live-load-percent">{{ percentageText }}%</span></div>
    <p tw-class="text-[11px] leading-5 text-gray-400 dark:text-gray-500">{{ lazyStrings.liveConversation__model_load_estimate_uses_stage_weights() }}</p>
  </div>
</template>
