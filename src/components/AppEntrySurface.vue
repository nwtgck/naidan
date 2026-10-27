<script setup lang="ts">
import { computed } from 'vue';
import LlamaCppBrowserModelLaunchEntry from '@/features/llama-cpp-browser/components/LlamaCppBrowserModelLaunchEntry.vue';
import { useAppEntry } from '@/composables/useAppEntry';

const entry = useAppEntry();
const modelInput = computed(() => {
  const intent = entry.intent.value;
  switch (intent.kind) {
  case 'model-preview': return intent.input;
  case 'home': case 'ordinary': case 'pending': return undefined;
  default: {
    const exhaustive: never = intent;
    throw new Error(String(exhaustive));
  }
  }
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div data-testid="app-entry-surface" :inert="entry.interaction.value === 'blocked' || undefined" :aria-busy="entry.interaction.value === 'blocked'" tw-class="relative flex h-full min-h-0 flex-col overflow-hidden bg-[#fcfcfd] dark:bg-gray-900">
    <LlamaCppBrowserModelLaunchEntry v-if="entry.intent.value.kind === 'model-preview'" :input="modelInput" :interaction="entry.interaction.value" />
  </div>
</template>
