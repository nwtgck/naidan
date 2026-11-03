<script setup lang="ts">
import { computed } from 'vue';
import type { WorkflowDefinition } from '@/01-models/workflow';
import { idToRaw, type WorkflowStepId } from '@/01-models/ids';
import { mapWorkflowSteps, workflowOutputNames, childWorkflowSteps } from '@/features/workflow/logic/definition';
import { lazyStrings } from '@/strings';
const props = defineProps<{ definition: WorkflowDefinition }>();
const emit = defineEmits<{ select: [id: WorkflowStepId] }>();
const graph = computed(() => {
  const roots = new Set(props.definition.steps.map(step => step.id));
  const edges: { source: WorkflowStepId, target: WorkflowStepId, output: string }[] = [];
  const levels = new Map<WorkflowStepId, number>();
  const rows = new Map<number, number>();
  const nodes = props.definition.steps.map(step => {
    let level = 0;
    mapWorkflowSteps({
      steps: [step],
      stepId: ({ id }) => id,
      transform: ({ value }) => {
        if (value.type === 'step_output' && roots.has(value.stepId) && value.stepId !== step.id) {
          if (!edges.some(edge => edge.source === value.stepId && edge.target === step.id && edge.output === value.output)) {
            edges.push({ source: value.stepId, target: step.id, output: value.output });
          }
          level = Math.max(level, (levels.get(value.stepId) ?? 0) + 1);
        }
        return value;
      },
    });
    levels.set(step.id, level);
    const row = rows.get(level) ?? 0;
    rows.set(level, row + 1);
    return { step, x: 24 + level * 280, y: 30 + row * 145, children: childWorkflowSteps({ step }).reduce((count, steps) => count + steps.length, 0) };
  });
  return { nodes, edges, width: Math.max(600, ...nodes.map(node => node.x + 250)), height: Math.max(300, ...nodes.map(node => node.y + 130)) };
});

function edgePath({ source, target }: { source: WorkflowStepId, target: WorkflowStepId }): string {
  const from = graph.value.nodes.find(node => node.step.id === source), to = graph.value.nodes.find(node => node.step.id === target);
  if (!from || !to) {
    return '';
  }
  const start = from.x + 220, end = to.x;
  return `M ${start} ${from.y + 48} C ${start + 30} ${from.y + 48}, ${end - 30} ${to.y + 48}, ${end} ${to.y + 48}`;
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div tw-class="h-full min-h-0 flex flex-col p-4 gap-3">
    <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.workflow__graph_notice() }}</p>
    <div tw-class="flex-1 min-h-0 overflow-auto rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-950">
      <svg :width="graph.width" :height="graph.height" :viewBox="`0 0 ${graph.width} ${graph.height}`" :aria-label="lazyStrings.workflow__graph()" role="img">
        <path v-for="edge in graph.edges" :key="`${idToRaw({ id: edge.source })}-${idToRaw({ id: edge.target })}-${edge.output}`" :d="edgePath(edge)" fill="none" stroke="currentColor" stroke-width="2" tw-class="text-blue-400/70"><title>{{ edge.output }}</title></path>
        <g v-for="node in graph.nodes" :key="idToRaw({ id: node.step.id })" :transform="`translate(${node.x}, ${node.y})`" tabindex="0" role="button" :aria-label="node.step.name" @click="emit('select', node.step.id)" @keydown.enter="emit('select', node.step.id)" tw-class="cursor-pointer outline-none focus:text-blue-500">
          <rect width="220" height="108" rx="12" fill="currentColor" stroke="currentColor" tw-class="text-white dark:text-gray-800" />
          <rect width="220" height="108" rx="12" fill="none" stroke="currentColor" tw-class="text-gray-300 dark:text-gray-600" />
          <text x="14" y="27" font-size="12" fill="currentColor" tw-class="text-gray-800 dark:text-gray-100">{{ node.step.name.slice(0, 23) }}</text>
          <text x="14" y="48" font-size="10" fill="currentColor" tw-class="text-gray-500 dark:text-gray-400">{{ node.step.type }}{{ node.children ? ` · ${node.children}` : '' }}</text>
          <text x="14" y="77" font-size="9" fill="currentColor" tw-class="text-blue-600 dark:text-blue-400">{{ workflowOutputNames({ step: node.step }).join(' · ').slice(0, 37) }}</text>
          <circle cx="0" cy="48" r="4" fill="currentColor" tw-class="text-blue-400" /><circle cx="220" cy="48" r="4" fill="currentColor" tw-class="text-blue-400" />
        </g>
      </svg>
    </div>
  </div>
</template>
