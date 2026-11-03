<script setup lang="ts">
import { ref } from 'vue';
import { GripVerticalIcon, ArrowUpIcon, ArrowDownIcon, PlusIcon } from 'lucide-vue-next';
import type { WorkflowStep } from '@/01-models/workflow';
import { idToRaw, toWorkflowStepId, toWorkflowId, type WorkflowStepId, type WorkflowId } from '@/01-models/ids';
import type { WorkflowDropTarget } from '@/features/workflow/logic/editor';
import { workflowStepLabel, workflowStepTypes, workflowInputText } from '@/features/workflow/logic/forms';
import { lazyStrings } from '@/strings';

defineOptions({ name: 'WorkflowStepList' });
const props = defineProps<{ steps: WorkflowStep[], selected: Set<WorkflowStepId>, parentId: WorkflowStepId | undefined, branch: WorkflowDropTarget['branch'], disabled: boolean }>();
const emit = defineEmits<{
  select: [payload: { id: WorkflowStepId, multiple: boolean }],
  move: [payload: { id: WorkflowStepId, target: WorkflowDropTarget }],
  add: [payload: { type: WorkflowStep['type'], target: WorkflowDropTarget }],
  insertPart: [payload: { id: WorkflowId, target: WorkflowDropTarget }],
}>();
const addType = ref<WorkflowStep['type']>('value');
const dragTarget = ref<number>();

function target({ index }: { index: number }): WorkflowDropTarget {
  return { parentId: props.parentId, branch: props.branch, index };
}

function drag({ event, id }: { event: DragEvent, id: WorkflowStepId }): void {
  if (props.disabled || !event.dataTransfer) {
    event.preventDefault();
    return;
  }
  event.dataTransfer.setData('application/x-naidan-workflow-step', idToRaw({ id }));
  event.dataTransfer.effectAllowed = 'move';
}

function drop({ event, index }: { event: DragEvent, index: number }): void {
  dragTarget.value = undefined;
  if (props.disabled || !event.dataTransfer) {
    return;
  }
  const step = event.dataTransfer.getData('application/x-naidan-workflow-step');
  const part = event.dataTransfer.getData('application/x-naidan-workflow-part');
  if (step) {
    emit('move', { id: toWorkflowStepId({ raw: step }), target: target({ index }) });
  } else if (part) {
    emit('insertPart', { id: toWorkflowId({ raw: part }), target: target({ index }) });
  }
}

function selectType({ event }: { event: Event }): void {
  const value = workflowInputText({ event });
  const type = workflowStepTypes.find(type => type === value);
  if (type) {
    addType.value = type;
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div tw-class="min-w-0" data-testid="workflow-step-list">
    <template v-for="(step, index) in steps" :key="idToRaw({ id: step.id })">
      <div @dragover.prevent.stop="dragTarget = index" @dragleave="dragTarget = undefined" @drop.prevent.stop="drop({ event: $event, index })" :tw-class="['h-3 rounded transition-colors', dragTarget === index ? 'bg-blue-400/40' : 'bg-transparent']" :aria-label="lazyStrings.workflow__drop_here()" />
      <section :tw-class="['rounded-xl border bg-white dark:bg-gray-900 shadow-sm transition-colors', selected.has(step.id) ? 'border-blue-500 ring-1 ring-blue-500/30' : 'border-gray-200 dark:border-gray-700']">
        <div tw-class="flex items-center gap-1 p-2">
          <button type="button" :draggable="!disabled" :disabled="disabled" @dragstart.stop="drag({ event: $event, id: step.id })" :title="lazyStrings.workflow__drag_step()" :aria-label="lazyStrings.workflow__drag_step()" tw-class="p-1 text-gray-400 cursor-grab rounded focus-visible:ring-2 focus-visible:ring-blue-500"><GripVerticalIcon tw-class="h-4 w-4" /></button>
          <input type="checkbox" :checked="selected.has(step.id)" :disabled="disabled" @change="emit('select', { id: step.id, multiple: true })" :aria-label="lazyStrings.workflow__selected()" tw-class="rounded border-gray-300 text-blue-600" />
          <button type="button" :disabled="disabled" @click="emit('select', { id: step.id, multiple: $event.ctrlKey || $event.metaKey })" tw-class="min-w-0 flex-1 text-left rounded-lg px-2 py-1 focus-visible:ring-2 focus-visible:ring-blue-500">
            <span tw-class="block truncate text-sm font-medium text-gray-800 dark:text-gray-100">{{ step.name || workflowStepLabel({ type: step.type }) }}</span>
            <span tw-class="block text-[10px] text-gray-500 dark:text-gray-400">{{ workflowStepLabel({ type: step.type }) }} · {{ idToRaw({ id: step.id }).slice(0, 6) }}</span>
          </button>
          <button type="button" :disabled="disabled || index === 0" @click="emit('move', { id: step.id, target: target({ index: index - 1 }) })" :aria-label="lazyStrings.workflow__move_up()" tw-class="p-1 text-gray-400 rounded hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-20"><ArrowUpIcon tw-class="h-3.5 w-3.5" /></button>
          <button type="button" :disabled="disabled || index === steps.length - 1" @click="emit('move', { id: step.id, target: target({ index: index + 2 }) })" :aria-label="lazyStrings.workflow__move_down()" tw-class="p-1 text-gray-400 rounded hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-20"><ArrowDownIcon tw-class="h-3.5 w-3.5" /></button>
        </div>
        <div v-if="step.type === 'repeat' || step.type === 'for_each'" tw-class="ml-4 mr-2 mb-3 pl-3 border-l-2 border-blue-300 dark:border-blue-700">
          <p tw-class="text-[10px] text-gray-500">{{ lazyStrings.workflow__body() }}</p>
          <WorkflowStepList :steps="step.body.steps" :selected="selected" :parent-id="step.id" branch="body" :disabled="disabled" @select="emit('select', $event)" @move="emit('move', $event)" @add="emit('add', $event)" @insert-part="emit('insertPart', $event)" />
        </div>
        <template v-else-if="step.type === 'if'">
          <div v-for="branchName in (['then', 'else'] as const)" :key="branchName" tw-class="ml-4 mr-2 mb-3 pl-3 border-l-2 border-gray-300 dark:border-gray-600">
            <p tw-class="text-[10px] text-gray-500">{{ branchName === 'then' ? lazyStrings.workflow__then() : lazyStrings.workflow__else() }}</p>
            <WorkflowStepList :steps="step[branchName].steps" :selected="selected" :parent-id="step.id" :branch="branchName" :disabled="disabled" @select="emit('select', $event)" @move="emit('move', $event)" @add="emit('add', $event)" @insert-part="emit('insertPart', $event)" />
          </div>
        </template>
      </section>
    </template>
    <div @dragover.prevent.stop="dragTarget = steps.length" @dragleave="dragTarget = undefined" @drop.prevent.stop="drop({ event: $event, index: steps.length })" :tw-class="['my-2 min-h-9 flex items-center justify-center rounded-lg border border-dashed text-xs', dragTarget === steps.length ? 'border-blue-400 bg-blue-50 text-blue-600 dark:bg-blue-900/20' : 'border-gray-200 text-gray-400 dark:border-gray-700']">{{ lazyStrings.workflow__drop_here() }}</div>
    <div tw-class="flex gap-1 items-center">
      <select :value="addType" @change="selectType({ event: $event })" :disabled="disabled" :aria-label="lazyStrings.workflow__add_step()" tw-class="min-w-0 flex-1 text-xs rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-2 text-gray-700 dark:text-gray-300">
        <option v-for="type in workflowStepTypes" :key="type" :value="type">{{ workflowStepLabel({ type }) }}</option>
      </select>
      <button type="button" :disabled="disabled" @click="emit('add', { type: addType, target: target({ index: steps.length }) })" :aria-label="lazyStrings.workflow__add_step()" tw-class="p-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40"><PlusIcon tw-class="w-4 h-4" /></button>
    </div>
  </div>
</template>
