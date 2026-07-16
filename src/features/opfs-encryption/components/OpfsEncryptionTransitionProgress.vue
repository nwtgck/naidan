<script setup lang="ts">
import { computed } from 'vue';
import type { OpfsEncryptionTransitionProgress } from '@/00-storage/service/opfs-encryption/transition-progress';
import { lazyStrings } from '@/strings';

const props = defineProps<{
  progress: OpfsEncryptionTransitionProgress | undefined,
}>();

const phaseLabel = computed(() => {
  const phase = props.progress?.phase;
  switch (phase) {
  case undefined:
    return lazyStrings.opfsEncryption__progress_preparing();
  case 'preparing':
    return lazyStrings.opfsEncryption__progress_preparing();
  case 'copying':
    return lazyStrings.opfsEncryption__progress_copying();
  case 'verifying':
    return lazyStrings.opfsEncryption__progress_verifying();
  case 'switching_authority':
    return lazyStrings.opfsEncryption__progress_switching_authority();
  case 'cleaning_source':
    return lazyStrings.opfsEncryption__progress_cleaning_source();
  case 'finalizing':
    return lazyStrings.opfsEncryption__progress_finalizing();
  default: {
    const _ex: never = phase;
    throw new Error(`Unhandled OPFS encryption progress phase: ${String(_ex)}`);
  }
  }
});

const percent = computed(() => props.progress?.percent);
const progressWidth = computed(() => `${percent.value ?? 100}%`);
const byteSummary = computed(() => {
  const progress = props.progress;
  if (progress === undefined || progress.totalBytes === undefined) {
    return undefined;
  }
  return lazyStrings.opfsEncryption__progress_bytes({
    completed: formatBytes({ byteLength: progress.completedBytes }),
    total: formatBytes({ byteLength: progress.totalBytes }),
  });
});
const entrySummary = computed(() => {
  const progress = props.progress;
  if (progress === undefined || progress.totalEntries === undefined) {
    return undefined;
  }
  return lazyStrings.opfsEncryption__progress_entries({
    completed: progress.completedEntries,
    total: progress.totalEntries,
  });
});

function formatBytes({ byteLength }: { byteLength: number }): string {
  if (byteLength < 1024) {
    return `${byteLength} B`;
  }
  const units = ['KiB', 'MiB', 'GiB', 'TiB'] as const;
  let value = byteLength / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {}),
});
</script>

<template>
  <div data-testid="opfs-encryption-transition-progress" tw-class="space-y-2 text-left">
    <div tw-class="flex items-center justify-between gap-3 text-xs font-bold text-gray-700 dark:text-gray-200">
      <span>{{ phaseLabel }}</span>
      <span v-if="percent !== undefined" data-testid="opfs-encryption-transition-percent">{{ percent }}%</span>
    </div>
    <div
      role="progressbar"
      :aria-valuenow="percent"
      aria-valuemin="0"
      aria-valuemax="100"
      tw-class="h-2.5 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-800"
    >
      <div
        tw-class="h-full rounded-full bg-blue-600 transition-[width] duration-150"
        :class="percent === undefined ? 'animate-pulse' : ''"
        :style="{ width: progressWidth }"
      />
    </div>
    <div v-if="byteSummary || entrySummary" tw-class="flex flex-wrap gap-x-4 gap-y-1 text-[10px] font-medium text-gray-500 dark:text-gray-400">
      <span v-if="byteSummary">{{ byteSummary }}</span>
      <span v-if="entrySummary">{{ entrySummary }}</span>
    </div>
  </div>
</template>
