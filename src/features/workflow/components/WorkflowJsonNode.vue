<script setup lang="ts">
import { computed, ref, inject } from 'vue';
import { PencilIcon, LinkIcon, UnlinkIcon } from 'lucide-vue-next';
import type { JsonValue } from '@/01-models/lm';
import type { WorkflowStep, WorkflowValue } from '@/01-models/workflow';
import type { WorkflowTypeScope } from '@/features/workflow/logic/value-types';
import { workflowValueSummary } from '@/features/workflow/logic/value-inputs';
import { workflowInputDraftsKey } from '@/features/workflow/composables/input-drafts';
import WorkflowValueEditor from './WorkflowValueEditor.vue';
import WorkflowJsonInput from './WorkflowJsonInput.vue';
import { lazyStrings } from '@/strings';
defineOptions({ name: 'WorkflowJsonNode' });
const props = defineProps<{
  value: JsonValue | undefined,
  path: (string | number)[],
  assignments: Extract<WorkflowValue, { type: 'json_compose' }>['assignments'],
  steps: WorkflowStep[], scope: WorkflowTypeScope, disabled: boolean,
}>();
const emit = defineEmits<{
  bind: [input: { path: (string | number)[], value: WorkflowValue }],
  unbind: [input: { path: (string | number)[] }],
  literal: [input: { path: (string | number)[], value: JsonValue }],
}>();
const editing = ref(false);
const drafts = inject(workflowInputDraftsKey, undefined);
const controlsLocked = computed(() => props.disabled || (drafts?.dirty.value ?? false));
const binding = computed(() => props.assignments.find(item => JSON.stringify(item.path) === JSON.stringify(props.path)));
const array = computed(() => Array.isArray(props.value));
const composite = computed(() => props.value !== null && typeof props.value === 'object');
const children = computed((): { key: string | number, value: JsonValue | undefined }[] => {
  if (Array.isArray(props.value)) {
    return props.value.map((value, key) => ({ key, value }));
  }
  if (props.value !== null && props.value !== undefined && typeof props.value === 'object') {
    const keys = new Set(Object.keys(props.value));
    for (const assignment of props.assignments) {
      if (assignment.path.length === props.path.length + 1 && props.path.every((key, i) => key === assignment.path[i])) {
        const key = assignment.path.at(-1);
        if (typeof key === 'string') {
          keys.add(key);
        }
      }
    }
    return [...keys].map(key => ({ key, value: props.value !== null && typeof props.value === 'object' && Object.hasOwn(props.value, key) ? Reflect.get(props.value, key) as JsonValue : undefined }));
  }
  return [];
});

function toggle(): void {
  if (!controlsLocked.value) {
    editing.value = !editing.value;
  }
}

function bind(): void {
  if (controlsLocked.value) {
    return;
  }
  emit('bind', { path: props.path, value: { type: 'literal', value: props.value ?? null } });
  editing.value = true;
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div tw-class="inline-block align-top min-w-0 max-w-full">
    <template v-if="binding">
      <button type="button" :disabled="controlsLocked" @click="toggle" :aria-expanded="editing" :aria-label="lazyStrings.workflow__edit_reference()" data-testid="workflow-inline-reference" tw-class="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-blue-300/80 dark:border-blue-700 bg-blue-50 dark:bg-blue-950/50 px-2 py-1 text-xs font-sans text-blue-700 dark:text-blue-200 align-middle hover:bg-blue-100 dark:hover:bg-blue-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50 transition-colors"><LinkIcon tw-class="w-3.5 h-3.5 shrink-0" /><span tw-class="truncate">{{ workflowValueSummary({ value: binding.value, scope }) }}</span></button>
      <button type="button" :disabled="controlsLocked" :aria-label="lazyStrings.workflow__remove_reference()" @click="emit('unbind', { path }); editing = false" tw-class="inline-flex p-1 align-middle rounded-md text-gray-400 hover:text-red-500 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40"><UnlinkIcon tw-class="w-3.5 h-3.5" /></button>
      <div v-if="editing" tw-class="my-2 p-3 font-sans rounded-xl border border-blue-200 dark:border-blue-800 bg-white dark:bg-gray-900">
        <WorkflowValueEditor :value="binding.value" :scope="scope" :steps="steps" :disabled="disabled" expected="json" @change="emit('bind', { path, value: $event })" />
      </div>
    </template>
    <template v-else>
      <template v-if="composite">
        <span>{{ array ? '[' : '{' }}</span>
        <button type="button" :disabled="controlsLocked" :aria-label="lazyStrings.workflow__edit_reference()" @click="bind" tw-class="inline-flex p-1 text-gray-400 rounded-md hover:bg-blue-50 dark:hover:bg-blue-900/40 hover:text-blue-500 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40"><LinkIcon tw-class="w-3.5 h-3.5" /></button>
        <div tw-class="pl-4 ml-1 border-l border-gray-200 dark:border-gray-700 space-y-1">
          <div v-for="(child, i) in children" :key="JSON.stringify(child.key)" tw-class="break-words">
            <span v-if="!array" tw-class="text-purple-700 dark:text-purple-300">{{ JSON.stringify(child.key) }}: </span>
            <WorkflowJsonNode :value="child.value" :path="[...path, child.key]" :assignments="assignments" :steps="steps" :scope="scope" :disabled="disabled" @bind="emit('bind', $event)" @unbind="emit('unbind', $event)" @literal="emit('literal', $event)" /><span v-if="i < children.length - 1">,</span>
          </div>
        </div><span>{{ array ? ']' : '}' }}</span>
      </template>
      <template v-else>
        <span tw-class="whitespace-pre-wrap break-all text-emerald-700 dark:text-emerald-300">{{ JSON.stringify(value) }}</span>
        <button type="button" :disabled="controlsLocked" :aria-label="lazyStrings.workflow__fixed_value()" @click="toggle" tw-class="inline-flex p-1 align-middle rounded-md text-gray-400 hover:text-blue-500 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40"><PencilIcon tw-class="w-3.5 h-3.5" /></button>
        <button type="button" :disabled="controlsLocked" :aria-label="lazyStrings.workflow__edit_reference()" @click="bind" tw-class="inline-flex p-1 align-middle rounded-md text-gray-400 hover:text-blue-500 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40"><LinkIcon tw-class="w-3.5 h-3.5" /></button>
        <WorkflowJsonInput v-if="editing" :value="value ?? null" :disabled="disabled" @change="emit('literal', { path, value: $event })" />
      </template>
    </template>
  </div>
</template>
