<script setup lang="ts">
import { computed, onMounted, onUnmounted, shallowRef } from 'vue';
import { lazyStrings } from '@/strings';
import { llamaCppBrowserService } from '@/features/llama-cpp-browser';
import type { EngineState } from '@/features/llama-cpp-browser/types';
const state = shallowRef<EngineState>(llamaCppBrowserService.getState());
let unsubscribe: (() => void) | undefined;
onMounted(() => {
  unsubscribe = llamaCppBrowserService.subscribe({ listener: ({ state: next }) => {
    state.value = next;
  } });
});
onUnmounted(() => unsubscribe?.());
const phase = computed(() => {
  const current = state.value;
  switch (current.status) {
  case 'unavailable': return lazyStrings.llamaCppBrowser__unavailable_in_standalone();
  case 'error': return lazyStrings.llamaCppBrowser__operation_failed();
  case 'idle': return lazyStrings.llamaCppBrowser__ready();
  case 'working':
    switch (current.progress.phase) {
    case 'importing': return lazyStrings.llamaCppBrowser__importing();
    case 'initializing': return lazyStrings.llamaCppBrowser__initializing();
    case 'loading': return lazyStrings.llamaCppBrowser__loading();
    case 'prefill': return lazyStrings.llamaCppBrowser__prefill();
    case 'generating': return lazyStrings.llamaCppBrowser__generating();
    default: { const exhaustive: never = current.progress.phase; return exhaustive; }
    }
  default: { const exhaustive: never = current; return exhaustive; }
  }
});
const percentage = computed(() => state.value.status === 'working' && state.value.progress.total > 0
  ? Math.min(100, Math.round(state.value.progress.completed / state.value.progress.total * 100)) : undefined);
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div role="status" tw-class="text-xs text-gray-600 dark:text-gray-300 space-y-2" data-testid="llama-cpp-browser-status">
    <p>{{ phase }}</p>
    <progress v-if="percentage !== undefined" :value="percentage" max="100" tw-class="w-full" />
    <code v-if="state.status === 'error'">{{ state.code }}</code>
  </div>
</template>
