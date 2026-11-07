import { clonePlainData } from '@/utils/clone-plain-data';
import type { WorkflowDefinition, WorkflowStep, WorkflowValue } from '@/01-models/workflow';
import { idToRaw, type WorkflowStepId } from '@/01-models/ids';
import { analyzeWorkflowTypes, type WorkflowValueBinding } from './value-types';
import { workflowReferenceChoices } from './value-inputs';
import { validateWorkflow } from './definition';
import { formatWorkflowValue } from '@/00-storage/service/workflow-json';
import { findWorkflowStep, moveWorkflowStep, type WorkflowDropTarget } from './editor';

export type WorkflowGraphScope = {
  key: string,
  parentId: WorkflowStepId | undefined,
  branch: WorkflowDropTarget['branch'],
  ancestors: { id: WorkflowStepId, name: string, branch: WorkflowDropTarget['branch'] }[],
  steps: WorkflowStep[],
};
export type WorkflowGraphEdit =
  | { type: 'connect', stepId: WorkflowStepId, location: readonly (string | number)[], previous: WorkflowValue, reference: WorkflowValue }
  | { type: 'move', stepId: WorkflowStepId, target: WorkflowDropTarget };
export type WorkflowGraphRequest = { definition: WorkflowDefinition, edit: WorkflowGraphEdit };
export type WorkflowGraphEdge = {
  sourceId: WorkflowStepId,
  targetId: WorkflowStepId,
  location: readonly (string | number)[],
  path: string,
  reference: Extract<WorkflowValue, { type: 'step_output' | 'loop_item' | 'loop_index' | 'loop_state' }>,
};

/** Scope keys contain IDs rather than names, which may be duplicate or edited. */
export function workflowGraphScopes({ definition }: { definition: WorkflowDefinition }): WorkflowGraphScope[] {
  const scopes: WorkflowGraphScope[] = [];
  function visit({ steps, parentId, branch, ancestors }: { steps: WorkflowStep[], parentId: WorkflowStepId | undefined, branch: WorkflowDropTarget['branch'], ancestors: WorkflowGraphScope['ancestors'] }): void {
    scopes.push({ key: JSON.stringify([parentId === undefined ? '' : idToRaw({ id: parentId }), branch]), parentId, branch, ancestors, steps });
    for (const step of steps) {
      const child = ({ steps, branch }: { steps: WorkflowStep[], branch: WorkflowDropTarget['branch'] }) => visit({ steps, parentId: step.id, branch, ancestors: [...ancestors, { id: step.id, name: step.name, branch }] });
      switch (step.type) {
      case 'repeat': case 'for_each': child({ steps: step.body.steps, branch: 'body' });
        break;
      case 'if':
        child({ steps: step.then.steps, branch: 'then' });
        child({ steps: step.else.steps, branch: 'else' });
        break;
      case 'value': case 'model_selection': case 'parse_json': case 'text_generation': case 'audio_generation': case 'image_generation': case 'tool_call': case 'request_input': case 'read_file': case 'write_file': break;
      default: {
        const exhaustive: never = step;
        throw new Error(String(exhaustive));
      }
      }
    }
  }
  visit({ steps: definition.steps, parentId: undefined, branch: 'root', ancestors: [] });
  return scopes;
}

/** Diagnostic paths are for people; exact locations remain arrays, including odd keys. */
export function workflowGraphLocationLabel({ location }: { location: readonly (string | number)[] }): string {
  return location.map(key => typeof key === 'number' ? `[${key}]` : `[${JSON.stringify(key)}]`).join('');
}

export function workflowGraphEdges({ bindings }: { bindings: Map<WorkflowStepId, WorkflowValueBinding[]> }): WorkflowGraphEdge[] {
  const edges: WorkflowGraphEdge[] = [];
  for (const [targetId, inputs] of bindings) {
    for (const input of inputs) {
      const reference = input.value;
      switch (reference.type) {
      case 'step_output': case 'loop_item': case 'loop_index': case 'loop_state':
        edges.push({ sourceId: reference.stepId, targetId, location: input.location, path: input.path, reference });
        break;
      // The analyzer visits expression children, but never literal JSON data.
      case 'literal': case 'model': case 'array': case 'object': case 'concat': case 'path': case 'get': case 'filename': case 'format_number': case 'equals': case 'not_empty': case 'conversation': case 'range': case 'json_compose': case 'arithmetic': case 'compare': case 'all': case 'any': case 'not': break;
      default: {
        const exhaustive: never = reference;
        throw new Error(String(exhaustive));
      }
      }
    }
  }
  return edges;
}

function assertUniqueIds({ definition }: { definition: WorkflowDefinition }): void {
  const ids = new Set<WorkflowStepId>();
  for (const scope of workflowGraphScopes({ definition })) {
    for (const step of scope.steps) {
      if (ids.has(step.id)) {
        throw new Error('Graph edits require unique Step IDs. Resolve duplicate IDs in JSON first.');
      }
      ids.add(step.id);
    }
  }
}

function replaceBinding({ step, location, value }: { step: WorkflowStep, location: readonly (string | number)[], value: WorkflowValue }): void {
  // Only analyzer-issued expression addresses may reach this function. Do not
  // interpret dots/brackets as traversal, and do not invoke inherited setters.
  let parent: unknown = step;
  for (const key of location.slice(0, -1)) {
    if (typeof parent !== 'object' || parent === null || !Object.hasOwn(parent, key)) {
      throw new Error('The selected input no longer exists.');
    }
    parent = Reflect.get(parent, key);
  }
  const key = location.at(-1);
  if (key === undefined || typeof parent !== 'object' || parent === null || !Object.hasOwn(parent, key)) {
    throw new Error('The selected input no longer exists.');
  }
  Object.defineProperty(parent, key, { value: clonePlainData({ value: value }), enumerable: true, configurable: true, writable: true });
}

function assertNoNewProblems({ before, after }: { before: WorkflowDefinition, after: WorkflowDefinition }): void {
  // Existing incomplete drafts may still be edited. Count diagnostics so one old
  // failure cannot mask a second, newly introduced failure with the same label.
  const counts = new Map<string, number>();
  const key = ({ issue }: { issue: ReturnType<typeof validateWorkflow>[number] }) => JSON.stringify([issue.stepId, issue.path, issue.message]);
  for (const issue of validateWorkflow({ definition: before })) {
    const id = key({ issue });
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  for (const issue of validateWorkflow({ definition: after })) {
    const id = key({ issue }), count = counts.get(id) ?? 0;
    if (count === 0) {
      throw new Error(`${issue.path}: ${issue.message}`);
    }
    counts.set(id, count - 1);
  }
}

/** Atomic edits validate the consumer and downstream users, never grant authority. */
export function editWorkflowGraph({ definition, edit }: { definition: WorkflowDefinition, edit: WorkflowGraphEdit }): WorkflowDefinition {
  assertUniqueIds({ definition });
  let next: WorkflowDefinition;
  switch (edit.type) {
  case 'connect': {
    const input = analyzeWorkflowTypes({ definition }).valueBindings.get(edit.stepId)?.find(input => JSON.stringify(input.location) === JSON.stringify(edit.location));
    if (!input || formatWorkflowValue({ value: input.value }) !== formatWorkflowValue({ value: edit.previous })) {
      throw new Error('The selected input changed. Select it again before connecting.');
    }
    const choice = workflowReferenceChoices({ scope: input.scope, expected: input.expected }).find(choice => JSON.stringify(choice.value) === JSON.stringify(edit.reference));
    if (!choice) {
      throw new Error('This output is not available or compatible at the selected input.');
    }
    next = clonePlainData({ value: definition });
    const step = findWorkflowStep({ steps: next.steps, id: edit.stepId });
    if (!step) {
      throw new Error('The selected Step no longer exists.');
    }
    replaceBinding({ step, location: input.location, value: choice.value });
    break;
  }
  case 'move': next = moveWorkflowStep({ definition, id: edit.stepId, target: edit.target });
    break;
  default: {
    const exhaustive: never = edit;
    throw new Error(String(exhaustive));
  }
  }
  assertNoNewProblems({ before: definition, after: next });
  return next;
}

export const TEST_ONLY = {
};
