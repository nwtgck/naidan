<script setup lang="ts">
import { computed, defineAsyncComponent, onScopeDispose, ref, watch } from 'vue';
import type { Endpoint } from '@/01-models/types';
import type { LocalModel } from '@/features/llama-cpp-browser/types';
import { lazyStrings } from '@/strings';
import { naturalSort } from '@/utils/string';
import ModelSelector from './ModelSelector.vue';
import { browserChatModelPanels } from './chat-model-selector-panels';
import type { ModelSelectorItem } from './model-selector-item';
import type { SettingsSourcePresentation } from './SettingsSourceBadge.vue';

const RepositoryModelPicker = defineAsyncComponent(() => import('@/features/llama-cpp-browser/components/LlamaCppBrowserRepositoryPicker.vue'));
const ModelSelectorFileImport = defineAsyncComponent(() => import('./ModelSelectorFileImport.vue'));

const props = defineProps<{
  modelValue: string | undefined,
  modelIds: readonly string[],
  endpointType: Endpoint['type'] | undefined,
  surface: 'sidebar' | 'settings',
  frame?: 'embedded',
  inputId?: string,
  popupPresentation?: 'floating' | 'inline',
  placeholder: string | undefined,
  clearLabel?: string,
  allowClear?: boolean,
  inheritedModel?: { id: string | undefined, source: SettingsSourcePresentation | undefined },
  loading: boolean,
  disabled?: boolean,
  modelSelection?: 'available' | 'unavailable',
  refreshModels: () => Promise<void>,
  selectModel: ({ modelId }: { modelId: string | undefined }) => void | Promise<void>,
}>();

const usesSavedModels = computed(() => props.endpointType === 'llama_cpp_browser');
const panels = computed(() => usesSavedModels.value ? browserChatModelPanels({ includeFiles: true }) : undefined);
const sortedModels = computed<ModelSelectorItem[]>(() => {
  const availability = usesSavedModels.value ? 'local' : 'remote';
  return naturalSort({ values: props.modelIds }).map(id => ({ id, label: id, description: undefined, availability }));
});

const addedModels = ref<readonly LocalModel[]>([]);
let disposed = false;
onScopeDispose(() => {
  disposed = true;
});
watch(usesSavedModels, () => {
  addedModels.value = [];
});

async function chooseLocalModel({ model, close }: { model: LocalModel, close: (() => void) | undefined }): Promise<void> {
  if (usesSavedModels.value && !props.disabled) {
    await props.selectModel({ modelId: model.modelId });
    close?.();
  }
}

function refreshAfterFileExplorer(): void {
  if (!disposed && usesSavedModels.value) {
    // An independent title endpoint may own a separate list of local models.
    void props.refreshModels().catch(() => {});
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <ModelSelector
    :surface="surface"
    :frame="frame"
    :input-id="inputId"
    :popup-presentation="popupPresentation"
    :model-value="modelValue || undefined"
    :inherited-model="inheritedModel"
    :models="sortedModels"
    :models-label="usesSavedModels ? lazyStrings.ModelSelector__models_on_this_device() : undefined"
    :panels="panels"
    :initial-panel="usesSavedModels && !modelValue && inheritedModel === undefined ? 'chat-candidates' : undefined"
    :loading="loading"
    :disabled="disabled"
    :model-selection="modelSelection ?? (endpointType === 'browser_provided_lm' ? 'unavailable' : 'available')"
    :placeholder="placeholder"
    :allow-clear="allowClear"
    :clear-label="clearLabel"
    :refresh-after-file-explorer="refreshAfterFileExplorer"
    @update:model-value="modelId => selectModel({ modelId })"
    @refresh="refreshModels"
  >
    <template v-if="$slots['trigger-label']" #trigger-label><slot name="trigger-label" /></template>
    <template v-if="$slots['trigger-summary']" #trigger-summary><slot name="trigger-summary" /></template>
    <template v-if="$slots.unavailable" #unavailable><slot name="unavailable" /></template>
    <template v-if="$slots.settings" #settings="{ popupTarget }"><slot name="settings" :popup-target="popupTarget" /></template>
    <template #panel="{ panel, active, close, popupTarget }">
      <div v-if="panel === 'files'" tw-class="py-3">
        <ModelSelectorFileImport
          v-model:added="addedModels"
          :available-model-ids="modelIds"
          :selected-model-id="modelValue || undefined"
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
        :current-model-id="modelValue || undefined"
        :refresh-inventory="refreshModels"
        @select-model="(model, presentation) => chooseLocalModel({ model, close: presentation === 'keep-open' ? undefined : close })"
        @close="close()"
      />
    </template>
  </ModelSelector>
</template>
