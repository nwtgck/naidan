import { describe, expect, it } from 'vitest';
import type { WorkflowDefinition, WorkflowStep, WorkflowValue } from '@/01-models/workflow';
import { editWorkflowGraph, workflowGraphScopes, workflowGraphEdges, workflowGraphLocationLabel } from './graph';
import { analyzeWorkflowTypes, workflowTypeCompatibility } from './value-types';
import { workflowReferenceChoices } from './value-inputs';
import { validateWorkflow } from './definition';
import { baseStep, literal, reference, runtimeFixture, stepId, valueStep } from './workflow.test-support';
import { runtimeMessageValues, textChunks } from './values';

function connect({ definition, id, location, value }: { definition: WorkflowDefinition, id: string, location: readonly (string | number)[], value: WorkflowValue }): WorkflowDefinition {
  const input = analyzeWorkflowTypes({ definition }).valueBindings.get(stepId({ raw: id }))?.find(input => JSON.stringify(input.location) === JSON.stringify(location));
  if (!input) {
    throw new Error('Missing test input');
  }
  return editWorkflowGraph({ definition, edit: { type: 'connect', stepId: stepId({ raw: id }), location, previous: input.value, reference: value } });
}

function loopStep({ id }: { id: string }): Extract<WorkflowStep, { type: 'for_each' }> {
  const step = baseStep({ type: 'for_each', id });
  if (step.type !== 'for_each') {
    throw new Error('fixture');
  }
  step.source = { type: 'literal', value: ['a', 'b'] };
  return step;
}

function ifStep({ id }: { id: string }): Extract<WorkflowStep, { type: 'if' }> {
  const step = baseStep({ type: 'if', id });
  if (step.type !== 'if') {
    throw new Error('fixture');
  }
  return step;
}

const first = valueStep({ id: 'first', value: literal({ value: 'hello' }) });
const second = valueStep({ id: 'second', value: literal({ value: 'old' }) });

describe('Scoped Workflow graph model', () => {
  it('enumerates root, empty bodies and both branches with stable ID keys', () => {
    const loop = loopStep({ id: 'loop' }), condition = ifStep({ id: 'if' });
    loop.body.steps = [condition];
    const definition = { name: 'x', steps: [loop] };
    const scopes = workflowGraphScopes({ definition });
    expect(scopes.map(scope => scope.branch)).toEqual(['root', 'body', 'then', 'else']);
    expect(scopes[2]?.ancestors.map(parent => parent.id)).toEqual([loop.id, condition.id]);
    expect(scopes[2]?.steps).toEqual([]);
    loop.name = 'renamed';
    expect(workflowGraphScopes({ definition }).map(scope => scope.key)).toEqual(scopes.map(scope => scope.key));
  });

  it('records exact addresses, not dotted object keys or literal reference lookalikes', () => {
    const target = valueStep({
      id: 'target',
      value: {
        type: 'object',
        properties: {
          'a.b[0]': reference({ id: 'first', output: 'value' }),
          opaque: { type: 'literal', value: { type: 'step_output', stepId: 'secret', output: 'value' } },
        },
      },
    });
    const analysis = analyzeWorkflowTypes({ definition: { name: '', steps: [first, target] } });
    expect(analysis.valueBindings.get(target.id)?.map(input => input.location)).toEqual([['value'], ['value', 'properties', 'a.b[0]'], ['value', 'properties', 'opaque']]);
    expect(workflowGraphEdges({ bindings: analysis.valueBindings }).map(edge => edge.location)).toEqual([['value', 'properties', 'a.b[0]']]);
    expect(workflowGraphLocationLabel({ location: ['value', 'properties', 'a.b[0]'] })).toBe('["value"]["properties"]["a.b[0]"]');
  });

  it('does not attribute child dependencies to the container Step', () => {
    const loop = loopStep({ id: 'loop' });
    const child = valueStep({ id: 'child', value: reference({ id: 'first', output: 'value' }) });
    loop.body.steps = [child];
    loop.emit = reference({ id: 'child', output: 'value' });
    const analysis = analyzeWorkflowTypes({ definition: { name: '', steps: [first, loop] } });
    expect(workflowGraphEdges({ bindings: analysis.valueBindings }).map(edge => [edge.sourceId, edge.targetId, edge.path])).toEqual([[child.id, loop.id, 'emit'], [first.id, child.id, 'value']]);
  });

  it('captures before-Step scopes rather than a mutable end-of-block map', () => {
    const analysis = analyzeWorkflowTypes({ definition: { name: '', steps: [first, second] } });
    expect(analysis.valueBindings.get(first.id)?.[0]?.scope.outputs.size).toBe(0);
    expect([...analysis.valueBindings.get(second.id)![0]!.scope.outputs.keys()]).toEqual([first.id]);
  });

  it('uses after-body scopes only for loop state next, emit and stop condition', () => {
    const loop = loopStep({ id: 'loop' });
    const child = valueStep({ id: 'child', value: literal({ value: true }) });
    loop.body.steps = [child];
    loop.state = { total: { initial: literal({ value: 0 }), next: literal({ value: 1 }) } };
    loop.emit = literal({ value: '' });
    loop.stopWhen = literal({ value: false });
    const inputs = analyzeWorkflowTypes({ definition: { name: '', steps: [loop] } }).valueBindings.get(loop.id)!;
    for (const input of inputs) {
      const afterBody = ['emit', 'stopWhen'].includes(String(input.location[0])) || input.location.at(-1) === 'next';
      expect(input.scope.outputs.has(child.id)).toBe(afterBody);
      expect(input.scope.loops.has(loop.id)).toBe(afterBody);
    }
  });

  it('separates branch outputs including incomplete unmatched else outputs', () => {
    const condition = ifStep({ id: 'if' });
    condition.then.steps = [first];
    condition.else.steps = [second];
    condition.then.outputs = { result: literal({ value: '' }) };
    condition.else.outputs = { result: literal({ value: '' }), draft: literal({ value: '' }) };
    const inputs = analyzeWorkflowTypes({ definition: { name: '', steps: [condition] } }).valueBindings.get(condition.id)!;
    expect(inputs.find(input => input.path === 'condition')?.scope.outputs.size).toBe(0);
    expect(inputs.find(input => JSON.stringify(input.location) === '["then","outputs","result"]')?.scope.outputs.has(first.id)).toBe(true);
    expect(inputs.find(input => JSON.stringify(input.location) === '["else","outputs","result"]')?.scope.outputs.has(first.id)).toBe(false);
    expect(inputs.find(input => JSON.stringify(input.location) === '["else","outputs","draft"]')?.scope.outputs.has(second.id)).toBe(true);
  });

  it('addresses appended conversation values without synthetic conversation fields', () => {
    const generation = baseStep({ type: 'text_generation', id: 'generate' });
    if (generation.type !== 'text_generation') {
      throw new Error('fixture');
    }
    generation.appendMessages = [{ role: 'user', parts: [{ type: 'text', text: 'prefix' }, { type: 'value', value: reference({ id: 'first', output: 'value' }) }] }];
    const inputs = analyzeWorkflowTypes({ definition: { name: '', steps: [first, generation] } }).valueBindings.get(generation.id)!;
    expect(inputs.some(input => JSON.stringify(input.location) === '["appendMessages",0,"parts",1,"value"]' && input.expected === 'text')).toBe(true);
    expect(inputs.some(input => input.location.length === 1 && input.location[0] === 'appendMessages')).toBe(false);
  });

  it('keeps tool argument contracts but not virtual fields inside literal JSON', () => {
    const tool = baseStep({ type: 'tool_call', id: 'tool' });
    if (tool.type !== 'tool_call') {
      throw new Error('fixture');
    }
    let inputs = analyzeWorkflowTypes({ definition: { name: '', steps: [tool] } }).valueBindings.get(tool.id)!;
    expect(inputs.find(input => JSON.stringify(input.location) === '["arguments","properties","expression"]')?.expected).toBe('text');
    tool.arguments = { type: 'literal', value: { expression: '1 + 1' } };
    inputs = analyzeWorkflowTypes({ definition: { name: '', steps: [tool] } }).valueBindings.get(tool.id)!;
    expect(inputs.map(input => input.location)).toEqual([['arguments']]);
  });

  it('records all audio/image parameter locations and nested composed assignments', () => {
    for (const type of ['audio_generation', 'image_generation'] as const) {
      const step = baseStep({ type, id: type });
      if (step.type !== 'audio_generation' && step.type !== 'image_generation') {
        throw new Error('fixture');
      }
      const inputs = analyzeWorkflowTypes({ definition: { name: '', steps: [step] } }).valueBindings.get(step.id)!;
      expect(inputs.filter(input => input.location[0] === 'parameters' && input.location.length === 2)).toHaveLength(Object.keys(step.parameters).length);
    }
    const value = valueStep({ id: 'compose', value: { type: 'json_compose', base: {}, assignments: [{ path: ['a'], value: reference({ id: 'first', output: 'value' }) }] } });
    const inputs = analyzeWorkflowTypes({ definition: { name: '', steps: [first, value] } }).valueBindings.get(value.id)!;
    expect(inputs.map(input => input.location)).toEqual([['value'], ['value', 'assignments', 0, 'value']]);
  });
});

describe('Atomic graph connection edits', () => {
  it('replaces only the selected expression and leaves the original tree unchanged', () => {
    const definition = { name: '', steps: [first, second] };
    const before = structuredClone(definition);
    const next = connect({ definition, id: 'second', location: ['value'], value: reference({ id: 'first', output: 'value' }) });
    expect(next.steps[1]).toMatchObject({ value: reference({ id: 'first', output: 'value' }) });
    expect(definition).toEqual(before);
    expect(next.steps[0]).toEqual(first);
    expect(next).not.toBe(definition);
  });

  it('rejects stale expression contents and fabricated addresses', () => {
    const definition = { name: '', steps: [first, second] };
    expect(() => editWorkflowGraph({ definition, edit: { type: 'connect', stepId: second.id, location: ['value'], previous: literal({ value: 'stale' }), reference: reference({ id: 'first', output: 'value' }) } })).toThrow('changed');
    expect(() => editWorkflowGraph({ definition, edit: { type: 'connect', stepId: second.id, location: ['value', 'value'], previous: second.value, reference: reference({ id: 'first', output: 'value' }) } })).toThrow('changed');
  });

  it.each(['self', 'future', 'missing', 'missing-output', 'literal'] as const)('rejects %s as a connection source', kind => {
    const source = kind === 'literal' ? literal({ value: 'not a reference' }) : reference({ id: kind === 'self' ? 'second' : kind === 'missing-output' ? 'first' : kind, output: kind === 'missing-output' ? 'absent' : 'value' });
    const definition = { name: '', steps: [first, second, valueStep({ id: 'future', value: literal({ value: 'later' }) })] };
    expect(() => connect({ definition, id: 'second', location: ['value'], value: source })).toThrow('not available');
  });

  it('rejects duplicate IDs even if the selected Step is otherwise unambiguous', () => {
    const definition = { name: '', steps: [first, structuredClone(first), second] };
    expect(() => connect({ definition, id: 'second', location: ['value'], value: reference({ id: 'first', output: 'value' }) })).toThrow('unique');
  });

  it('rejects a known mismatch at the target', () => {
    const parse = baseStep({ type: 'parse_json', id: 'parse' });
    const number = valueStep({ id: 'number', value: literal({ value: 1 }) });
    expect(() => connect({ definition: { name: '', steps: [number, parse] }, id: 'parse', location: ['source'], value: reference({ id: 'number', output: 'value' }) })).toThrow('not available');
  });

  it('rejects a source compatible with any when it breaks a downstream typed consumer', () => {
    const number = valueStep({ id: 'number', value: literal({ value: 1 }) });
    const parse = baseStep({ type: 'parse_json', id: 'parse' });
    if (parse.type !== 'parse_json') {
      throw new Error('fixture');
    }
    parse.source = reference({ id: 'second', output: 'value' });
    const definition = { name: '', steps: [number, second, parse] };
    expect(validateWorkflow({ definition })).toEqual([]);
    expect(() => connect({ definition, id: 'second', location: ['value'], value: reference({ id: 'number', output: 'value' }) })).toThrow('Expected text');
  });

  it('allows unknown outputs without claiming a proven compatible type', () => {
    const parse = baseStep({ type: 'parse_json', id: 'parse' }), other = baseStep({ type: 'parse_json', id: 'other' });
    const definition = { name: '', steps: [parse, other] };
    const input = analyzeWorkflowTypes({ definition }).valueBindings.get(other.id)![0]!;
    const choice = workflowReferenceChoices({ scope: input.scope, expected: input.expected })[0]!;
    expect(workflowTypeCompatibility({ actual: choice.type, expected: input.expected })).toBe('unknown');
    expect(() => connect({ definition, id: 'other', location: ['source'], value: reference({ id: 'parse', output: 'value' }) })).not.toThrow();
  });

  it('permits an unrelated incomplete file destination while fixing another expression', () => {
    const file = baseStep({ type: 'read_file', id: 'file' });
    const definition = { name: '', steps: [file, first, second] };
    expect(validateWorkflow({ definition }).length).toBeGreaterThan(0);
    const next = connect({ definition, id: 'second', location: ['value'], value: reference({ id: 'first', output: 'value' }) });
    expect(validateWorkflow({ definition: next })).toEqual(validateWorkflow({ definition }));
  });

  it('edits keys containing dots, brackets and __proto__ without invoking prototype setters', () => {
    for (const key of ['a.b[0]', '__proto__', 'constructor', '']) {
      const target = valueStep({ id: 'target', value: { type: 'object', properties: { [key]: literal({ value: 'old' }) } } });
      const next = connect({ definition: { name: '', steps: [first, target] }, id: 'target', location: ['value', 'properties', key], value: reference({ id: 'first', output: 'value' }) });
      const step = next.steps[1];
      if (step?.type !== 'value' || step.value.type !== 'object') {
        throw new Error('fixture');
      }
      expect(Object.hasOwn(step.value.properties, key)).toBe(true);
      expect(step.value.properties[key]).toEqual(reference({ id: 'first', output: 'value' }));
      expect(Object.getPrototypeOf(step.value.properties)).toBe(Object.prototype);
    }
  });

  it('supports loop item, index and state references only in their evaluation scope', () => {
    const loop = loopStep({ id: 'loop' });
    loop.state = { sum: { initial: literal({ value: 0 }), next: { type: 'loop_state', stepId: loop.id, key: 'sum' } } };
    loop.body.steps = [second];
    const definition = { name: '', steps: [loop] };
    for (const source of [{ type: 'loop_item', stepId: loop.id }, { type: 'loop_index', stepId: loop.id }, { type: 'loop_state', stepId: loop.id, key: 'sum' }] satisfies WorkflowValue[]) {
      expect(() => connect({ definition, id: 'second', location: ['value'], value: source })).not.toThrow();
      expect(() => connect({ definition, id: 'loop', location: ['source'], value: source })).toThrow('not available');
    }
  });

  it('allows body results in stopWhen, but not in the initial loop state', () => {
    const loop = loopStep({ id: 'loop' }), flag = valueStep({ id: 'flag', value: literal({ value: true }) });
    loop.body.steps = [flag];
    loop.state = { flag: { initial: literal({ value: false }), next: literal({ value: false }) } };
    loop.stopWhen = literal({ value: false });
    const definition = { name: '', steps: [loop] }, source = reference({ id: 'flag', output: 'value' });
    expect(() => connect({ definition, id: 'loop', location: ['stopWhen'], value: source })).not.toThrow();
    expect(() => connect({ definition, id: 'loop', location: ['state', 'flag', 'initial'], value: source })).toThrow('not available');
  });

  it('does not expose one branch output inside its sibling', () => {
    const condition = ifStep({ id: 'if' });
    condition.then.steps = [first];
    condition.else.steps = [second];
    condition.then.outputs = { result: literal({ value: 'a' }) };
    condition.else.outputs = { result: literal({ value: 'b' }) };
    const definition = { name: '', steps: [condition] };
    expect(() => connect({ definition, id: 'if', location: ['then', 'outputs', 'result'], value: reference({ id: 'first', output: 'value' }) })).not.toThrow();
    expect(() => connect({ definition, id: 'if', location: ['else', 'outputs', 'result'], value: reference({ id: 'first', output: 'value' }) })).toThrow('not available');
  });

  it('runs the same ordered definition after reconnecting an appended message', async () => {
    const generation = baseStep({ type: 'text_generation', id: 'generate' });
    if (generation.type !== 'text_generation') {
      throw new Error('fixture');
    }
    generation.appendMessages = [{ role: 'user', parts: [{ type: 'value', value: literal({ value: 'old' }) }] }];
    const definition = connect({ definition: { name: '', steps: [first, generation] }, id: 'generate', location: ['appendMessages', 0, 'parts', 0, 'value'], value: reference({ id: 'first', output: 'value' }) });
    let prompt = '';
    await using fixture = await runtimeFixture({
      definition,
      overrides: {
        generate: async ({ input }) => {
          for (const value of runtimeMessageValues({ messages: input.conversation })) {
            for await (const chunk of textChunks({ value, signal: input.signal })) {
              prompt += chunk;
            }
          }
          return { text: { type: 'json', value: 'answer' }, reasoning: { type: 'json', value: '' }, conversation: { type: 'conversation', messages: [] }, metrics: { type: 'json', value: {} } };
        },
      },
    });
    expect(fixture.result.status).toBe('completed');
    expect(prompt).toContain('hello');
    expect(prompt).not.toContain('old');
  });
});

describe('Validated structural graph edits', () => {
  it('moves an independent Step and preserves the original', () => {
    const definition = { name: '', steps: [first, second] };
    const next = editWorkflowGraph({ definition, edit: { type: 'move', stepId: second.id, target: { parentId: undefined, branch: 'root', index: 0 } } });
    expect(next.steps.map(step => step.id)).toEqual([second.id, first.id]);
    expect(definition.steps.map(step => step.id)).toEqual([first.id, second.id]);
  });

  it('rejects moving a producer after its consumer', () => {
    const consumer = valueStep({ id: 'consumer', value: reference({ id: 'first', output: 'value' }) });
    const definition = { name: '', steps: [first, consumer] };
    expect(() => editWorkflowGraph({ definition, edit: { type: 'move', stepId: first.id, target: { parentId: undefined, branch: 'root', index: 2 } } })).toThrow();
  });

  it('allows independent moves into empty scopes, but rejects escaping loop values', () => {
    const loop = loopStep({ id: 'loop' });
    const definition = { name: '', steps: [first, loop] };
    const next = editWorkflowGraph({ definition, edit: { type: 'move', stepId: first.id, target: { parentId: loop.id, branch: 'body', index: 0 } } });
    expect(workflowGraphScopes({ definition: next })[1]?.steps.map(step => step.id)).toEqual([first.id]);
    loop.body.steps = [valueStep({ id: 'child', value: { type: 'loop_item', stepId: loop.id } })];
    expect(() => editWorkflowGraph({ definition, edit: { type: 'move', stepId: stepId({ raw: 'child' }), target: { parentId: undefined, branch: 'root', index: 0 } } })).toThrow();
  });

  it('rejects moving a container into its own descendant and invalid positions', () => {
    const loop = loopStep({ id: 'loop' }), nested = loopStep({ id: 'nested' });
    loop.body.steps = [nested];
    const definition = { name: '', steps: [loop] };
    expect(() => editWorkflowGraph({ definition, edit: { type: 'move', stepId: loop.id, target: { parentId: nested.id, branch: 'body', index: 0 } } })).toThrow('itself');
    for (const index of [-1, 1.5, 100, Number.NaN]) {
      expect(() => editWorkflowGraph({ definition, edit: { type: 'move', stepId: loop.id, target: { parentId: undefined, branch: 'root', index } } })).toThrow('position');
    }
  });

  it('rejects a branch move that invalidates its published output', () => {
    const condition = ifStep({ id: 'if' });
    condition.then.steps = [first];
    condition.then.outputs = { value: reference({ id: 'first', output: 'value' }) };
    condition.else.outputs = { value: literal({ value: 'fallback' }) };
    expect(() => editWorkflowGraph({ definition: { name: '', steps: [condition] }, edit: { type: 'move', stepId: first.id, target: { parentId: condition.id, branch: 'else', index: 0 } } })).toThrow();
  });
});
