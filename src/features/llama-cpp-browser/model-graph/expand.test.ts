import { describe, expect, it } from 'vitest';
import { graphFixture } from './fixtures.test-support';
import { expandModelGraphDefinition } from './expand';
import { compileModelGraph } from './compile';
import { parseModelGraphDefinitions, type ModelGraphDefinition } from './definition';
import { createGraphExpressionEvaluator, type GraphNumber, type GraphMetadataValue } from './expressions';

function repeated() {
  const { definition: original, inventory } = graphFixture();
  const metadata = new Map<string, GraphMetadataValue>([...inventory.metadata, ['layers', 3], ['layer.scale', [2, 3, 4]], ['layer.active', [true, false, true]]]);
  const definition: ModelGraphDefinition = {
    ...original,
    requiredCapabilities: [...original.requiredCapabilities, 'declaration-expansion/v1'],
    parameters: [...original.parameters, { name: 'layers', value: { metadata: 'layers' } }],
    graph: {
      nodes: [
        { id: 'hidden0', op: 'embedding', weight: 'embedding' },
        {
          id: 'layers',
          op: 'repeat',
          index: 'i',
          count: { parameter: 'layers' },
          weights: [],
          slots: [],
          tensors: [],
          updates: [],
          nodes: [
            {
              id: 'select${i}',
              op: 'choose',
              condition: { metadata: 'layer.active', index: { variable: 'i' }, equals: true },
              then: [{ id: 'hidden${i+1}', op: 'scale', input: 'hidden${i}', value: { metadata: 'layer.scale', index: { variable: 'i' } } }],
              otherwise: [{ id: 'hidden${i+1}', op: 'contiguous', input: 'hidden${i}' }],
            },
          ],
        },
        { id: 'logits', op: 'linear', weight: 'output', input: 'hidden${layers}' },
      ],
    },
  };
  return { definition, inventory: { ...inventory, metadata } };
}

describe('bounded declarative model expansion', () => {
  it('expands metadata arrays, layer templates and branches to an ordinary static graph', () => {
    const fixture = repeated();
    const parsed = parseModelGraphDefinitions({ input: JSON.stringify(fixture.definition) })[0]!.definition;
    const expanded = expandModelGraphDefinition({ definition: parsed, inventory: fixture.inventory });
    expect(expanded.graph.nodes.map(node => node.id)).toEqual(['hidden0', 'hidden1', 'hidden2', 'hidden3', 'logits']);
    expect(expanded.graph.nodes.map(node => node.op)).toEqual(['embedding', 'scale', 'contiguous', 'scale', 'linear']);
    expect(expanded.parameters.map(p => p.value)).toEqual([4, 3]);
    const plan = compileModelGraph({ definition: parsed, inventory: fixture.inventory, inputTokens: 2, cacheTokens: 64, capacity: 128, maximumScratchBytes: 65536 });
    expect(plan.nodes[1]!.node).toMatchObject({ op: 'scale', value: 2 });
    expect(plan.nodes[3]!.node).toMatchObject({ op: 'scale', value: 4 });
    expect(plan.nodes.at(-1)!.shape).toEqual([5, 2]);
    expect(fixture.definition.graph.nodes[1]?.op).toBe('repeat'); // Never mutate the imported source.
  });

  it('uses bounded integer arithmetic for layer selection, not eval or a callback', () => {
    const fixture = repeated();
    const block = fixture.definition.graph.nodes[1]!;
    if (block.op !== 'repeat') {
      throw new Error('fixture');
    }
    block.nodes[0] = {
      id: 'branch',
      op: 'choose',
      condition: { compare: 'equal', left: { modulo: [{ variable: 'i' }, 2] }, right: 0 },
      then: [{ id: 'hidden${i+1}', op: 'scale', input: 'hidden${i}', value: { quotient: [{ sum: [2, { variable: 'i' }] }, { sqrt: 4 }] } }],
      otherwise: [{ id: 'hidden${i+1}', op: 'contiguous', input: 'hidden${i}' }],
    };
    const plan = compileModelGraph({ ...fixture, inputTokens: 1, cacheTokens: 64, capacity: 128, maximumScratchBytes: 65536 });
    expect(plan.nodes[1]!.node).toMatchObject({ value: 1 });
    expect(plan.nodes[3]!.node).toMatchObject({ value: 2 });
    expect(() => parseModelGraphDefinitions({ input: JSON.stringify(fixture.definition).replace('"repeat"', '"eval"') })).toThrow();
  });

  it('rejects shadowed bindings, non-integer loop counts, missing capability and missing array items', () => {
    for (const mutation of ['shadow', 'fraction', 'capability', 'range', 'template'] as const) {
      const fixture = repeated();
      const block = fixture.definition.graph.nodes[1]!;
      if (block.op !== 'repeat') {
        throw new Error('fixture');
      }
      switch (mutation) {
      case 'shadow': block.index = 'layers';
        break;
      case 'fraction': block.count = 2.5;
        break;
      case 'capability': fixture.definition.requiredCapabilities = ['tensor-graph/v1'];
        break;
      case 'range': block.count = 4;
        break;
      case 'template': block.nodes[0] = { id: 'hidden${notBound}', op: 'contiguous', input: 'hidden0' };
        break;
      default: {
        const exhaustive: never = mutation;
        throw new Error(String(exhaustive));
      }
      }
      expect(() => expandModelGraphDefinition(fixture)).toThrow();
    }
  });

  it('bounds nested expansion even when each individual repeat count is permitted', () => {
    const fixture = repeated();
    const nested: ModelGraphDefinition['graph']['nodes'][number] = {
      id: 'outer',
      op: 'repeat',
      index: 'i',
      count: 200,
      weights: [],
      slots: [],
      tensors: [],
      updates: [],
      nodes: [
        { id: 'inner', op: 'repeat', index: 'j', count: 200, weights: [], slots: [], tensors: [], updates: [], nodes: [{ id: 'id${i}.${j}', op: 'contiguous', input: 'embedding' }] },
      ],
    };
    fixture.definition.graph.nodes = [nested];
    expect(() => expandModelGraphDefinition(fixture)).toThrow('budget');
  });

  it('validates both branch syntaxes, then validates references in the selected graph', () => {
    const fixture = repeated();
    const block = fixture.definition.graph.nodes[1]!;
    if (block.op !== 'repeat') {
      throw new Error('fixture');
    }
    const branch = block.nodes[0]!;
    if (branch.op !== 'choose') {
      throw new Error('fixture');
    }
    const withScript: unknown = { ...branch, otherwise: [{ id: 'hidden${i+1}', op: 'javascript', source: 'throw new Error()' }] };
    const source = JSON.stringify(fixture.definition).replace(JSON.stringify(branch), JSON.stringify(withScript));
    expect(() => parseModelGraphDefinitions({ input: source })).toThrow();
    branch.then = [{ id: 'hidden${i+1}', op: 'contiguous', input: 'missing' }];
    expect(() => expandModelGraphDefinition(fixture)).toThrow('reference');
  });
});

describe('closed numeric model expressions', () => {
  const evaluator = () => createGraphExpressionEvaluator({
    environment: {
      parameters: new Map([['width', 8]]),
      variables: new Map([['layer', 2]]),
      metadata: new Map<string, GraphMetadataValue>([['array', [3, 4, 5]], ['flag', true], ['name', 'test']]),
      tensors: new Map([['weight', { shape: [8, 16] }]]),
      inputTokens: 7,
      cacheTokens: 64,
      capacity: 128,
    },
    maximumSteps: 1000,
  });

  it.each([
    [4, 4], [{ parameter: 'width' }, 8], [{ variable: 'layer' }, 2], [{ metadata: 'array', index: 1 }, 4],
    [{ tensor: 'weight', dimension: 1 }, 16], [{ inputTokens: true }, 7], [{ cacheTokens: true }, 64], [{ capacity: true }, 128],
    [{ sum: [2, 3] }, 5], [{ product: [2, 3] }, 6], [{ quotient: [12, 3] }, 4], [{ subtract: [1, 3] }, -2],
    [{ power: [2, 5] }, 32], [{ minimum: [3, 1] }, 1], [{ maximum: [2, 5] }, 5], [{ sqrt: 16 }, 4], [{ modulo: [-1, 3] }, 2],
  ] satisfies [GraphNumber, number][])('evaluates %j', (value, expected) => {
    expect(evaluator().number({ value })).toBe(expected);
  });

  it.each([
    { quotient: [2, 0] }, { sqrt: -1 }, { power: [10, 30] }, { parameter: 'missing' },
    { metadata: 'array', index: -1 }, { metadata: 'array', index: 0.5 }, { metadata: 'array', index: 3 },
    { metadata: 'name' }, { metadata: 'flag' }, { tensor: 'weight', dimension: 3 },
  ] satisfies GraphNumber[])('rejects unsafe or untyped arithmetic %j', value => {
    expect(() => evaluator().number({ value })).toThrow();
  });

  it('shares the work budget across calls and rejects deep expressions before overflow', () => {
    const limited = createGraphExpressionEvaluator({ environment: { parameters: new Map(), variables: new Map(), metadata: new Map(), tensors: new Map(), inputTokens: undefined, cacheTokens: undefined, capacity: undefined }, maximumSteps: 2 });
    expect(limited.number({ value: 1 })).toBe(1);
    expect(() => limited.number({ value: { sum: [1, 2] } })).toThrow('budget');
    let deep: GraphNumber = 1;
    for (let i = 0; i < 50; i++) {
      deep = { sum: [deep, 0] };
    }
    expect(() => evaluator().number({ value: deep })).toThrow('budget');
  });
});

export const TEST_ONLY = {
};
