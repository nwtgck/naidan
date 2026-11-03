import { describe, it, expect } from 'vitest';
import { validateWorkflow, copyWorkflowSteps } from './definition';
import { stepId, literal, reference, valueStep, baseStep } from './workflow.test-support';
import { moveWorkflowStep, selectedWorkflowSteps, createWorkflowHistory } from './editor';
import type { WorkflowDefinition, WorkflowStep } from '@/01-models/workflow';

describe('Workflow structure and editor operations', () => {
  it('allows fan-out and join without making the producer run twice', () => {
    const a = valueStep({ id: 'a', value: literal({ value: 'a' }) });
    const b = valueStep({ id: 'b', value: reference({ id: 'a', output: 'value' }) });
    const c = valueStep({ id: 'c', value: reference({ id: 'a', output: 'value' }) });
    const d = valueStep({ id: 'd', value: { type: 'array', items: [reference({ id: 'b', output: 'value' }), reference({ id: 'c', output: 'value' })] } });
    expect(validateWorkflow({ definition: { name: '', steps: [a, b, c, d] } })).toEqual([]);
    expect(validateWorkflow({ definition: { name: '', steps: [b, a, c, d] } })).toHaveLength(1);
  });

  it('checks output names, duplicate identities and empty model inputs', () => {
    const a = valueStep({ id: 'a', value: literal({ value: 1 }) });
    const b = valueStep({ id: 'b', value: reference({ id: 'a', output: 'missing' }) });
    expect(validateWorkflow({ definition: { name: '', steps: [a, a, b] } }).map(issue => issue.path)).toEqual(['id', 'value']);
  });

  it('does not expose an unchosen branch child and requires branch output symmetry', () => {
    const branch: WorkflowStep = { id: stepId({ raw: 'if' }), name: '', type: 'if', condition: literal({ value: true }), then: { steps: [valueStep({ id: 'inside', value: literal({ value: 1 }) })], outputs: { value: reference({ id: 'inside', output: 'value' }) } }, else: { steps: [], outputs: {} } };
    expect(validateWorkflow({ definition: { name: '', steps: [branch, valueStep({ id: 'outside', value: reference({ id: 'inside', output: 'value' }) })] } })).toHaveLength(2);
  });

  it('restricts loop item and carried state to their lexical scopes', () => {
    const loop = baseStep({ type: 'repeat', id: 'loop' });
    if (loop.type !== 'repeat') {
      throw new Error('Wrong fixture');
    }
    loop.state = { first: { initial: literal({ value: 'x' }), next: { type: 'loop_state', stepId: loop.id, key: 'first' } } };
    loop.body.steps = [valueStep({ id: 'child', value: { type: 'loop_item', stepId: loop.id } })];
    const issues = validateWorkflow({ definition: { name: '', steps: [loop, valueStep({ id: 'outside', value: { type: 'loop_state', stepId: loop.id, key: 'first' } })] } });
    expect(issues).toHaveLength(2);
  });

  it('copies only structural identities and remaps all internal references', () => {
    const a = valueStep({ id: 'a', value: { type: 'literal', value: { type: 'step_output', stepId: 'a', id: 'a', value: 'a' } } });
    const b = valueStep({ id: 'b', value: { type: 'array', items: [reference({ id: 'a', output: 'value' }), reference({ id: 'external', output: 'value' })] } });
    const copy = copyWorkflowSteps({ steps: [a, b] });
    expect(copy[0]?.id).not.toBe(a.id);
    expect(copy[0]).toMatchObject({ value: a.value });
    expect(copy[1]).toMatchObject({ value: { items: [{ stepId: copy[0]?.id }, { stepId: stepId({ raw: 'external' }) }] } });
    expect(a.id).toBe(stepId({ raw: 'a' }));
  });

  it('moves into nested blocks without renaming IDs and rejects self nesting', () => {
    const a = valueStep({ id: 'a', value: literal({ value: 1 }) });
    const loop = baseStep({ type: 'repeat', id: 'loop' });
    const definition = { name: '', steps: [a, loop] };
    const moved = moveWorkflowStep({ definition, id: a.id, target: { parentId: loop.id, branch: 'body', index: 0 } });
    expect(moved.steps).toHaveLength(1);
    expect(moved.steps[0]).toMatchObject({ body: { steps: [a] } });
    expect(definition.steps).toHaveLength(2);
    expect(() => moveWorkflowStep({ definition, id: loop.id, target: { parentId: loop.id, branch: 'body', index: 0 } })).toThrow('itself');
  });

  it('copies a selected parent once, without duplicating selected descendants', () => {
    const loop = baseStep({ type: 'repeat', id: 'loop' });
    if (loop.type !== 'repeat') {
      throw new Error('Wrong fixture');
    }
    const a = valueStep({ id: 'a', value: literal({ value: 1 }) });
    loop.body.steps = [a];
    expect(selectedWorkflowSteps({ definition: { name: '', steps: [loop] }, ids: new Set([loop.id, a.id]) })).toHaveLength(1);
  });

  it('bounds undo history and clears redo when editing diverges', () => {
    const history = createWorkflowHistory();
    const current: WorkflowDefinition = { name: 'latest', steps: [] };
    for (let i = 0; i < 40; i++) {
      history.push({ definition: { name: String(i), steps: [] } });
    }
    expect(history.getState().undo).toBe(30);
    expect(history.undo({ current })?.name).toBe('39');
    history.push({ definition: current });
    expect(history.getState().redo).toBe(0);
  });
});
