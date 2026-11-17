<script setup lang="ts">
import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue';
import ModelSelectorHuggingFaceSearch from '@/components/ModelSelectorHuggingFaceSearch.vue';
import LlamaCppBrowserLocalFiles from '@/features/llama-cpp-browser/components/LlamaCppBrowserLocalFiles.vue';
import type { RepositoryCatalog } from '@/features/llama-cpp-browser/hugging-face/catalog';
import { getMetadataSession } from '@/features/llama-cpp-browser/hugging-face/metadata-session';
import { formatDownloadBytes } from '@/features/llama-cpp-browser/hugging-face/presentation';
import { confirmModelLaunchConfiguration, modelLaunchChoices } from '@/features/llama-cpp-browser/model-launch/target';
import type { AudioTranscriptionModelImport, useAudioTranscriptionModels } from '@/features/audio-transcription/composables/useAudioTranscriptionModels';
import { lazyStrings } from '@/strings';
import { awaitInspection } from '@/logic/model-file-inspection/abort';

const props = defineProps<{ models: ReturnType<typeof useAudioTranscriptionModels>, disabled: boolean, mode: 'files' | 'huggingface', active: boolean, query: string }>();
const emit = defineEmits<{ selected: [], 'update:query': [value: string] }>();
const catalog = shallowRef<RepositoryCatalog>();
const metadataRequest = shallowRef<AbortController>();
const failed = ref(false);
const mainPath = ref('');
const blocked = computed(() => props.disabled || props.models.busy.value || !props.active);
// ASR currently supports one complete GGUF, without shards or companions.
const choices = computed(() => catalog.value === undefined ? [] : modelLaunchChoices({ catalog: catalog.value }).filter(choice => choice.models.length === 1 && choice.models[0]?.files.length === 1));
const target = computed(() => {
  if (catalog.value === undefined || mainPath.value === '') {
    return undefined;
  }
  try {
    return confirmModelLaunchConfiguration({ catalog: catalog.value, mainFilePath: mainPath.value, companionFilePath: undefined, multimodal: 'off' });
  } catch {
    return undefined;
  }
});

function resetRepository(): void {
  metadataRequest.value?.abort();
  metadataRequest.value = undefined;
  catalog.value = undefined;
  mainPath.value = '';
  failed.value = false;
}

async function inspectRepository({ repository }: { repository: string }): Promise<void> {
  if (blocked.value || metadataRequest.value !== undefined) {
    return;
  }
  resetRepository();
  const controller = new AbortController();
  metadataRequest.value = controller;
  try {
    // Only a submitted repository or an explicitly selected search result
    // authorizes this request. Typing and opening this panel stay local.
    const result = await awaitInspection({ task: getMetadataSession().inspect({ input: repository, signal: controller.signal, freshness: 'reuse' }), signal: controller.signal });
    controller.signal.throwIfAborted();
    catalog.value = result;
  } catch {
    if (!controller.signal.aborted) {
      failed.value = true;
    }
  } finally {
    if (metadataRequest.value === controller) {
      metadataRequest.value = undefined;
    }
  }
}

function selectRepository(): void {
  const selected = target.value;
  if (blocked.value || selected === undefined) {
    return;
  }
  props.models.addRepositoryModel({ selection: selected.selection });
  emit('selected');
}

async function importFiles({ input: request }: { input: AudioTranscriptionModelImport }): Promise<void> {
  await props.models.importModels(request);
  if (!request.controller.signal.aborted && props.models.failure.value === undefined) {
    emit('selected');
  }
}

watch(() => props.query, resetRepository);
watch(blocked, value => {
  if (value) {
    metadataRequest.value?.abort();
  }
});
onScopeDispose(resetRepository);
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div data-testid="audio-transcription-model-sources" tw-class="space-y-4 text-left">
    <div v-if="mode === 'files'">
      <LlamaCppBrowserLocalFiles :disabled="blocked" layout="compact" @accept="importFiles({ input: $event })" />
    </div>
    <div v-else tw-class="space-y-3">
      <ModelSelectorHuggingFaceSearch :query="query" :active="props.active" :disabled="disabled || models.busy.value || metadataRequest !== undefined" @update:query="emit('update:query', $event)" @select="inspectRepository({ repository: $event })" />
      <p v-if="failed" role="alert" tw-class="text-sm text-red-600 dark:text-red-400">{{ lazyStrings.AudioTranscriptionModelSources__could_not_check_repository() }}</p>
      <div v-if="catalog" tw-class="space-y-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
        <p tw-class="break-all text-sm font-medium">{{ catalog.repository }}</p>
        <label tw-class="block space-y-2 text-sm">
          <span>{{ lazyStrings.AudioTranscriptionModelSources__model_file() }}</span>
          <select v-model="mainPath" :disabled="blocked" data-testid="audio-transcription-model-repository-file" tw-class="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 dark:border-gray-600 dark:bg-gray-900">
            <option value="">{{ lazyStrings.AudioTranscriptionModelSources__choose_a_file() }}</option>
            <option v-for="choice in choices" :key="choice.primaryRelativePath" :value="choice.primaryRelativePath">{{ choice.primaryRelativePath }} · {{ formatDownloadBytes({ bytes: choice.models[0]?.size ?? 0 }) }}</option>
          </select>
        </label>
        <p v-if="choices.length === 0" role="status" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.AudioTranscriptionModelSources__no_single_file_models() }}</p>
        <button type="button" :disabled="blocked || target === undefined" data-testid="audio-transcription-model-select-repository" tw-class="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40" @click="selectRepository">{{ lazyStrings.AudioTranscriptionModelSources__select_model() }}</button>
      </div>
    </div>
    <p v-if="models.busy.value" role="status" tw-class="text-sm text-gray-500 dark:text-gray-400">{{ lazyStrings.AudioTranscriptionModelSources__preparing_model() }}</p>
    <p v-if="models.failure.value" role="alert" tw-class="text-sm text-red-600 dark:text-red-400">{{ lazyStrings.AudioTranscriptionModelSources__could_not_prepare_model() }}</p>
  </div>
</template>
