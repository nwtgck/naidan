<script setup lang="ts">
import { computed, onMounted, onUnmounted, shallowRef } from 'vue';
import AssistantWaitingIndicator from '@/components/AssistantWaitingIndicator.vue';
import { Loader2Icon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import { llamaCppBrowserService } from '@/features/llama-cpp-browser';
import type { EngineState } from '@/features/llama-cpp-browser/types';

const props = defineProps<{ scope: 'import' | 'inference', waiting?: boolean, isNested?: boolean }>();
const state = shallowRef<EngineState>(llamaCppBrowserService.getState());
let unsubscribe: (() => void) | undefined;
onMounted(() => {
  unsubscribe = llamaCppBrowserService.subscribe({ listener: ({ state: next }) => {
    state.value = next;
  } });
});
onUnmounted(() => unsubscribe?.());
const importScope = computed(() => {
  switch (props.scope) {
  case 'import': return true;
  case 'inference': return false;
  default: { const exhaustive: never = props.scope; throw new Error(`Unhandled scope: ${exhaustive}`); }
  }
});
const progress = computed(() => {
  const current = state.value;
  switch (current.status) {
  case 'idle': case 'error': case 'unavailable': return undefined;
  case 'working': break;
  default: { const exhaustive: never = current; throw new Error(`Unhandled state: ${exhaustive}`); }
  }
  const value = current.progress;
  switch (value.phase) {
  case 'importing': return importScope.value ? value : undefined;
  case 'initializing': case 'loading': return importScope.value ? undefined : value;
  // The chat already has a streaming indicator. maxTokens is not a completion estimate.
  case 'prefill': case 'generating': case 'decoding-audio': return undefined;
  default: { const exhaustive: never = value.phase; throw new Error(`Unhandled phase: ${exhaustive}`); }
  }
});
const phase = computed(() => {
  const value = progress.value?.phase;
  switch (value) {
  case 'importing': return lazyStrings.llamaCppBrowser__importing();
  case 'initializing': return lazyStrings.llamaCppBrowser__initializing();
  case 'loading': return lazyStrings.llamaCppBrowser__loading();
  case 'prefill': return lazyStrings.llamaCppBrowser__prefill();
  case 'decoding-audio': case 'generating': case undefined: return undefined;
  default: { const exhaustive: never = value; return exhaustive; }
  }
});
const percentage = computed(() => progress.value && progress.value.total > 0
  ? Math.min(100, Math.max(0, Math.round(progress.value.completed / progress.value.total * 100))) : undefined);
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div v-if="progress" role="status" tw-class="flex flex-col gap-2.5 py-3" data-testid="llama-cpp-browser-status">
    <div tw-class="flex items-start justify-between gap-3 text-xs leading-5">
      <div tw-class="flex min-w-0 items-start gap-2">
        <Loader2Icon aria-hidden="true" tw-class="mt-0.5 h-4 w-4 shrink-0 text-gray-400 animate-spin motion-reduce:animate-none" />
        <span tw-class="font-medium text-gray-600 dark:text-gray-300">{{ phase }}</span>
      </div>
      <span v-if="percentage !== undefined" tw-class="shrink-0 tabular-nums text-gray-500 dark:text-gray-400">{{ percentage }}%</span>
    </div>
    <div
      v-if="percentage !== undefined"
      role="progressbar"
      :aria-label="phase"
      :aria-valuenow="percentage"
      :aria-valuemin="0"
      :aria-valuemax="100"
      tw-class="h-1 rounded-full overflow-hidden bg-gray-100 dark:bg-gray-800"
    >
      <div tw-class="h-full rounded-full bg-purple-500/80 dark:bg-purple-400/80 transition-[width] duration-300 ease-out motion-reduce:transition-none" :style="{ width: `${percentage}%` }"></div>
    </div>
  </div>
  <!-- Input processing and token waits are not model loading. The same existing
       waiting UI remains visible until text/thinking arrives, without a bar. -->
  <AssistantWaitingIndicator v-else-if="scope === 'inference' && waiting" :is-nested="isNested" data-testid="loading-indicator" />
</template>
