<script setup lang="ts">
import { computed, inject } from 'vue';
import { PlusIcon, Trash2Icon } from 'lucide-vue-next';
import { workflowInputDraftsKey } from '@/features/workflow/composables/input-drafts';
import type { WorkflowMessage, WorkflowStep } from '@/01-models/workflow';
import type { WorkflowTypeScope } from '@/features/workflow/logic/value-types';
import { toToolCallId } from '@/01-models/ids';
import WorkflowToolHistoryPart from './WorkflowToolHistoryPart.vue';
import WorkflowValueEditor from './WorkflowValueEditor.vue';
import SettingsFormSelect from '@/components/SettingsFormSelect.vue';
import { lazyStrings } from '@/strings';
const props = defineProps<{ messages: WorkflowMessage[], steps: WorkflowStep[], disabled: boolean, scope?: WorkflowTypeScope }>();
const emit = defineEmits<{ change: [messages: WorkflowMessage[]] }>();
const drafts = inject(workflowInputDraftsKey, undefined);
const formDisabled = computed(() => props.disabled || (drafts?.dirty.value ?? false));
const roles: { value: WorkflowMessage['role'], label: string }[] = [{ value: 'system', label: 'system' }, { value: 'user', label: 'user' }, { value: 'assistant', label: 'assistant' }, { value: 'tool', label: 'tool' }];

function update({ index, message }: { index: number, message: WorkflowMessage }): void {
  if (!props.disabled) {
    emit('change', props.messages.map((item, i) => i === index ? message : item));
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div tw-class="space-y-3">
    <div v-for="(message, index) in messages" :key="index" tw-class="p-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50/40 dark:bg-gray-800/20 space-y-3">
      <div tw-class="flex items-end gap-2">
        <div tw-class="flex-1 min-w-0"><SettingsFormSelect :model-value="message.role" :options="roles" :disabled="formDisabled" :label="lazyStrings.workflow__role()" @update:model-value="update({ index, message: { ...message, role: $event } })" /></div>
        <button type="button" :disabled="formDisabled" :aria-label="lazyStrings.workflow__delete()" @click="emit('change', messages.filter((_, i) => index !== i))" tw-class="p-2.5 rounded-lg text-gray-400 hover:bg-red-50 dark:hover:bg-red-950/30 hover:text-red-500 disabled:opacity-40"><Trash2Icon tw-class="w-4 h-4" /></button>
      </div>
      <div v-for="(part, partIndex) in message.parts" :key="partIndex" tw-class="space-y-1">
        <WorkflowToolHistoryPart v-if="part.type === 'tool_call' || part.type === 'tool_result'" :part="part" :steps="steps" :scope="scope" :disabled="disabled" @change="update({ index, message: { ...message, parts: message.parts.map((p, i) => i === partIndex ? $event : p) } })" />
        <label v-else-if="part.type === 'reasoning'" tw-class="block text-xs text-gray-500">
          {{ lazyStrings.workflow__reasoning_part() }}
          <textarea :value="part.text" :disabled="formDisabled" @input="update({ index, message: { ...message, parts: message.parts.map((p, i) => i === partIndex ? { type: 'reasoning', text: ($event.target as HTMLTextAreaElement).value } : p) } })" rows="3" tw-class="block w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-transparent p-2 text-sm" />
        </label>
        <WorkflowValueEditor v-else :value="part.type === 'text' ? { type: 'literal', value: part.text } : part.value" :scope="scope" :steps="steps" :disabled="disabled" expected="text" @change="update({ index, message: { ...message, parts: message.parts.map((p, i) => i === partIndex ? { type: 'value', value: $event } : p) } })" />
        <button v-if="message.parts.length > 1" type="button" :disabled="formDisabled" @click="update({ index, message: { ...message, parts: message.parts.filter((_, i) => i !== partIndex) } })" tw-class="text-xs text-gray-500 hover:text-red-500">{{ lazyStrings.workflow__delete() }}</button>
      </div>
      <button v-if="message.role !== 'tool'" type="button" :disabled="formDisabled" @click="update({ index, message: { ...message, parts: [...message.parts, { type: 'text', text: '' }] } })" tw-class="flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline disabled:opacity-40"><PlusIcon tw-class="w-3.5 h-3.5" />{{ lazyStrings.workflow__add_text_part() }}</button>
      <button v-if="message.role === 'assistant'" type="button" :disabled="formDisabled" @click="update({ index, message: { ...message, parts: [...message.parts, { type: 'tool_call', id: toToolCallId({ raw: '' }), name: '', arguments: '{}' }] } })" tw-class="text-xs text-blue-600 dark:text-blue-400 disabled:opacity-40">{{ lazyStrings.workflow__historical_tool_call() }}</button>
      <button v-if="message.role === 'tool'" type="button" :disabled="formDisabled" @click="update({ index, message: { ...message, parts: [...message.parts, { type: 'tool_result', id: toToolCallId({ raw: '' }), status: 'success', code: undefined, content: { type: 'literal', value: '' } }] } })" tw-class="text-xs text-blue-600 dark:text-blue-400 disabled:opacity-40">{{ lazyStrings.workflow__historical_tool_result() }}</button>
    </div>
    <button type="button" :disabled="formDisabled" @click="emit('change', [...messages, { role: 'user', parts: [{ type: 'text', text: '' }] }])" tw-class="flex items-center gap-2 rounded-lg border border-dashed border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/30 disabled:opacity-40"><PlusIcon tw-class="w-4 h-4" />{{ lazyStrings.workflow__add_message() }}</button>
  </div>
</template>
