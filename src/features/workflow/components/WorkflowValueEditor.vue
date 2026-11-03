<script setup lang="ts">
import { computed, ref, watch, inject, onBeforeUnmount } from 'vue';
import type { WorkflowValue, WorkflowStep } from '@/01-models/workflow';
import { idToRaw, toWorkflowStepId } from '@/01-models/ids';
import { parseWorkflowValue, formatWorkflowValue, parseWorkflowJson } from '@/00-storage/service/workflow-json';
import { lazyStrings } from '@/strings';
import { workflowInputText } from '@/features/workflow/logic/forms';
import { workflowInputDraftsKey } from '@/features/workflow/composables/input-drafts';
import { workflowOutputNames } from '@/features/workflow/logic/definition';

defineOptions({ name: 'WorkflowValueEditor' });
const props = defineProps<{ value: WorkflowValue, steps: WorkflowStep[], disabled: boolean }>();
const emit = defineEmits<{ change: [value: WorkflowValue] }>();
const advanced = ref(false), draft = ref(''), error = ref('');
const draftKind = ref<'value' | 'literal'>('value');
const drafts = inject(workflowInputDraftsKey, undefined);
const owner = Symbol('workflow-value-draft');
const locked = computed(() => props.disabled || (drafts?.hasOther({ owner }) ?? false));

function discardDraft(): void {
  advanced.value = false;
  draft.value = '';
  error.value = '';
}

watch([advanced, draft], () => {
  drafts?.update({ owner, text: advanced.value ? draft.value : undefined, discard: discardDraft });
}, { flush: 'sync' });
onBeforeUnmount(() => drafts?.update({ owner, text: undefined, discard: discardDraft }));
const mode = computed(() => {
  switch (props.value.type) {
  case 'literal': return typeof props.value.value === 'string' ? 'text' : 'json';
  case 'model': case 'step_output': case 'loop_item': case 'loop_index': case 'loop_state': case 'array': case 'object': case 'concat': case 'path': case 'get': case 'filename': case 'format_number': case 'equals': case 'not_empty': case 'conversation': return props.value.type;
  default: {
    const exhaustive: never = props.value;
    throw new Error(`Unknown value: ${exhaustive}`);
  }
  }
});
const targetStep = computed(() => {
  const value = props.value;
  switch (value.type) {
  case 'step_output': return props.steps.find(step => step.id === value.stepId);
  case 'literal': case 'model': case 'loop_item': case 'loop_index': case 'loop_state': case 'array': case 'object': case 'concat': case 'path': case 'get': case 'filename': case 'format_number': case 'equals': case 'not_empty': case 'conversation': return undefined;
  default: {
    const exhaustive: never = value;
    throw new Error(`Unknown value: ${exhaustive}`);
  }
  }
});
const hasReference = computed(() => {
  const value = props.value;
  return (value.type === 'step_output' || value.type === 'loop_item' || value.type === 'loop_index' || value.type === 'loop_state') && props.steps.some(step => step.id === value.stepId);
});
watch(() => props.value, () => {
  if (!advanced.value) {
    draft.value = '';
  }
});

function changeMode({ event }: { event: Event }): void {
  const type = workflowInputText({ event });
  const id = props.steps[0]?.id ?? toWorkflowStepId({ raw: '' });
  switch (type) {
  case 'text': emit('change', { type: 'literal', value: '' });
    break;
  case 'json': emit('change', { type: 'literal', value: [] });
    break;
  case 'step_output': emit('change', { type, stepId: id, output: 'value' });
    break;
  case 'loop_item': case 'loop_index': emit('change', { type, stepId: id });
    break;
  case 'loop_state': emit('change', { type, stepId: id, key: '' });
    break;
  case 'array': case 'concat': case 'path': emit('change', { type, items: [{ type: 'literal', value: '' }] });
    break;
  case 'conversation': emit('change', { type, messages: [] });
    break;
  case 'model': emit('change', { type, endpoint: { type: 'openai', url: '' }, modelId: '' });
    break;
  default: openAdvanced();
  }
}

function openAdvanced(): void {
  if (advanced.value || locked.value) {
    return;
  }
  draftKind.value = 'value';
  advanced.value = true;
  draft.value = formatWorkflowValue({ value: props.value });
  error.value = '';
}

function applyAdvanced(): void {
  try {
    let value: WorkflowValue;
    switch (draftKind.value) {
    case 'value': value = parseWorkflowValue({ text: draft.value });
      break;
    case 'literal': value = { type: 'literal', value: parseWorkflowJson({ text: draft.value }) };
      break;
    default: {
      const exhaustive: never = draftKind.value;
      throw new Error(`Unknown draft kind: ${exhaustive}`);
    }
    }
    emit('change', value);
    advanced.value = false;
    error.value = '';
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason);
  }
}

function setLiteral({ event }: { event: Event }): void {
  emit('change', { type: 'literal', value: workflowInputText({ event }) });
}

function openLiteral(): void {
  if (locked.value) {
    return;
  }
  const value = props.value;
  switch (value.type) {
  case 'literal':
    draftKind.value = 'literal';
    draft.value = JSON.stringify(value.value, null, 2);
    advanced.value = true;
    error.value = '';
    return;
  case 'model': case 'step_output': case 'loop_item': case 'loop_index': case 'loop_state': case 'array': case 'object': case 'concat': case 'path': case 'get': case 'filename': case 'format_number': case 'equals': case 'not_empty': case 'conversation': return;
  default: {
    const exhaustive: never = value;
    throw new Error(`Unknown value: ${exhaustive}`);
  }
  }
}

function setReference({ event }: { event: Event }): void {
  const value = props.value;
  if (value.type === 'step_output' || value.type === 'loop_item' || value.type === 'loop_index' || value.type === 'loop_state') {
    emit('change', { ...value, stepId: toWorkflowStepId({ raw: workflowInputText({ event }) }) });
  }
}

function changeItem({ index, value }: { index: number, value: WorkflowValue }): void {
  if (props.value.type === 'array' || props.value.type === 'concat' || props.value.type === 'path') {
    emit('change', { ...props.value, items: props.value.items.map((item, i) => i === index ? value : item) });
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div tw-class="space-y-2 min-w-0">
    <div tw-class="flex flex-wrap gap-2">
      <select :value="mode" :disabled="locked || advanced" @change="changeMode({ event: $event })" tw-class="w-full min-w-0 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50">
        <option value="text">{{ lazyStrings.workflow__literal_text() }}</option>
        <option value="json">{{ lazyStrings.workflow__literal_json() }}</option>
        <option value="step_output">{{ lazyStrings.workflow__step_reference() }}</option>
        <option value="loop_item">{{ lazyStrings.workflow__loop_item() }}</option>
        <option value="loop_index">{{ lazyStrings.workflow__loop_index() }}</option>
        <option value="loop_state">{{ lazyStrings.workflow__loop_state() }}</option>
        <option value="model">{{ lazyStrings.workflow__model() }}</option>
        <option value="conversation">{{ lazyStrings.workflow__conversation() }}</option>
        <option value="array">array</option><option value="concat">concat</option><option value="path">path</option>
        <option v-if="!['literal','step_output','loop_item','loop_index','loop_state','model','conversation','array','concat','path'].includes(value.type)" :value="value.type">{{ value.type }}</option>
      </select>
      <button type="button" :disabled="locked" @click="openAdvanced" data-testid="workflow-value-json" tw-class="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-40">{{ lazyStrings.workflow__json() }}</button>
    </div>
    <template v-if="advanced">
      <textarea data-testid="workflow-value-draft" v-model="draft" :disabled="locked" rows="10" spellcheck="false" tw-class="w-full min-w-0 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 font-mono text-xs" :aria-label="lazyStrings.workflow__structured_input()" />
      <button type="button" :disabled="locked" @click="applyAdvanced" data-testid="workflow-value-apply" tw-class="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-40">{{ lazyStrings.workflow__apply() }}</button>
      <button type="button" @click="discardDraft" tw-class="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-40">{{ lazyStrings.workflow__discard() }}</button>
    </template>
    <template v-else-if="value.type === 'literal'">
      <textarea v-if="typeof value.value === 'string'" :value="value.value" :disabled="locked" rows="3" @input="setLiteral({ event: $event })" tw-class="w-full min-w-0 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50" />
      <div v-else tw-class="space-y-2">
        <pre tw-class="max-h-36 overflow-auto text-xs font-mono whitespace-pre-wrap">{{ JSON.stringify(value.value, null, 2) }}</pre>
        <button type="button" :disabled="locked" @click="openLiteral" tw-class="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-xs hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-40">{{ lazyStrings.workflow__json() }}</button>
      </div>
    </template>
    <template v-else-if="value.type === 'step_output' || value.type === 'loop_item' || value.type === 'loop_index' || value.type === 'loop_state'">
      <select :value="idToRaw({ id: value.stepId })" :disabled="locked" @change="setReference({ event: $event })" tw-class="w-full min-w-0 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50" :aria-label="lazyStrings.workflow__step_reference()">
        <option v-if="!hasReference" :value="idToRaw({ id: value.stepId })">{{ idToRaw({ id: value.stepId }) || lazyStrings.workflow__not_selected() }}</option>
        <option v-for="step in steps" :key="idToRaw({ id: step.id })" :value="idToRaw({ id: step.id })">{{ step.name }} · {{ idToRaw({ id: step.id }).slice(0, 6) }}</option>
      </select>
      <select v-if="value.type === 'step_output'" :value="value.output" :disabled="locked" @change="emit('change', { ...value, output: workflowInputText({ event: $event }) })" tw-class="w-full min-w-0 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50" :aria-label="lazyStrings.workflow__output()">
        <option v-if="!targetStep || !workflowOutputNames({ step: targetStep }).includes(value.output)" :value="value.output">{{ value.output }}</option>
        <option v-for="output in targetStep ? workflowOutputNames({ step: targetStep }) : []" :key="output" :value="output">{{ output }}</option>
      </select>
      <input v-if="value.type === 'loop_state'" :value="value.key" :disabled="locked" @input="emit('change', { ...value, key: workflowInputText({ event: $event }) })" tw-class="w-full min-w-0 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50" :aria-label="lazyStrings.workflow__key()" />
    </template>
    <template v-else-if="value.type === 'array' || value.type === 'concat' || value.type === 'path'">
      <div v-for="(item, index) in value.items" :key="index" tw-class="border-l-2 border-gray-200 dark:border-gray-700 pl-3 space-y-2">
        <WorkflowValueEditor :value="item" :steps="steps" :disabled="disabled" @change="changeItem({ index, value: $event })" />
        <button type="button" :disabled="locked" @click="emit('change', { ...value, items: value.items.filter((_, i) => i !== index) })" tw-class="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-40">{{ lazyStrings.workflow__delete() }}</button>
      </div>
      <button type="button" :disabled="locked" @click="emit('change', { ...value, items: [...value.items, { type: 'literal', value: '' }] })" tw-class="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-40">＋ {{ lazyStrings.workflow__value() }}</button>
    </template>
    <p v-else tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.workflow__structured_input() }} · {{ value.type }}</p>
    <p v-if="error" role="alert" tw-class="text-xs text-red-600 dark:text-red-400 break-words">{{ error }}</p>
  </div>
</template>
