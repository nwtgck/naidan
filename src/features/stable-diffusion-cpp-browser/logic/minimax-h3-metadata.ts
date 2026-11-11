import type { TensorInfo } from './model-metadata';

function findTensor({ tensors, suffix }: { tensors: readonly TensorInfo[], suffix: string }): TensorInfo | undefined {
  return tensors.find(tensor => tensor.name === suffix || tensor.name.endsWith('.' + suffix));
}

function matchesShape({ tensors, suffix, shape }: { tensors: readonly TensorInfo[], suffix: string, shape: readonly number[] }): boolean {
  const tensor = findTensor({ tensors, suffix });
  return tensor !== undefined && tensor.shape.length === shape.length && shape.every((dimension, index) => tensor.shape[index] === dimension);
}

function consecutive({ indices, count }: { indices: ReadonlySet<number>, count: number }): boolean {
  return indices.size === count && Array.from({ length: count }, (_value, index) => indices.has(index)).every(Boolean);
}

/** Structural evidence only; quantization and native execution support are
 * separate checks. Shared by inventory selection and the load preflight. */
export function hasMinimaxH3ImageStructure({ tensors }: { tensors: readonly TensorInfo[] }): boolean {
  return matchesShape({ tensors, suffix: 'video_patch_proj.weight', shape: [5376, 96] })
    && matchesShape({ tensors, suffix: 'condition_proj.weight', shape: [5376, 5120] })
    && matchesShape({ tensors, suffix: 'final_layer.video_out.weight', shape: [576, 5376] })
    && !tensors.some(tensor => /(^|[._])audio([._]|$)/.test(tensor.name));
}

export function hasMinimaxH3ImageVaeStructure({ tensors }: { tensors: readonly TensorInfo[] }): boolean {
  return matchesShape({ tensors, suffix: 'decoder.proj_out.weight', shape: [768, 1024] })
    && matchesShape({ tensors, suffix: 'decoder.x_embedder.weight', shape: [1024, 24] })
    && matchesShape({ tensors, suffix: 'encoder.conv_in.weight', shape: [128, 3, 3, 3, 3] });
}

/** The metadata-free H3 encoder keeps 50 text layers and no final norm. Return
 * its embedding only after recognizing that specific structural signature. */
export function minimaxH3PrunedTextEmbedding({ tensors, architecture, modelType, textModelType }: {
  tensors: readonly TensorInfo[], architecture: string | number | boolean | undefined, modelType: string | undefined, textModelType: string | undefined,
}): TensorInfo | undefined {
  if ((architecture !== undefined && architecture !== 'qwen3vl')
    || (modelType !== undefined && modelType !== 'qwen3_vl')
    || (textModelType !== undefined && textModelType !== 'qwen3_vl_text')
    || !matchesShape({ tensors, suffix: 'model.embed_tokens.weight', shape: [151936, 5120] })
    || !matchesShape({ tensors, suffix: 'model.layers.0.self_attn.q_proj.weight', shape: [8192, 5120] })
    || !matchesShape({ tensors, suffix: 'model.layers.0.self_attn.k_proj.weight', shape: [1024, 5120] })
    || !matchesShape({ tensors, suffix: 'model.layers.0.self_attn.q_norm.weight', shape: [128] })
    || !matchesShape({ tensors, suffix: 'visual.patch_embed.proj.weight', shape: [3456, 2, 16, 16] })
    || ![0, 1, 2].every(index => matchesShape({ tensors, suffix: `visual.deepstack_merger_list.${index}.linear_fc2.weight`, shape: [5120, 4608] }))
    || findTensor({ tensors, suffix: 'model.norm.weight' }) || findTensor({ tensors, suffix: 'output_norm.weight' })) {
    return undefined;
  }
  const textLayers = new Set<number>(), visionLayers = new Set<number>(), deepstackMergers = new Set<number>();
  for (const tensor of tensors) {
    const text = /(?:^|\.)(?:blk|layers)\.([0-9]+)\./.exec(tensor.name);
    if (text && !tensor.name.includes('visual')) {
      textLayers.add(Number(text[1]));
    }
    const vision = /(?:^|\.)visual\.blocks\.([0-9]+)\./.exec(tensor.name);
    if (vision) {
      visionLayers.add(Number(vision[1]));
    }
    const merger = /(?:^|\.)visual\.deepstack_merger_list\.([0-9]+)\./.exec(tensor.name);
    if (merger) {
      deepstackMergers.add(Number(merger[1]));
    }
  }
  return consecutive({ indices: textLayers, count: 50 }) && consecutive({ indices: visionLayers, count: 27 }) && consecutive({ indices: deepstackMergers, count: 3 })
    ? findTensor({ tensors, suffix: 'model.embed_tokens.weight' }) : undefined;
}

export const TEST_ONLY = {
};
