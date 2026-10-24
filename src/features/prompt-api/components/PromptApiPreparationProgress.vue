<script setup lang="ts">
import { computed } from 'vue';
import { DownloadIcon, Loader2Icon } from 'lucide-vue-next';
import type { PromptApiRuntimeState } from '@/features/prompt-api/runtime';
import { lazyStrings } from '@/strings';

// Rendering progress must not acquire monitoring or start a native session.
// Callers retain their existing preparation and runtime ownership.
const props = defineProps<{
  state: Extract<PromptApiRuntimeState, { status: 'downloading' | 'preparing' }>,
}>();

const progressPercent = computed(() => props.state.status === 'downloading' && props.state.progress !== undefined
  ? Math.round(props.state.progress * 100)
  : undefined);
const label = computed(() => {
  const state = props.state;
  switch (state.status) {
  case 'downloading':
    return progressPercent.value === undefined
      ? lazyStrings.PromptApiPreparationProgress__downloading_browser_provided_model()
      : lazyStrings.PromptApiPreparationProgress__downloading_browser_provided_model_progress({ progress: progressPercent.value });
  case 'preparing': return lazyStrings.PromptApiPreparationProgress__preparing_browser_provided_model();
  default: {
    const exhaustive: never = state;
    return exhaustive;
  }
  }
});

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div data-testid="prompt-api-preparation-progress" tw-class="space-y-3">
    <div tw-class="flex items-center gap-2.5 text-xs font-medium leading-relaxed text-gray-700 dark:text-gray-200">
      <DownloadIcon v-if="state.status === 'downloading'" aria-hidden="true" tw-class="h-4 w-4 shrink-0 text-blue-500 dark:text-blue-400" />
      <Loader2Icon v-else aria-hidden="true" tw-class="h-4 w-4 shrink-0 animate-spin text-blue-500 motion-reduce:animate-none dark:text-blue-400" />
      <span tw-class="min-w-0 tabular-nums">{{ label }}</span>
    </div>
    <div
      v-if="state.status === 'downloading'"
      data-testid="prompt-api-download-progress-track"
      role="progressbar"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-valuenow="progressPercent"
      :aria-label="label"
      tw-class="h-1.5 overflow-hidden rounded-full bg-blue-100/80 dark:bg-blue-400/10"
    >
      <div
        v-if="progressPercent !== undefined"
        data-testid="prompt-api-download-progress-determinate"
        tw-class="h-full rounded-full bg-blue-500 transition-[width] duration-300 ease-out motion-reduce:transition-none dark:bg-blue-400"
        :style="{ width: `${progressPercent}%` }"
      />
      <div
        v-else
        class="prompt-api-download-progress-indeterminate"
        data-testid="prompt-api-download-progress-indeterminate"
        tw-class="h-full w-2/5 rounded-full bg-blue-500 dark:bg-blue-400"
      />
    </div>
  </div>
</template>

<style scoped>
@keyframes prompt-api-download-progress-slide {
  0% {
    transform: translateX(-120%);
  }
  100% {
    transform: translateX(350%);
  }
}

.prompt-api-download-progress-indeterminate {
  animation: prompt-api-download-progress-slide 1.4s ease-in-out infinite;
}

@media (prefers-reduced-motion: reduce) {
  .prompt-api-download-progress-indeterminate {
    animation: none;
    transform: translateX(75%);
  }
}
</style>
