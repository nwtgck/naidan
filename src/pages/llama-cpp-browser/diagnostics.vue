<script setup lang="ts">
import { computed } from 'vue';
import { useSettings } from '@/composables/useSettings';
import LlamaCppBrowserDiagnosticsPage from '@/features/llama-cpp-browser/components/LlamaCppBrowserDiagnosticsPage.vue';
const { settings } = useSettings();
const defaultModel = computed(() => {
  const type = settings.value.endpoint.type;
  switch (type) {
  case 'llama_cpp_browser': return settings.value.defaultModelId;
  case 'openai': case 'ollama': case 'transformers_js': case 'browser_provided_lm': case 'naidan_rpc': case 'unsupported_experimental_endpoint': return undefined;
  default: {
    const exhaustive: never = type;
    throw new Error(String(exhaustive));
  }
  }
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template><LlamaCppBrowserDiagnosticsPage :default-model="defaultModel" /></template>
