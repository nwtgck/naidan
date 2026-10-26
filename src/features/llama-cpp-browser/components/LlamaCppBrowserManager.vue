<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import { useSettings } from '@/composables/useSettings';
import { useRecentModelImports } from '@/features/llama-cpp-browser/composables/useRecentModelImports';
import { provideLlamaCppBrowserSettingsTypography } from '@/features/llama-cpp-browser/composables/useLlamaCppBrowserSettingsTypography';
import { llamaCppBrowserService } from '@/features/llama-cpp-browser';
import type { EngineState, LocalModel } from '@/features/llama-cpp-browser/types';
import type { ApplyDefaultModel, DefaultModelContext } from '@/features/llama-cpp-browser/default-model';
import type { ModelPreset } from '@/features/llama-cpp-browser/model-preset';
import { getDownloadQueue, jobIsBusy } from '@/features/llama-cpp-browser/hugging-face/download-queue';
import LlamaCppBrowserModelLibrary from './LlamaCppBrowserModelLibrary.vue';
import LlamaCppBrowserModelSuggestions from './LlamaCppBrowserModelSuggestions.vue';
import LlamaCppBrowserHuggingFaceManager from './LlamaCppBrowserHuggingFaceManager.vue';
import LlamaCppBrowserRuntimeSettings from './LlamaCppBrowserRuntimeSettings.vue';

// Settings keeps its catalog and runtime controls around the shared file library.
const props = defineProps<{ presentation: 'settings' | 'embedded', suspended?: boolean, suggestions?: 'chat' | 'none', modelPreset?: ModelPreset, defaultModel?: DefaultModelContext, applyDefaultModel?: ApplyDefaultModel, createChatGroup?: ({ model, signal }: { model: LocalModel, signal: AbortSignal }) => Promise<void> }>();
provideLlamaCppBrowserSettingsTypography({ presentation: () => props.presentation });
const emit = defineEmits<{ modelsChanged: [models: LocalModel[]], modelSelected: [modelId: string], runtimeReady: [ready: boolean] }>();
const library = ref<InstanceType<typeof LlamaCppBrowserModelLibrary>>();
const repositoryManager = ref<InstanceType<typeof LlamaCppBrowserHuggingFaceManager>>();
const downloading = ref(false);
const { settings, initialized } = useSettings();
const { prune: pruneRecentModels } = useRecentModelImports();
watch([settings, initialized], pruneRecentModels);
const state = shallowRef<EngineState>(llamaCppBrowserService.getState());
const runtimeStatus = computed(() => {
  const current = state.value;
  switch (current.status) {
  case 'idle': case 'error': return 'idle';
  case 'working': return 'working';
  case 'unavailable': return 'unavailable';
  default: {
    const exhaustive: never = current;
    throw new Error(String(exhaustive));
  }
  }
});
let unsubscribe: (() => void) | undefined;
onMounted(() => {
  unsubscribe = llamaCppBrowserService.subscribe({
    listener: ({ state: next }) => {
      state.value = next;
    },
  });
});
const queue = getDownloadQueue();
const externalBusy = computed(() => downloading.value || queue.jobs.value.some(job => jobIsBusy({ job })));
const defaultActionDisabled = computed(() => !props.defaultModel || !props.applyDefaultModel);

async function inspectRepository({ input }: { input: string }): Promise<void> {
  await repositoryManager.value?.inspectRepository({ input });
}

defineSlots<{ catalog({ disabled, inspect }: { disabled: boolean, inspect: typeof inspectRepository }): unknown }>();

async function refresh(): Promise<void> {
  await library.value?.refresh();
}

watch(queue.changed, () => {
  void refresh();
});
onUnmounted(() => {
  unsubscribe?.();
  emit('runtimeReady', false);
});
defineExpose({ refresh, ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <section data-testid="llama-cpp-browser-manager">
    <LlamaCppBrowserModelLibrary ref="library" :suspended="props.suspended" :external-busy="externalBusy" :runtime-status="runtimeStatus" :default-model="defaultModel" :apply-default-model="applyDefaultModel" :create-chat-group="props.createChatGroup" @models-changed="emit('modelsChanged', $event)" @model-selected="emit('modelSelected', $event)">
      <template #header="{ disabled, refresh: refreshModels, selectReadyModel, invalidateModelSelection }">
        <slot name="catalog" :disabled="disabled || downloading" :inspect="inspectRepository" />
        <LlamaCppBrowserHuggingFaceManager ref="repositoryManager" :model-preset="props.modelPreset" :disabled="disabled" @busy="downloading = $event" @changed="refreshModels" @model-ready="selectReadyModel({ model: $event })" @selection-changed="invalidateModelSelection" />
      </template>
      <template #suggestions="{ models, disabled, createChatGroup, creatingChatGroupModelId, selectDefault, refresh: refreshModels }">
        <!-- Bundled suggestions require no network request until an explicit action. -->
        <LlamaCppBrowserModelSuggestions v-if="props.suggestions !== 'none'" :models="models" :disabled="disabled" :default-model="defaultModel" :default-action-disabled="defaultActionDisabled" :create-chat-group="createChatGroup" :creating-chat-group-model-id="creatingChatGroupModelId" @select-default="selectDefault({ model: $event })" @changed="refreshModels" />
      </template>
      <template #footer="{ disabled, releaseDisabled }">
        <LlamaCppBrowserRuntimeSettings :disabled="disabled" :release-disabled="releaseDisabled" @runtime-ready="emit('runtimeReady', $event)" />
      </template>
    </LlamaCppBrowserModelLibrary>
  </section>
</template>
