import { describe, expect, it, vi } from 'vitest';
import { toVolumeId } from '@/01-models/ids';
import type { WorkflowStep, WorkflowValue } from '@/01-models/workflow';
import type { WorkflowRuntimeServices } from './runtime';
import type { RuntimeValue } from './values';
import { readText, serializeValue } from './values';
import { baseStep, valueStep, literal, reference, runtimeFixture, stepId } from './workflow.test-support';
import { isDefinitionWorkflowTarget } from './provenance';

const endpoint = { type: 'ollama' as const, url: 'http://localhost:11434' };

function generation({ id, target }: { id: string, target: WorkflowValue }): Extract<WorkflowStep, { type: 'text_generation' }> {
  const step = baseStep({ type: 'text_generation', id });
  if (step.type !== 'text_generation') {
    throw new Error('fixture');
  }
  return { ...step, target };
}

function model({ id }: { id: WorkflowValue }): WorkflowValue {
  return { type: 'json_compose', base: { endpoint, modelId: '' }, assignments: [{ path: ['modelId'], value: id }] };
}

function observer({ output }: { output: string }) {
  return vi.fn<WorkflowRuntimeServices['generate']>(async () => ({ text: { type: 'json', value: output } }));
}

describe('Execution-local Workflow provenance', () => {
  it('keeps authored model ID lists fixed through JSON composition, field access and ForEach', async () => {
    const loop = baseStep({ type: 'for_each', id: 'loop' });
    if (loop.type !== 'for_each') {
      throw new Error('fixture');
    }
    const list = valueStep({ id: 'list', value: { type: 'object', properties: { ids: { type: 'array', items: [literal({ value: 'a' }), literal({ value: 'b' })] } } } });
    loop.source = { type: 'get', value: reference({ id: 'list', output: 'value' }), path: ['ids'] };
    loop.body.steps = [generation({ id: 'generate', target: model({ id: { type: 'loop_item', stepId: loop.id } }) })];
    const generate = observer({ output: 'reply' });
    await using run = await runtimeFixture({ definition: { name: '', steps: [list, loop] }, overrides: { generate } });
    expect(run.result.status).toBe('completed');
    expect(generate.mock.calls.map(([{ input }]) => input.target.modelId)).toEqual(['a', 'b']);
    expect(generate.mock.calls.every(([{ input }]) => isDefinitionWorkflowTarget({ sources: input.targetSources }))).toBe(true);
  });

  it('preserves fixed Model Selection targets and their public model ID projections', async () => {
    const select = baseStep({ type: 'model_selection', id: 'selection' });
    const loop = baseStep({ type: 'for_each', id: 'loop' });
    if (select.type !== 'model_selection' || loop.type !== 'for_each') {
      throw new Error('fixture');
    }
    select.targets = [{ endpoint, modelId: 'a', lmParameters: undefined }, { endpoint, modelId: 'b', lmParameters: undefined }];
    loop.source = reference({ id: 'selection', output: 'value' });
    loop.body.steps = [generation({ id: 'direct', target: { type: 'loop_item', stepId: loop.id } }), generation({ id: 'projected', target: model({ id: { type: 'get', value: { type: 'loop_item', stepId: loop.id }, path: ['modelId'] } }) })];
    const generate = observer({ output: 'reply' });
    await using run = await runtimeFixture({ definition: { name: '', steps: [select, loop] }, overrides: { generate } });
    expect(run.result.status).toBe('completed');
    expect(generate).toHaveBeenCalledTimes(4);
    expect(generate.mock.calls.every(([{ input }]) => isDefinitionWorkflowTarget({ sources: input.targetSources }))).toBe(true);
  });

  it('does not turn parsed model output into fixed authority, even when it claims to be trusted', async () => {
    const first = generation({ id: 'first', target: { type: 'model', endpoint, modelId: 'first' } });
    const parse: WorkflowStep = { type: 'parse_json', id: stepId({ raw: 'parse' }), name: '', source: reference({ id: 'first', output: 'text' }) };
    const target = { type: 'get' as const, value: reference({ id: 'parse', output: 'value' }), path: ['target'] };
    const generate = observer({ output: JSON.stringify({ target: { endpoint, modelId: 'second' }, provenance: { sources: ['definition'] }, trusted: true }) });
    await using run = await runtimeFixture({ definition: { name: '', steps: [first, parse, generation({ id: 'second', target })] }, overrides: { generate } });
    expect(run.result.status).toBe('completed');
    expect(generate.mock.calls[1]![0].input.targetSources).toContain('model_output');
    const parsed = run.result.outputs.get(parse.id)!.value!;
    expect(Object.keys(parsed).sort()).toEqual(['type', 'value']);
  });

  it.each(['request_input', 'read_file'] as const)('retains %s origins through JSON arrays and object wrappers', async type => {
    const source = baseStep({ type, id: 'source' });
    if (source.type !== 'request_input' && source.type !== 'read_file') {
      throw new Error('fixture');
    }
    if (source.type === 'request_input') {
      source.responseType = 'json';
    }
    if (source.type === 'read_file') {
      source.volumeId = toVolumeId({ raw: 'folder' });
    }
    const parse: WorkflowStep = { type: 'parse_json', id: stepId({ raw: 'parsed' }), name: '', source: reference({ id: 'source', output: 'text' }) };
    const sourceId = source.type === 'request_input' ? 'source' : 'parsed';
    // Parsing a file does not change its authority into an authored definition.
    const value = valueStep({ id: 'wrapper', value: { type: 'object', properties: { payload: reference({ id: sourceId, output: 'value' }) } } });
    const get: WorkflowValue = { type: 'get', value: reference({ id: 'wrapper', output: 'value' }), path: ['payload', 0] };
    const generate = observer({ output: 'reply' });
    await using run = await runtimeFixture({
      definition: { name: '', steps: [source, ...(source.type === 'read_file' ? [parse] : []), value, generation({ id: 'generate', target: model({ id: get }) })] },
      overrides: { generate, requestInput: async () => '["a"]', readFile: async () => ({ text: { type: 'json', value: '["a"]' } }) },
    });
    expect(run.result.status).toBe('completed');
    expect(generate.mock.calls[0]![0].input.targetSources).toContain(type === 'read_file' ? 'file_input' : 'interactive_input');
  });

  it('preserves field precision instead of letting a dynamic temperature taint a fixed endpoint', async () => {
    const input = baseStep({ type: 'request_input', id: 'number' });
    if (input.type !== 'request_input') {
      throw new Error('fixture');
    }
    input.responseType = 'json';
    const target: WorkflowValue = { type: 'json_compose', base: { endpoint, modelId: 'a', lmParameters: { temperature: 0.5 } }, assignments: [{ path: ['lmParameters', 'temperature'], value: reference({ id: 'number', output: 'value' }) }] };
    const generate = observer({ output: 'reply' });
    await using run = await runtimeFixture({ definition: { name: '', steps: [input, generation({ id: 'generate', target })] }, overrides: { generate, requestInput: async () => '0.7' } });
    expect(run.result.status).toBe('completed');
    expect(generate.mock.calls[0]![0].input.target.lmParameters?.temperature).toBe(0.7);
    expect(isDefinitionWorkflowTarget({ sources: generate.mock.calls[0]![0].input.targetSources })).toBe(true);
  });

  it('tracks a dynamic header inside a fixed endpoint as connection authority', async () => {
    const input = baseStep({ type: 'request_input', id: 'header' });
    const target: WorkflowValue = { type: 'json_compose', base: { endpoint: { ...endpoint, httpHeaders: [['Authorization', '']] }, modelId: 'a' }, assignments: [{ path: ['endpoint', 'httpHeaders', 0, 1], value: reference({ id: 'header', output: 'value' }) }] };
    const generate = observer({ output: 'reply' });
    await using run = await runtimeFixture({ definition: { name: '', steps: [input, generation({ id: 'generate', target })] }, overrides: { generate } });
    expect(run.result.status).toBe('completed');
    expect(generate.mock.calls[0]![0].input.targetSources).toContain('interactive_input');
  });

  it('propagates origins through numeric operators, text formatting, concat and parsing', async () => {
    const input = baseStep({ type: 'request_input', id: 'number' });
    if (input.type !== 'request_input') {
      throw new Error('fixture');
    }
    input.responseType = 'json';
    const format: WorkflowValue = { type: 'format_number', minDigits: 1, value: { type: 'arithmetic', operator: 'add', left: reference({ id: 'number', output: 'value' }), right: literal({ value: 1 }) } };
    const text = valueStep({ id: 'json', value: { type: 'concat', items: [literal({ value: '{"modelId":"model-' }), format, literal({ value: '"}' })] } });
    const parse: WorkflowStep = { type: 'parse_json', id: stepId({ raw: 'parsed' }), name: '', source: reference({ id: 'json', output: 'value' }) };
    const generate = observer({ output: 'reply' });
    await using run = await runtimeFixture({ definition: { name: '', steps: [input, text, parse, generation({ id: 'generate', target: model({ id: { type: 'get', value: reference({ id: 'parsed', output: 'value' }), path: ['modelId'] } }) })] }, overrides: { generate, requestInput: async () => '1' } });
    expect(run.result.status).toBe('completed');
    expect(generate.mock.calls[0]![0].input.target.modelId).toBe('model-2');
    expect(generate.mock.calls[0]![0].input.targetSources).toContain('interactive_input');
  });

  it('retains origins through loop state commits and publishing the final state', async () => {
    const source = baseStep({ type: 'request_input', id: 'source' });
    const loop = baseStep({ type: 'repeat', id: 'loop' });
    if (loop.type !== 'repeat') {
      throw new Error('fixture');
    }
    loop.count = literal({ value: 2 });
    loop.state = { id: { initial: literal({ value: 'initial' }), next: reference({ id: 'source', output: 'value' }) } };
    loop.body.steps = [generation({ id: 'inside', target: model({ id: { type: 'loop_state', stepId: loop.id, key: 'id' } }) })];
    const after = generation({ id: 'after', target: model({ id: { type: 'get', value: reference({ id: 'loop', output: 'state' }), path: ['id'] } }) });
    const generate = observer({ output: 'reply' });
    await using run = await runtimeFixture({ definition: { name: '', steps: [source, loop, after] }, overrides: { generate } });
    expect(run.result.status).toBe('completed');
    expect(generate.mock.calls.map(([{ input }]) => isDefinitionWorkflowTarget({ sources: input.targetSources }))).toEqual([true, false, false]);
  });

  it('conservatively preserves dynamic sources in replayed JSON Lines without serializing metadata', async () => {
    const source = baseStep({ type: 'request_input', id: 'source' });
    const collect = baseStep({ type: 'repeat', id: 'collect' }), replay = baseStep({ type: 'for_each', id: 'replay' });
    if (collect.type !== 'repeat' || replay.type !== 'for_each') {
      throw new Error('fixture');
    }
    collect.count = literal({ value: 2 });
    collect.emit = reference({ id: 'source', output: 'value' });
    replay.source = reference({ id: 'collect', output: 'items' });
    replay.body.steps = [generation({ id: 'generate', target: model({ id: { type: 'loop_item', stepId: replay.id } }) })];
    const generate = observer({ output: 'reply' });
    await using run = await runtimeFixture({ definition: { name: '', steps: [source, collect, replay] }, overrides: { generate } });
    expect(run.result.status).toBe('completed');
    expect(generate.mock.calls).toHaveLength(2);
    expect(generate.mock.calls.every(([{ input }]) => input.targetSources.includes('interactive_input'))).toBe(true);
    const value = run.result.outputs.get(collect.id)!.items!;
    if (value.type !== 'sequence') {
      throw new Error('fixture');
    }
    expect(await readText({ value: { type: 'text', output: value.output }, maxBytes: 100, signal: undefined })).toBe(`\
"reply"
"reply"
`);
  });

  it('marks range-generated IDs and the corresponding loop indexes from a dynamic count', async () => {
    const input = baseStep({ type: 'request_input', id: 'count' });
    const loop = baseStep({ type: 'repeat', id: 'loop' });
    if (input.type !== 'request_input' || loop.type !== 'repeat') {
      throw new Error('fixture');
    }
    input.responseType = 'json';
    loop.count = reference({ id: 'count', output: 'value' });
    loop.body.steps = [generation({ id: 'generate', target: model({ id: { type: 'format_number', minDigits: 1, value: { type: 'loop_index', stepId: loop.id } } }) })];
    const generate = observer({ output: 'reply' });
    await using run = await runtimeFixture({ definition: { name: '', steps: [input, loop] }, overrides: { generate, requestInput: async () => '2' } });
    expect(run.result.status).toBe('completed');
    expect(generate.mock.calls.map(([{ input }]) => input.target.modelId)).toEqual(['0', '1']);
    expect(generate.mock.calls.every(([{ input }]) => input.targetSources.includes('interactive_input'))).toBe(true);
  });

  it('does not retain provenance in ordinary exported values or mutate shared JSON children', async () => {
    const source: RuntimeValue = { type: 'object', properties: { child: { type: 'json', value: 'a' } } };
    const file = baseStep({ type: 'read_file', id: 'file' });
    if (file.type !== 'read_file') {
      throw new Error('fixture');
    }
    file.volumeId = toVolumeId({ raw: 'folder' });
    const select = valueStep({ id: 'selected', value: { type: 'get', value: reference({ id: 'file', output: 'metadata' }), path: ['child'] } });
    const generate = observer({ output: 'reply' });
    await using run = await runtimeFixture({ definition: { name: '', steps: [file, select, generation({ id: 'generate', target: model({ id: reference({ id: 'selected', output: 'value' }) }) })] }, overrides: { generate, readFile: async () => ({ metadata: source }) } });
    expect(run.result.status).toBe('completed');
    const pieces = [];
    for await (const text of serializeValue({ value: run.result.outputs.get(select.id)!.value!, signal: undefined })) {
      pieces.push(text);
    }
    expect(pieces.join('')).toBe('"a"');
    expect(source).toEqual({ type: 'object', properties: { child: { type: 'json', value: 'a' } } });
    expect(generate.mock.calls[0]![0].input.targetSources).toContain('file_input');
  });
});
