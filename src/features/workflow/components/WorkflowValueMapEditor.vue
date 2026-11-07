<script setup lang="ts">
import { computed, inject, ref } from 'vue';
import { PlusIcon, Trash2Icon } from 'lucide-vue-next';
import type { WorkflowStep, WorkflowValue } from '@/01-models/workflow';
import type { WorkflowTypeScope } from '@/features/workflow/logic/value-types';
import { workflowInputDraftsKey } from '@/features/workflow/composables/input-drafts';
import WorkflowValueEditor from './WorkflowValueEditor.vue';
import { lazyStrings } from '@/strings';
import { workflowInputText } from '@/features/workflow/logic/forms';
const props = defineProps<{ values: Record<string, WorkflowValue>, steps: WorkflowStep[], scope: WorkflowTypeScope, disabled: boolean }>();
const emit = defineEmits<{ change: [values: Record<string, WorkflowValue>] }>();
const drafts = inject(workflowInputDraftsKey, undefined);
const locked = computed(() => props.disabled || (drafts?.dirty.value ?? false));
const error = ref('');

function update({ key, value, rename }: { key: string, value: WorkflowValue | undefined, rename?: string }): void {
  if (rename !== undefined && key !== rename && Object.hasOwn(props.values, rename)) {
    error.value = 'A field with that name already exists.';
    return;
  }
  const entries = Object.entries(props.values).filter(([name]) => name !== key);
  if (value) {
    entries.push([rename ?? key, value]);
  }
  emit('change', Object.fromEntries(entries));
  error.value = '';
}

function add(): void {
  let key = 'value';
  let count = 1;
  while (Object.hasOwn(props.values, key)) {
    key = `value${++count}`;
  }
  update({ key, value: { type: 'literal', value: '' } });
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div tw-class="space-y-3">
    <div v-for="(value, key) in values" :key="key" tw-class="rounded-xl border border-gray-200 dark:border-gray-700 p-3 space-y-2">
      <div tw-class="flex gap-2"><input :value="key" :disabled="locked" :aria-label="lazyStrings.workflow__key()" @change="update({ key: String(key), value, rename: workflowInputText({ event: $event }) })" tw-class="min-w-0 flex-1 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-2 py-1.5 text-xs font-mono outline-none focus:ring-2 focus:ring-blue-500/40" /><button type="button" :disabled="locked" :aria-label="lazyStrings.workflow__delete()" @click="update({ key: String(key), value: undefined })" tw-class="p-2 rounded-lg text-gray-400 hover:text-red-500 disabled:opacity-40"><Trash2Icon tw-class="w-4 h-4" /></button></div>
      <WorkflowValueEditor :value="value" :steps="steps" :scope="scope" :disabled="disabled" @change="update({ key: String(key), value: $event })" />
    </div>
    <p v-if="error" role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ error }}</p>
    <button type="button" :disabled="locked" @click="add" tw-class="flex items-center gap-2 text-sm text-blue-600 dark:text-blue-400 hover:underline disabled:opacity-40"><PlusIcon tw-class="w-4 h-4" />{{ lazyStrings.workflow__add_field() }}</button>
  </div>
</template>
