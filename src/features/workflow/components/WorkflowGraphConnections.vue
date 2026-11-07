<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { WorkflowDefinition, WorkflowStep } from '@/01-models/workflow';
import { idToRaw } from '@/01-models/ids';
import { lazyStrings } from '@/strings';
import SettingsFormSelect from '@/components/SettingsFormSelect.vue';
import { workflowReferenceChoices, workflowValueMode, workflowValueModeLabel } from '@/features/workflow/logic/value-inputs';
import { workflowTypeCompatibility, type WorkflowValueBinding } from '@/features/workflow/logic/value-types';
import { workflowGraphLocationLabel, type WorkflowGraphRequest } from '@/features/workflow/logic/graph';

const props = defineProps<{ definition: WorkflowDefinition, step: WorkflowStep, bindings: WorkflowValueBinding[], disabled: boolean }>();
const emit = defineEmits<{ edit: [request: WorkflowGraphRequest] }>();
const inputKey = ref(''), sourceKey = ref('');
const inputs = computed(() => props.bindings.map(binding => ({ value: JSON.stringify(binding.location), label: `${workflowGraphLocationLabel({ location: binding.location })} · ${binding.expected}` })));
const input = computed(() => props.bindings.find(binding => JSON.stringify(binding.location) === inputKey.value));
const choices = computed(() => input.value ? workflowReferenceChoices({ scope: input.value.scope, expected: input.value.expected }) : []);
const choice = computed(() => choices.value.find(choice => choice.id === sourceKey.value));
const sources = computed(() => [{ value: '', label: lazyStrings.workflow__not_selected() }, ...choices.value.map(choice => ({ value: choice.id, label: `${choice.label ?? ''} · ${'stepId' in choice.value ? idToRaw({ id: choice.value.stepId }) : ''} · ${choice.type.kind}` }))]);
const unknown = computed(() => input.value && choice.value && workflowTypeCompatibility({ actual: choice.value.type, expected: input.value.expected }) === 'unknown');
const current = computed(() => {
  const value = input.value?.value;
  if (!value) {
    return undefined;
  }
  switch (value.type) {
  case 'step_output': return `${idToRaw({ id: value.stepId })} · ${value.output}`;
  case 'loop_state': return `${idToRaw({ id: value.stepId })} · ${value.key} · ${lazyStrings.workflow__loop_state() ?? ''}`;
  case 'loop_item': case 'loop_index': return `${idToRaw({ id: value.stepId })} · ${workflowValueModeLabel({ mode: value.type }) ?? ''}`;
  case 'literal': case 'model': case 'array': case 'object': case 'concat': case 'path': case 'get': case 'filename': case 'format_number': case 'equals': case 'not_empty': case 'conversation': case 'range': case 'json_compose': case 'arithmetic': case 'compare': case 'all': case 'any': case 'not': return workflowValueModeLabel({ mode: workflowValueMode({ value }) });
  default: {
    const exhaustive: never = value;
    throw new Error(String(exhaustive));
  }
  }
});
const unchanged = computed(() => input.value && choice.value && JSON.stringify(input.value.value) === JSON.stringify(choice.value.value));

watch(() => props.definition, () => {
  inputKey.value = '';
  sourceKey.value = '';
}, { flush: 'sync' });
watch(() => props.step.id, () => {
  inputKey.value = '';
  sourceKey.value = '';
}, { flush: 'sync' });

function selectInput({ key }: { key: string }): void {
  if (!props.disabled && inputs.value.some(input => input.value === key)) {
    inputKey.value = key;
    sourceKey.value = '';
  }
}

function selectSource({ key }: { key: string }): void {
  if (!props.disabled && sources.value.some(source => source.value === key)) {
    sourceKey.value = key;
  }
}

function apply(): void {
  if (props.disabled || !input.value || !choice.value || unchanged.value) {
    return;
  }
  emit('edit', { definition: props.definition, edit: { type: 'connect', stepId: props.step.id, location: input.value.location, previous: input.value.value, reference: choice.value.value } });
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <section data-testid="workflow-graph-connections" tw-class="rounded-xl border border-blue-200 dark:border-blue-800 p-3 space-y-3">
    <h3 tw-class="text-sm font-semibold">{{ lazyStrings.workflow__graph_connect() }} · {{ step.name }}</h3>
    <p v-if="!bindings.length" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.workflow__graph_no_inputs() }}</p>
    <template v-else>
      <SettingsFormSelect data-testid="graph-input" :model-value="inputKey" :options="[{ value: '', label: lazyStrings.workflow__not_selected() }, ...inputs]" :label="lazyStrings.workflow__graph_input()" :disabled="disabled" @update:model-value="selectInput({ key: $event })" />
      <template v-if="input">
        <p data-testid="graph-current" tw-class="text-xs break-words text-gray-600 dark:text-gray-300">{{ lazyStrings.workflow__graph_current() }}: {{ current }}</p>
        <SettingsFormSelect data-testid="graph-source" :model-value="sourceKey" :options="sources" :label="lazyStrings.workflow__graph_source()" :disabled="disabled" @update:model-value="selectSource({ key: $event })" />
        <p v-if="!choices.length" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.workflow__graph_no_sources() }}</p>
        <p v-if="unknown" data-testid="graph-unknown" tw-class="text-xs text-amber-700 dark:text-amber-300">{{ lazyStrings.workflow__graph_unknown_type() }}</p>
        <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.workflow__graph_replace_notice() }}</p>
        <button type="button" data-testid="graph-connect-apply" :disabled="disabled || !choice || unchanged" @click="apply" tw-class="rounded-lg bg-blue-600 hover:bg-blue-700 px-3 py-2 text-xs font-medium text-white disabled:opacity-40">{{ lazyStrings.workflow__apply() }}</button>
      </template>
    </template>
  </section>
</template>
