import type { ExpandedModelGraphDefinition } from './definition';
import { modelGraphFormat } from './definition';
import type { ModelGraphInventory } from './compile';

export function graphFixture(): { definition: ExpandedModelGraphDefinition; inventory: ModelGraphInventory } {
  return {
    definition: {
      format: modelGraphFormat,
      name: 'Fixture',
      applicability: { architecture: 'fixture', metadata: [] },
      requiredCapabilities: ['tensor-graph/v1'],
      parameters: [{ name: 'width', value: { metadata: 'fixture.embedding_length' } }],
      weights: [{ id: 'embedding', tensor: 'token_embd.weight', shape: [{ parameter: 'width' }, 5], types: ['F32'] }, { id: 'output', tensor: 'output.weight', shape: [4, 5], types: ['F32'] }],
      state: { profile: 'decoder-state/v2', slots: [], tensors: [], updates: [] },
      graph: { nodes: [{ id: 'hidden', op: 'embedding', weight: 'embedding' }, { id: 'logits', op: 'linear', weight: 'output', input: 'hidden' }] },
      outputs: { logits: 'logits' },
    },
    inventory: {
      architecture: 'fixture',
      metadata: new Map([['fixture.embedding_length', 4]]),
      vocabularySize: 5,
      tensors: new Map([
        ['token_embd.weight', { name: 'token_embd.weight', shape: [4, 5], type: 'F32', bytes: 80 }],
        ['output.weight', { name: 'output.weight', shape: [4, 5], type: 'F32', bytes: 80 }],
      ]),
    },
  };
}

export const TEST_ONLY = {
};

/** Deliberately authored independently of the native llama graph builder. */
export function llamaGraphFixture(): ExpandedModelGraphDefinition {
  const p = ({ name }: { name: string }) => ({ parameter: name });
  const token = { inputTokens: true } as const;
  const weights: ExpandedModelGraphDefinition['weights'] = [
    { id: 'embedding', tensor: 'token_embd.weight', shape: [p({ name: 'width' }), p({ name: 'vocab' })], types: ['F32', 'F16'] },
    { id: 'output', tensor: 'output.weight', shape: [p({ name: 'width' }), p({ name: 'vocab' })], types: ['F32', 'F16'] },
    { id: 'outputNorm', tensor: 'output_norm.weight', shape: [p({ name: 'width' })], types: ['F32'] },
    { id: 'attnNorm', tensor: 'blk.0.attn_norm.weight', shape: [p({ name: 'width' })], types: ['F32'] },
    { id: 'ffnNorm', tensor: 'blk.0.ffn_norm.weight', shape: [p({ name: 'width' })], types: ['F32'] },
  ];
  for (const [id, name, shape] of [
    ['wq', 'attn_q', [32, 32]], ['wk', 'attn_k', [32, 32]], ['wv', 'attn_v', [32, 32]], ['wo', 'attn_output', [32, 32]],
    ['gate', 'ffn_gate', [32, 64]], ['up', 'ffn_up', [32, 64]], ['down', 'ffn_down', [64, 32]],
  ] satisfies [string, string, number[]][]) {
    weights.push({ id, tensor: `blk.0.${name}.weight`, shape, types: ['F32'] });
  }
  return {
    format: modelGraphFormat,
    name: 'Single-layer Llama test graph',
    applicability: { architecture: 'llama', metadata: [{ key: 'llama.block_count', value: 1 }] },
    requiredCapabilities: ['tensor-graph/v1', 'decoder-kv-linear/v1', 'rotary-normal-neox/v1'],
    parameters: [{ name: 'width', value: { metadata: 'llama.embedding_length' } }, { name: 'vocab', value: { tensor: 'token_embd.weight', dimension: 1 } }],
    weights,
    state: { profile: 'decoder-state/v2', tensors: [], updates: [], slots: [{ id: 'layer0', headSize: 8, heads: 4, precision: 'F32' }] },
    graph: {
      nodes: [
        { id: 'x', op: 'embedding', weight: 'embedding' },
        { id: 'an', op: 'normalizeRms', input: 'x', epsilon: 1e-5 },
        { id: 'a', op: 'multiply', left: 'an', right: 'attnNorm' },
        { id: 'q', op: 'linear', weight: 'wq', input: 'a' }, { id: 'k', op: 'linear', weight: 'wk', input: 'a' }, { id: 'v', op: 'linear', weight: 'wv', input: 'a' },
        { id: 'qr', op: 'reshape', input: 'q', shape: [8, 4, token] }, { id: 'kr', op: 'reshape', input: 'k', shape: [8, 4, token] }, { id: 'vr', op: 'reshape', input: 'v', shape: [8, 4, token] },
        { id: 'qp', op: 'rotaryEmbedding', input: 'qr', dimensions: 8, mode: 'normal', frequencyBase: 10000, frequencyScale: 1 },
        { id: 'kp', op: 'rotaryEmbedding', input: 'kr', dimensions: 8, mode: 'normal', frequencyBase: 10000, frequencyScale: 1 },
        { id: 'attn', op: 'attentionCached', query: 'qp', key: 'kp', value: 'vr', slot: 'layer0', window: 0, scale: 'inverseSqrtHead' },
        { id: 'projected', op: 'linear', weight: 'wo', input: 'attn' }, { id: 'residual', op: 'add', left: 'x', right: 'projected' },
        { id: 'fn', op: 'normalizeRms', input: 'residual', epsilon: 1e-5 }, { id: 'f', op: 'multiply', left: 'fn', right: 'ffnNorm' },
        { id: 'g', op: 'linear', weight: 'gate', input: 'f' }, { id: 'u', op: 'linear', weight: 'up', input: 'f' },
        { id: 's', op: 'silu', input: 'g' }, { id: 'gated', op: 'multiply', left: 's', right: 'u' },
        { id: 'ffn', op: 'linear', weight: 'down', input: 'gated' }, { id: 'hidden', op: 'add', left: 'residual', right: 'ffn' },
        { id: 'on', op: 'normalizeRms', input: 'hidden', epsilon: 1e-5 }, { id: 'out', op: 'multiply', left: 'on', right: 'outputNorm' },
        { id: 'logits', op: 'linear', weight: 'output', input: 'out' },
      ],
    },
    outputs: { logits: 'logits' },
  };
}
