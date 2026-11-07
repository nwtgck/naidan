<script setup lang="ts">
import { computed, inject } from 'vue';
import type { WorkflowStep, WorkflowToolExecutionPolicy } from '@/01-models/workflow';
import type { ToolConfig } from '@/01-models/tool';
import type { Volume } from '@/01-models/types';
import { idToRaw, toVolumeId } from '@/01-models/ids';
import { workflowInputDraftsKey } from '@/features/workflow/composables/input-drafts';
import { lazyStrings } from '@/strings';
import SettingsFormSelect from '@/components/SettingsFormSelect.vue';
import ToggleSwitch from '@/components/ToggleSwitch.vue';
import WorkflowNumberInput from './WorkflowNumberInput.vue';
import WorkflowDisclosure from './WorkflowDisclosure.vue';

const props = defineProps<{ step: Extract<WorkflowStep, { type: 'text_generation' }>, volumes: Volume[], disabled: boolean }>();
const emit = defineEmits<{ change: [step: Extract<WorkflowStep, { type: 'text_generation' }>] }>();
const drafts = inject(workflowInputDraftsKey, undefined);
const locked = computed(() => props.disabled || (drafts?.dirty.value ?? false));
const options = computed(() => [
  { key: 'builtin.calculator' as const, label: lazyStrings.ToolConfigHierarchySettings__calculator() },
  { key: 'builtin.choices' as const, label: lazyStrings.workflow__fixed_choices() },
  { key: 'builtin.wikipedia' as const, label: 'Wikipedia' },
  { key: 'builtin.wesh' as const, label: lazyStrings.WeshToolSettings__shell() },
]);
const policy = computed<WorkflowToolExecutionPolicy>(() => props.step.toolExecution ?? { maxRounds: 8, maxCalls: 32, shell: undefined });
const shellEnabled = computed(() => props.step.toolConfigs.some(tool => tool.key === 'builtin.wesh' && tool.status === 'enabled'));
const volumeOptions = computed(() => [{ value: '', label: lazyStrings.workflow__not_selected() }, ...props.volumes.map(volume => ({ value: idToRaw({ id: volume.id }), label: volume.name }))]);

function toggle({ key }: { key: ToolConfig['key'] }): void {
  if (locked.value) {
    return;
  }
  const current = props.step.toolConfigs.find(tool => tool.key === key);
  const currentStatus = current?.status;
  const status = (() => {
    switch (currentStatus) {
    case 'enabled': return 'disabled' as const;
    case 'disabled': case undefined: return 'enabled' as const;
    default: {
      const exhaustive: never = currentStatus;
      throw new Error(String(exhaustive));
    }
    }
  })();
  const config: ToolConfig = (() => {
    switch (key) {
    case 'builtin.wesh': return { key, status, naidanSysfs: { accessScope: 'none' } };
    case 'builtin.calculator': case 'builtin.choices': case 'builtin.wikipedia': return { key, status };
    default: {
      const exhaustive: never = key;
      throw new Error(String(exhaustive));
    }
    }
  })();
  const toolConfigs = [...props.step.toolConfigs.filter(tool => tool.key !== key), config];
  const toolExecution = { ...policy.value };
  if (key === 'builtin.wesh' && status === 'enabled') {
    toolExecution.shell ??= { volumeId: toVolumeId({ raw: '' }), access: 'read-only' };
  }
  emit('change', { ...props.step, toolConfigs, toolExecution });
}

function changeLimits({ maxRounds, maxCalls }: { maxRounds: number, maxCalls: number }): void {
  // The number editor owns its incomplete draft; allow its valid commit.
  if (!locked.value) {
    emit('change', { ...props.step, toolExecution: { ...policy.value, maxRounds, maxCalls } });
  }
}

function changeShell({ volumeId, access }: { volumeId: string, access: 'read-only' | 'read-write' }): void {
  if (!locked.value) {
    emit('change', { ...props.step, toolExecution: { ...policy.value, shell: { volumeId: toVolumeId({ raw: volumeId }), access } } });
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <WorkflowDisclosure :title="lazyStrings.workflow__model_tools()" data-testid="workflow-model-tools">
    <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.workflow__model_tools_notice() }}</p>
    <label v-for="option in options" :key="option.key" tw-class="flex items-center gap-2 text-sm">
      <ToggleSwitch><input type="checkbox" :data-tool-key="option.key" :checked="step.toolConfigs.some(tool => tool.key === option.key && tool.status === 'enabled')" :disabled="locked" @change="toggle({ key: option.key })" /></ToggleSwitch>{{ option.label }}
    </label>
    <div tw-class="grid gap-3 sm:grid-cols-2">
      <label tw-class="space-y-1 text-xs text-gray-600 dark:text-gray-300">{{ lazyStrings.workflow__tool_round_limit() }}<WorkflowNumberInput :value="policy.maxRounds" :disabled="disabled" :label="lazyStrings.workflow__tool_round_limit()" @change="changeLimits({ maxRounds: $event, maxCalls: policy.maxCalls })" /></label>
      <label tw-class="space-y-1 text-xs text-gray-600 dark:text-gray-300">{{ lazyStrings.workflow__tool_call_limit() }}<WorkflowNumberInput :value="policy.maxCalls" :disabled="disabled" :label="lazyStrings.workflow__tool_call_limit()" @change="changeLimits({ maxRounds: policy.maxRounds, maxCalls: $event })" /></label>
    </div>
    <template v-if="shellEnabled">
      <SettingsFormSelect :model-value="policy.shell === undefined ? '' : idToRaw({ id: policy.shell.volumeId })" :options="volumeOptions" :label="lazyStrings.workflow__folder()" :disabled="locked" @update:model-value="changeShell({ volumeId: $event, access: policy.shell?.access ?? 'read-only' })" />
      <SettingsFormSelect :model-value="policy.shell?.access ?? 'read-only'" :options="[{ value: 'read-only' as const, label: lazyStrings.workflow__read_only() }, { value: 'read-write' as const, label: lazyStrings.workflow__read_write() }]" :label="lazyStrings.workflow__folder_permission()" :disabled="locked" @update:model-value="changeShell({ volumeId: policy.shell === undefined ? '' : idToRaw({ id: policy.shell.volumeId }), access: $event })" />
      <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.workflow__model_tools_folder_help() }}</p>
    </template>
  </WorkflowDisclosure>
</template>
