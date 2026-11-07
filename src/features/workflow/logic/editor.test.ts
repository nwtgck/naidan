import { describe, expect, it } from 'vitest';
import { createWorkflowHistory, moveWorkflowStep, selectedWorkflowSteps, replaceWorkflowStep, insertWorkflowSteps } from './editor';
import { baseStep, stepId, valueStep } from './workflow.test-support';
import type { WorkflowDefinition } from '@/01-models/workflow';

describe('Workflow structural editing', () => {
  it('moves a step down within the same list without shifting it twice', () => {
    const definition = { name: 'test', steps: ['a', 'b', 'c'].map(id => valueStep({ id, value: { type: 'literal', value: id } })) };
    const moved = moveWorkflowStep({ definition, id: stepId({ raw: 'a' }), target: { parentId: undefined, branch: 'root', index: 3 } });
    expect(moved.steps.map(step => step.id)).toEqual(['b', 'c', 'a']);
    expect(definition.steps.map(step => step.id)).toEqual(['a', 'b', 'c']);
  });

  it('allows moving into a control block and refuses moving a parent into its descendant', () => {
    const loop = baseStep({ type: 'repeat', id: 'loop' });
    if (loop.type !== 'repeat') {
      throw new Error('fixture');
    }
    const nested = baseStep({ type: 'repeat', id: 'nested' });
    loop.body.steps = [nested];
    const value = valueStep({ id: 'a', value: { type: 'literal', value: 'x' } });
    const definition = { name: 'test', steps: [loop, value] };
    const moved = moveWorkflowStep({ definition, id: value.id, target: { parentId: loop.id, branch: 'body', index: 0 } });
    expect(moved.steps).toHaveLength(1);
    expect(moved.steps[0]).toMatchObject({ body: { steps: [{ id: 'a' }, { id: 'nested' }] } });
    expect(() => moveWorkflowStep({ definition, id: loop.id, target: { parentId: nested.id, branch: 'body', index: 0 } })).toThrow('itself');
  });

  it('copies a selected parent only once even when descendants are selected too', () => {
    const loop = baseStep({ type: 'repeat', id: 'loop' });
    if (loop.type !== 'repeat') {
      throw new Error('fixture');
    }
    const child = valueStep({ id: 'a', value: { type: 'literal', value: 'x' } });
    loop.body.steps = [child];
    const copied = selectedWorkflowSteps({ definition: { name: '', steps: [loop] }, ids: new Set([loop.id, child.id]) });
    expect(copied).toHaveLength(1);
    expect(copied[0]?.id).not.toBe(loop.id);
    expect(copied[0]).toMatchObject({ body: { steps: [expect.objectContaining({ name: child.name })] } });
  });

  it('rejects stale insertion and replacement targets rather than dropping edits', () => {
    const step = valueStep({ id: 'a', value: { type: 'literal', value: 'x' } });
    const definition: WorkflowDefinition = { name: '', steps: [] };
    expect(() => replaceWorkflowStep({ definition, step })).toThrow('no longer exists');
    expect(() => insertWorkflowSteps({ definition, steps: [step], target: { parentId: step.id, branch: 'body', index: 0 } })).toThrow('no longer exists');
  });

  it('caps history and makes a new edit invalidate redo without retaining mutable snapshots', () => {
    const history = createWorkflowHistory();
    for (let index = 0; index < 50; index++) {
      history.push({ definition: { name: String(index), steps: [] } });
    }
    expect(history.getState()).toEqual({ undo: 30, redo: 0 });
    const current = { name: '50', steps: [] };
    expect(history.undo({ current })?.name).toBe('49');
    current.name = 'changed';
    expect(history.redo({ current })?.name).toBe('50');
    history.undo({ current });
    history.push({ definition: current });
    expect(history.getState().redo).toBe(0);
    history.clear();
    expect(history.getState()).toEqual({ undo: 0, redo: 0 });
  });
});
