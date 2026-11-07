import { clonePlainData } from '@/utils/clone-plain-data';
import type { WorkflowStep, WorkflowDefinition, WorkflowValue } from '@/01-models/workflow';
import type { Endpoint, LmParameters } from '@/01-models/types';
import { toVolumeId, type WorkflowStepId } from '@/01-models/ids';
import { generateId } from '@/01-models/id';
import { childWorkflowSteps, copyWorkflowSteps } from './definition';
import { defaultWorkflowAudioParameters } from './audio-input';
import { defaultWorkflowImageParameters } from './image-input';
import { formatWorkflowDefinition } from '@/00-storage/service/workflow-json';

export type WorkflowDropTarget = { parentId: WorkflowStepId | undefined, branch: 'root' | 'body' | 'then' | 'else', index: number };

export function literalValue({ value }: { value: string | number | boolean }): WorkflowValue {
  return { type: 'literal', value };
}

export function newWorkflowStep({ type, name, endpoint, modelId, lmParameters }: {
  type: WorkflowStep['type'], name: string, endpoint: Endpoint, modelId: string, lmParameters: LmParameters | undefined,
}): WorkflowStep {
  const id = generateId<WorkflowStepId>();
  switch (type) {
  case 'value': return { id, name, type, value: literalValue({ value: '' }) };
  case 'model_selection': return { id, name, type, targets: [{ endpoint, modelId, lmParameters }] };
  case 'parse_json': return { id, name, type, source: literalValue({ value: '[]' }) };
  case 'text_generation': return {
    id,
    name,
    type,
    target: { type: 'model', endpoint, modelId },
    conversation: { type: 'conversation', messages: [] },
    appendMessages: [{ role: 'user', parts: [{ type: 'text', text: '' }] }],
    lmParameters,
    systemPrompt: undefined,
    toolConfigs: [],
  };
  case 'audio_generation': return {
    id,
    name,
    type,
    modelId: literalValue({ value: '' }),
    text: literalValue({ value: '' }),
    reference: undefined,
    parameters: defaultWorkflowAudioParameters(),
    onLimit: 'error',
  };
  case 'image_generation': return { id, name, type, model: { type: 'literal', value: {} }, prompt: { type: 'literal', value: '' }, parameters: defaultWorkflowImageParameters(), gpuBudgetMiB: undefined };
  case 'tool_call': return { id, name, type, tool: { name: 'calculator' }, arguments: { type: 'object', properties: { expression: literalValue({ value: '1 + 1' }) } }, onError: 'fail' };
  case 'request_input': return { id, name, type, prompt: literalValue({ value: '' }), responseType: 'text' };
  case 'repeat': return { id, name, type, count: literalValue({ value: 3 }), state: {}, body: { steps: [] }, emit: undefined };
  case 'for_each': return { id, name, type, source: { type: 'literal', value: [] }, state: {}, body: { steps: [] }, emit: undefined };
  case 'if': return { id, name, type, condition: literalValue({ value: true }), then: { steps: [], outputs: {} }, else: { steps: [], outputs: {} } };
  case 'read_file': return { id, name, type, volumeId: toVolumeId({ raw: '' }), relativePath: literalValue({ value: 'input.txt' }) };
  case 'write_file': return { id, name, type, volumeId: toVolumeId({ raw: '' }), relativePath: literalValue({ value: 'results/answer.txt' }), source: literalValue({ value: '' }), format: 'text', onConflict: 'error' };
  default: {
    const exhaustive: never = type;
    throw new Error(`Unknown step: ${exhaustive}`);
  }
  }
}

export function flatWorkflowSteps({ steps }: { steps: WorkflowStep[] }): WorkflowStep[] {
  return steps.flatMap(step => [step, ...childWorkflowSteps({ step }).flatMap(steps => flatWorkflowSteps({ steps }))]);
}

export function findWorkflowStep({ steps, id }: { steps: WorkflowStep[], id: WorkflowStepId }): WorkflowStep | undefined {
  return flatWorkflowSteps({ steps }).find(step => step.id === id);
}

function locate({ steps, id }: { steps: WorkflowStep[], id: WorkflowStepId }): { list: WorkflowStep[], index: number } | undefined {
  for (const [index, step] of steps.entries()) {
    if (step.id === id) {
      return { list: steps, index };
    }
    for (const child of childWorkflowSteps({ step })) {
      const found = locate({ steps: child, id });
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

function targetList({ definition, target }: { definition: WorkflowDefinition, target: WorkflowDropTarget }): WorkflowStep[] {
  if (target.parentId === undefined && target.branch === 'root') {
    return definition.steps;
  }
  const parent = target.parentId === undefined ? undefined : findWorkflowStep({ steps: definition.steps, id: target.parentId });
  if (parent?.type === 'if' && (target.branch === 'then' || target.branch === 'else')) {
    return parent[target.branch].steps;
  }
  if ((parent?.type === 'repeat' || parent?.type === 'for_each') && target.branch === 'body') {
    return parent.body.steps;
  }
  throw new Error('The drop destination no longer exists.');
}

export function moveWorkflowStep({ definition, id, target }: { definition: WorkflowDefinition, id: WorkflowStepId, target: WorkflowDropTarget }): WorkflowDefinition {
  const next = clonePlainData({ value: definition });
  const source = locate({ steps: next.steps, id });
  if (!source) {
    throw new Error('The moved step no longer exists.');
  }
  const step = source.list[source.index]!;
  if (target.parentId !== undefined && flatWorkflowSteps({ steps: [step] }).some(item => item.id === target.parentId)) {
    throw new Error('A step cannot be moved into itself.');
  }
  const destination = targetList({ definition: next, target });
  if (!Number.isInteger(target.index) || target.index < 0 || target.index > destination.length) {
    throw new Error('Invalid insertion position.');
  }
  const index = destination === source.list && source.index < target.index ? target.index - 1 : target.index;
  source.list.splice(source.index, 1);
  destination.splice(index, 0, step);
  return next;
}

export function insertWorkflowSteps({ definition, steps, target }: { definition: WorkflowDefinition, steps: WorkflowStep[], target: WorkflowDropTarget }): WorkflowDefinition {
  const next = clonePlainData({ value: definition }), destination = targetList({ definition: next, target });
  if (!Number.isInteger(target.index) || target.index < 0 || target.index > destination.length) {
    throw new Error('Invalid insertion position.');
  }
  destination.splice(target.index, 0, ...steps);
  return next;
}

export function replaceWorkflowStep({ definition, step }: { definition: WorkflowDefinition, step: WorkflowStep }): WorkflowDefinition {
  const next = clonePlainData({ value: definition }), found = locate({ steps: next.steps, id: step.id });
  if (!found) {
    throw new Error('The step no longer exists.');
  }
  found.list[found.index] = clonePlainData({ value: step });
  return next;
}

export function removeWorkflowSteps({ definition, ids }: { definition: WorkflowDefinition, ids: Set<WorkflowStepId> }): WorkflowDefinition {
  const next = clonePlainData({ value: definition });
  const remove = ({ steps }: { steps: WorkflowStep[] }): void => {
    for (let index = steps.length - 1; index >= 0; index--) {
      const step = steps[index]!;
      if (ids.has(step.id)) {
        steps.splice(index, 1);
      } else {
        for (const child of childWorkflowSteps({ step })) {
          remove({ steps: child });
        }
      }
    }
  };
  remove({ steps: next.steps });
  return next;
}

export function selectedWorkflowSteps({ definition, ids }: { definition: WorkflowDefinition, ids: Set<WorkflowStepId> }): WorkflowStep[] {
  const selected: WorkflowStep[] = [];
  const visit = ({ steps }: { steps: WorkflowStep[] }): void => {
    for (const step of steps) {
      if (ids.has(step.id)) {
        selected.push(step);
      } else {
        for (const child of childWorkflowSteps({ step })) {
          visit({ steps: child });
        }
      }
    }
  };
  visit({ steps: definition.steps });
  return copyWorkflowSteps({ steps: selected });
}

/** Undo retains bounded document snapshots, never runtime outputs. */
export function createWorkflowHistory() {
  const undo: { definition: WorkflowDefinition, bytes: number }[] = [], redo: typeof undo = [];
  const entry = ({ definition }: { definition: WorkflowDefinition }) => ({ definition: clonePlainData({ value: definition }), bytes: new TextEncoder().encode(formatWorkflowDefinition({ definition })).byteLength });
  const trim = (): void => {
    while (undo.length + redo.length > 30 || [...undo, ...redo].reduce((sum, item) => sum + item.bytes, 0) > 8 * 1024 * 1024) {
      if (undo.length) {
        undo.shift();
      } else {
        redo.shift();
      }
    }
  };
  return {
    push({ definition }: { definition: WorkflowDefinition }) {
      undo.push(entry({ definition }));
      redo.length = 0;
      trim();
    },
    undo({ current }: { current: WorkflowDefinition }) {
      const item = undo.pop();
      if (!item) {
        return undefined;
      }
      redo.push(entry({ definition: current }));
      trim();
      return item.definition;
    },
    redo({ current }: { current: WorkflowDefinition }) {
      const item = redo.pop();
      if (!item) {
        return undefined;
      }
      undo.push(entry({ definition: current }));
      trim();
      return item.definition;
    },
    clear() {
      undo.length = 0;
      redo.length = 0;
    },
    getState() {
      return { undo: undo.length, redo: redo.length };
    },
  };
}

export const TEST_ONLY = {
  locate,
  targetList,
};
