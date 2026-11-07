<script setup lang="ts">
import { computed, inject, ref } from 'vue';
import type { WorkflowImageParameters, WorkflowStep } from '@/01-models/workflow';
import { workflowImageParameterKeys } from '@/features/workflow/logic/image-input';
import { workflowInputDraftsKey } from '@/features/workflow/composables/input-drafts';
import { lazyStrings } from '@/strings';
import ToggleSwitch from '@/components/ToggleSwitch.vue';
import WorkflowImageInputsEditor from './WorkflowImageInputsEditor.vue';
import WorkflowImagePreviewSettings from './WorkflowImagePreviewSettings.vue';
import WorkflowImageModelEditor from './WorkflowImageModelEditor.vue';
import WorkflowImageParameterEditor from './WorkflowImageParameterEditor.vue';
import WorkflowValueEditor from './WorkflowValueEditor.vue';
import WorkflowDisclosure from './WorkflowDisclosure.vue';
const props = defineProps<{ step: Extract<WorkflowStep, { type: 'image_generation' }>, steps: WorkflowStep[], disabled: boolean }>();
const emit = defineEmits<{ change: [step: Extract<WorkflowStep, { type: 'image_generation' }>] }>();
const drafts = inject(workflowInputDraftsKey, undefined);
const locked = computed(() => props.disabled || (drafts?.dirty.value ?? false));
const modelValueMode = ref(props.step.model.type !== 'literal');
const basic: (keyof WorkflowImageParameters)[] = ['width', 'height', 'steps', 'seed'];
const advanced = workflowImageParameterKeys.filter(key => !basic.includes(key));
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div data-testid="workflow-image-editor" tw-class="space-y-4">
    <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.workflow__local_image_help() }}</p>
    <section tw-class="space-y-2">
      <div tw-class="flex items-center justify-between gap-2"><h3 tw-class="text-sm font-semibold">{{ lazyStrings.workflow__model() }}</h3><button type="button" :disabled="locked" @click="modelValueMode = !modelValueMode" data-testid="workflow-image-model-value" tw-class="text-xs text-blue-600 dark:text-blue-400 disabled:opacity-40">{{ modelValueMode ? lazyStrings.workflow__fixed_value() : lazyStrings.workflow__choose_value() }}</button></div>
      <WorkflowValueEditor v-if="modelValueMode" :value="step.model" :steps="steps" :disabled="disabled" expected="json" @change="emit('change', { ...step, model: $event })" />
      <WorkflowImageModelEditor v-else :value="step.model" :disabled="locked" @change="emit('change', { ...step, model: $event })" />
    </section>
    <section tw-class="space-y-2">
      <h3 tw-class="text-sm font-semibold">{{ lazyStrings.stableDiffusionCppBrowser__prompt() }}</h3>
      <WorkflowValueEditor :value="step.prompt" :steps="steps" :disabled="disabled" expected="text" @change="emit('change', { ...step, prompt: $event })" />
    </section>
    <WorkflowImageInputsEditor :step="step" :steps="steps" :disabled="disabled" @change="emit('change', $event)" />
    <WorkflowImagePreviewSettings :value="step.preview" :disabled="disabled" @change="emit('change', { ...step, preview: $event })" />
    <WorkflowImageParameterEditor v-for="key in basic" :key="key" :field="key" :value="step.parameters[key]" :steps="steps" :disabled="disabled" @change="emit('change', { ...step, parameters: { ...step.parameters, [key]: $event } })" />
    <WorkflowDisclosure :title="lazyStrings.stableDiffusionCppBrowser__runtime_settings()" :initially-open="false">
      <WorkflowImageParameterEditor v-for="key in advanced" :key="key" :field="key" :value="step.parameters[key]" :steps="steps" :disabled="disabled" @change="emit('change', { ...step, parameters: { ...step.parameters, [key]: $event } })" />
      <label tw-class="flex items-center gap-2 text-xs"><ToggleSwitch><input type="checkbox" :checked="step.gpuBudgetMiB !== undefined" :disabled="locked" @change="emit('change', { ...step, gpuBudgetMiB: step.gpuBudgetMiB === undefined ? { type: 'literal', value: 2048 } : undefined })" data-testid="workflow-image-budget-enabled" /></ToggleSwitch>{{ lazyStrings.stableDiffusionCppBrowser__gpu_budget() }}</label>
      <WorkflowValueEditor v-if="step.gpuBudgetMiB !== undefined" :value="step.gpuBudgetMiB" :steps="steps" :disabled="disabled" expected="number" @change="emit('change', { ...step, gpuBudgetMiB: $event })" />
      <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__gpu_budget_help() }}</p>
    </WorkflowDisclosure>
    <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.workflow__image_outputs_help() }}</p>
  </div>
</template>
