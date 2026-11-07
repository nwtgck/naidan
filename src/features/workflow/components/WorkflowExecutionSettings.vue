<script setup lang="ts">
import { computed, inject } from 'vue';
import type { WorkflowExecutionLimits } from '@/01-models/workflow';
import { lazyStrings } from '@/strings';
import ToggleSwitch from '@/components/ToggleSwitch.vue';
import WorkflowDisclosure from './WorkflowDisclosure.vue';
import WorkflowNumberInput from './WorkflowNumberInput.vue';
import { DEFAULT_WORKFLOW_EXECUTION_LIMITS, workflowExecutionLimitIssues } from '@/features/workflow/logic/execution-control';
import { workflowInputDraftsKey } from '@/features/workflow/composables/input-drafts';

const props = defineProps<{ value: WorkflowExecutionLimits | undefined, disabled: boolean, running: boolean }>();
const emit = defineEmits<{ change: [value: WorkflowExecutionLimits | undefined] }>();
const drafts = inject(workflowInputDraftsKey, undefined);
const effective = computed(() => props.value ?? DEFAULT_WORKFLOW_EXECUTION_LIMITS);
const locked = computed(() => props.disabled || (drafts?.dirty.value ?? false));
const problems = computed(() => workflowExecutionLimitIssues({ limits: props.value }));
const counts = computed(() => [
  { key: 'maxLoopIterations' as const, label: lazyStrings.workflow__total_loop_iterations() },
  { key: 'maxStepExecutions' as const, label: lazyStrings.workflow__step_executions() },
  { key: 'maxValueEvaluations' as const, label: lazyStrings.workflow__value_evaluations() },
]);

// Effective defaults stay visible. Editing one field materializes a complete
// local configuration; resetting it does not affect a run already in progress.
function count({ key, value }: { key: 'maxLoopIterations' | 'maxStepExecutions' | 'maxValueEvaluations', value: number }): void {
  if (!props.disabled) {
    emit('change', { ...effective.value, [key]: value });
  }
}

function time({ seconds }: { seconds: number }): void {
  if (!props.disabled) {
    emit('change', { ...effective.value, timeoutMs: seconds * 1000 });
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <WorkflowDisclosure :title="lazyStrings.workflow__execution_limits()" :initially-open="false" data-testid="workflow-execution-settings">
    <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.workflow__execution_limits_hint() }}</p>
    <p v-if="running" tw-class="text-xs text-blue-600 dark:text-blue-400">{{ lazyStrings.workflow__limits_apply_next_run() }}</p>
    <div tw-class="grid grid-cols-1 sm:grid-cols-3 gap-3">
      <label v-for="field in counts" :key="field.key" tw-class="space-y-1.5 min-w-0 text-xs font-medium text-gray-600 dark:text-gray-300">
        <span>{{ field.label }}</span>
        <WorkflowNumberInput :value="effective[field.key]" :disabled="disabled" :label="field.label" @change="count({ key: field.key, value: $event })" />
      </label>
    </div>
    <label tw-class="flex items-center justify-between gap-3 text-sm">
      <span>{{ lazyStrings.workflow__time_limit() }}</span>
      <ToggleSwitch><input type="checkbox" :checked="effective.timeoutMs !== undefined" :disabled="locked" :aria-label="lazyStrings.workflow__time_limit()" @change="emit('change', { ...effective, timeoutMs: effective.timeoutMs === undefined ? 300000 : undefined })" /></ToggleSwitch>
    </label>
    <WorkflowNumberInput v-if="effective.timeoutMs !== undefined" :value="effective.timeoutMs / 1000" :label="lazyStrings.workflow__timeout_seconds()" :disabled="disabled" @change="time({ seconds: $event })" />
    <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.workflow__timeout_includes_waiting() }}</p>
    <p v-for="problem in problems" :key="problem" role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ problem }}</p>
    <button type="button" :disabled="locked || value === undefined" @click="emit('change', undefined)" tw-class="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40 transition-colors">{{ lazyStrings.workflow__use_default_limits() }}</button>
  </WorkflowDisclosure>
</template>
