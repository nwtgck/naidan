import { describe, expect, it } from 'vitest';
import { createGraphExpressionEvaluator, graphNameExpressionSchema, graphNumberSchema, type GraphNameExpression } from './expressions';
import { graphFixture } from './fixtures.test-support';
import { expandModelGraphDefinition } from './expand';
import { parseModelGraphDefinitions } from './definition';

function evaluator() {
  return createGraphExpressionEvaluator({ environment: { parameters: new Map([['offset', 2]]), iterations: new Map([['layer', 7]]), metadata: new Map([['block.7.width', 4], ['${literal}', 3]]), tensors: new Map([['blk.7.weight', { shape: [4, 8] }]]), inputTokens: undefined, cacheTokens: undefined, capacity: undefined }, maximumSteps: 1000 });
}

describe('explicit external model names', () => {
  it.each([
    ['blk.7.weight', 'blk.7.weight'],
    [{ concat: ['blk.', { decimal: { iteration: 'layer' } }, '.weight'] }, 'blk.7.weight'],
    [{ concat: ['x', { decimal: { sum: [{ iteration: 'layer' }, { parameter: 'offset' }] } }] }, 'x9'],
    [{ concat: ['x', { concat: ['.', { decimal: -3 }] }] }, 'x.-3'],
    [{ decimal: -0 }, '0'],
    ['${layer+1}', '${layer+1}'],
  ] satisfies [GraphNameExpression, string][])('resolves %j without interpreting literal strings', (value, expected) => {
    expect(evaluator().name({ value })).toBe(expected);
  });

  it('supports independently named GGUF tensors and metadata keys', () => {
    const read = evaluator();
    expect(read.number({ value: { metadata: { concat: ['block.', { decimal: { iteration: 'layer' } }, '.width'] } } })).toBe(4);
    expect(read.number({ value: { tensor: { concat: ['blk.', { decimal: { iteration: 'layer' } }, '.weight'] }, dimension: 1 } })).toBe(8);
    expect(read.number({ value: { metadata: '${literal}' } })).toBe(3);
  });

  it.each([
    { decimal: 0.5 }, { decimal: Infinity }, { decimal: NaN }, { decimal: Number.MAX_SAFE_INTEGER + 1 },
    { decimal: { iteration: 'absent' } }, { decimal: { inputTokens: true } }, { decimal: { cacheTokens: true } }, { decimal: { capacity: true } },
    { concat: ['x'.repeat(200), 'x'.repeat(100)] }, 'あ'.repeat(100), 'a\0b', '\ud800', '',
  ] satisfies GraphNameExpression[])('rejects unresolved, inexact, unsafe or oversized name %j', value => {
    expect(() => evaluator().name({ value })).toThrow();
  });

  it.each([{ concat: [] }, { concat: [1] }, { variable: 'layer' }, { var: 'layer' }, { eval: 'layer' }, { literal: 'x', concat: ['x'] }, { decimal: 1, extra: true }])('does not provide implicit coercion or an alternate template language: %j', value => {
    expect(graphNameExpressionSchema.safeParse(value).success).toBe(false);
  });

  it('rejects removed numeric variable syntax and bounds nested name/number work', () => {
    expect(graphNumberSchema.safeParse({ variable: 'layer' }).success).toBe(false);
    let name: GraphNameExpression = 'x';
    for (let i = 0; i < 55; i++) {
      name = { concat: [name] };
    }
    expect(() => evaluator().name({ value: name })).toThrow('budget');
    const read = evaluator();
    for (let i = 0; i < 1000; i++) {
      read.name({ value: 'x' });
    }
    expect(() => read.name({ value: 'x' })).toThrow('budget');
  });

  it('does not rewrite annotations, literal metadata keys or literal tensor names', () => {
    const { definition, inventory } = graphFixture();
    definition.annotations = 'literal ${notAnIteration}';
    definition.weights[0]!.tensor = 'literal.${layer}.weight';
    const tensors = new Map(inventory.tensors);
    tensors.set('literal.${layer}.weight', { ...tensors.get('token_embd.weight')!, name: 'literal.${layer}.weight' });
    const flat = expandModelGraphDefinition({ definition, inventory: { ...inventory, tensors } });
    expect(flat.weights[0]!.tensor).toBe('literal.${layer}.weight');
    expect(flat.annotations).toBe(definition.annotations);
  });

  it('rejects interpolation in local identifiers and does not migrate old formats', () => {
    const { definition } = graphFixture();
    expect(() => parseModelGraphDefinitions({ input: JSON.stringify({ ...definition, format: 'naidan.model-graph/experimental-2' }) })).toThrow();
    definition.graph.nodes[0]!.id = 'n.${layer}';
    expect(() => parseModelGraphDefinitions({ input: JSON.stringify(definition) })).toThrow();
  });
});
