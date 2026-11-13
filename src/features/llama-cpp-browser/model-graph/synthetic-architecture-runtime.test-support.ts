import { syntheticArchitectureFixture } from './synthetic-architecture.test-support';
import type { GraphMetadataValue } from './expressions';

/** Allocate only the tiny invented decoder's F32 weights. The reference below
 * evaluates equations directly, without expanding or interpreting graph nodes. */
export function smallSyntheticArchitectureFixture({ precision, clamp, embeddingScale, ropeBase }: {
  precision: 'F32' | 'F16'; clamp: number | readonly number[] | undefined; embeddingScale: number | undefined; ropeBase: number | undefined;
}) {
  const { definition, inventory: original, size } = syntheticArchitectureFixture({ scale: 'small', precision });
  const metadata = new Map(original.metadata);
  for (const [key, value] of [
    ['fixture.clamp', clamp], ['fixture.embedding_scale', embeddingScale], ['fixture.local_rope_base', ropeBase],
  ] satisfies [string, GraphMetadataValue | undefined][]) {
    if (value === undefined) {
      metadata.delete(key);
    } else {
      metadata.set(key, value);
    }
  }
  const inventory = { ...original, metadata };
  const values = new Map<string, Float32Array>();
  const locations = new Map<string, { source: { size: number; read: ({ destination, offset }: { destination: Uint8Array; offset: number }) => number }; offset: number }>();
  for (const [index, weight] of [...inventory.tensors.values()].entries()) {
    let seed = index + 1;
    const data = Float32Array.from({ length: weight.bytes / 4 }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const value = seed / 2 ** 32;
      return weight.name.includes('norm.weight') ? 0.8 + 0.4 * value : 0.08 * (2 * value - 1);
    });
    const bytes = new Uint8Array(data.buffer);
    values.set(weight.name, data);
    locations.set(weight.name, {
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
  return {
    definition,
    inventory,
    locations,
    reference: createReference({
      values,
      precision,
      clamps: Array.from({ length: size.layers }, (_, layer) => typeof clamp === 'number' ? clamp : clamp?.[layer] ?? 0),
      embeddingScale: embeddingScale === undefined || embeddingScale === 0 ? 1 : embeddingScale,
      frequencyBase: ropeBase ?? 10000,
      localAttention: Array.from({ length: size.layers }, (_, layer) => layer % 2 === 0),
      size,
    }),
  };
}

/** Scalar reference for the invented decoder equations; it does not walk or
 * lower the declaration, call GGML, or use the production operator catalog. */
function createReference({ values, precision, clamps, embeddingScale, frequencyBase, localAttention, size }: { values: ReadonlyMap<string, Float32Array>; precision: 'F32' | 'F16'; clamps: readonly number[]; embeddingScale: number; frequencyBase: number; localAttention: readonly boolean[]; size: ReturnType<typeof syntheticArchitectureFixture>['size'] }) {
  const { heads, kvHeads, headSize, width, layers, window } = size;
  const history: { keys: number[][]; vals: number[][] }[] = Array.from({ length: layers }, () => ({ keys: [], vals: [] }));
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
      for (let layer = 0; layer < layers; layer++) {
        const name = ({ suffix }: { suffix: string }) => `layer.${layer}.${suffix}.weight`;
        const input = norm({ input: hidden, name: name({ suffix: 'attn_norm' }), size: width });
        let query = norm({ input: linear({ input, name: name({ suffix: 'attn_q' }) }), name: name({ suffix: 'attn_q_norm' }), size: headSize });
        let key = norm({ input: linear({ input, name: name({ suffix: 'attn_k' }) }), name: name({ suffix: 'attn_k_norm' }), size: headSize });
        const mix = 1 / (1 + Math.exp(-weight({ name: name({ suffix: 'attn_vres_lambda' }) })[0]!));
        const vinput = input.map((value, i) => initial[i]! + mix * (value - initial[i]!));
        const value = linear({ input: vinput, name: name({ suffix: 'attn_v' }) });
        const sliding = localAttention[layer]!;
        if (sliding) {
          query = rotary({ input: query });
          key = rotary({ input: key });
        }
        history[layer]!.keys.push(key.map(value => roundCache({ value })));
        history[layer]!.vals.push(value.map(value => roundCache({ value })));
        const attention: number[] = [];
        for (let head = 0; head < heads; head++) {
          const kv = Math.floor(head / (heads / kvHeads));
          const first = sliding ? Math.max(0, position - window + 1) : 0;
          const scores = history[layer]!.keys.slice(first).map(keys => {
            let dot = 0;
            for (let i = 0; i < headSize; i++) {
              dot += query[head * headSize + i]! * keys[kv * headSize + i]!;
            }
            return dot / Math.sqrt(headSize);
          });
          // Only persistent cache storage is rounded above. Evaluate the
          // attention equation independently of the backend's accumulation order
          // and accumulator precision, so accuracy improvements do not require
          // changing the reference to imitate a particular CPU kernel.
          const maximum = Math.max(...scores), probabilities = scores.map(score => Math.exp(score - maximum)), total = probabilities.reduce((sum, x) => sum + x, 0);
          for (let i = 0; i < headSize; i++) {
            attention.push(probabilities.reduce((sum, p, at) => sum + p / total * history[layer]!.vals[first + at]![kv * headSize + i]!, 0));
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
