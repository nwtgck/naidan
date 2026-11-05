<script setup lang="ts">
import { computed, inject } from 'vue';
import type { WorkflowImagePreview } from '@/01-models/workflow';
import { workflowInputDraftsKey } from '@/features/workflow/composables/input-drafts';
import { lazyStrings } from '@/strings';
import SettingsFormSelect from '@/components/SettingsFormSelect.vue';
import ToggleSwitch from '@/components/ToggleSwitch.vue';
import WorkflowNumberInput from './WorkflowNumberInput.vue';
import WorkflowDisclosure from './WorkflowDisclosure.vue';
const props = defineProps<{ value: WorkflowImagePreview | undefined, disabled: boolean }>();
const emit = defineEmits<{ change: [value: WorkflowImagePreview] }>();
const drafts = inject(workflowInputDraftsKey, undefined);
const locked = computed(() => props.disabled || (drafts?.dirty.value ?? false));
const settings = computed<WorkflowImagePreview>(() => props.value ?? { enabled: false, interval: 2, startStep: 1, mode: 'projection', maxEdge: 512 });

function structure({ value }: { value: WorkflowImagePreview }): void {
  if (!locked.value) {
    emit('change', value);
  }
}

function number({ field, value }: { field: 'interval' | 'startStep' | 'maxEdge', value: number }): void {
  if (!locked.value) {
    emit('change', { ...settings.value, [field]: value });
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <WorkflowDisclosure :title="lazyStrings.workflow__live_image_preview()" :initially-open="settings.enabled">
    <label tw-class="flex items-center gap-2 text-xs"><ToggleSwitch><input type="checkbox" :checked="settings.enabled" :disabled="locked" @change="structure({ value: { ...settings, enabled: !settings.enabled } })" data-testid="workflow-image-preview-enabled" /></ToggleSwitch>{{ lazyStrings.workflow__live_image_preview() }}</label>
    <template v-if="settings.enabled">
      <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.workflow__preview_notice() }}</p>
      <SettingsFormSelect :model-value="settings.mode" :disabled="locked" :label="lazyStrings.stableDiffusionCppBrowser__preview_mode()" :options="[{ value: 'projection' as const, label: lazyStrings.stableDiffusionCppBrowser__preview_projection() }, { value: 'vae' as const, label: lazyStrings.stableDiffusionCppBrowser__preview_vae() }]" @update:model-value="structure({ value: { ...settings, mode: $event } })" />
      <label tw-class="block space-y-1 text-xs">{{ lazyStrings.workflow__preview_interval() }}<WorkflowNumberInput :value="settings.interval" :disabled="disabled" :label="lazyStrings.workflow__preview_interval()" @change="number({ field: 'interval', value: $event })" /></label>
      <label tw-class="block space-y-1 text-xs">{{ lazyStrings.workflow__preview_start() }}<WorkflowNumberInput :value="settings.startStep" :disabled="disabled" :label="lazyStrings.workflow__preview_start()" @change="number({ field: 'startStep', value: $event })" /></label>
      <label tw-class="block space-y-1 text-xs">{{ lazyStrings.workflow__preview_max_edge() }}<WorkflowNumberInput :value="settings.maxEdge" :disabled="disabled" :label="lazyStrings.workflow__preview_max_edge()" @change="number({ field: 'maxEdge', value: $event })" /></label>
    </template>
  </WorkflowDisclosure>
</template>
