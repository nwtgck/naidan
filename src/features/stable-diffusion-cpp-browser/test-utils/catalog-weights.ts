/** Small, structurally representative fixtures, not executable trained models. */
import { ggufFixture, safetensorsFixture, tensor } from './weights';
import type { ImageRecipeFile } from '@/features/stable-diffusion-cpp-browser/model-recipes';
export async function qwenRecipeFixtureBytes({ file, layers }: { file: ImageRecipeFile, layers: number }): Promise<Uint8Array<ArrayBuffer>> {
  const name = file.path.split('/').at(-1)!;
  const blob = (() => {
    switch (file.role) {
    case 'diffusion': return ggufFixture({ name, metadata: {}, extraBytes: 0, tensors: [
      tensor({ name: 'txt_in.text_norm.weight', shape: [4096] }),
      tensor({ name: 'img_in.weight', shape: [1, 64] }),
      tensor({ name: 'txt_in.in_layer.weight', shape: [1, 4096] }),
    ] }).file;
    case 'vae': return safetensorsFixture({ name, tensors: [
      tensor({ name: 'conv2.weight', shape: [64, 64, 1, 1, 1] }),
      tensor({ name: 'decoder.conv1.weight', shape: [1, 64, 1, 1, 1] }),
      tensor({ name: 'decoder.head.2.weight', shape: [4, 1, 1, 1, 1] }),
    ] }).file;
    case 'lm': return ggufFixture({ name, metadata: { 'general.architecture': 'qwen3vl', 'qwen3vl.block_count': layers }, extraBytes: 0, tensors: [
      tensor({ name: 'token_embd.weight', shape: [1, 4096] }),
      tensor({ name: 'blk.0.attn_q_norm.weight', shape: [128] }),
      tensor({ name: `blk.${layers - 1}.attn_norm.weight`, shape: [4096] }),
    ] }).file;
    default: { const exhaustive: never = file.role; throw new Error(String(exhaustive)); }
    }
  })();
  return new Uint8Array(await blob.slice(0, blob.size).arrayBuffer());
}
export const TEST_ONLY = {
};
