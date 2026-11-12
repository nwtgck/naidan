import { describe, expect, it } from 'vitest';
import { compileModelGraph } from './compile';
import { checkModelGraphMemoryBudget } from './memory-budget';
import { ricursiveDeclarationFixture, ricursiveInventoryFixture } from './ricursive.test-support';

const gib = 1024 ** 3;

describe('registered graph state and compute budgeting', () => {
  it.each([1, 256])('accepts the supplied 80-layer declaration with %i input tokens without double-counting 10 GiB of state', inputTokens => {
    const definition = ricursiveDeclarationFixture();
    const plan = compileModelGraph({ definition, inventory: ricursiveInventoryFixture({ definition }), inputTokens, cacheTokens: 32768, capacity: 32768, maximumScratchBytes: 16 * gib });
    expect(plan.slots).toHaveLength(80);
    expect(plan.weights).toHaveLength(1203);
    expect(plan.stateBytes).toBe(10 * gib);
    expect(plan.nodes.length).toBeGreaterThan(3000);
    expect(plan.nodes.filter(({ node }) => node.op === 'attentionCached')).toHaveLength(80);
  });

  it('does not mistake the model weight bytes for simultaneous compute buffers', () => {
    const definition = ricursiveDeclarationFixture();
    const inventory = ricursiveInventoryFixture({ definition });
    const weights = [...inventory.tensors.values()].reduce((total, tensor) => total + tensor.bytes, 0);
    expect(weights).toBeGreaterThan(30 * gib);
    const plan = compileModelGraph({ definition, inventory, inputTokens: 1, cacheTokens: 64, capacity: 2048, maximumScratchBytes: gib });
    expect(plan.stateBytes).toBe(640 * 1024 ** 2);
  });

  it('still rejects a context whose persistent state alone exceeds the unchanged budget', () => {
    const definition = ricursiveDeclarationFixture();
    expect(() => compileModelGraph({ definition, inventory: ricursiveInventoryFixture({ definition }), inputTokens: 1, cacheTokens: 64, capacity: 65536, maximumScratchBytes: 16 * gib }))
      .toThrow(/State allocation budget exceeded: persistent state 21474836480 bytes.*limit 17179869184 bytes.*context 65536/);
  });

  it('checks the fixed sliding window in the reviewed JSON against model metadata', () => {
    const definition = ricursiveDeclarationFixture();
    definition.applicability.metadata.push({ key: 'ricursive.attention.sliding_window', value: 1024 });
    const inventory = ricursiveInventoryFixture({ definition });
    const request = { definition, inventory, inputTokens: 1, cacheTokens: 64, capacity: 2048, maximumScratchBytes: gib };
    expect(() => compileModelGraph(request)).not.toThrow();
    const metadata = new Map(inventory.metadata);
    metadata.set('ricursive.attention.sliding_window', 2048);
    expect(() => compileModelGraph({ ...request, inventory: { ...inventory, metadata } })).toThrow('Model metadata does not match: ricursive.attention.sliding_window');
  });

  it('counts actual state once, allows exact equality and reports all operands on overflow', () => {
    const request = { phase: 'graph' as const, stateBytes: 10n * BigInt(gib), computeBytes: 6n * BigInt(gib), maximumBytes: 16 * gib, contextTokens: 32768, batchTokens: 256 };
    expect(() => checkModelGraphMemoryBudget(request)).not.toThrow();
    expect(() => checkModelGraphMemoryBudget({ ...request, computeBytes: request.computeBytes + 1n }))
      .toThrow(/persistent state 10737418240 bytes \+ compute buffers 6442450945 bytes.*batch 256.*weights are additional/);
  });

  it('compares large sums as bigint rather than rounding an unsafe Number total', () => {
    expect(() => checkModelGraphMemoryBudget({ phase: 'graph', stateBytes: BigInt(Number.MAX_SAFE_INTEGER), computeBytes: 1n, maximumBytes: Number.MAX_SAFE_INTEGER, contextTokens: 1, batchTokens: 1 }))
      .toThrow('9007199254740992');
  });
});
