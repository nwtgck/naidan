<script setup lang="ts">
import { computed, inject } from 'vue';
import type { WorkflowMessagePart, WorkflowStep } from '@/01-models/workflow';
import type { WorkflowTypeScope } from '@/features/workflow/logic/value-types';
import { idToRaw, toToolCallId } from '@/01-models/ids';
import { workflowInputText } from '@/features/workflow/logic/forms';
import { workflowInputDraftsKey } from '@/features/workflow/composables/input-drafts';
import { lazyStrings } from '@/strings';
import SettingsFormSelect from '@/components/SettingsFormSelect.vue';
import WorkflowValueEditor from './WorkflowValueEditor.vue';

type Part = Extract<WorkflowMessagePart, { type: 'tool_call' | 'tool_result' }>;
const props = defineProps<{ part: Part, steps: WorkflowStep[], disabled: boolean, scope?: WorkflowTypeScope }>();
const emit = defineEmits<{ change: [part: Part] }>();
const drafts = inject(workflowInputDraftsKey, undefined);
const locked = computed(() => props.disabled || (drafts?.dirty.value ?? false));

function update({ part }: { part: Part }): void {
  if (!locked.value) {
    emit('change', part);
  }
}

function updateContent({ value }: { value: Extract<Part, { type: 'tool_result' }>['content'] }): void {
  if (!props.disabled && props.part.type === 'tool_result') {
    emit('change', { ...props.part, content: value });
  }
}

const errorCodes = ['invalid_arguments', 'execution_failed', 'timeout', 'other'] as const;
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div tw-class="space-y-2 rounded-lg border border-gray-200 dark:border-gray-700 p-3">
    <p tw-class="text-xs font-semibold">{{ part.type === 'tool_call' ? lazyStrings.workflow__historical_tool_call() : lazyStrings.workflow__historical_tool_result() }}</p>
    <label tw-class="block space-y-1 text-xs">{{ lazyStrings.workflow__tool_call_id() }}<input :value="idToRaw({ id: part.id })" :disabled="locked" @input="update({ part: { ...part, id: toToolCallId({ raw: workflowInputText({ event: $event }) }) } })" tw-class="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent px-3 py-2 font-mono" /></label>
    <template v-if="part.type === 'tool_call'">
      <label tw-class="block space-y-1 text-xs">{{ lazyStrings.workflow__tool_name() }}<input :value="part.name" :disabled="locked" @input="update({ part: { ...part, name: workflowInputText({ event: $event }) } })" tw-class="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent px-3 py-2" /></label>
      <label tw-class="block space-y-1 text-xs">{{ lazyStrings.workflow__tool_raw_arguments() }}<textarea :value="part.arguments" :disabled="locked" rows="3" @input="update({ part: { ...part, arguments: workflowInputText({ event: $event }) } })" tw-class="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent px-3 py-2 font-mono" /></label>
    </template>
    <template v-else>
      <SettingsFormSelect :model-value="part.status" :disabled="locked" :label="lazyStrings.workflow__tool_result_status()" :options="[{ value: 'success' as const, label: 'success' }, { value: 'error' as const, label: 'error' }]" @update:model-value="update({ part: { ...part, status: $event, code: $event === 'success' ? undefined : (part.code ?? 'execution_failed') } })" />
      <SettingsFormSelect v-if="part.status === 'error'" :model-value="part.code ?? 'execution_failed'" :disabled="locked" :label="lazyStrings.workflow__tool_result_code()" :options="errorCodes.map(value => ({ value, label: value }))" @update:model-value="update({ part: { ...part, code: $event } })" />
      <WorkflowValueEditor :value="part.content" :scope="scope" :steps="steps" :disabled="disabled" expected="text" @change="updateContent({ value: $event })" />
    </template>
    <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.workflow__tool_history_notice() }}</p>
  </div>
</template>
