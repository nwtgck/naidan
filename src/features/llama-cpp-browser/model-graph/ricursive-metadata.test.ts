import { describe, expect, it } from 'vitest';
import { compileModelGraph } from './compile';
import { ricursiveDeclarationFixture, ricursiveInventoryFixture } from './ricursive.test-support';
import { reviewedRicursiveDeclarationFixture } from './ricursive-reviewed.test-support';
import type { GraphMetadataValue } from './expressions';

function compile({ clamp, embeddingScale, swaBase }: { clamp: GraphMetadataValue | undefined; embeddingScale: number | undefined; swaBase: number | undefined }) {
  const definition = reviewedRicursiveDeclarationFixture();
  const inventory = ricursiveInventoryFixture({ definition });
  const metadata = new Map(inventory.metadata);
  if (clamp === undefined) {
    metadata.delete('ricursive.swiglu_clamp');
  } else {
    metadata.set('ricursive.swiglu_clamp', clamp);
  }
  if (embeddingScale === undefined) {
    metadata.delete('ricursive.embedding_scale');
  } else {
    metadata.set('ricursive.embedding_scale', embeddingScale);
  }
  if (swaBase !== undefined) {
    metadata.set('ricursive.rope.freq_base_swa', swaBase);
  }
  return {
    definition,
    inventory: { ...inventory, metadata },
    run: () => compileModelGraph({ definition, inventory: { ...inventory, metadata }, inputTokens: 1, cacheTokens: 64, capacity: 2048, maximumScratchBytes: 1024 ** 3 }),
  };
}

describe('reviewed Ricursive metadata contracts', () => {
  it('reproduces the reported error with the original declaration and a valid scalar clamp', () => {
    const definition = ricursiveDeclarationFixture(), inventory = ricursiveInventoryFixture({ definition });
    const metadata = new Map(inventory.metadata);
    metadata.set('ricursive.swiglu_clamp', 10);
    expect(() => compileModelGraph({ definition, inventory: { ...inventory, metadata }, inputTokens: 1, cacheTokens: 64, capacity: 2048, maximumScratchBytes: 1024 ** 3 })).toThrow('Expected metadata array: ricursive.swiglu_clamp');
  });

  it('accepts scalar and layer-dependent clamps without adding architecture logic to the compiler', () => {
    for (const clamp of [10, Array.from({ length: 80 }, (_, i) => i + 1)]) {
      const fixture = compile({ clamp, embeddingScale: 1, swaBase: undefined });
      const plan = fixture.run();
      const nodes = plan.nodes.filter(({ node }) => node.op === 'tensor' && node.operation.nativeFunctions.includes('ggml_swiglu_clamp'));
      expect(nodes).toHaveLength(80);
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i]!.node;
        expect(node.op).toBe('tensor');
        expect(node.id.endsWith('.swiglu')).toBe(true);
        expect(plan.definition.graph.nodes.find(entry => entry.id === node.id)).toMatchObject({ attributes: { limit: { index: i, length: { metadata: 'ricursive.block_count' }, scalar: 'broadcast' } } });
      }
    }
  });

  it.each([{ clamp: undefined }, { clamp: 0 }, { clamp: Array<number>(80).fill(0) }])('uses ordinary SwiGLU for absent/zero clamp $clamp', ({ clamp }) => {
    const plan = compile({ clamp, embeddingScale: undefined, swaBase: undefined }).run();
    expect(plan.nodes.filter(({ node }) => node.op === 'silu')).toHaveLength(80);
    expect(plan.nodes.filter(({ node }) => node.op === 'tensor' && node.operation.nativeFunctions.includes('ggml_swiglu_clamp'))).toHaveLength(0);
    expect(plan.nodes.find(({ node }) => node.id.endsWith('.initialHidden'))?.node.op).toBe('contiguous');
  });

  it('supports mixed zero and positive layer clamps, optional no-scale embeddings and the SWA-specific base', () => {
    const plan = compile({ clamp: Array.from({ length: 80 }, (_, i) => i % 2 ? 0 : 10), embeddingScale: 0, swaBase: 5000 }).run();
    expect(plan.nodes.filter(({ node }) => node.op === 'silu')).toHaveLength(40);
    expect(plan.nodes.filter(({ node }) => node.op === 'tensor' && node.operation.nativeFunctions.includes('ggml_swiglu_clamp'))).toHaveLength(40);
    expect(plan.nodes.find(({ node }) => node.id.endsWith('.initialHidden'))?.node.op).toBe('contiguous');
    for (const { node } of plan.nodes) {
      if (node.op === 'rotaryEmbedding') {
        expect(node.frequencyBase).toBe(5000);
      }
    }
  });

  it.each([
    { clamp: [] }, { clamp: [10] }, { clamp: Array<number>(79).fill(10) }, { clamp: Array<number>(81).fill(10) },
    { clamp: -1 }, { clamp: '10' }, { clamp: true }, { clamp: NaN }, { clamp: Infinity },
    { clamp: Array.from({ length: 80 }, (_, i) => i === 79 ? -1 : 10) },
  ])('rejects malformed clamp metadata instead of padding or silently disabling it: $clamp', ({ clamp }) => {
    expect(() => compile({ clamp, embeddingScale: 1, swaBase: undefined }).run()).toThrow();
  });

  it('requires the exact declared sliding/full pattern length, even when the first 80 entries exist', () => {
    const fixture = compile({ clamp: 10, embeddingScale: 1, swaBase: undefined });
    for (const length of [0, 1, 79, 81]) {
      const metadata = new Map(fixture.inventory.metadata);
      metadata.set('ricursive.attention.sliding_window_pattern', Array<boolean>(length).fill(true));
      expect(() => compileModelGraph({ definition: fixture.definition, inventory: { ...fixture.inventory, metadata }, inputTokens: 1, cacheTokens: 64, capacity: 2048, maximumScratchBytes: 1024 ** 3 })).toThrow('Metadata array length mismatch: ricursive.attention.sliding_window_pattern');
    }
  });
});
