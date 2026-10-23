<script setup lang="ts">
import { computed } from 'vue';
import { lazyStrings } from '@/strings';
import type { LocalModelLaunchChatUi } from '@/features/llama-cpp-browser/composables/useLocalModelLaunchChat';
import LlamaCppBrowserModelLoadProgress from '@/features/llama-cpp-browser/components/LlamaCppBrowserModelLoadProgress.vue';
import { localModelDisplayName } from './browser-model-presentation';
import BrowserModelPreparation from './BrowserModelPreparation.vue';
import { formatDownloadBytes } from '@/features/llama-cpp-browser/hugging-face/presentation';

const props = defineProps<{ state: LocalModelLaunchChatUi, errorMessage?: string, appearance?: 'full' | 'compact' }>();
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
  if (props.errorMessage !== undefined) {
    return props.errorMessage;
  }
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
    <div v-if="appearance === 'compact'" tw-class="space-y-1.5">
      <div tw-class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p :role="stage === 'failed' ? 'alert' : 'status'" tw-class="text-xs font-medium text-gray-800 dark:text-gray-100">{{ stage === 'failed' ? lazyStrings.LlamaCppBrowserModelLaunch__could_not_prepare_model() : stage === 'ready' ? lazyStrings.LlamaCppBrowserModelLaunch__ready_when_you_are() : lazyStrings.LlamaCppBrowserModelLaunch__loading_model() }}</p>
        <p :title="state.model.value?.modelId" tw-class="flex min-w-0 max-w-full items-baseline gap-2 text-[10px] text-gray-500 dark:text-gray-400"><span data-testid="preparation-model-name" tw-class="truncate">{{ model.name }}</span><span v-if="state.model.value" tw-class="shrink-0 tabular-nums">{{ formatDownloadBytes({ bytes: state.model.value.size }) }}</span></p>
      </div>
      <LlamaCppBrowserModelLoadProgress v-if="stage === 'loading'" :progress="state.progress.value" appearance="compact" />
      <template v-else-if="stage === 'failed'">
        <p v-if="error && error !== lazyStrings.LlamaCppBrowserModelLaunch__could_not_prepare_model()" role="alert" tw-class="text-xs leading-relaxed text-red-600 dark:text-red-400">{{ error }}</p>
        <button type="button" data-testid="start-preview-model" tw-class="min-h-8 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800" @click="state.retry()">{{ lazyStrings.LlamaCppBrowserModelLaunch__retry() }}</button>
      </template>
    </div>
    <BrowserModelPreparation v-else presentation="preparation" :model="model" :entry="state.homeOriginId.value === undefined ? 'local' : 'home'" :stage="stage" interaction="ready" variant="GGUF" :quantization-options="[]" start-status="idle" :error="error" :selection-state="undefined" failure-action="retry" file-source="local" @retry="state.retry()" @back="state.back()">
      <template #progress><LlamaCppBrowserModelLoadProgress :progress="state.progress.value" /></template>
    </BrowserModelPreparation>
  </div>
</template>
