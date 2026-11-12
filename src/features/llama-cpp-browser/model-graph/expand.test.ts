import { describe, expect, it } from 'vitest';
import { graphFixture } from './fixtures.test-support';
import { expandModelGraphDefinition } from './expand';
import { compileModelGraph } from './compile';
import { parseModelGraphDefinitions, type GraphScopeBody, type ModelGraphEntry, type ModelGraphDefinition } from './definition';
import { createGraphExpressionEvaluator, type GraphNumber, type GraphMetadataValue } from './expressions';

function body({ nodes }: { nodes: ModelGraphEntry[] }): GraphScopeBody {
  return { weights: [], slots: [], tensors: [], updates: [], nodes };
}

function repeated() {
  const { definition: original, inventory } = graphFixture();
  const metadata = new Map<string, GraphMetadataValue>([...inventory.metadata, ['layers', 3], ['layer.scale', [2, 3, 4]], ['layer.active', [true, false, true]]]);
  const branch: Extract<ModelGraphEntry, { op: 'choose' }> = {
    id: 'select',
    op: 'choose',
    condition: { metadata: 'layer.active', index: { iteration: 'i' }, equals: true },
    capture: { input: { carry: 'hidden' } },
    then: { ...body({ nodes: [{ id: 'value', op: 'scale', input: { capture: 'input' }, value: { metadata: 'layer.scale', index: { iteration: 'i' } } }] }), outputs: { result: { local: 'value' } } },
    otherwise: { ...body({ nodes: [{ id: 'value', op: 'contiguous', input: { capture: 'input' } }] }), outputs: { result: { local: 'value' } } },
  };
  const block: Extract<ModelGraphEntry, { op: 'repeat' }> = {
    id: 'layers',
    op: 'repeat',
    index: 'i',
    count: { parameter: 'layers' },
    capture: {},
    carry: { hidden: { initial: 'hidden0', next: { output: { block: 'select', port: 'result' } } } },
    body: body({ nodes: [branch] }),
    outputs: { hidden: { carry: 'hidden' } },
  };
  const definition: ModelGraphDefinition = {
    ...original,
    requiredCapabilities: [...original.requiredCapabilities, 'scoped-declarations/v1'],
    parameters: [...original.parameters, { name: 'layers', value: { metadata: 'layers' } }],
    graph: {
      nodes: [ { id: 'hidden0', op: 'embedding', weight: 'embedding' }, block,
        { id: 'logits', op: 'linear', weight: 'output', input: { output: { block: 'layers', port: 'hidden' } } } ],
    },
  };
  return { definition, block, branch, inventory: { ...inventory, metadata } };
}

function compile({ definition, inventory }: { definition: ModelGraphDefinition; inventory: ReturnType<typeof repeated>['inventory'] }) {
  return compileModelGraph({ definition, inventory, inputTokens: 2, cacheTokens: 64, capacity: 128, maximumScratchBytes: 65536 });
}

describe('bounded scoped model expansion', () => {
  it('expands metadata arrays and branches into static graph edges without mutating source', () => {
    const fixture = repeated(), before = JSON.stringify(fixture.definition);
    const definition = parseModelGraphDefinitions({ input: before })[0]!.definition;
    const expanded = expandModelGraphDefinition({ definition, inventory: fixture.inventory });
    expect(expanded.graph.nodes.map(node => node.op)).toEqual(['embedding', 'scale', 'contiguous', 'scale', 'linear']);
    expect(new Set(expanded.graph.nodes.map(node => node.id)).size).toBe(5);
    expect(expanded.parameters.map(parameter => parameter.value)).toEqual([4, 3]);
    const plan = compile({ definition, inventory: fixture.inventory });
    expect(plan.nodes[1]!.node).toMatchObject({ op: 'scale', value: 2 });
    expect(plan.nodes[3]!.node).toMatchObject({ op: 'scale', value: 4 });
    expect(plan.nodes.at(-1)!.shape).toEqual([5, 2]);
    expect(JSON.stringify(fixture.definition)).toBe(before);
  });

  it('uses closed integer arithmetic to choose layers, not evaluated source code', () => {
    const fixture = repeated();
    fixture.branch.condition = { compare: 'equal', left: { modulo: [{ iteration: 'i' }, 2] }, right: 0 };
    fixture.branch.then.nodes = [{ id: 'value', op: 'scale', input: { capture: 'input' }, value: { quotient: [{ sum: [2, { iteration: 'i' }] }, { sqrt: 4 }] } }];
    const plan = compile(fixture);
    expect(plan.nodes[1]!.node).toMatchObject({ value: 1 });
    expect(plan.nodes[3]!.node).toMatchObject({ value: 2 });
    expect(() => parseModelGraphDefinitions({ input: JSON.stringify(fixture.definition).replace('"repeat"', '"eval"') })).toThrow();
  });

  it('rejects shadowing, fractional counts, missing capability, missing array items and implicit templates', () => {
    for (const mutation of ['shadow', 'fraction', 'capability', 'range', 'template', 'unbound'] as const) {
      const fixture = repeated();
      switch (mutation) {
      case 'shadow': fixture.block.index = 'layers';
        break;
      case 'fraction': fixture.block.count = 2.5;
        break;
      case 'capability': fixture.definition.requiredCapabilities = ['tensor-graph/v1'];
        break;
      case 'range': fixture.block.count = 4;
        break;
      case 'template': fixture.branch.then.nodes[0]!.id = 'hidden${i}';
        break;
      case 'unbound': fixture.block.count = { iteration: 'missing' };
        break;
      default: {
        const exhaustive: never = mutation;
        throw new Error(String(exhaustive));
      }
      }
      expect(() => expandModelGraphDefinition(fixture)).toThrow();
    }
  });

  it('bounds nested expansion even when individual counts are permitted', () => {
    const fixture = repeated();
    const inner: ModelGraphEntry = { id: 'inner', op: 'repeat', index: 'j', count: 200, capture: {}, carry: { x: { initial: { carry: 'hidden' }, next: 'value' } }, body: body({ nodes: [{ id: 'value', op: 'contiguous', input: { carry: 'x' } }] }), outputs: { x: { carry: 'x' } } };
    fixture.block.count = 200;
    fixture.block.body.nodes = [inner];
    fixture.block.carry.hidden!.next = { output: { block: 'inner', port: 'x' } };
    expect(() => expandModelGraphDefinition(fixture)).toThrow('budget');
  });

  it('preserves nested iteration bindings and explicit carry edges without name assembly', () => {
    const fixture = repeated();
    const inner: ModelGraphEntry = {
      id: 'inner',
      op: 'repeat',
      index: 'j',
      count: 2,
      capture: {},
      carry: { x: { initial: { carry: 'hidden' }, next: 'value' } },
      body: body({ nodes: [{ id: 'value', op: 'scale', input: { carry: 'x' }, value: { sum: [{ iteration: 'i' }, { iteration: 'j' }, 1] } }] }),
      outputs: { x: { carry: 'x' } },
    };
    fixture.block.count = 2;
    fixture.block.body.nodes = [inner];
    fixture.block.carry.hidden!.next = { output: { block: 'inner', port: 'x' } };
    const plan = compile(fixture);
    expect(plan.nodes.filter(({ node }) => node.op === 'scale').map(({ node }) => 'value' in node ? node.value : undefined)).toEqual([1, 2, 2, 3]);
    for (let index = 1; index < 5; index++) {
      expect(plan.nodes[index]!.node).toMatchObject({ input: plan.nodes[index - 1]!.node.id });
    }
  });

  it('does not collide generated internal identities with root user identities', () => {
    const fixture = repeated();
    fixture.definition.graph.nodes[0]!.id = 'scope1.value';
    fixture.block.carry.hidden!.initial = 'scope1.value';
    const plan = compile(fixture);
    expect(plan.nodes[0]!.node.id).toBe('scope1.value');
    expect(new Set(plan.nodes.map(({ node }) => node.id)).size).toBe(plan.nodes.length);
    expect(plan.nodes[1]!.node).toMatchObject({ input: 'scope1.value' });
  });

  it('does not let a persistent state handle masquerade as a loop-carried value', () => {
    const fixture = repeated();
    fixture.definition.state.tensors = [{ id: 'state', shape: [4, 1], precision: 'F32', initial: 'zeros' }];
    fixture.block.carry.hidden!.initial = 'state';
    expect(() => parseModelGraphDefinitions({ input: JSON.stringify(fixture.definition) })).toThrow('Expected tensor reference');
  });

  it('checks both branches even when one is inactive', () => {
    const fixture = repeated();
    fixture.branch.condition = { compare: 'equal', left: 1, right: 1 };
    const withScript = { ...fixture.branch, otherwise: { ...fixture.branch.otherwise, nodes: [{ id: 'value', op: 'javascript', source: 'throw new Error()' }] } };
    expect(() => parseModelGraphDefinitions({ input: JSON.stringify(fixture.definition).replace(JSON.stringify(fixture.branch), JSON.stringify(withScript)) })).toThrow();
    fixture.branch.otherwise.nodes = [{ id: 'value', op: 'contiguous', input: 'hidden0' }];
    expect(() => parseModelGraphDefinitions({ input: JSON.stringify(fixture.definition) })).toThrow('reference');
  });

  it('keeps hidden body nodes inaccessible outside their scope', () => {
    const fixture = repeated();
    fixture.definition.graph.nodes[2] = { id: 'logits', op: 'linear', weight: 'output', input: 'value' };
    expect(() => expandModelGraphDefinition(fixture)).toThrow('reference');
  });

  it('requires exactly matching branch ports, without guessing a last node', () => {
    const fixture = repeated();
    fixture.branch.otherwise.outputs = { wrong: 'value' };
    expect(() => expandModelGraphDefinition(fixture)).toThrow('same output ports');
  });

  it('returns initial carries for zero iterations and rejects nonexistent last-body results', () => {
    const fixture = repeated();
    fixture.block.count = 0;
    expect(compile(fixture).nodes.map(value => value.node.op)).toEqual(['embedding', 'linear']);
    fixture.block.outputs = { hidden: { output: { block: 'select', port: 'result' } } };
    expect(() => expandModelGraphDefinition(fixture)).toThrow('reference');
  });

  it('updates multiple carries simultaneously, rather than in object order', () => {
    const fixture = repeated();
    fixture.definition.graph.nodes = [
      { id: 'a', op: 'embedding', weight: 'embedding' }, { id: 'b', op: 'scale', input: 'a', value: 2 },
      { id: 'swap', op: 'repeat', index: 'step', count: 1, capture: {}, carry: { x: { initial: 'a', next: { carry: 'y' } }, y: { initial: 'b', next: { carry: 'x' } } }, body: body({ nodes: [] }), outputs: { x: { carry: 'x' }, y: { carry: 'y' } } },
      { id: 'sum', op: 'subtract', left: { output: { block: 'swap', port: 'x' } }, right: { output: { block: 'swap', port: 'y' } } },
      { id: 'logits', op: 'linear', weight: 'output', input: 'sum' },
    ];
    expect(expandModelGraphDefinition(fixture).graph.nodes[2]).toMatchObject({ op: 'subtract', left: 'b', right: 'a' });
  });

  it('does not require loop-carried values to keep the same shape', () => {
    const fixture = repeated();
    fixture.block.count = 3;
    fixture.block.body.nodes = [
      { id: 'joined', op: 'tensor', operator: 'concat', inputs: [{ carry: 'hidden' }, { carry: 'hidden' }], attributes: { axis: 0 } },
      { id: 'wide', op: 'reshape', input: 'joined', shape: [{ product: [4, { power: [2, { sum: [{ iteration: 'i' }, 1] }] }] }, { inputTokens: true }] },
    ];
    fixture.block.carry.hidden!.next = 'wide';
    fixture.definition.requiredCapabilities.push('tensor-operators/v2');
    const weight = fixture.definition.weights.find(item => item.id === 'output')!;
    weight.shape = [32, 5];
    const tensors = new Map(fixture.inventory.tensors);
    tensors.set('output.weight', { name: 'output.weight', shape: [32, 5], type: 'F32', bytes: 32 * 5 * 4 });
    expect(compile({ definition: fixture.definition, inventory: { ...fixture.inventory, tensors } }).nodes.at(-2)!.shape).toEqual([32, 2]);
  });
});

describe('closed numeric model expressions', () => {
  const evaluator = () => createGraphExpressionEvaluator({
    environment: {
      parameters: new Map([['width', 8]]),
      iterations: new Map([['layer', 2]]),
      metadata: new Map<string, GraphMetadataValue>([['array', [3, 4, 5]], ['flag', true], ['name', 'test']]),
      tensors: new Map([['weight', { shape: [8, 16] }]]),
      inputTokens: 7,
      cacheTokens: 64,
      capacity: 128,
    },
    maximumSteps: 1000,
  });

  it.each([
    [4, 4], [{ parameter: 'width' }, 8], [{ iteration: 'layer' }, 2], [{ metadata: 'array', index: 1 }, 4],
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
    const limited = createGraphExpressionEvaluator({ environment: { parameters: new Map(), iterations: new Map(), metadata: new Map(), tensors: new Map(), inputTokens: undefined, cacheTokens: undefined, capacity: undefined }, maximumSteps: 2 });
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
