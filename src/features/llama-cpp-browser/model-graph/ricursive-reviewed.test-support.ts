import { ricursiveDeclarationFixture } from './ricursive.test-support';
import { parseModelGraphDefinitions, type ModelGraphDefinition, type ModelGraphEntry } from './definition';
import type { GraphNumber } from './expressions';

/** Test-only authoring of the reviewed replacement. This is not an architecture
 * dispatcher in Naidan: production sees only the data imported by the user. */
export function reviewedRicursiveDeclarationFixture(): ModelGraphDefinition {
  const source = ricursiveDeclarationFixture();
  const length: GraphNumber = { metadata: 'ricursive.block_count' };
  const limit: GraphNumber = { metadata: 'ricursive.swiglu_clamp', index: { variable: 'layer' }, length, scalar: 'broadcast', fallback: 0 };
  const transform = ({ nodes }: { nodes: ModelGraphEntry[] }): ModelGraphEntry[] => nodes.map(node => {
    switch (node.op) {
    case 'repeat': return { ...node, nodes: transform({ nodes: node.nodes }) };
    case 'choose': return {
      ...node,
      condition: 'metadata' in node.condition && node.condition.metadata === 'ricursive.attention.sliding_window_pattern'
        ? { metadata: node.condition.metadata, equals: node.condition.equals, index: { variable: 'layer' }, length } : node.condition,
      then: transform({ nodes: node.then }),
      otherwise: transform({ nodes: node.otherwise }),
    };
    case 'tensor':
      // This fixture names its exact activation node; production dispatch is
      // performed only by the validated operator catalog.
      if (node.id === 'swiglu.${layer}') {
        return {
          id: 'ffnActivation.${layer}',
          op: 'choose',
          condition: { compare: 'equal', left: limit, right: 0 },
          then: [
            { id: 'ffnSilu.${layer}', op: 'silu', input: 'ffnGate.${layer}' },
            { id: node.id, op: 'multiply', left: 'ffnSilu.${layer}', right: 'ffnUp.${layer}' },
          ],
          otherwise: [{ ...node, attributes: { limit } }],
        };
      }
      return node;
    case 'scale':
      if (node.id === 'h.-1') {
        const scale: GraphNumber = { metadata: 'ricursive.embedding_scale', fallback: 0 };
        return {
          id: 'embeddingScale',
          op: 'choose',
          condition: { compare: 'equal', left: scale, right: 0 },
          then: [{ id: node.id, op: 'contiguous', input: node.input }],
          otherwise: [{ ...node, value: scale }],
        };
      }
      return node;
    case 'rotaryEmbedding': return { ...node, frequencyBase: { metadata: 'ricursive.rope.freq_base_swa', fallback: node.frequencyBase } };
    case 'embedding': case 'linear': case 'normalizeRms': case 'add': case 'subtract': case 'multiply': case 'sigmoid': case 'silu':
    case 'contiguous': case 'reshape': case 'permute': case 'attentionCached': case 'stateRead': case 'input': return node;
    default: {
      const exhaustive: never = node;
      throw new Error(String(exhaustive));
    }
    }
  });
  return parseModelGraphDefinitions({
    input: JSON.stringify({
      ...source,
      name: 'Ricursive Ripple-65B Preview (explicit scalar/array metadata)',
      applicability: { ...source.applicability, metadata: [...source.applicability.metadata, { key: 'ricursive.attention.sliding_window', value: 1024 }] },
      graph: { nodes: transform({ nodes: source.graph.nodes }) },
      annotations: 'Reviewed scalar/array clamp handling; absent or zero clamp uses ordinary SwiGLU. A clamp array must contain exactly block_count entries. Embedding scale absent/zero means no scaling. SWA-specific RoPE base overrides the common base when present. Retains fixed 80-layer dimensions, 1024 window, required boolean layer-pattern array, gates/value-residual tensors, output weight, and default RoPE scaling. Not a universal Ricursive converter. Real 65B/WebGPU execution is unverified; synthetic CPU regression is not a production-model guarantee.',
    }),
  })[0]!.definition;
}

export const TEST_ONLY = {
};
