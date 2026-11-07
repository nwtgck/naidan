<script setup lang="ts">
import { ref } from 'vue';
import type { WorkflowStep, WorkflowValue } from '@/01-models/workflow';
import type { JsonValue } from '@/01-models/lm';
import type { WorkflowTypeScope } from '@/features/workflow/logic/value-types';
import { replaceJsonValue, validateJsonAssignments, validateJsonCompositionBaseEdit } from '@/features/workflow/logic/json-composition';
import WorkflowJsonNode from './WorkflowJsonNode.vue';
import WorkflowJsonInput from './WorkflowJsonInput.vue';
import WorkflowDisclosure from './WorkflowDisclosure.vue';
import { lazyStrings } from '@/strings';
const props = defineProps<{ value: Extract<WorkflowValue, { type: 'json_compose' }>, steps: WorkflowStep[], scope: WorkflowTypeScope, disabled: boolean }>();
const emit = defineEmits<{ change: [value: WorkflowValue] }>();
const error = ref('');

function bind({ path, value }: { path: (string | number)[], value: WorkflowValue }): void {
  const assignments = props.value.assignments.filter(item => JSON.stringify(item.path) !== JSON.stringify(path));
  assignments.push({ path, value });
  try {
    validateJsonAssignments({ base: props.value.base, paths: assignments.map(item => item.path) });
    emit('change', { ...props.value, assignments });
    error.value = '';
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason);
  }
}

function validateBase({ value }: { value: JsonValue }): void {
  validateJsonCompositionBaseEdit({ before: props.value.base, after: value, paths: props.value.assignments.map(item => item.path) });
}

function literal({ path, value }: { path: (string | number)[], value: JsonValue }): void {
  try {
    const base = replaceJsonValue({ base: props.value.base, path, value });
    validateBase({ value: base });
    emit('change', { ...props.value, base });
    error.value = '';
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason);
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div tw-class="space-y-3" data-testid="workflow-json-composer">
    <div tw-class="min-w-0 overflow-x-auto rounded-xl border border-gray-200/80 dark:border-gray-700/70 bg-gray-50/60 dark:bg-gray-800/40 p-3 text-xs leading-7 font-mono text-gray-700 dark:text-gray-200">
      <WorkflowJsonNode :value="value.base" :path="[]" :assignments="value.assignments" :steps="steps" :scope="scope" :disabled="disabled" @bind="bind" @literal="literal" @unbind="emit('change', { ...value, assignments: value.assignments.filter(item => JSON.stringify(item.path) !== JSON.stringify($event.path)) })" />
    </div>
    <p v-if="error" role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ error }}</p>
    <WorkflowDisclosure :title="lazyStrings.workflow__edit_base_json()" :initially-open="Object.keys(value.base ?? {}).length === 0">
      <WorkflowJsonInput :value="value.base" :disabled="disabled" :validate="validateBase" @change="emit('change', { ...value, base: $event })" />
    </WorkflowDisclosure>
  </div>
</template>
