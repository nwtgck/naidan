import { reviewedRicursiveDeclarationFixture } from './ricursive-reviewed.test-support';
import { ricursiveDeclarationFixture } from './ricursive.test-support';
import { expandModelGraphDefinition } from './expand';
import { parseModelGraphDefinitions, type ModelGraphDefinition } from './definition';
import type { ModelGraphInventory, ModelGraphTensorInfo } from './compile';
import type { GraphMetadataValue } from './expressions';

/** Scale only dimensions and windows of the supplied declaration. Retain its
 * five-layer sliding/full cycle, gates, value blending and normalization order. */
export function smallRicursiveFixture({ precision }: { precision: 'F32' | 'F16' }) {
  return buildSmallRicursiveFixture({ precision, declaration: ricursiveDeclarationFixture(), metadataOverrides: [] });
}

export function smallReviewedRicursiveFixture({ precision, clamp, embeddingScale, swaBase }: {
  precision: 'F32' | 'F16'; clamp: number | readonly number[] | undefined; embeddingScale: number | undefined; swaBase: number | undefined;
}) {
  return buildSmallRicursiveFixture({
    precision,
    declaration: reviewedRicursiveDeclarationFixture(),
    metadataOverrides: [
      ['ricursive.swiglu_clamp', clamp], ['ricursive.embedding_scale', embeddingScale], ['ricursive.rope.freq_base_swa', swaBase],
    ],
  });
}

function buildSmallRicursiveFixture({ precision, declaration, metadataOverrides }: {
  precision: 'F32' | 'F16'; declaration: ModelGraphDefinition; metadataOverrides: readonly [string, GraphMetadataValue | undefined][];
}) {
  const replace = ({ value }: { value: unknown }): unknown => {
    if (typeof value === 'number') {
      return new Map([[5120, 16], [100352, 24], [10240, 32], [1024, 16], [40960, 32], [128, 8], [80, 4], [8, 2]]).get(value) ?? value;
    }
    if (typeof value === 'string') {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map(entry => replace({ value: entry }));
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, key === 'window' && entry === 1024 ? 2 : key === 'count' && entry === 80 ? 5 : replace({ value: entry })]));
    }
    return value;
  };
  const definition = parseModelGraphDefinitions({ input: JSON.stringify(replace({ value: declaration })) })[0]!.definition;
  definition.applicability.metadata.find(entry => entry.key === 'ricursive.block_count')!.value = 5;
  const windowConstraint = definition.applicability.metadata.find(entry => entry.key === 'ricursive.attention.sliding_window');
  if (windowConstraint) {
    windowConstraint.value = 2;
  }
  const metadata = new Map<string, GraphMetadataValue>([
    ...definition.applicability.metadata.map(({ key, value }): [string, GraphMetadataValue] => [key, value]),
    ['ricursive.attention.sliding_window', 2], ['ricursive.embedding_scale', 4],
    ['ricursive.attention.layer_norm_rms_epsilon', 1e-6], ['ricursive.rope.freq_base', 10000],
    ['ricursive.attention.sliding_window_pattern', [true, true, true, true, false]],
    ['ricursive.swiglu_clamp', [0.3, 0.4, 0.5, 0.6, 0.7]],
  ]);
  for (const [key, value] of metadataOverrides) {
    if (value === undefined) {
      metadata.delete(key);
    } else {
      metadata.set(key, value);
    }
  }
  const rawClamp = metadata.get('ricursive.swiglu_clamp');
  const clamps = Array.from({ length: 5 }, (_, layer) => {
    const limit: unknown = rawClamp === undefined ? 0 : typeof rawClamp === 'number' ? rawClamp : Array.isArray(rawClamp) ? rawClamp[layer] : undefined;
    if (typeof limit !== 'number') {
      throw new Error('Invalid reference clamp');
    }
    return limit;
  });
  const scale = metadata.get('ricursive.embedding_scale') ?? 0;
  const base = metadata.get('ricursive.rope.freq_base_swa') ?? metadata.get('ricursive.rope.freq_base');
  if (typeof scale !== 'number' || typeof base !== 'number') {
    throw new Error('Invalid scalar reference metadata');
  }
  const provisional: ModelGraphInventory = { architecture: 'ricursive', vocabularySize: 24, metadata, tensors: new Map() };
  const flat = expandModelGraphDefinition({ definition, inventory: provisional });
  // Cache rounding is independently modeled below for F16. Weight precision is
  // F32 in this tiny numerical fixture, not a quantization fidelity experiment.
  const choosePrecision = ({ entries }: { entries: ModelGraphDefinition['graph']['nodes'] }): void => {
    for (const entry of entries) {
      switch (entry.op) {
      case 'repeat': entry.body.slots.forEach(slot => {
        slot.precision = precision;
      });
        choosePrecision({ entries: entry.body.nodes });
        break;
      case 'choose': choosePrecision({ entries: entry.then.nodes });
        choosePrecision({ entries: entry.otherwise.nodes });
        break;
      case 'embedding': case 'linear': case 'normalizeRms': case 'add': case 'subtract': case 'multiply': case 'sigmoid': case 'silu':
      case 'contiguous': case 'scale': case 'reshape': case 'permute': case 'rotaryEmbedding': case 'tensor': case 'stateRead': case 'input': case 'attentionCached': break;
      default: {
        const exhaustive: never = entry;
        throw new Error(String(exhaustive));
      }
      }
    }
  };
  choosePrecision({ entries: definition.graph.nodes });
  const tensors = new Map<string, ModelGraphTensorInfo>();
  const values = new Map<string, Float32Array>();
  const locations = new Map<string, { source: { size: number; read: ({ destination, offset }: { destination: Uint8Array; offset: number }) => number }; offset: number }>();
  for (const [index, weight] of flat.weights.entries()) {
    const shape = weight.shape.map(value => {
      if (typeof value !== 'number') {
        throw new Error('Unexpected fixture weight expression');
      }
      return value;
    });
    const data = Float32Array.from({ length: shape.reduce((a, b) => a * b, 1) }, (_unused, i) =>
      weight.tensor.includes('norm.weight') ? 0.8 + 0.2 * Math.cos(i + index) : 0.08 * Math.sin((i + 1) * 0.37 + index * 0.13));
    const bytes = new Uint8Array(data.buffer);
    tensors.set(weight.tensor, { name: weight.tensor, shape, type: 'F32', bytes: bytes.byteLength });
    values.set(weight.tensor, data);
    locations.set(weight.tensor, {
      offset: 0,
      source: {
        size: bytes.length,
        read: ({ destination, offset }) => {
          const part = bytes.subarray(offset, offset + destination.length);
          destination.set(part);
          return part.length;
        },
      },
    });
  }
  const inventory = { ...provisional, tensors };
  return { definition, inventory, locations, reference: createReference({ values, precision, clamps, embeddingScale: scale === 0 ? 1 : scale, frequencyBase: base }) };
}

/** Scalar reference for the official Ricursive equations; it does not walk or
 * lower the declaration, call GGML, or use the production operator catalog. */
function createReference({ values, precision, clamps, embeddingScale, frequencyBase }: { values: ReadonlyMap<string, Float32Array>; precision: 'F32' | 'F16'; clamps: readonly number[]; embeddingScale: number; frequencyBase: number }) {
  const heads = 4, kvHeads = 2, headSize = 8, width = 16;
  const history: { keys: number[][]; vals: number[][] }[] = Array.from({ length: 5 }, () => ({ keys: [], vals: [] }));
  let position = 0;
  const weight = ({ name }: { name: string }) => {
    const found = values.get(name);
    if (!found) {
      throw new Error(name);
    }
    return found;
  };
  const linear = ({ name, input }: { name: string; input: number[] }): number[] => {
    const data = weight({ name });
    return Array.from({ length: data.length / input.length }, (_unused, row) => input.reduce((sum, value, column) => sum + value * data[row * input.length + column]!, 0));
  };
  const norm = ({ input, name, size }: { input: number[]; name: string; size: number }): number[] => {
    const gamma = weight({ name }), output: number[] = [];
    for (let offset = 0; offset < input.length; offset += size) {
      const part = input.slice(offset, offset + size), inverse = 1 / Math.sqrt(part.reduce((sum, x) => sum + x * x, 0) / size + 1e-6);
      output.push(...part.map((x, i) => x * inverse * gamma[i]!));
    }
    return output;
  };
  const rotary = ({ input }: { input: number[] }): number[] => {
    const result = [...input];
    for (let offset = 0; offset < input.length; offset += headSize) {
      for (let i = 0; i < headSize / 2; i++) {
        const theta = position / frequencyBase ** (2 * i / headSize), cosine = Math.cos(theta), sine = Math.sin(theta);
        const a = input[offset + i]!, b = input[offset + i + headSize / 2]!;
        result[offset + i] = a * cosine - b * sine;
        result[offset + i + headSize / 2] = a * sine + b * cosine;
      }
    }
    return result;
  };
  const roundCache = ({ value }: { value: number }): number => {
    switch (precision) {
    case 'F32': return Math.fround(value);
    case 'F16': {
      const sign = Math.sign(value), magnitude = Math.abs(Math.fround(value));
      if (!magnitude || !Number.isFinite(magnitude)) {
        return value;
      }
      if (magnitude >= 65520) {
        return sign * Infinity;
      }
      const unit = 2 ** Math.max(-24, Math.floor(Math.log2(magnitude)) - 10);
      const scaled = magnitude / unit, below = Math.floor(scaled), fraction = scaled - below;
      const rounded = fraction < 0.5 ? below : fraction > 0.5 ? below + 1 : below + below % 2;
      return sign * rounded * unit;
    }
    default: {
      const exhaustive: never = precision;
      throw new Error(String(exhaustive));
    }
    }
  };
  return {
    step({ token }: { token: number }): number[] {
      const embedding = weight({ name: 'token_embd.weight' });
      const initial = Array.from(embedding.subarray(token * width, (token + 1) * width), x => x * embeddingScale);
      let hidden = initial;
      for (let layer = 0; layer < 5; layer++) {
        const name = ({ suffix }: { suffix: string }) => `blk.${layer}.${suffix}.weight`;
        const input = norm({ input: hidden, name: name({ suffix: 'attn_norm' }), size: width });
        let query = norm({ input: linear({ input, name: name({ suffix: 'attn_q' }) }), name: name({ suffix: 'attn_q_norm' }), size: headSize });
        let key = norm({ input: linear({ input, name: name({ suffix: 'attn_k' }) }), name: name({ suffix: 'attn_k_norm' }), size: headSize });
        const mix = 1 / (1 + Math.exp(-weight({ name: name({ suffix: 'attn_vres_lambda' }) })[0]!));
        const vinput = input.map((value, i) => initial[i]! + mix * (value - initial[i]!));
        const value = linear({ input: vinput, name: name({ suffix: 'attn_v' }) });
        const sliding = layer !== 4;
        if (sliding) {
          query = rotary({ input: query });
          key = rotary({ input: key });
        }
        history[layer]!.keys.push(key.map(value => roundCache({ value })));
        history[layer]!.vals.push(value.map(value => roundCache({ value })));
        const attention: number[] = [];
        for (let head = 0; head < heads; head++) {
          const kv = Math.floor(head / (heads / kvHeads));
          const first = sliding ? Math.max(0, position - 1) : 0;
          const scores = history[layer]!.keys.slice(first).map(keys => {
            let dot = 0;
            for (let i = 0; i < headSize; i++) {
              dot += roundCache({ value: query[head * headSize + i]! }) * keys[kv * headSize + i]!;
            }
            return dot / Math.sqrt(headSize);
          });
          switch (precision) {
          case 'F32': {
            const maximum = Math.max(...scores), probabilities = scores.map(score => Math.exp(score - maximum)), total = probabilities.reduce((sum, x) => sum + x, 0);
            for (let i = 0; i < headSize; i++) {
              attention.push(probabilities.reduce((sum, p, at) => sum + p / total * history[layer]!.vals[first + at]![kv * headSize + i]!, 0));
            }
            break;
          }
          case 'F16': {
            // The supplied CPU kernel uses half-vector dot products and an
            // online half accumulator below its 64-query tiled-prefill path.
            // Match those rounding sites, not a looser error threshold.
            const sums = Array<number>(headSize).fill(0);
            let maximum = -Infinity, total = 0;
            for (const [at, score] of scores.entries()) {
              let rescale = 1, probability = 1;
              if (score > maximum) {
                rescale = Math.fround(Math.exp(maximum - score));
                maximum = score;
                for (let i = 0; i < headSize; i++) {
                  sums[i] = roundCache({ value: sums[i]! * rescale });
                }
              } else {
                probability = Math.fround(Math.exp(score - maximum));
              }
              for (let i = 0; i < headSize; i++) {
                sums[i] = roundCache({ value: sums[i]! + history[layer]!.vals[first + at]![kv * headSize + i]! * probability });
              }
              total = Math.fround(total * rescale + probability);
            }
            attention.push(...sums.map(sum => sum / total));
            break;
          }
          default: {
            const exhaustive: never = precision;
            throw new Error(String(exhaustive));
          }
          }
        }
        const gate = linear({ input, name: name({ suffix: 'attn_gate' }) });
        const projected = linear({ input: attention.map((x, i) => x / (1 + Math.exp(-gate[i]!))), name: name({ suffix: 'attn_output' }) });
        const post = norm({ input: projected, name: name({ suffix: 'post_attention_norm' }), size: width });
        const residual = hidden.map((x, i) => x + post[i]!);
        const ffInput = norm({ input: residual, name: name({ suffix: 'ffn_norm' }), size: width });
        const ffGate = linear({ input: ffInput, name: name({ suffix: 'ffn_gate' }) }), up = linear({ input: ffInput, name: name({ suffix: 'ffn_up' }) });
        const limit = clamps[layer]!;
        const active = ffGate.map((x, i) => {
          if (limit === 0) {
            return x / (1 + Math.exp(-x)) * up[i]!;
          }
          const clipped = Math.min(x, limit);
          return clipped / (1 + Math.exp(-clipped)) * Math.max(-limit, Math.min(limit, up[i]!));
        });
        const down = linear({ input: active, name: name({ suffix: 'ffn_down' }) });
        const ffPost = norm({ input: down, name: name({ suffix: 'post_ffw_norm' }), size: width });
        hidden = residual.map((x, i) => x + ffPost[i]!);
      }
      position++;
      return linear({ input: norm({ input: hidden, name: 'output_norm.weight', size: width }), name: 'output.weight' });
    },
    reset() {
      position = 0;
      history.forEach(layer => {
        layer.keys.length = 0;
        layer.vals.length = 0;
      });
    },
  };
}

export const TEST_ONLY = {
};
