/** Structural descriptors from the published H3 Image components. No trained
 * weights are present; sparse file ranges contain synthetic bytes only. */
import type { TensorInfo } from '@/features/stable-diffusion-cpp-browser/logic/model-metadata';
import { sparseFile, tensor } from './weights.test-support';

export const minimaxH3ImageTensors: TensorInfo[] = [
  tensor({ name: 'video_patch_proj.weight', shape: [5376, 96] }),
  { name: 'condition_proj.weight', shape: [5376, 5120], dtype: 'BF16' },
  tensor({ name: 'final_layer.video_out.weight', shape: [576, 5376] }),
];

export const minimaxH3ImageVaeTensors: TensorInfo[] = [
  { name: 'decoder.proj_out.weight', shape: [768, 1024], dtype: 'F16' },
  { name: 'decoder.x_embedder.weight', shape: [1024, 24], dtype: 'F16' },
  { name: 'encoder.conv_in.weight', shape: [128, 3, 3, 3, 3], dtype: 'F16' },
];

export const minimaxH3PrunedTextTensors: TensorInfo[] = [
  { name: 'model.embed_tokens.weight', shape: [151936, 5120], dtype: 'BF16' },
  ...Array.from({ length: 50 }, (_value, index) => tensor({ name: `model.layers.${index}.self_attn.q_proj.weight`, shape: [8192, 5120] })),
  tensor({ name: 'model.layers.0.self_attn.k_proj.weight', shape: [1024, 5120] }),
  tensor({ name: 'model.layers.0.self_attn.q_norm.weight', shape: [128] }),
  tensor({ name: 'visual.patch_embed.proj.weight', shape: [3456, 2, 16, 16] }),
  ...Array.from({ length: 27 }, (_value, index) => tensor({ name: `visual.blocks.${index}.attn.qkv.weight`, shape: [3456, 1152] })),
  ...Array.from({ length: 3 }, (_value, index) => tensor({ name: `visual.deepstack_merger_list.${index}.linear_fc2.weight`, shape: [5120, 4608] })),
];

/** Keep the small quantization JSON readable while every large weight range is
 * sparse. This exercises the unsupported-format guard before native loading. */
export function minimaxH3Int8DiffusionFixture({ name }: { name: string }): ReturnType<typeof sparseFile> {
  const quant = new TextEncoder().encode(JSON.stringify({ format: 'int8_tensorwise', convrot: true, convrot_groupsize: 256 }));
  const descriptors: Record<string, { dtype: string, shape: number[], data_offsets: number[] }> = {
    'blocks.0.attn.out_proj.comfy_quant': { dtype: 'U8', shape: [quant.length], data_offsets: [0, quant.length] },
  };
  let offset = quant.length;
  for (const tensor of [...minimaxH3ImageTensors, { name: 'blocks.0.attn.out_proj.weight', shape: [5376, 5376], dtype: 'I8' }]) {
    const width = tensor.dtype === 'I8' ? 1 : tensor.dtype === 'BF16' ? 2 : 4;
    const end = offset + tensor.shape.reduce((total, dimension) => total * dimension, width);
    descriptors[tensor.name] = { dtype: tensor.dtype, shape: tensor.shape, data_offsets: [offset, end] };
    offset = end;
  }
  const json = new TextEncoder().encode(JSON.stringify(descriptors));
  const header = new Uint8Array(8 + json.length + quant.length);
  new DataView(header.buffer).setBigUint64(0, BigInt(json.length), true);
  header.set(json, 8);
  header.set(quant, 8 + json.length);
  return sparseFile({ name, header, size: 8 + json.length + offset });
}

export const TEST_ONLY = {
};
