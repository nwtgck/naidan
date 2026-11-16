<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Reasoning } from '@/01-models/types';
import { useSettings } from '@/composables/useSettings';
import { useToast } from '@/composables/useToast';
import { naturalSort } from '@/utils/string';
import { ensureStrings, lazyStrings } from '@/strings';
import ModelSelector from './ModelSelector.vue';
import ReasoningSettings from './ReasoningSettings.vue';

defineProps<{ expanded: boolean }>();

const { settings, isFetchingModels, availableModels, updateGlobalModel, updateGlobalReasoningEffort } = useSettings();
const { addToast } = useToast();
const reasoningSaveState = ref<'idle' | 'saving'>('idle');
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

const sortedModels = computed(() => naturalSort({ values: availableModels.value || [] }));
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <ModelSelector
    v-if="expanded"
    surface="sidebar"
    :model-value="settings.defaultModelId || ''"
    :models="sortedModels"
    :loading="isFetchingModels"
    :model-selection="settings.endpoint.type === 'browser_provided_lm' ? 'unavailable' : 'available'"
    @update:model-value="newModelId => handleGlobalModelChange({ newModelId })"
    :placeholder="lazyStrings.Sidebar__none()"
  >
    <template #trigger-label>{{ lazyStrings.Sidebar__default_model() }}</template>
    <template v-if="globalReasoningLabel !== undefined" #trigger-summary>
      <span data-testid="sidebar-reasoning-summary" :title="globalReasoningDescription"><span tw-class="sr-only">{{ lazyStrings.ReasoningSettings__think() }} </span><span data-testid="sidebar-reasoning-value">{{ globalReasoningLabel }}</span></span>
    </template>
    <template #unavailable>{{ lazyStrings.Sidebar__model_selection_is_unavailable_for_this_connection() }}</template>
    <template #settings>
      <ReasoningSettings :selected-effort="settings.lmParameters?.reasoning.effort" :disabled="reasoningSaveState === 'saving'" surface="plain" notice="inline-help" @update:effort="handleGlobalReasoningChange({ effort: $event })" />
    </template>
  </ModelSelector>
</template>
