<script setup lang="ts">
import { computed } from 'vue';
import { lazyStrings } from '@/strings';
import type { LocalModelLaunchChatUi } from '@/features/llama-cpp-browser/composables/useLocalModelLaunchChat';
import LlamaCppBrowserModelLoadProgress from '@/features/llama-cpp-browser/components/LlamaCppBrowserModelLoadProgress.vue';
import { localModelDisplayName } from './browser-model-presentation';
import BrowserModelPreparation from './BrowserModelPreparation.vue';

const props = defineProps<{ state: LocalModelLaunchChatUi }>();
const model = computed(() => {
  const current = props.state.model.value;
  if (current === undefined) {
    return undefined;
  }
  const developer = current.source?.directoryName ?? lazyStrings.LocalModelPreparation__local_files();
  if (developer === undefined) {
    return undefined;
  }
  return { name: localModelDisplayName({ model: current }), developer, repository: current.modelId, bytes: current.size };
});
const stage = computed(() => {
  const status = props.state.status.value;
  switch (status) {
  case 'loading': return 'loading';
  case 'ready': return 'ready';
  case 'error': return 'failed';
  default: {
    const exhaustive: never = status;
    return exhaustive;
  }
  }
});
const error = computed(() => {
  const status = props.state.status.value;
  switch (status) {
  case 'loading': case 'ready': return undefined;
  case 'error': {
    const code = props.state.error.value;
    switch (code) {
    case 'unavailable': return lazyStrings.LlamaCppBrowserModelLaunch__unavailable_here();
    case undefined: case 'invalid-gguf': case 'duplicate-model': case 'missing-model': case 'storage-error':
    case 'runtime-error': case 'template-unsupported': case 'reasoning-unsupported': case 'context-full': case 'unsupported-input':
    case 'busy': case 'aborted': case 'worker-failed': case 'audio-model-unsupported': case 'audio-reference-required': case 'audio-reference-invalid': case 'audio-output-empty':
      return lazyStrings.LlamaCppBrowserModelLaunch__could_not_prepare_model();
    default: {
      const exhaustive: never = code;
      return exhaustive;
    }
    }
  }
  default: {
    const exhaustive: never = status;
    return exhaustive;
  }
  }
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div v-if="state.visible.value && model" data-testid="local-model-preparation" tw-class="w-full pointer-events-auto">
    <BrowserModelPreparation :model="model" :entry="state.homeOriginId.value === undefined ? 'local' : 'home'" :stage="stage" interaction="ready" variant="GGUF" :quantization-options="[]" start-status="idle" :error="error" :selection-state="undefined" failure-action="retry" file-source="local" @retry="state.retry()" @back="state.back()">
      <template #progress><LlamaCppBrowserModelLoadProgress :progress="state.progress.value" /></template>
    </BrowserModelPreparation>
  </div>
</template>
