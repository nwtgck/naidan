<script setup lang="ts">
import { computed } from 'vue';
import { ServerCogIcon } from 'lucide-vue-next';
import type { FakeLmDebugModeStatus } from '@/services/fake-lm';
import { createOllamaProvider } from '@/services/lm/providerFactory';
import OllamaPsView from './OllamaPsView.vue';

const props = defineProps<{
  endpointUrl: string | undefined;
  endpointHttpHeaders: [string, string][] | undefined;
  fakeLmDebugModeStatus: FakeLmDebugModeStatus;
}>();

const provider = computed(() => createOllamaProvider({
  endpointUrl: props.endpointUrl,
  endpointHttpHeaders: props.endpointHttpHeaders,
  fakeLmDebugModeStatus: props.fakeLmDebugModeStatus,
}));

defineExpose({
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  },
});
</script>

<template>
  <section
    class="space-y-5 border-t border-gray-100 pt-6 dark:border-gray-800"
    aria-labelledby="ollama-runtime-heading"
    data-testid="ollama-management-view"
  >
    <div class="flex items-center gap-2 border-b border-gray-100 pb-3 dark:border-gray-800">
      <ServerCogIcon class="h-5 w-5 text-blue-500" />
      <h2 id="ollama-runtime-heading" class="text-lg font-bold tracking-tight text-gray-800 dark:text-white">
        Ollama Runtime
      </h2>
    </div>

    <p class="ml-1 text-[11px] font-medium leading-relaxed text-gray-400">
      View and unload models currently held in memory by this Ollama server.
    </p>

    <OllamaPsView
      :provider="provider"
      :endpoint-url="props.endpointUrl"
    />
  </section>
</template>
