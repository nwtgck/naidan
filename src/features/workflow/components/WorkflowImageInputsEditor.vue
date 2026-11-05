<script setup lang="ts">
import { computed, inject } from 'vue';
import type { WorkflowStep, WorkflowImageInputs, WorkflowValue } from '@/01-models/workflow';
import { workflowInputDraftsKey } from '@/features/workflow/composables/input-drafts';
import { lazyStrings } from '@/strings';
import ToggleSwitch from '@/components/ToggleSwitch.vue';
import WorkflowValueEditor from './WorkflowValueEditor.vue';
import WorkflowDisclosure from './WorkflowDisclosure.vue';

const props = defineProps<{ step: Extract<WorkflowStep, { type: 'image_generation' }>, steps: WorkflowStep[], disabled: boolean }>();
const emit = defineEmits<{ change: [step: Extract<WorkflowStep, { type: 'image_generation' }>] }>();
const drafts = inject(workflowInputDraftsKey, undefined);
const locked = computed(() => props.disabled || (drafts?.dirty.value ?? false));
const inputs = computed<WorkflowImageInputs>(() => props.step.imageInputs ?? { initImage: undefined, referenceImages: [], strength: { type: 'literal', value: 0.75 } });

function structure({ value }: { value: WorkflowImageInputs }): void {
  if (!locked.value) {
    emit('change', { ...props.step, imageInputs: value });
  }
}

function expression({ field, value, index }: { field: 'initImage' | 'strength' | 'reference', value: WorkflowValue, index: number | undefined }): void {
  if (props.disabled) {
    return;
  }
  switch (field) {
  case 'initImage': emit('change', { ...props.step, imageInputs: { ...inputs.value, initImage: value } });
    break;
  case 'strength': emit('change', { ...props.step, imageInputs: { ...inputs.value, strength: value } });
    break;
  case 'reference':
    if (index !== undefined && index >= 0 && index < inputs.value.referenceImages.length) {
      emit('change', { ...props.step, imageInputs: { ...inputs.value, referenceImages: inputs.value.referenceImages.map((item, i) => i === index ? value : item) } });
    }
    break;
  default: {
    const exhaustive: never = field;
    throw new Error(String(exhaustive));
  }
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <WorkflowDisclosure :title="lazyStrings.workflow__image_inputs()" :initially-open="step.imageInputs !== undefined" data-testid="workflow-image-inputs">
    <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.workflow__image_inputs_help() }}</p>
    <label tw-class="flex items-center gap-2 text-xs"><ToggleSwitch><input type="checkbox" :disabled="locked" :checked="inputs.initImage !== undefined" @change="structure({ value: { ...inputs, initImage: inputs.initImage === undefined ? { type: 'literal', value: null } : undefined } })" data-testid="workflow-initial-image-enabled" /></ToggleSwitch>{{ lazyStrings.workflow__initial_image() }}</label>
    <template v-if="inputs.initImage !== undefined">
      <WorkflowValueEditor :value="inputs.initImage" :steps="steps" :disabled="disabled" expected="binary" @change="expression({ field: 'initImage', value: $event, index: undefined })" />
      <h3 tw-class="text-xs font-semibold">{{ lazyStrings.workflow__image_strength() }}</h3>
      <WorkflowValueEditor :value="inputs.strength" :steps="steps" :disabled="disabled" expected="number" @change="expression({ field: 'strength', value: $event, index: undefined })" />
    </template>
    <h3 tw-class="text-xs font-semibold">{{ lazyStrings.workflow__reference_images() }}</h3>
    <div v-for="(reference, index) in inputs.referenceImages" :key="index" tw-class="space-y-2 rounded-lg border border-gray-200 dark:border-gray-700 p-3">
      <WorkflowValueEditor :value="reference" :steps="steps" :disabled="disabled" expected="binary" @change="expression({ field: 'reference', value: $event, index })" />
      <button type="button" :disabled="locked" @click="structure({ value: { ...inputs, referenceImages: inputs.referenceImages.filter((_, i) => i !== index) } })" tw-class="text-xs text-red-600 dark:text-red-400 disabled:opacity-40">{{ lazyStrings.workflow__delete() }}</button>
    </div>
    <button type="button" :disabled="locked || inputs.referenceImages.length >= 8" @click="structure({ value: { ...inputs, referenceImages: [...inputs.referenceImages, { type: 'literal', value: null }] } })" tw-class="text-xs text-blue-600 dark:text-blue-400 disabled:opacity-40">{{ lazyStrings.workflow__add_reference_image() }}</button>
  </WorkflowDisclosure>
</template>
