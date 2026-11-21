<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from 'vue';
import type { Reasoning } from '@/01-models/types';
import type { LocalModel } from '@/features/llama-cpp-browser/types';
import { useSettings } from '@/composables/useSettings';
import { useToast } from '@/composables/useToast';
import { naturalSort } from '@/utils/string';
import { ensureStrings, lazyStrings } from '@/strings';
import ChatModelSelector from './ChatModelSelector.vue';
import type { ModelSelectorItem } from './model-selector-item';
import ReasoningSettings from './ReasoningSettings.vue';
import { browserChatModelPanels } from './chat-model-selector-panels';

const RepositoryModelPicker = defineAsyncComponent(() => import('@/features/llama-cpp-browser/components/LlamaCppBrowserRepositoryPicker.vue'));
const ModelSelectorFileImport = defineAsyncComponent(() => import('./ModelSelectorFileImport.vue'));

defineProps<{ expanded: boolean }>();

const { settings, isFetchingModels, availableModels, fetchModels, updateGlobalModel, updateGlobalReasoningEffort } = useSettings();
const { addToast } = useToast();
const reasoningSaveState = ref<'idle' | 'saving'>('idle');
const usesSavedModels = computed(() => settings.value.endpoint.type === 'llama_cpp_browser');
const panels = computed(() => usesSavedModels.value ? browserChatModelPanels({ includeFiles: true }) : undefined);
const addedModels = ref<readonly LocalModel[]>([]);
watch(usesSavedModels, () => {
  addedModels.value = [];
});
const globalReasoningLabel = computed(() => {
  const effort = settings.value.lmParameters?.reasoning.effort;
  switch (effort) {
  case undefined: return undefined;
  case 'none': return lazyStrings.ReasoningSettings__off();
  case 'low': return lazyStrings.ReasoningSettings__low();
  case 'medium': return lazyStrings.ReasoningSettings__med();
  case 'high': return lazyStrings.ReasoningSettings__high();
  default: {
    const _ex: never = effort;
    throw new Error(`Unhandled reasoning effort: ${_ex}`);
  }
  }
});
const globalReasoningDescription = computed(() => {
  const heading = lazyStrings.ReasoningSettings__think();
  const label = globalReasoningLabel.value;
  return heading === undefined || label === undefined ? undefined : `${heading} ${label}`;
});

async function handleGlobalReasoningChange({ effort }: { effort: Reasoning['effort'] }) {
  const saveState = reasoningSaveState.value;
  switch (saveState) {
  case 'saving': return;
  case 'idle': break;
  default: {
    const _ex: never = saveState;
    throw new Error(`Unhandled reasoning save state: ${_ex}`);
  }
  }
  reasoningSaveState.value = 'saving';
  try {
    await updateGlobalReasoningEffort({ effort });
  } catch {
    addToast({ message: await ensureStrings.Sidebar__failed_to_save_reasoning() });
  } finally {
    reasoningSaveState.value = 'idle';
  }
}

async function handleGlobalModelChange({ newModelId }: { newModelId: string | undefined }) {
  if (!newModelId) {
    return;
  }
  await updateGlobalModel({ modelId: newModelId });
}

const sortedModels = computed<ModelSelectorItem[]>(() => {
  const availability = usesSavedModels.value ? 'local' : 'remote';
  return naturalSort({ values: availableModels.value || [] }).map(id => ({ id, label: id, description: undefined, availability }));
});

async function refreshModels(): Promise<void> {
  // useSettings reports refresh errors through the application's error log.
  await fetchModels({}).catch(() => {});
}

async function chooseLocalModel({ model, close }: { model: LocalModel, close: (() => void) | undefined }): Promise<void> {
  if (!usesSavedModels.value) {
    return;
  }
  await handleGlobalModelChange({ newModelId: model.modelId });
  close?.();
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <ChatModelSelector
    v-if="expanded"
    surface="sidebar"
    :model-value="settings.defaultModelId || undefined"
    :models="sortedModels"
    :models-label="usesSavedModels ? lazyStrings.ModelSelector__models_on_this_device() : undefined"
    :panels="panels"
    :initial-panel="usesSavedModels && !settings.defaultModelId ? 'chat-candidates' : undefined"
    :loading="isFetchingModels"
    :model-selection="settings.endpoint.type === 'browser_provided_lm' ? 'unavailable' : 'available'"
    @update:model-value="newModelId => handleGlobalModelChange({ newModelId })"
    @refresh="refreshModels"
    :placeholder="lazyStrings.Sidebar__none()"
  >
    <template #trigger-label>{{ lazyStrings.Sidebar__default_model() }}</template>
    <template v-if="globalReasoningLabel !== undefined" #trigger-summary>
      <span data-testid="sidebar-reasoning-summary" :title="globalReasoningDescription"><span tw-class="sr-only">{{ lazyStrings.ReasoningSettings__think() }} </span><span data-testid="sidebar-reasoning-value">{{ globalReasoningLabel }}</span></span>
    </template>
    <template #unavailable>{{ lazyStrings.Sidebar__model_selection_is_unavailable_for_this_connection() }}</template>
    <template #panel="{ panel, active, close, popupTarget }">
      <div v-if="panel === 'files'" tw-class="py-3">
        <ModelSelectorFileImport
          v-model:added="addedModels"
          :selected-model-id="settings.defaultModelId || undefined"
          :disabled="!active"
          @choose="model => chooseLocalModel({ model, close })"
          @inventory-changed="refreshModels"
        />
      </div>
      <RepositoryModelPicker
        v-else
        :layout="panel === 'chat-candidates' ? 'candidate-results' : 'inline-results'"
        :disabled="!active"
        :popup-target="popupTarget"
        selection-policy="installed-only"
        :current-model-id="settings.defaultModelId || undefined"
        :refresh-inventory="refreshModels"
        @select-model="(model, presentation) => chooseLocalModel({ model, close: presentation === 'keep-open' ? undefined : close })"
        @close="close()"
      />
    </template>
    <template #settings="{ popupTarget }">
      <ReasoningSettings :selected-effort="settings.lmParameters?.reasoning.effort" :disabled="reasoningSaveState === 'saving'" :popup-target="popupTarget" surface="plain" layout="inline" notice="inline-help" @update:effort="handleGlobalReasoningChange({ effort: $event })" />
    </template>
  </ChatModelSelector>
</template>
