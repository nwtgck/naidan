import { describe, it, expect } from 'vitest';
import { validateJsonAssignments, replaceJsonValue, validateJsonCompositionBaseEdit } from './json-composition';
import { workflowRangeItems } from './range';
import { runtimeFixture, baseStep, stepId, literal, reference, valueStep } from './workflow.test-support';
import { materializeJson, readText } from './values';
import { parseWorkflowValue, formatWorkflowValue, applyWorkflowStepJson, parseWorkflowModelConfiguration } from '@/00-storage/service/workflow-json';
import { copyWorkflowSteps, validateWorkflow } from './definition';
import type { WorkflowValue } from '@/01-models/workflow';

describe('Structural JSON composition', () => {
  it('replaces a whole value without interpolating template-like text or mutating the base', () => {
    const base = { key: '{index}', nested: { modelId: '' } };
    const result = replaceJsonValue({ base, path: ['nested', 'modelId'], value: 'model.gguf' });
    expect(result).toEqual({ key: '{index}', nested: { modelId: 'model.gguf' } });
    expect(base.nested.modelId).toBe('');
  });

  it('allows an object leaf to be added but requires existing intermediate objects and array indices', () => {
    validateJsonAssignments({ base: { nested: {}, list: [0] }, paths: [['nested', 'modelId'], ['list', 0]] });
    for (const path of [['missing', 'x'], ['list', 1], ['list', '0'], ['list', -1], ['list', 0.5]]) {
      expect(() => validateJsonAssignments({ base: { list: [0] }, paths: [path] })).toThrow();
    }
  });

  it('rejects duplicate and overlapping paths regardless of assignment order', () => {
    const paths = [['nested'], ['nested', 'x']];
    for (const order of [paths, [...paths].reverse(), [['nested'], ['nested']], [[], ['nested']]]) {
      expect(() => validateJsonAssignments({ base: { nested: { x: 1 } }, paths: order })).toThrow('overlap');
    }
    expect(replaceJsonValue({ base: {}, path: [], value: [1, 2] })).toEqual([1, 2]);
  });

  it('treats prototype-looking field names as ordinary JSON data', () => {
    const result = replaceJsonValue({ base: {}, path: ['__proto__'], value: { injected: true } });
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    if (result === null || typeof result !== 'object') {
      throw new Error('fixture');
    }
    expect(Object.hasOwn(result, '__proto__')).toBe(true);
    expect(Object.hasOwn({}, 'injected')).toBe(false);
    expect(() => validateJsonAssignments({ base: {}, paths: [['constructor', 'prototype']] })).toThrow('intermediate');
  });

  it('keeps binding identities safe when raw base arrays are edited', () => {
    const before = { models: ['a', 'b'], description: 'before' };
    validateJsonCompositionBaseEdit({ before, after: { ...before, description: 'after' }, paths: [['models', 1]] });
    expect(() => validateJsonCompositionBaseEdit({ before, after: { ...before, models: ['new', 'a', 'b'] }, paths: [['models', 1]] })).toThrow('ambiguous');
    expect(() => validateJsonCompositionBaseEdit({ before, after: { ...before, models: ['b', 'a'] }, paths: [['models', 1]] })).toThrow('ambiguous');
  });

  it('round trips composed values without interpreting literal type/id fields as expressions', () => {
    const value: WorkflowValue = { type: 'json_compose', base: { type: 'step_output', stepId: 'inside' }, assignments: [{ path: ['modelId'], value: reference({ id: 'inside', output: 'value' }) }] };
    expect(parseWorkflowValue({ text: formatWorkflowValue({ value }) })).toEqual(value);
    const copy = copyWorkflowSteps({ steps: [valueStep({ id: 'inside', value: literal({ value: 'm' }) }), valueStep({ id: 'consumer', value })] });
    expect(copy[1]).toMatchObject({ value: { base: value.base, assignments: [{ value: { stepId: copy[0]?.id } }] } });
  });

  it('merges ordinary base data without discarding siblings when its type changes', () => {
    const step = valueStep({ id: 'compose', value: { type: 'json_compose', base: { type: 'article', title: 'keep' }, assignments: [] } });
    expect(applyWorkflowStepJson({ step, text: '{"value":{"base":{"type":"book"}}}' })).toMatchObject({ value: { base: { type: 'book', title: 'keep' } } });
  });

  it('uses a model-ID list and generic JSON composition without a model-specific constructor', async () => {
    const loop = baseStep({ type: 'for_each', id: 'models' });
    const generate = baseStep({ type: 'text_generation', id: 'generate' });
    if (loop.type !== 'for_each' || generate.type !== 'text_generation') {
      throw new Error('fixture');
    }
    loop.source = { type: 'literal', value: ['a.gguf', 'b.gguf'] };
    generate.target = { type: 'json_compose', base: { endpoint: { type: 'experimental_type', experimental: { endpoint: { type: 'llama_cpp_browser' } } } }, assignments: [{ path: ['modelId'], value: { type: 'loop_item', stepId: loop.id } }] };
    loop.body.steps = [generate];
    await using run = await runtimeFixture({ definition: { name: '', steps: [loop] }, overrides: {} });
    expect(run.result.status).toBe('completed');
    expect(run.generate.mock.calls.map(([{ input }]) => input.target)).toEqual([
      { type: 'model', endpoint: { type: 'llama_cpp_browser' }, modelId: 'a.gguf', lmParameters: undefined },
      { type: 'model', endpoint: { type: 'llama_cpp_browser' }, modelId: 'b.gguf', lmParameters: undefined },
    ]);
  });

  it('also accepts a generic object constructor and validates the consumer boundary', async () => {
    const generate = baseStep({ type: 'text_generation', id: 'generate' });
    if (generate.type !== 'text_generation') {
      throw new Error('fixture');
    }
    generate.target = { type: 'object', properties: { endpoint: { type: 'literal', value: { type: 'ollama', url: 'http://localhost:11434' } }, modelId: literal({ value: 'test' }) } };
    await using run = await runtimeFixture({ definition: { name: '', steps: [generate] }, overrides: {} });
    expect(run.result.status).toBe('completed');
    expect(() => parseWorkflowModelConfiguration({ value: { endpoint: { type: 'ollama', url: 'http://localhost' }, modelId: 'test', permission: true } })).toThrow();
  });

  it('preserves per-model generation parameters in the dedicated model-selection output', async () => {
    const models = baseStep({ type: 'model_selection', id: 'models' });
    const loop = baseStep({ type: 'for_each', id: 'loop' });
    const generate = baseStep({ type: 'text_generation', id: 'g' });
    if (models.type !== 'model_selection' || loop.type !== 'for_each' || generate.type !== 'text_generation') {
      throw new Error('fixture');
    }
    const configuration = parseWorkflowModelConfiguration({ value: { endpoint: { type: 'ollama', url: 'http://localhost:11434' }, modelId: 'm', lmParameters: { temperature: 0.25 } } });
    models.targets = [configuration];
    loop.source = reference({ id: 'models', output: 'value' });
    generate.target = { type: 'loop_item', stepId: loop.id };
    loop.body.steps = [generate];
    loop.emit = { type: 'get', value: { type: 'loop_item', stepId: loop.id }, path: ['modelId'] };
    await using run = await runtimeFixture({ definition: { name: '', steps: [models, loop] }, overrides: {} });
    expect(run.result.status).toBe('completed');
    expect(run.generate.mock.calls[0]?.[0].input.target.lmParameters?.temperature).toBe(0.25);
    const emitted = run.result.outputs.get(loop.id)?.items;
    if (emitted?.type !== 'sequence') {
      throw new Error('fixture');
    }
    expect(await readText({ value: { type: 'text', output: emitted.output }, maxBytes: 1000, signal: undefined })).toBe('"m"\n');
    await expect(materializeJson({ value: run.result.outputs.get(models.id)!.value!, signal: undefined })).rejects.toThrow();
  });
});

describe('Lazy integer ranges', () => {
  it('supports exclusive endpoints, descending steps and empty ranges', () => {
    expect([...workflowRangeItems({ range: { start: 1, end: 7, step: 2 } })]).toEqual([1, 3, 5]);
    expect([...workflowRangeItems({ range: { start: 10, end: 0, step: -2 } })]).toEqual([10, 8, 6, 4, 2]);
    expect([...workflowRangeItems({ range: { start: 0, end: 5, step: -1 } })]).toEqual([]);
    expect([...workflowRangeItems({ range: { start: 0, end: 0, step: 1 } })]).toEqual([]);
  });

  it('does not allocate an open-ended range and detects loss of integer precision', () => {
    const range = workflowRangeItems({ range: { start: 0, end: undefined, step: 1 } });
    expect([range.next().value, range.next().value, range.next().value]).toEqual([0, 1, 2]);
    range.return(undefined);
    const boundary = workflowRangeItems({ range: { start: Number.MAX_SAFE_INTEGER, end: undefined, step: 1 } });
    expect(boundary.next().value).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => boundary.next()).toThrow('precision');
  });

  it('rejects zero, fractional, nonfinite and unsafe increments', () => {
    for (const step of [0, 0.1, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => workflowRangeItems({ range: { start: 0, end: 10, step } }).next()).toThrow();
    }
  });

  it('uses sequence values, not ordinal indices, as loop items', async () => {
    const loop = baseStep({ type: 'for_each', id: 'loop' });
    if (loop.type !== 'for_each') {
      throw new Error('fixture');
    }
    loop.source = { type: 'range', start: literal({ value: 10 }), end: literal({ value: 4 }), step: literal({ value: -2 }) };
    loop.emit = { type: 'object', properties: { item: { type: 'loop_item', stepId: loop.id }, index: { type: 'loop_index', stepId: loop.id } } };
    await using run = await runtimeFixture({ definition: { name: '', steps: [loop] }, overrides: {} });
    const value = run.result.outputs.get(stepId({ raw: 'loop' }))!.items!;
    if (value.type !== 'sequence') {
      throw new Error('fixture');
    }
    expect(await readText({ value: { type: 'text', output: value.output }, maxBytes: 1000, signal: undefined })).toBe(`\
{"item":10,"index":0}
{"item":8,"index":1}
{"item":6,"index":2}
`);
  });

  it('reports constant invalid range settings before executing earlier effects', () => {
    const value = valueStep({ id: 'bad', value: { type: 'range', start: literal({ value: 0 }), end: undefined, step: literal({ value: 0 }) } });
    expect(validateWorkflow({ definition: { name: '', steps: [value] } }).some(issue => issue.path.endsWith('.step'))).toBe(true);
  });

  it('round trips an omitted endpoint and keeps expression references structural', () => {
    const value: WorkflowValue = { type: 'range', start: reference({ id: 'start', output: 'value' }), end: undefined, step: literal({ value: 1 }) };
    expect(parseWorkflowValue({ text: formatWorkflowValue({ value }) })).toEqual(value);
  });
});
