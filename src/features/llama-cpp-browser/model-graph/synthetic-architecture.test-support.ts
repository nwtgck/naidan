import { modelGraphFormat, parseModelGraphDefinitions, type GraphReference, type GraphScopeBody, type ModelGraphDefinition, type ModelGraphEntry } from './definition';
import { expandModelGraphDefinition } from './expand';
import { graphTensorBytes } from './tensor-layout';
import type { GraphMetadataValue } from './expressions';
import type { ModelGraphInventory, ModelGraphTensorInfo } from './compile';

// Deliberately test-specific to avoid collisions with real model names.
export const syntheticArchitecture = 'naidan-test-only-architecture';

const dimensions = {
  small: { layers: 3, width: 12, vocabulary: 16, heads: 2, kvHeads: 1, headSize: 8, feedForward: 24, window: 3 },
  large: { layers: 64, width: 4096, vocabulary: 8192, heads: 20, kvHeads: 10, headSize: 128, feedForward: 8192, window: 128 },
} as const;

function body({ nodes }: { nodes: ModelGraphEntry[] }): GraphScopeBody {
  return { weights: [], slots: [], tensors: [], updates: [], nodes };
}

function normalized({ id, input, weight }: { id: string; input: GraphReference; weight: string }): ModelGraphEntry[] {
  return [
    { id: `${id}Rms`, op: 'normalizeRms', input, epsilon: 1e-6 },
    { id: `${id}Weight`, op: 'tensor', operator: 'cast', inputs: [weight], attributes: { type: 'F32' } },
    { id, op: 'multiply', left: `${id}Rms`, right: `${id}Weight` },
  ];
}

/** Invented decoder exercising graph features, not a declaration of a trained
 * model. The large form contains descriptors only; it never allocates weights. */
export function syntheticArchitectureFixture({ scale, precision }: { scale: keyof typeof dimensions; precision: 'F16' | 'F32' }) {
  const size = dimensions[scale];
  const { layers, width, vocabulary, heads, kvHeads, headSize, feedForward, window } = size;
  const index = { iteration: 'layer' } as const;
  const length = { metadata: 'fixture.layers' } as const;
  const clamp = { metadata: 'fixture.clamp', index, length, scalar: 'broadcast', fallback: 0 } as const;
  const frequencyBase = { metadata: 'fixture.local_rope_base', fallback: { metadata: 'fixture.rope_base' } } as const;
  const tokens = { inputTokens: true } as const;
  const embeddingScale = { metadata: 'fixture.embedding_scale', fallback: 0 } as const;
  const layerWeights: [string, number[]][] = [
    ['attn_norm', [width]], ['attn_q', [width, heads * headSize]], ['attn_k', [width, kvHeads * headSize]],
    ['attn_v', [width, kvHeads * headSize]], ['attn_output', [heads * headSize, width]],
    ['attn_q_norm', [headSize]], ['attn_k_norm', [headSize]], ['attn_gate', [width, heads * headSize]],
    ['attn_vres_lambda', [1]], ['post_attention_norm', [width]], ['ffn_norm', [width]],
    ['ffn_gate', [width, feedForward]], ['ffn_up', [width, feedForward]], ['ffn_down', [feedForward, width]], ['post_ffw_norm', [width]],
  ];
  const definition: ModelGraphDefinition = {
    format: modelGraphFormat,
    name: 'Synthetic hybrid decoder',
    applicability: { architecture: syntheticArchitecture, metadata: [{ key: 'fixture.layers', value: layers }, { key: 'fixture.window', value: window }] },
    requiredCapabilities: ['tensor-graph/v1', 'decoder-kv-linear/v1', 'rotary-normal-neox/v1', 'tensor-operators/v2', 'scoped-declarations/v1'],
    parameters: [],
    weights: [
      { id: 'embedding', tensor: 'token_embd.weight', shape: [width, vocabulary], types: ['F32'] },
      { id: 'outputNorm', tensor: 'output_norm.weight', shape: [width], types: ['F32'] },
      { id: 'output', tensor: 'output.weight', shape: [width, vocabulary], types: ['F32'] },
    ],
    state: { profile: 'decoder-state/v2', slots: [], tensors: [], updates: [] },
    graph: {
      nodes: [
        { id: 'embedded', op: 'embedding', weight: 'embedding' },
        {
          id: 'embeddingScale',
          op: 'choose',
          condition: { compare: 'equal', left: embeddingScale, right: 0 },
          capture: { input: 'embedded' },
          then: { ...body({ nodes: [{ id: 'initialHidden', op: 'contiguous', input: { capture: 'input' } }] }), outputs: { hidden: 'initialHidden' } },
          otherwise: { ...body({ nodes: [{ id: 'initialHidden', op: 'scale', input: { capture: 'input' }, value: embeddingScale }] }), outputs: { hidden: 'initialHidden' } },
        },
        {
          id: 'layers',
          op: 'repeat',
          index: 'layer',
          count: length,
          capture: { initial: { output: { block: 'embeddingScale', port: 'hidden' } } },
          carry: { hidden: { initial: { output: { block: 'embeddingScale', port: 'hidden' } }, next: 'hidden' } },
          body: {
            weights: layerWeights.map(([id, shape]) => ({ id, tensor: { concat: ['layer.', { decimal: index }, `.${id}.weight`] }, shape, types: ['F32'] })),
            slots: [{ id: 'kv', headSize, heads: kvHeads, precision }],
            tensors: [],
            updates: [],
            nodes: [
              ...normalized({ id: 'input', input: { carry: 'hidden' }, weight: 'attn_norm' }),
              { id: 'q', op: 'linear', weight: 'attn_q', input: 'input' }, { id: 'k', op: 'linear', weight: 'attn_k', input: 'input' },
              { id: 'mix', op: 'sigmoid', input: 'attn_vres_lambda' },
              { id: 'delta', op: 'subtract', left: 'input', right: { capture: 'initial' } },
              { id: 'mixed', op: 'multiply', left: 'delta', right: 'mix' },
              { id: 'valueInput', op: 'add', left: { capture: 'initial' }, right: 'mixed' },
              { id: 'v', op: 'linear', weight: 'attn_v', input: 'valueInput' },
              { id: 'q3', op: 'reshape', input: 'q', shape: [headSize, heads, tokens] },
              { id: 'k3', op: 'reshape', input: 'k', shape: [headSize, kvHeads, tokens] },
              { id: 'v3', op: 'reshape', input: 'v', shape: [headSize, kvHeads, tokens] },
              ...normalized({ id: 'query', input: 'q3', weight: 'attn_q_norm' }),
              ...normalized({ id: 'key', input: 'k3', weight: 'attn_k_norm' }),
              {
                id: 'attentionChoice',
                op: 'choose',
                condition: { metadata: 'fixture.local_attention', index, length, equals: true },
                capture: { query: 'query', key: 'key', value: 'v3', kv: 'kv' },
                then: {
                  ...body({
                    nodes: [
                      { id: 'qr', op: 'rotaryEmbedding', input: { capture: 'query' }, dimensions: headSize, mode: 'neox', frequencyBase, frequencyScale: 1 },
                      { id: 'kr', op: 'rotaryEmbedding', input: { capture: 'key' }, dimensions: headSize, mode: 'neox', frequencyBase, frequencyScale: 1 },
                      { id: 'attention', op: 'attentionCached', query: 'qr', key: 'kr', value: { capture: 'value' }, slot: { capture: 'kv' }, window, scale: 'inverseSqrtHead' },
                    ],
                  }),
                  outputs: { attention: 'attention' },
                },
                otherwise: {
                  ...body({ nodes: [{ id: 'attention', op: 'attentionCached', query: { capture: 'query' }, key: { capture: 'key' }, value: { capture: 'value' }, slot: { capture: 'kv' }, window: 0, scale: 'inverseSqrtHead' }] }),
                  outputs: { attention: 'attention' },
                },
              },
              { id: 'gate', op: 'linear', weight: 'attn_gate', input: 'input' }, { id: 'sigmoid', op: 'sigmoid', input: 'gate' },
              { id: 'gated', op: 'multiply', left: { output: { block: 'attentionChoice', port: 'attention' } }, right: 'sigmoid' },
              { id: 'projected', op: 'linear', weight: 'attn_output', input: 'gated' },
              ...normalized({ id: 'postAttention', input: 'projected', weight: 'post_attention_norm' }),
              { id: 'residual', op: 'add', left: { carry: 'hidden' }, right: 'postAttention' },
              ...normalized({ id: 'ffnInput', input: 'residual', weight: 'ffn_norm' }),
              { id: 'ffnGate', op: 'linear', weight: 'ffn_gate', input: 'ffnInput' }, { id: 'ffnUp', op: 'linear', weight: 'ffn_up', input: 'ffnInput' },
              {
                id: 'activation',
                op: 'choose',
                condition: { compare: 'equal', left: clamp, right: 0 },
                capture: { gate: 'ffnGate', up: 'ffnUp' },
                then: { ...body({ nodes: [{ id: 'silu', op: 'silu', input: { capture: 'gate' } }, { id: 'swiglu', op: 'multiply', left: 'silu', right: { capture: 'up' } }] }), outputs: { activation: 'swiglu' } },
                otherwise: { ...body({ nodes: [{ id: 'swiglu', op: 'tensor', operator: 'swigluClamped', inputs: [{ capture: 'gate' }, { capture: 'up' }], attributes: { limit: clamp } }] }), outputs: { activation: 'swiglu' } },
              },
              { id: 'down', op: 'linear', weight: 'ffn_down', input: { output: { block: 'activation', port: 'activation' } } },
              ...normalized({ id: 'postFfn', input: 'down', weight: 'post_ffw_norm' }),
              { id: 'hidden', op: 'add', left: 'residual', right: 'postFfn' },
            ],
          },
          outputs: { hidden: { carry: 'hidden' } },
        },
        ...normalized({ id: 'normalized', input: { output: { block: 'layers', port: 'hidden' } }, weight: 'outputNorm' }),
        { id: 'logits', op: 'linear', weight: 'output', input: 'normalized' },
      ],
    },
    outputs: { logits: 'logits' },
  };
  const parsed = parseModelGraphDefinitions({ input: JSON.stringify(definition) })[0]!.definition;
  const metadata = new Map<string, GraphMetadataValue>([
    ['fixture.layers', layers], ['fixture.window', window], ['fixture.clamp', Array.from({ length: layers }, (_, i) => 0.3 + 0.1 * i)],
    ['fixture.embedding_scale', 4], ['fixture.rope_base', 10000], ['fixture.local_attention', Array.from({ length: layers }, (_, i) => i % 2 === 0)],
  ]);
  const provisional: ModelGraphInventory = { architecture: syntheticArchitecture, vocabularySize: vocabulary, metadata, tensors: new Map() };
  const expanded = expandModelGraphDefinition({ definition: parsed, inventory: provisional });
  const tensors = new Map<string, ModelGraphTensorInfo>();
  for (const weight of expanded.weights) {
    const shape = weight.shape.map(value => {
      if (typeof value !== 'number') {
        throw new Error('Unexpected symbolic synthetic weight');
      }
      return value;
    });
    tensors.set(weight.tensor, { name: weight.tensor, shape, type: 'F32', bytes: graphTensorBytes({ shape, type: 'F32' }) });
  }
  return { definition: parsed, inventory: { ...provisional, tensors }, size };
}

export const TEST_ONLY = {
};
