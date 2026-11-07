import { describe, it, expect } from 'vitest';
import { analyzeWorkflowTypes, emptyWorkflowTypeScope, inferWorkflowValueType, workflowTypeCompatibility } from './value-types';
import { workflowValueInputOptions, workflowReferenceChoices } from './value-inputs';
import { baseStep, literal, stepId, valueStep, reference } from './workflow.test-support';
import { validateWorkflow } from './definition';

describe('Shared Workflow input contracts', () => {
  it('excludes incompatible constructors from iterable inputs, without hiding the current invalid value', () => {
    const scope = emptyWorkflowTypeScope();
    const valid = workflowValueInputOptions({ scope, expected: 'iterable', current: { type: 'array', items: [] } });
    expect(valid.map(option => option.value)).toEqual(expect.arrayContaining(['array', 'range', 'json', 'json_compose']));
    expect(valid.some(option => option.value === 'text')).toBe(false);
    expect(valid.some(option => option.value === 'model')).toBe(false);
    const invalid = workflowValueInputOptions({ scope, expected: 'iterable', current: literal({ value: 'not a list' }) });
    expect(invalid.find(option => option.value === 'text')).toMatchObject({ disabled: true });
  });

  it('keeps ordinary object construction available for model targets but not iterables', () => {
    const scope = emptyWorkflowTypeScope();
    const target = workflowValueInputOptions({ scope, expected: 'model', current: { type: 'model', endpoint: { type: 'llama_cpp_browser' }, modelId: '' } });
    expect(target.some(option => option.value === 'object' && !option.disabled)).toBe(true);
    const iterable = workflowValueInputOptions({ scope, expected: 'iterable', current: { type: 'array', items: [] } });
    expect(iterable.some(option => option.value === 'object')).toBe(false);
  });

  it('distinguishes unknown data from proven mismatches', () => {
    expect(workflowTypeCompatibility({ actual: { kind: 'unknown' }, expected: 'iterable' })).toBe('unknown');
    expect(workflowTypeCompatibility({ actual: { kind: 'text' }, expected: 'iterable' })).toBe('incompatible');
    expect(workflowTypeCompatibility({ actual: { kind: 'array', item: { kind: 'unknown' } }, expected: 'iterable' })).toBe('compatible');
    expect(workflowTypeCompatibility({ actual: { kind: 'union', options: [{ kind: 'text' }, { kind: 'array', item: { kind: 'text' } }] }, expected: 'iterable' })).toBe('unknown');
  });

  it('suggests only preceding in-scope outputs and current loop fields', () => {
    const list = valueStep({ id: 'list', value: { type: 'literal', value: [{ title: 'A', prompt: 'P' }] } });
    const future = valueStep({ id: 'future', value: literal({ value: 'later' }) });
    const loop = baseStep({ type: 'for_each', id: 'loop' });
    const child = valueStep({ id: 'child', value: { type: 'loop_item', stepId: stepId({ raw: 'loop' }) } });
    if (loop.type !== 'for_each') {
      throw new Error('fixture');
    }
    loop.source = reference({ id: 'list', output: 'value' });
    loop.body.steps = [child];
    const analysis = analyzeWorkflowTypes({ definition: { name: '', steps: [list, loop, future] } });
    const scope = analysis.inputs.get(child.id)!;
    expect(scope.outputs.has(future.id)).toBe(false);
    expect(scope.outputs.has(child.id)).toBe(false);
    expect(scope.loops.get(loop.id)?.item).toEqual({ kind: 'object', fields: { title: { kind: 'text' }, prompt: { kind: 'text' } } });
    expect(workflowReferenceChoices({ scope, expected: 'iterable' }).map(choice => choice.value)).toEqual([reference({ id: 'list', output: 'value' })]);
    expect(analysis.inputs.get(future.id)!.loops.size).toBe(0);
  });

  it('infers composed field types and reports missing known fields before execution', () => {
    const value = valueStep({ id: 'compose', value: { type: 'json_compose', base: { count: 1 }, assignments: [{ path: ['name'], value: literal({ value: 'name' }) }] } });
    const get = valueStep({ id: 'get', value: { type: 'get', value: reference({ id: 'compose', output: 'value' }), path: ['missing'] } });
    expect(inferWorkflowValueType({ value: value.value, scope: emptyWorkflowTypeScope() })).toEqual({ kind: 'object', fields: { count: { kind: 'number' }, name: { kind: 'text' } } });
    expect(validateWorkflow({ definition: { name: '', steps: [value, get] } }).some(issue => issue.message.includes('field'))).toBe(true);
  });

  it('propagates model selection through loops without requiring ordinary JSON exports', () => {
    const models = baseStep({ type: 'model_selection', id: 'models' });
    const loop = baseStep({ type: 'for_each', id: 'loop' });
    const generation = baseStep({ type: 'text_generation', id: 'generate' });
    if (loop.type !== 'for_each' || generation.type !== 'text_generation') {
      throw new Error('fixture');
    }
    loop.source = reference({ id: 'models', output: 'value' });
    generation.target = { type: 'loop_item', stepId: loop.id };
    loop.body.steps = [generation];
    const analysis = analyzeWorkflowTypes({ definition: { name: '', steps: [models, loop] } });
    expect(inferWorkflowValueType({ value: generation.target, scope: analysis.inputs.get(generation.id)! })).toEqual({ kind: 'model' });
    expect(analysis.problems).toEqual([]);
  });

  it('rejects invalid array indices and private model fields in known projections', () => {
    for (const key of [-1, 0.5]) {
      const get = valueStep({ id: 'get', value: { type: 'get', value: { type: 'literal', value: ['item'] }, path: [key] } });
      expect(validateWorkflow({ definition: { name: '', steps: [get] } }).length).toBeGreaterThan(0);
    }
    const get = valueStep({ id: 'get', value: { type: 'get', value: { type: 'model', endpoint: { type: 'ollama', url: 'http://localhost' }, modelId: 'm' }, path: ['endpoint'] } });
    expect(validateWorkflow({ definition: { name: '', steps: [get] } }).length).toBeGreaterThan(0);
  });

  it('does not promise that a changing loop state has the initial type forever', () => {
    const loop = baseStep({ type: 'repeat', id: 'loop' });
    if (loop.type !== 'repeat') {
      throw new Error('fixture');
    }
    loop.state = { changing: { initial: literal({ value: 1 }), next: literal({ value: 'later' }) }, stable: { initial: literal({ value: 1 }), next: { type: 'loop_state', stepId: loop.id, key: 'stable' } } };
    const analysis = analyzeWorkflowTypes({ definition: { name: '', steps: [loop] } });
    expect(analysis.bodies.get(loop.id)?.loops.get(loop.id)?.state).toEqual({ changing: { kind: 'unknown' }, stable: { kind: 'number' } });
  });
});
