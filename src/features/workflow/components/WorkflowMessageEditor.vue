<script setup lang="ts">
import { computed, inject } from 'vue';
import { workflowInputDraftsKey } from '@/features/workflow/composables/input-drafts';
import type { WorkflowMessage, WorkflowStep } from '@/01-models/workflow';
import WorkflowValueEditor from './WorkflowValueEditor.vue';
import { lazyStrings } from '@/strings';
import { workflowInputText } from '@/features/workflow/logic/forms';
const props = defineProps<{ messages: WorkflowMessage[], steps: WorkflowStep[], disabled: boolean }>();
const emit = defineEmits<{ change: [messages: WorkflowMessage[]] }>();
const drafts = inject(workflowInputDraftsKey, undefined);
const formDisabled = computed(() => props.disabled || (drafts?.dirty.value ?? false));

function update({ index, message }: { index: number, message: WorkflowMessage }): void {
  emit('change', props.messages.map((item, i) => i === index ? message : item));
}

function role({ event, index, message }: { event: Event, index: number, message: WorkflowMessage }): void {
  const value = workflowInputText({ event });
  if (value === 'system' || value === 'user' || value === 'assistant') {
    update({ index, message: { ...message, role: value } });
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div tw-class="space-y-3">
    <div v-for="(message, index) in messages" :key="index" tw-class="p-3 rounded-xl border border-gray-200 dark:border-gray-700 space-y-2">
      <div tw-class="flex items-center gap-2">
        <select :value="message.role" :disabled="formDisabled" @change="role({ event: $event, index, message })" tw-class="w-full min-w-0 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50" :aria-label="lazyStrings.workflow__role()"><option value="system">system</option><option value="user">user</option><option value="assistant">assistant</option></select>
        <button type="button" :disabled="formDisabled" @click="emit('change', messages.filter((_, i) => index !== i))" tw-class="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-40">{{ lazyStrings.workflow__delete() }}</button>
      </div>
      <div v-for="(part, partIndex) in message.parts" :key="partIndex">
        <WorkflowValueEditor :value="part.type === 'text' ? { type: 'literal', value: part.text } : part.value" :steps="steps" :disabled="disabled" @change="update({ index, message: { ...message, parts: message.parts.map((p, i) => i === partIndex ? { type: 'value', value: $event } : p) } })" />
      </div>
    </div>
    <button type="button" :disabled="formDisabled" @click="emit('change', [...messages, { role: 'user', parts: [{ type: 'text', text: '' }] }])" tw-class="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-40">＋ {{ lazyStrings.workflow__add_message() }}</button>
  </div>
</template>
