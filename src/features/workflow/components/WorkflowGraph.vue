<script setup lang="ts">
import { computed, ref, shallowRef, useId, watch } from 'vue';
import type { WorkflowDefinition, WorkflowStep } from '@/01-models/workflow';
import { idToRaw, type WorkflowStepId } from '@/01-models/ids';
import { lazyStrings } from '@/strings';
import SettingsFormSelect from '@/components/SettingsFormSelect.vue';
import WorkflowDisclosure from './WorkflowDisclosure.vue';
import WorkflowGraphConnections from './WorkflowGraphConnections.vue';
import { analyzeWorkflowTypes } from '@/features/workflow/logic/value-types';
import { findWorkflowStep, type WorkflowDropTarget } from '@/features/workflow/logic/editor';
import { workflowGraphScopes, workflowGraphEdges, type WorkflowGraphScope, type WorkflowGraphRequest } from '@/features/workflow/logic/graph';
import { workflowStepLabel, workflowStepTypes, workflowInputText } from '@/features/workflow/logic/forms';

const props = defineProps<{ definition: WorkflowDefinition, selectedId: WorkflowStepId | undefined, selectedIds: ReadonlySet<WorkflowStepId>, disabled: boolean }>();
const emit = defineEmits<{ select: [id: WorkflowStepId], edit: [request: WorkflowGraphRequest], add: [request: { type: WorkflowStep['type'], target: WorkflowDropTarget }] }>();
const scopes = computed(() => workflowGraphScopes({ definition: props.definition }));
const markerId = useId();
const scopeKey = ref(''), page = ref(0), destinationKey = ref(''), position = ref('1');
const scope = computed(() => scopes.value.find(scope => scope.key === scopeKey.value) ?? scopes.value[0]!);
const destination = computed(() => scopes.value.find(scope => scope.key === destinationKey.value));
const selected = computed(() => props.selectedId === undefined ? undefined : findWorkflowStep({ steps: props.definition.steps, id: props.selectedId }));
const analysis = computed(() => analyzeWorkflowTypes({ definition: props.definition }));
const edges = computed(() => workflowGraphEdges({ bindings: analysis.value.valueBindings }));
const pageCount = computed(() => Math.max(1, Math.ceil(scope.value.steps.length / 40)));
const visible = computed(() => scope.value.steps.slice(page.value * 40, (page.value + 1) * 40));
const visibleIndexes = computed(() => new Map(visible.value.map((step, index) => [step.id, index])));
const curves = computed(() => edges.value.flatMap(edge => {
  const from = visibleIndexes.value.get(edge.sourceId), to = visibleIndexes.value.get(edge.targetId);
  // Loop values refer to the active iteration, not the parent's final output.
  return edge.reference.type === 'step_output' && from !== undefined && to !== undefined && from !== to ? [{ ...edge, from, to }] : [];
}).slice(0, 200));
const stepType = ref<WorkflowStep['type']>('value');
const stepOptions = computed(() => workflowStepTypes.map(type => ({ value: type, label: workflowStepLabel({ type }) })));
const drag = shallowRef<{ definition: WorkflowDefinition, id: WorkflowStepId }>();
const validPosition = computed(() => /^\d+$/.test(position.value) && Number.isSafeInteger(Number(position.value)) && Number(position.value) >= 1 && destination.value !== undefined && Number(position.value) <= destination.value.steps.length + 1);

function branchLabel({ branch }: { branch: WorkflowDropTarget['branch'] }): string | undefined {
  switch (branch) {
  case 'root': return lazyStrings.workflow__graph_root();
  case 'body': return lazyStrings.workflow__graph_body();
  case 'then': return lazyStrings.workflow__graph_then();
  case 'else': return lazyStrings.workflow__graph_else();
  default: {
    const exhaustive: never = branch;
    throw new Error(String(exhaustive));
  }
  }
}

function scopeLabel({ scope }: { scope: WorkflowGraphScope }): string | undefined {
  const root = lazyStrings.workflow__graph_root();
  return root === undefined ? undefined : [root, ...scope.ancestors.map(ancestor => `${ancestor.name} [${idToRaw({ id: ancestor.id })}] · ${branchLabel({ branch: ancestor.branch }) ?? ''}`)].join(' / ');
}

const scopeOptions = computed(() => scopes.value.map(scope => ({ value: scope.key, label: scopeLabel({ scope }) })));

function revealSelection(): void {
  const containing = scopes.value.find(scope => scope.steps.some(step => step.id === props.selectedId));
  if (containing) {
    scopeKey.value = containing.key;
    page.value = Math.floor(containing.steps.findIndex(step => step.id === props.selectedId) / 40);
  }
}

watch(() => props.selectedId, revealSelection, { immediate: true, flush: 'sync' });
watch(() => props.definition, (_, previous) => {
  drag.value = undefined;
  destinationKey.value = '';
  position.value = '1';
  // Keep an opened child scope during ordinary edits, but follow a selected
  // Step that actually moved to another scope.
  if (!scopes.value.some(scope => scope.key === scopeKey.value)) {
    scopeKey.value = scopes.value[0]!.key;
  }
  const priorScope = workflowGraphScopes({ definition: previous }).find(scope => scope.steps.some(step => step.id === props.selectedId));
  const currentScope = scopes.value.find(scope => scope.steps.some(step => step.id === props.selectedId));
  if (currentScope && priorScope?.key !== currentScope.key) {
    revealSelection();
  } else {
    page.value = Math.min(page.value, pageCount.value - 1);
  }
}, { flush: 'sync' });
watch(() => props.disabled, disabled => {
  if (disabled) {
    drag.value = undefined;
  }
}, { flush: 'sync' });

function chooseScope({ key }: { key: string }): void {
  if (!props.disabled && scopes.value.some(scope => scope.key === key)) {
    scopeKey.value = key;
    page.value = 0;
  }
}

function chooseDestination({ key }: { key: string }): void {
  if (!props.disabled && scopes.value.some(scope => scope.key === key)) {
    destinationKey.value = key;
    position.value = '1';
  }
}

function chooseType({ type }: { type: WorkflowStep['type'] }): void {
  if (!props.disabled) {
    stepType.value = type;
  }
}

function select({ id }: { id: WorkflowStepId }): void {
  if (!props.disabled) {
    emit('select', id);
  }
}

function changePage({ delta }: { delta: number }): void {
  if (!props.disabled) {
    page.value = Math.max(0, Math.min(pageCount.value - 1, page.value + delta));
  }
}

function append(): void {
  if (!props.disabled) {
    emit('add', { type: stepType.value, target: { parentId: scope.value.parentId, branch: scope.value.branch, index: scope.value.steps.length } });
  }
}

function edit({ request }: { request: WorkflowGraphRequest }): void {
  if (!props.disabled && request.definition === props.definition) {
    emit('edit', request);
  }
}

function move(): void {
  if (!props.disabled && selected.value && destination.value && validPosition.value) {
    edit({ request: { definition: props.definition, edit: { type: 'move', stepId: selected.value.id, target: { parentId: destination.value.parentId, branch: destination.value.branch, index: Number(position.value) - 1 } } } });
  }
}

function beginDrag({ event, id }: { event: DragEvent, id: WorkflowStepId }): void {
  if (props.disabled || !event.dataTransfer) {
    event.preventDefault();
    return;
  }
  drag.value = { definition: props.definition, id };
  event.dataTransfer.effectAllowed = 'move';
  // The payload is only a browser drag hint, never an authority or edit command.
  event.dataTransfer.setData('text/plain', idToRaw({ id }));
}

function drop({ index }: { index: number }): void {
  const active = drag.value;
  drag.value = undefined;
  if (!props.disabled && active?.definition === props.definition) {
    edit({ request: { definition: active.definition, edit: { type: 'move', stepId: active.id, target: { parentId: scope.value.parentId, branch: scope.value.branch, index } } } });
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div data-testid="workflow-graph" tw-class="space-y-4">
    <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.workflow__graph_edit_notice() }}</p>
    <SettingsFormSelect data-testid="graph-scope" :model-value="scope.key" :options="scopeOptions" :label="lazyStrings.workflow__graph_scope()" :disabled="disabled" @update:model-value="chooseScope({ key: $event })" />
    <WorkflowGraphConnections v-if="selected" :definition="definition" :step="selected" :bindings="analysis.valueBindings.get(selected.id) ?? []" :disabled="disabled" @edit="edit({ request: $event })" />
    <WorkflowDisclosure v-if="selected" :title="lazyStrings.workflow__graph_move()">
      <div tw-class="space-y-3">
        <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.workflow__graph_move_notice() }}</p>
        <SettingsFormSelect data-testid="graph-destination" :model-value="destinationKey" :options="[{ value: '', label: lazyStrings.workflow__not_selected() }, ...scopeOptions]" :label="lazyStrings.workflow__graph_destination()" :disabled="disabled" @update:model-value="chooseDestination({ key: $event })" />
        <label tw-class="block space-y-1 text-xs text-gray-600 dark:text-gray-300"><span>{{ lazyStrings.workflow__graph_position() }}</span><input data-testid="graph-position" :value="position" inputmode="numeric" :disabled="disabled" :aria-invalid="!!destination && !validPosition" @input="!disabled && (position = workflowInputText({ event: $event }))" tw-class="block w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 p-2" /></label>
        <button data-testid="graph-move-apply" type="button" :disabled="disabled || !validPosition" @click="move" tw-class="rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-xs disabled:opacity-40">{{ lazyStrings.workflow__apply() }}</button>
      </div>
    </WorkflowDisclosure>
    <div tw-class="flex flex-wrap items-center gap-2">
      <SettingsFormSelect data-testid="graph-add-type" :model-value="stepType" :options="stepOptions" :label="lazyStrings.workflow__graph_add()" :disabled="disabled" @update:model-value="chooseType({ type: $event })" />
      <button type="button" data-testid="graph-add" :disabled="disabled" @click="append" tw-class="rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-xs disabled:opacity-40">{{ lazyStrings.workflow__graph_add() }}</button>
    </div>
    <p v-if="!scope.steps.length" data-testid="graph-empty" tw-class="text-sm text-gray-500 dark:text-gray-400">{{ lazyStrings.workflow__graph_empty() }}</p>
    <div tw-class="flex flex-wrap items-center gap-2 text-xs">
      <button type="button" data-testid="graph-previous" :disabled="disabled || page === 0" @click="changePage({ delta: -1 })" tw-class="rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 disabled:opacity-40">{{ lazyStrings.workflow__graph_previous() }}</button>
      <span data-testid="graph-page" aria-live="polite">{{ page + 1 }} / {{ pageCount }} · {{ scope.steps.length }}</span>
      <button type="button" data-testid="graph-next" :disabled="disabled || page + 1 >= pageCount" @click="changePage({ delta: 1 })" tw-class="rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 disabled:opacity-40">{{ lazyStrings.workflow__graph_next() }}</button>
    </div>
    <p tw-class="text-[11px] text-gray-500 dark:text-gray-400">{{ lazyStrings.workflow__graph_page_notice() }}</p>
    <div tw-class="relative">
      <svg :height="visible.length * 180" width="64" aria-hidden="true" tw-class="absolute left-0 top-0 pointer-events-none text-blue-500 dark:text-blue-400">
        <defs><marker :id="markerId" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 6 3 L 0 6 z" fill="currentColor" /></marker></defs>
        <path v-for="(edge, index) in curves" :marker-end="`url(#${markerId})`" :key="index" :d="`M 62 ${edge.from * 180 + 48} C ${8 + index % 5 * 8} ${edge.from * 180 + 48}, ${8 + index % 5 * 8} ${edge.to * 180 + 48}, 62 ${edge.to * 180 + 48}`" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.65" data-testid="graph-reference-curve" />
        <path v-for="(_, index) in visible.slice(1)" :key="`order-${index}`" :d="`M 52 ${index * 180 + 80} V ${(index + 1) * 180 + 28} l -4 -6 m 4 6 l 4 -6`" fill="none" stroke="currentColor" stroke-dasharray="4 4" tw-class="text-gray-400 dark:text-gray-500" />
      </svg>
      <ol tw-class="relative ml-16" :aria-label="lazyStrings.workflow__steps()">
        <li v-for="(step, index) in visible" :key="idToRaw({ id: step.id })" :data-graph-node="idToRaw({ id: step.id })" tw-class="h-[180px] pb-4" @dragover.prevent @drop.prevent="drop({ index: page * 40 + index })">
          <div :tw-class="['h-full rounded-xl border bg-white dark:bg-gray-900 p-3 overflow-y-auto', selectedIds.has(step.id) ? 'border-blue-500 ring-1 ring-blue-500' : 'border-gray-200 dark:border-gray-700']">
            <div tw-class="flex items-start gap-2">
              <button type="button" :disabled="disabled" :aria-pressed="selectedIds.has(step.id)" @click="select({ id: step.id })" tw-class="min-w-0 flex-1 rounded text-left focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40" data-testid="graph-select-node">
                <span tw-class="text-[10px] text-gray-400">{{ page * 40 + index + 1 }} · {{ workflowStepLabel({ type: step.type }) }}</span>
                <strong tw-class="block truncate text-sm" :title="`${step.name} [${idToRaw({ id: step.id })}]`">{{ step.name }}</strong>
              </button>
              <button type="button" :disabled="disabled" :draggable="!disabled" :aria-label="lazyStrings.workflow__graph_drag()" :title="lazyStrings.workflow__graph_drag()" @dragstart="beginDrag({ event: $event, id: step.id })" @dragend="drag = undefined" tw-class="rounded border border-gray-200 dark:border-gray-700 px-2 py-1 text-xs cursor-grab disabled:opacity-40" data-testid="graph-drag">↕</button>
            </div>
            <p tw-class="mt-2 truncate text-[10px] text-blue-600 dark:text-blue-400">{{ Object.entries(analysis.outputTypes.get(step.id) ?? {}).map(([name, type]) => `${name}: ${type.kind}`).join(' · ') }}</p>
            <div tw-class="mt-2 flex flex-wrap gap-1">
              <button v-for="child in scopes.filter(scope => scope.parentId === step.id)" :key="child.key" type="button" :disabled="disabled" @click="chooseScope({ key: child.key })" tw-class="rounded-lg border border-gray-200 dark:border-gray-700 px-2 py-1 text-xs disabled:opacity-40" :data-graph-branch="child.branch">{{ branchLabel({ branch: child.branch }) }} · {{ child.steps.length }}</button>
            </div>
          </div>
        </li>
      </ol>
    </div>
    <div data-testid="graph-drop-end" @dragover.prevent @drop.prevent="drop({ index: scope.steps.length })" tw-class="rounded-lg border border-dashed border-gray-300 dark:border-gray-700 p-3 text-center text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.workflow__graph_drop() }}</div>
  </div>
</template>
