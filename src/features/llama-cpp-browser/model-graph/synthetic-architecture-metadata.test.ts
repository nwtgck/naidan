import { describe, expect, it } from 'vitest';
import { compileModelGraph } from './compile';
import { syntheticArchitectureFixture } from './synthetic-architecture.test-support';
import type { GraphMetadataValue } from './expressions';

function compile({ clamp, embeddingScale, ropeBase }: { clamp: GraphMetadataValue | undefined; embeddingScale: number | undefined; ropeBase: number | undefined }) {
  const { definition, inventory } = syntheticArchitectureFixture({ scale: 'small', precision: 'F16' });
  const metadata = new Map(inventory.metadata);
  if (clamp === undefined) {
    metadata.delete('fixture.clamp');
  } else {
    metadata.set('fixture.clamp', clamp);
  }
  if (embeddingScale === undefined) {
    metadata.delete('fixture.embedding_scale');
  } else {
    metadata.set('fixture.embedding_scale', embeddingScale);
  }
  if (ropeBase !== undefined) {
    metadata.set('fixture.local_rope_base', ropeBase);
  }
  return {
    definition,
    inventory: { ...inventory, metadata },
    run: () => compileModelGraph({ definition, inventory: { ...inventory, metadata }, inputTokens: 1, cacheTokens: 64, capacity: 2048, maximumScratchBytes: 1024 ** 3 }),
  };
}

describe('synthetic architecture metadata contracts', () => {
  it('requires explicit scalar broadcast for indexed metadata', () => {
    const fixture = compile({ clamp: 0.3, embeddingScale: 1, ropeBase: undefined });
    const layers = fixture.definition.graph.nodes.find(node => node.op === 'repeat');
    const activation = layers?.body.nodes.find(node => node.id === 'activation');
    if (activation?.op !== 'choose' || !('compare' in activation.condition) || activation.condition.compare !== 'equal') {
      throw new Error('Missing synthetic activation condition');
    }
    activation.condition.left = { metadata: 'fixture.clamp', index: { iteration: 'layer' }, length: { metadata: 'fixture.layers' } };
    expect(fixture.run).toThrow('Expected metadata array: fixture.clamp');
  });

  it('accepts scalar and layer-dependent clamps without adding architecture logic to the compiler', () => {
    for (const clamp of [10, Array.from({ length: 3 }, (_, i) => i + 1)]) {
      const fixture = compile({ clamp, embeddingScale: 1, ropeBase: undefined });
      const plan = fixture.run();
      const nodes = plan.nodes.filter(({ node }) => node.op === 'tensor' && node.operation.nativeFunctions.includes('ggml_swiglu_clamp'));
      expect(nodes).toHaveLength(3);
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i]!.node;
        expect(node.op).toBe('tensor');
        expect(node.id.endsWith('.swiglu')).toBe(true);
        expect(plan.definition.graph.nodes.find(entry => entry.id === node.id)).toMatchObject({ attributes: { limit: { index: i, length: { metadata: 'fixture.layers' }, scalar: 'broadcast' } } });
      }
    }
  });

  it.each([{ clamp: undefined }, { clamp: 0 }, { clamp: Array<number>(3).fill(0) }])('uses ordinary SwiGLU for absent/zero clamp $clamp', ({ clamp }) => {
    const plan = compile({ clamp, embeddingScale: undefined, ropeBase: undefined }).run();
    expect(plan.nodes.filter(({ node }) => node.op === 'silu')).toHaveLength(3);
    expect(plan.nodes.filter(({ node }) => node.op === 'tensor' && node.operation.nativeFunctions.includes('ggml_swiglu_clamp'))).toHaveLength(0);
    expect(plan.nodes.find(({ node }) => node.id.endsWith('.initialHidden'))?.node.op).toBe('contiguous');
  });

  it('supports mixed zero and positive layer clamps, optional no-scale embeddings and a local-attention RoPE base', () => {
    const plan = compile({ clamp: Array.from({ length: 3 }, (_, i) => i % 2 ? 0 : 10), embeddingScale: 0, ropeBase: 5000 }).run();
    expect(plan.nodes.filter(({ node }) => node.op === 'silu')).toHaveLength(1);
    expect(plan.nodes.filter(({ node }) => node.op === 'tensor' && node.operation.nativeFunctions.includes('ggml_swiglu_clamp'))).toHaveLength(2);
    expect(plan.nodes.find(({ node }) => node.id.endsWith('.initialHidden'))?.node.op).toBe('contiguous');
    for (const { node } of plan.nodes) {
      if (node.op === 'rotaryEmbedding') {
        expect(node.frequencyBase).toBe(5000);
      }
    }
  });

  it.each([
    { clamp: [] }, { clamp: [10] }, { clamp: Array<number>(2).fill(10) }, { clamp: Array<number>(4).fill(10) },
    { clamp: -1 }, { clamp: '10' }, { clamp: true }, { clamp: NaN }, { clamp: Infinity },
    { clamp: Array.from({ length: 3 }, (_, i) => i === 2 ? -1 : 10) },
  ])('rejects malformed clamp metadata instead of padding or silently disabling it: $clamp', ({ clamp }) => {
    expect(() => compile({ clamp, embeddingScale: 1, ropeBase: undefined }).run()).toThrow();
  });

  it('requires the exact declared sliding/full pattern length, even when the first three entries exist', () => {
    const fixture = compile({ clamp: 10, embeddingScale: 1, ropeBase: undefined });
    for (const length of [0, 1, 2, 4]) {
      const metadata = new Map(fixture.inventory.metadata);
      metadata.set('fixture.local_attention', Array<boolean>(length).fill(true));
      expect(() => compileModelGraph({ definition: fixture.definition, inventory: { ...fixture.inventory, metadata }, inputTokens: 1, cacheTokens: 64, capacity: 2048, maximumScratchBytes: 1024 ** 3 })).toThrow('Metadata array length mismatch: fixture.local_attention');
    }
  });
});
