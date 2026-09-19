<script setup lang="ts">
import { computed, onMounted, onUnmounted, shallowRef } from 'vue';
import { Loader2Icon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import { llamaCppBrowserService } from '@/features/llama-cpp-browser';
import type { EngineState } from '@/features/llama-cpp-browser/types';

const props = defineProps<{ scope: 'import' | 'inference' }>();
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
  case 'initializing': case 'loading': case 'prefill': return importScope.value ? undefined : value;
  // The chat already has a streaming indicator. maxTokens is not a completion estimate.
  case 'generating': return undefined;
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
  case 'generating': case undefined: return undefined;
  default: { const exhaustive: never = value; return exhaustive; }
  }
});
const percentage = computed(() => progress.value && progress.value.total > 0
  ? Math.min(100, Math.max(0, Math.round(progress.value.completed / progress.value.total * 100))) : undefined);
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div v-if="progress" role="status" tw-class="flex items-start gap-3 py-3" data-testid="llama-cpp-browser-status">
    <div tw-class="w-8 h-8 rounded-xl flex items-center justify-center bg-purple-50 dark:bg-purple-900/20 border border-purple-100 dark:border-purple-900/30 shrink-0"><Loader2Icon tw-class="w-4 h-4 text-purple-500 animate-spin" /></div>
    <div tw-class="flex-1 min-w-0 space-y-2 pt-1">
      <div tw-class="flex items-center justify-between gap-3 text-xs font-bold text-purple-600 dark:text-purple-400"><span>{{ phase }}</span><span v-if="percentage !== undefined" tw-class="tabular-nums">{{ percentage }}%</span></div>
      <div v-if="percentage !== undefined" role="progressbar" :aria-label="phase" :aria-valuenow="percentage" :aria-valuemin="0" :aria-valuemax="100" tw-class="h-1.5 rounded-full overflow-hidden bg-purple-100 dark:bg-purple-900/30"><div tw-class="h-full rounded-full bg-purple-600 dark:bg-purple-400 transition-all duration-300 ease-out" :style="{ width: `${percentage}%` }"></div></div>
    </div>
  </div>
</template>
