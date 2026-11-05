<script setup lang="ts">
import { computed, inject } from 'vue';
import type { WorkflowStep, WorkflowToolSelection, WorkflowValue } from '@/01-models/workflow';
import type { Volume } from '@/01-models/types';
import { idToRaw, toVolumeId } from '@/01-models/ids';
import { lazyStrings } from '@/strings';
import { workflowInputDraftsKey } from '@/features/workflow/composables/input-drafts';
import { defaultWorkflowToolArguments, workflowToolArgumentFields } from '@/features/workflow/logic/tool-input';
import SettingsFormSelect from '@/components/SettingsFormSelect.vue';
import WorkflowValueEditor from './WorkflowValueEditor.vue';
import WorkflowDisclosure from './WorkflowDisclosure.vue';

const props = defineProps<{ step: Extract<WorkflowStep, { type: 'tool_call' }>, steps: WorkflowStep[], volumes: Volume[], disabled: boolean }>();
const emit = defineEmits<{ change: [step: Extract<WorkflowStep, { type: 'tool_call' }>] }>();
const drafts = inject(workflowInputDraftsKey, undefined);
const locked = computed(() => props.disabled || (drafts?.dirty.value ?? false));
const names: WorkflowToolSelection['name'][] = ['calculator', 'wikipedia_search', 'wikipedia_get_page', 'shell_execute'];
const toolOptions = computed(() => names.map(name => {
  switch (name) {
  case 'calculator': return { value: name, label: lazyStrings.ToolConfigHierarchySettings__calculator() };
  case 'wikipedia_search': return { value: name, label: lazyStrings.chatApproval__search_wikipedia() };
  case 'wikipedia_get_page': return { value: name, label: lazyStrings.chatApproval__get_wikipedia_page() };
  case 'shell_execute': return { value: name, label: lazyStrings.WeshToolSettings__shell() };
  default: {
    const exhaustive: never = name;
    throw new Error(String(exhaustive));
  }
  }
}));
const volumeOptions = computed(() => [{ value: '', label: lazyStrings.workflow__not_selected() }, ...props.volumes.map(volume => ({ value: idToRaw({ id: volume.id }), label: volume.name }))]);
const properties = computed(() => workflowToolArgumentFields({ value: props.step.arguments }));
const fields = computed(() => {
  const text = 'text' as const, number = 'number' as const;
  switch (props.step.tool.name) {
  case 'calculator': return [{ key: 'expression', label: lazyStrings.workflow__expression(), expected: text }];
  case 'wikipedia_search': return [{ key: 'lang', label: lazyStrings.workflow__language_code(), expected: text }, { key: 'query', label: lazyStrings.workflow__search_query(), expected: text }];
  case 'wikipedia_get_page': return [{ key: 'lang', label: lazyStrings.workflow__language_code(), expected: text }, { key: 'pageId', label: lazyStrings.workflow__page_id(), expected: number }];
  case 'shell_execute': return [
    { key: 'shell_script', label: lazyStrings.workflow__shell_script(), expected: text },
    { key: 'stdout_limit', label: lazyStrings.workflow__stdout_limit_bytes(), expected: number },
    { key: 'stderr_limit', label: lazyStrings.workflow__stderr_limit_bytes(), expected: number },
    { key: 'timeout_ms', label: lazyStrings.workflow__shell_timeout_milliseconds(), expected: number },
  ];
  default: {
    const exhaustive: never = props.step.tool;
    throw new Error(String(exhaustive));
  }
  }
});

function choose({ name }: { name: WorkflowToolSelection['name'] }): void {
  if (!locked.value && name !== props.step.tool.name) {
    const tool: WorkflowToolSelection = (() => {
      switch (name) {
      case 'shell_execute': return { name, volumeId: toVolumeId({ raw: '' }), access: 'read-only' };
      case 'calculator': case 'wikipedia_search': case 'wikipedia_get_page': return { name };
      default: {
        const exhaustive: never = name;
        throw new Error(String(exhaustive));
      }
      }
    })();
    emit('change', { ...props.step, tool, arguments: defaultWorkflowToolArguments({ name }) });
  }
}

function updateShell({ volumeId, access }: { volumeId: string, access: 'read-only' | 'read-write' }): void {
  if (!locked.value && props.step.tool.name === 'shell_execute') {
    emit('change', { ...props.step, tool: { name: 'shell_execute', volumeId: toVolumeId({ raw: volumeId }), access } });
  }
}

function updatePolicy({ onError }: { onError: 'fail' | 'continue' }): void {
  if (!locked.value) {
    emit('change', { ...props.step, onError });
  }
}

function updateArguments({ value }: { value: WorkflowValue }): void {
  if (!props.disabled) {
    emit('change', { ...props.step, arguments: value });
  }
}

function fieldValue({ key }: { key: string }): WorkflowValue {
  if (properties.value && Object.hasOwn(properties.value, key)) {
    return properties.value[key]!;
  }
  // Only optional shell defaults are effective at runtime. Never display a
  // plausible default for an absent required argument without storing it.
  switch (key) {
  case 'stdout_limit': return { type: 'literal', value: 16384 };
  case 'stderr_limit': return { type: 'literal', value: 8192 };
  case 'timeout_ms': return { type: 'literal', value: 8000 };
  case 'pageId': return { type: 'literal', value: 0 };
  default: return { type: 'literal', value: '' };
  }
}

function updateField({ key, value }: { key: string, value: WorkflowValue }): void {
  // ValueEditor owns its in-progress number/JSON draft; committing it must work
  // while structural operations (tool/volume changes) remain locked.
  if (!props.disabled && properties.value !== undefined) {
    emit('change', { ...props.step, arguments: { type: 'object', properties: { ...properties.value, [key]: value } } });
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div data-testid="workflow-tool-editor" tw-class="space-y-4">
    <SettingsFormSelect :model-value="step.tool.name" :options="toolOptions" :label="lazyStrings.workflow__tool()" :disabled="locked" @update:model-value="choose({ name: $event })" />
    <template v-if="step.tool.name === 'shell_execute'">
      <SettingsFormSelect :model-value="idToRaw({ id: step.tool.volumeId })" :options="volumeOptions" :label="lazyStrings.workflow__folder()" :disabled="locked" @update:model-value="updateShell({ volumeId: $event, access: step.tool.access })" />
      <SettingsFormSelect :model-value="step.tool.access" :options="[{ value: 'read-only' as const, label: lazyStrings.workflow__read_only() }, { value: 'read-write' as const, label: lazyStrings.workflow__read_write() }]" :label="lazyStrings.workflow__folder_permission()" :disabled="locked" @update:model-value="updateShell({ volumeId: idToRaw({ id: step.tool.volumeId }), access: $event })" />
      <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.workflow__shell_mount_notice() }}</p>
    </template>
    <template v-if="properties !== undefined">
      <div v-for="field in fields" :key="field.key" :data-tool-field="field.key" tw-class="space-y-2">
        <h3 tw-class="text-xs font-medium text-gray-600 dark:text-gray-300">{{ field.label }}</h3>
        <WorkflowValueEditor :value="fieldValue({ key: field.key })" :expected="field.expected" :steps="steps" :disabled="disabled" @change="updateField({ key: field.key, value: $event })" />
      </div>
      <WorkflowDisclosure :title="lazyStrings.workflow__tool_arguments()">
        <WorkflowValueEditor :value="step.arguments" expected="json" :steps="steps" :disabled="disabled" @change="updateArguments({ value: $event })" />
      </WorkflowDisclosure>
    </template>
    <WorkflowValueEditor v-else :value="step.arguments" expected="json" :steps="steps" :disabled="disabled" @change="updateArguments({ value: $event })" />
    <SettingsFormSelect :model-value="step.onError" :label="lazyStrings.workflow__tool_failure_policy()" :disabled="locked" :options="[{ value: 'fail' as const, label: lazyStrings.workflow__stop_on_tool_failure() }, { value: 'continue' as const, label: lazyStrings.workflow__continue_with_error_output() }]" @update:model-value="updatePolicy({ onError: $event })" />
  </div>
</template>
