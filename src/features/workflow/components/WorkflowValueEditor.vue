<script setup lang="ts">
import { computed, ref, watch, inject, onBeforeUnmount } from 'vue';
import { PlusIcon, Trash2Icon } from 'lucide-vue-next';
import type { WorkflowValue, WorkflowStep } from '@/01-models/workflow';
import { parseWorkflowValue, formatWorkflowValue } from '@/00-storage/service/workflow-json';
import { lazyStrings } from '@/strings';
import SettingsFormSelect from '@/components/SettingsFormSelect.vue';
import ToggleSwitch from '@/components/ToggleSwitch.vue';
import WorkflowModelEditor from './WorkflowModelEditor.vue';
import WorkflowMessageEditor from './WorkflowMessageEditor.vue';
import WorkflowJsonInput from './WorkflowJsonInput.vue';
import WorkflowJsonComposer from './WorkflowJsonComposer.vue';
import WorkflowNumberInput from './WorkflowNumberInput.vue';
import { workflowInputText } from '@/features/workflow/logic/forms';
import { workflowInputDraftsKey } from '@/features/workflow/composables/input-drafts';
import { workflowValueScopeKey } from '@/features/workflow/composables/value-context';
import { emptyWorkflowTypeScope, inferWorkflowValueType, workflowTypeCompatibility, type WorkflowTypeScope, type WorkflowExpectedType } from '@/features/workflow/logic/value-types';
import { workflowValueMode, workflowValueInputOptions, newWorkflowValueInput, workflowReferenceChoices, workflowValueSummary, type WorkflowValueInputMode } from '@/features/workflow/logic/value-inputs';

defineOptions({ name: 'WorkflowValueEditor' });
const props = defineProps<{ value: WorkflowValue, steps: WorkflowStep[], disabled: boolean, expected?: WorkflowExpectedType, scope?: WorkflowTypeScope }>();
const emit = defineEmits<{ change: [value: WorkflowValue] }>();
const advanced = ref(false), draft = ref(''), error = ref('');
const drafts = inject(workflowInputDraftsKey, undefined), owner = Symbol('workflow-value-draft');
const injectedScope = inject(workflowValueScopeKey, undefined);
const emptyScope = emptyWorkflowTypeScope();
const scope = computed(() => props.scope ?? injectedScope?.value ?? emptyScope);
const expected = computed(() => props.expected ?? 'any');
const locked = computed(() => props.disabled || (drafts?.hasOther({ owner }) ?? false));
const mode = computed(() => workflowValueMode({ value: props.value }));
const options = computed(() => workflowValueInputOptions({ scope: scope.value, expected: expected.value, current: props.value }));
const compatibility = computed(() => workflowTypeCompatibility({ actual: inferWorkflowValueType({ value: props.value, scope: scope.value }), expected: expected.value }));
const references = computed(() => workflowReferenceChoices({ scope: scope.value, expected: expected.value }).filter(choice => choice.value.type === props.value.type));
const referenceSelection = computed(() => references.value.find(choice => JSON.stringify(choice.value) === JSON.stringify(props.value))?.id ?? '');
const referenceOptions = computed(() => [
  ...(!referenceSelection.value ? [{ value: '', label: workflowValueSummary({ value: props.value, scope: scope.value }), disabled: true }] : []),
  ...references.value.map(choice => ({ value: choice.id, label: choice.label })),
]);

function discardDraft(): void {
  advanced.value = false;
  draft.value = '';
  error.value = '';
}

watch([advanced, draft], () => drafts?.update({ owner, text: advanced.value ? draft.value : undefined, discard: discardDraft }), { flush: 'sync' });
onBeforeUnmount(() => drafts?.update({ owner, text: undefined, discard: discardDraft }));

function changeMode({ type }: { type: WorkflowValueInputMode }): void {
  if (locked.value || advanced.value) {
    return;
  }
  const value = newWorkflowValueInput({ mode: type, scope: scope.value, expected: expected.value });
  if (value) {
    emit('change', value);
  }
}

function openAdvanced(): void {
  if (advanced.value || locked.value) {
    return;
  }
  draft.value = formatWorkflowValue({ value: props.value });
  advanced.value = true;
  error.value = '';
}

function applyAdvanced(): void {
  try {
    emit('change', parseWorkflowValue({ text: draft.value }));
    advanced.value = false;
    error.value = '';
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason);
  }
}

function setReference({ id }: { id: string }): void {
  const choice = references.value.find(item => item.id === id);
  if (choice && !locked.value) {
    emit('change', choice.value);
  }
}

function changeItem({ index, value }: { index: number, value: WorkflowValue }): void {
  if (props.value.type === 'array' || props.value.type === 'concat' || props.value.type === 'path' || props.value.type === 'all' || props.value.type === 'any') {
    emit('change', { ...props.value, items: props.value.items.map((item, i) => i === index ? value : item) });
  }
}

function property({ key, value, rename }: { key: string, value: WorkflowValue | undefined, rename?: string }): void {
  switch (props.value.type) {
  case 'object': break;
  case 'arithmetic': case 'compare': case 'all': case 'any': case 'not': case 'literal': case 'model': case 'step_output': case 'loop_item': case 'loop_index': case 'loop_state': case 'array': case 'concat': case 'path': case 'get': case 'filename': case 'format_number': case 'equals': case 'not_empty': case 'conversation': case 'range': case 'json_compose': return;
  default: {
    const exhaustive: never = props.value;
    throw new Error(String(exhaustive));
  }
  }
  if (rename !== undefined && rename !== key && Object.hasOwn(props.value.properties, rename)) {
    error.value = 'A field with that name already exists.';
    return;
  }
  const entries = Object.entries(props.value.properties).filter(([name]) => name !== key);
  if (value) {
    entries.push([rename ?? key, value]);
  }
  emit('change', { ...props.value, properties: Object.fromEntries(entries) });
  error.value = '';
}

function addProperty(): void {
  if (props.value.type !== 'object' || locked.value) {
    return;
  }
  let key = 'field';
  let index = 1;
  while (Object.hasOwn(props.value.properties, key)) {
    key = `field${++index}`;
  }
  property({ key, value: { type: 'literal', value: '' } });
}

const fieldType = computed(() => {
  switch (props.value.type) {
  case 'get': return inferWorkflowValueType({ value: props.value, scope: scope.value });
  case 'arithmetic': case 'compare': case 'all': case 'any': case 'not': case 'literal': case 'model': case 'step_output': case 'loop_item': case 'loop_index': case 'loop_state': case 'array': case 'object': case 'concat': case 'path': case 'filename': case 'format_number': case 'equals': case 'not_empty': case 'conversation': case 'range': case 'json_compose': return undefined;
  default: {
    const exhaustive: never = props.value;
    throw new Error(String(exhaustive));
  }
  }
});
const fieldOptions = computed(() => {
  const type = fieldType.value;
  if (!type) {
    return [];
  }
  switch (type.kind) {
  case 'object': return Object.keys(type.fields).map(key => ({ value: key, label: key }));
  case 'model': return [{ value: 'modelId', label: 'modelId' }];
  case 'unknown': case 'text': case 'number': case 'boolean': case 'null': case 'conversation': case 'binary': case 'array': case 'sequence': case 'union': return [];
  default: {
    const exhaustive: never = type;
    throw new Error(String(exhaustive));
  }
  }
});

function appendField({ key }: { key: string | number }): void {
  if (props.value.type === 'get' && !locked.value) {
    emit('change', { ...props.value, path: [...props.value.path, key] });
  }
}

function pathPart({ index, key }: { index: number, key: string | number }): void {
  switch (props.value.type) {
  case 'get': emit('change', { ...props.value, path: props.value.path.map((part, i) => i === index ? key : part) });
    return;
  case 'arithmetic': case 'compare': case 'all': case 'any': case 'not': case 'literal': case 'model': case 'step_output': case 'loop_item': case 'loop_index': case 'loop_state': case 'array': case 'object': case 'concat': case 'path': case 'filename': case 'format_number': case 'equals': case 'not_empty': case 'conversation': case 'range': case 'json_compose': return;
  default: {
    const exhaustive: never = props.value;
    throw new Error(String(exhaustive));
  }
  }
}

const arithmeticOptions = computed(() => [
  { value: 'add' as const, label: lazyStrings.workflow__add_numbers() },
  { value: 'subtract' as const, label: lazyStrings.workflow__subtract_numbers() },
  { value: 'multiply' as const, label: lazyStrings.workflow__multiply_numbers() },
  { value: 'divide' as const, label: lazyStrings.workflow__divide_numbers() },
  { value: 'remainder' as const, label: lazyStrings.workflow__remainder() },
]);
const comparisonOptions = computed(() => [
  { value: 'less' as const, label: lazyStrings.workflow__less_than() },
  { value: 'less_or_equal' as const, label: lazyStrings.workflow__at_most() },
  { value: 'greater' as const, label: lazyStrings.workflow__greater_than() },
  { value: 'greater_or_equal' as const, label: lazyStrings.workflow__at_least() },
]);

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div tw-class="space-y-3 min-w-0" data-testid="workflow-value-editor">
    <div tw-class="flex items-start gap-2">
      <div tw-class="min-w-0 flex-1"><SettingsFormSelect data-testid="workflow-value-mode" :model-value="mode" :options="options" :disabled="locked || advanced" :label="lazyStrings.workflow__choose_value()" @update:model-value="changeMode({ type: $event })" /></div>
      <button type="button" :disabled="locked" @click="openAdvanced" data-testid="workflow-value-json" :aria-label="lazyStrings.workflow__structured_input()" tw-class="mt-6 rounded-lg border border-gray-200 dark:border-gray-700 px-2.5 py-2 text-xs text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40 transition-colors">{{ lazyStrings.workflow__json() }}</button>
    </div>
    <p v-if="compatibility === 'incompatible'" role="alert" data-testid="workflow-type-warning" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.workflow__incompatible_value() }}</p>
    <p v-else-if="compatibility === 'unknown' && expected !== 'any'" tw-class="text-xs text-amber-700 dark:text-amber-300">{{ lazyStrings.workflow__runtime_type_check() }}</p>
    <template v-if="advanced">
      <textarea data-testid="workflow-value-draft" v-model="draft" :disabled="locked" rows="10" spellcheck="false" tw-class="w-full min-w-0 rounded-xl border border-gray-200/80 dark:border-gray-700/70 bg-gray-50/60 dark:bg-gray-800/40 px-3 py-2.5 text-xs font-mono outline-none focus:ring-2 focus:ring-blue-500/40 transition-colors disabled:opacity-45" :aria-label="lazyStrings.workflow__structured_input()" />
      <div tw-class="flex gap-2"><button type="button" :disabled="locked" @click="applyAdvanced" data-testid="workflow-value-apply" tw-class="rounded-lg bg-blue-600 text-white px-3 py-1.5 text-xs hover:bg-blue-700 disabled:opacity-40 transition-colors">{{ lazyStrings.workflow__apply() }}</button><button type="button" @click="discardDraft" tw-class="rounded-lg px-3 py-1.5 text-xs hover:bg-gray-100 dark:hover:bg-gray-800">{{ lazyStrings.workflow__discard() }}</button></div>
    </template>
    <template v-else-if="value.type === 'literal'">
      <textarea v-if="typeof value.value === 'string'" :value="value.value" :disabled="locked" rows="3" @input="emit('change', { type: 'literal', value: workflowInputText({ event: $event }) })" :aria-label="lazyStrings.workflow__literal_text()" tw-class="w-full min-w-0 resize-y rounded-xl border border-gray-200/80 dark:border-gray-700/70 bg-gray-50/60 dark:bg-gray-800/40 px-3 py-2.5 text-sm leading-relaxed outline-none focus:ring-2 focus:ring-blue-500/40 transition-colors disabled:opacity-45" />
      <WorkflowNumberInput v-else-if="typeof value.value === 'number'" :value="value.value" :disabled="disabled" @change="emit('change', { type: 'literal', value: $event })" />
      <label v-else-if="typeof value.value === 'boolean'" tw-class="flex items-center justify-between gap-3 rounded-xl bg-gray-50 dark:bg-gray-800/50 p-3 text-sm"><span>{{ value.value ? 'true' : 'false' }}</span><ToggleSwitch><input type="checkbox" :checked="value.value" :disabled="locked" :aria-label="lazyStrings.workflow__boolean()" @change="emit('change', { type: 'literal', value: !value.value })" /></ToggleSwitch></label>
      <WorkflowJsonInput v-else :value="value.value" :disabled="disabled" @change="emit('change', { type: 'literal', value: $event })" />
    </template>
    <SettingsFormSelect v-else-if="value.type === 'step_output' || value.type === 'loop_item' || value.type === 'loop_index' || value.type === 'loop_state'" :model-value="referenceSelection" :options="referenceOptions" :disabled="locked" :label="lazyStrings.workflow__source()" @update:model-value="setReference({ id: $event })" />
    <WorkflowModelEditor v-else-if="value.type === 'model'" :value="{ endpoint: value.endpoint, modelId: value.modelId, lmParameters: undefined }" :disabled="locked" :show-parameters="false" @change="emit('change', { type: 'model', endpoint: $event.endpoint, modelId: $event.modelId })" />
    <WorkflowJsonComposer v-else-if="value.type === 'json_compose'" :value="value" :steps="steps" :scope="scope" :disabled="disabled" @change="emit('change', $event)" />
    <WorkflowMessageEditor v-else-if="value.type === 'conversation'" :messages="value.messages" :steps="steps" :scope="scope" :disabled="disabled" @change="emit('change', { type: 'conversation', messages: $event })" />
    <template v-else-if="value.type === 'array' || value.type === 'concat' || value.type === 'path' || value.type === 'all' || value.type === 'any'">
      <div v-for="(item, index) in value.items" :key="index" tw-class="rounded-xl border border-gray-200 dark:border-gray-700 p-3 space-y-2">
        <div tw-class="flex justify-between items-center text-xs text-gray-500"><span>{{ index + 1 }}</span><button type="button" :disabled="locked" :aria-label="lazyStrings.workflow__delete()" @click="emit('change', { ...value, items: value.items.filter((_, i) => i !== index) })" tw-class="p-1 rounded-md hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-40"><Trash2Icon tw-class="w-3.5 h-3.5" /></button></div>
        <WorkflowValueEditor :value="item" :steps="steps" :scope="scope" :disabled="disabled" :expected="value.type === 'array' ? 'any' : value.type === 'all' || value.type === 'any' ? 'boolean' : 'text'" @change="changeItem({ index, value: $event })" />
      </div>
      <button type="button" :disabled="locked" @click="emit('change', { ...value, items: [...value.items, { type: 'literal', value: value.type === 'all' || value.type === 'any' ? true : '' }] })" tw-class="flex items-center gap-2 rounded-lg border border-dashed border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/30 disabled:opacity-40"><PlusIcon tw-class="w-4 h-4" />{{ lazyStrings.workflow__add_item() }}</button>
    </template>
    <template v-else-if="value.type === 'object'">
      <div v-for="(item, key) in value.properties" :key="key" tw-class="p-3 rounded-xl border border-gray-200 dark:border-gray-700 space-y-2">
        <div tw-class="flex gap-2"><input :value="key" :disabled="locked" :aria-label="lazyStrings.workflow__key()" @change="property({ key: String(key), value: item, rename: workflowInputText({ event: $event }) })" tw-class="w-full min-w-0 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 px-2 py-1.5 text-xs font-mono focus:ring-2 focus:ring-blue-500/40 outline-none" /><button type="button" :disabled="locked" :aria-label="lazyStrings.workflow__delete()" @click="property({ key: String(key), value: undefined })" tw-class="p-2 text-gray-400 hover:text-red-500"><Trash2Icon tw-class="w-4 h-4" /></button></div>
        <WorkflowValueEditor :value="item" :steps="steps" :scope="scope" :disabled="disabled" @change="property({ key: String(key), value: $event })" />
      </div>
      <button type="button" :disabled="locked" @click="addProperty" tw-class="flex items-center gap-2 text-sm text-blue-600 dark:text-blue-400 hover:underline disabled:opacity-40"><PlusIcon tw-class="w-4 h-4" />{{ lazyStrings.workflow__add_field() }}</button>
    </template>
    <template v-else-if="value.type === 'range'">
      <div tw-class="space-y-2"><p tw-class="text-xs font-medium text-gray-500">{{ lazyStrings.workflow__start_value() }}</p><WorkflowValueEditor :value="value.start" :scope="scope" :steps="steps" :disabled="disabled" expected="number" @change="emit('change', { ...value, start: $event })" /></div>
      <div tw-class="space-y-2"><p tw-class="text-xs font-medium text-gray-500">{{ lazyStrings.workflow__increment() }}</p><WorkflowValueEditor :value="value.step" :scope="scope" :steps="steps" :disabled="disabled" expected="number" @change="emit('change', { ...value, step: $event })" /></div>
      <label tw-class="flex justify-between items-center text-sm gap-3"><span>{{ lazyStrings.workflow__no_end() }}</span><ToggleSwitch><input type="checkbox" :checked="!value.end" :disabled="locked" @change="emit('change', { ...value, end: value.end ? undefined : { type: 'literal', value: 10 } })" /></ToggleSwitch></label>
      <div v-if="value.end" tw-class="space-y-2"><p tw-class="text-xs font-medium text-gray-500">{{ lazyStrings.workflow__end_exclusive() }}</p><WorkflowValueEditor :value="value.end" :scope="scope" :steps="steps" :disabled="disabled" expected="number" @change="emit('change', { ...value, end: $event })" /></div>
      <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.workflow__range_limits_hint() }}</p>
    </template>
    <template v-else-if="value.type === 'get'">
      <WorkflowValueEditor :value="value.value" :scope="scope" :steps="steps" :disabled="disabled" @change="emit('change', { ...value, value: $event })" />
      <div v-for="(part, index) in value.path" :key="index" tw-class="flex gap-2 items-center">
        <span tw-class="text-xs text-gray-400">→</span><input v-if="typeof part === 'string'" :value="part" :disabled="locked" :aria-label="lazyStrings.workflow__key()" @input="pathPart({ index, key: workflowInputText({ event: $event }) })" tw-class="min-w-0 flex-1 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-2 py-2 text-xs focus:ring-2 focus:ring-blue-500/40 outline-none" /><WorkflowNumberInput v-else :value="part" :disabled="disabled" @change="pathPart({ index, key: $event })" />
        <button type="button" :disabled="locked" :aria-label="lazyStrings.workflow__delete()" @click="emit('change', { ...value, path: value.path.slice(0, index) })" tw-class="p-2 text-gray-400 hover:text-red-500"><Trash2Icon tw-class="w-3.5 h-3.5" /></button>
      </div>
      <SettingsFormSelect v-if="fieldOptions.length" :model-value="''" :options="[{ value: '', label: lazyStrings.workflow__get_field(), disabled: true }, ...fieldOptions]" :disabled="locked" :label="lazyStrings.workflow__key()" @update:model-value="appendField({ key: $event })" />
      <div tw-class="flex gap-3 text-xs"><button type="button" :disabled="locked" @click="appendField({ key: '' })" tw-class="text-blue-600 dark:text-blue-400 hover:underline">＋ {{ lazyStrings.workflow__key() }}</button><button type="button" :disabled="locked" @click="appendField({ key: 0 })" tw-class="text-blue-600 dark:text-blue-400 hover:underline">＋ {{ lazyStrings.workflow__number() }}</button></div>
    </template>
    <template v-else-if="value.type === 'filename' || value.type === 'format_number' || value.type === 'not_empty' || value.type === 'not'">
      <WorkflowValueEditor :value="value.value" :scope="scope" :steps="steps" :disabled="disabled" :expected="value.type === 'format_number' ? 'number' : value.type === 'filename' ? 'text' : value.type === 'not' ? 'boolean' : 'any'" @change="emit('change', { ...value, value: $event })" />
      <WorkflowNumberInput v-if="value.type === 'format_number'" :value="value.minDigits" :disabled="disabled" label="minDigits" @change="emit('change', { ...value, minDigits: $event })" />
    </template>
    <template v-else-if="value.type === 'arithmetic' || value.type === 'compare'">
      <WorkflowValueEditor :value="value.left" :scope="scope" :steps="steps" :disabled="disabled" expected="number" @change="emit('change', { ...value, left: $event })" />
      <SettingsFormSelect v-if="value.type === 'arithmetic'" :model-value="value.operator" :options="arithmeticOptions" :disabled="locked" :label="lazyStrings.workflow__operation()" @update:model-value="emit('change', { ...value, operator: $event })" />
      <SettingsFormSelect v-else :model-value="value.operator" :options="comparisonOptions" :disabled="locked" :label="lazyStrings.workflow__operation()" @update:model-value="emit('change', { ...value, operator: $event })" />
      <WorkflowValueEditor :value="value.right" :scope="scope" :steps="steps" :disabled="disabled" expected="number" @change="emit('change', { ...value, right: $event })" />
    </template>
    <template v-else-if="value.type === 'equals'">
      <WorkflowValueEditor :value="value.left" :scope="scope" :steps="steps" :disabled="disabled" @change="emit('change', { ...value, left: $event })" /><p tw-class="text-center text-gray-400">=</p><WorkflowValueEditor :value="value.right" :scope="scope" :steps="steps" :disabled="disabled" @change="emit('change', { ...value, right: $event })" />
    </template>
    <p v-if="error" role="alert" tw-class="text-xs text-red-600 dark:text-red-400 break-words">{{ error }}</p>
  </div>
</template>
