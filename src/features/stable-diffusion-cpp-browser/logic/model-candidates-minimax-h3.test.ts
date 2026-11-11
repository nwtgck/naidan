// @vitest-environment node
import { expect, it } from 'vitest';
import { scanImageRepositories, componentRequirements, componentMatch, defaultCompanion } from './model-candidates';
import type { TensorInfo } from './model-metadata';
import type { LocalImageRepository } from './repository-store';
import { ggufFixture, safetensorsFixture, tensor, wanVaeTensors, qwenVaeTensors, qwenTextTensors } from '@/features/stable-diffusion-cpp-browser/test-utils/weights.test-support';
import { minimaxH3ImageTensors, minimaxH3ImageVaeTensors, minimaxH3PrunedTextTensors, minimaxH3Int8DiffusionFixture } from '@/features/stable-diffusion-cpp-browser/test-utils/minimax-h3-weights.test-support';

function repository({ file, config }: { file: File, config: string | undefined }): LocalImageRepository {
  return {
    repositoryKey: `user/${file.name}`,
    repositoryLabel: 'Renamed components',
    files: [{ relativePath: file.name, file }, ...(config === undefined ? [] : [{ relativePath: 'config.json', file: new File([config], 'config.json') }])],
  };
}

async function inspect({ tensors, architecture, config }: { tensors: TensorInfo[], architecture: string | undefined, config: string | undefined }) {
  const file = ggufFixture({ name: 'unrelated-name.gguf', tensors, metadata: architecture === undefined ? {} : { 'general.architecture': architecture }, extraBytes: 0 }).file;
  const inventory = await scanImageRepositories({ repositories: [repository({ file, config })], signal: undefined });
  expect(inventory.issues).toEqual([]);
  return inventory.candidates[0]!;
}

it.each(['', 'model.diffusion_model.'])('recognizes H3 Image projections with prefix %s without using filenames or training labels', async prefix => {
  const file = safetensorsFixture({ name: 'renamed.bin', tensors: minimaxH3ImageTensors.map(tensor => ({ ...tensor, name: prefix + tensor.name })) }).file;
  const result = await scanImageRepositories({ repositories: [repository({ file, config: undefined })], signal: undefined });
  expect(result.issues).toEqual([]);
  expect(result.candidates[0]).toMatchObject({ family: 'minimax-h3-image', roles: ['diffusion'], variant: 'unknown', turboHint: false });
});

it.each([
  { name: 'missing output', tensors: minimaxH3ImageTensors.slice(0, 2) },
  { name: 'different image patch', tensors: minimaxH3ImageTensors.map(tensor => tensor.name === 'video_patch_proj.weight' ? { ...tensor, shape: [5376, 192] } : tensor) },
  { name: 'different conditioner', tensors: minimaxH3ImageTensors.map(tensor => tensor.name === 'condition_proj.weight' ? { ...tensor, shape: [5376, 4096] } : tensor) },
  { name: 'different output', tensors: minimaxH3ImageTensors.map(tensor => tensor.name === 'final_layer.video_out.weight' ? { ...tensor, shape: [1152, 5376] } : tensor) },
  { name: 'audio input', tensors: [...minimaxH3ImageTensors, tensor({ name: 'audio_patch_proj.weight', shape: [5376, 96] })] },
  { name: 'audio output', tensors: [...minimaxH3ImageTensors, tensor({ name: 'final_layer.audio_out.weight', shape: [96, 5376] })] },
])('does not classify H3 $name as H3 Image', async ({ tensors }) => {
  expect((await inspect({ tensors, architecture: undefined, config: undefined })).family).toBe('unknown');
});

it('keeps the detected H3 Image INT8 ConvRot file unsupported and reads only bounded header/metadata ranges', async () => {
  const { file, reads } = minimaxH3Int8DiffusionFixture({ name: 'renamed.safetensors' });
  const result = await scanImageRepositories({ repositories: [repository({ file, config: undefined })], signal: undefined });
  expect(result.candidates[0]).toMatchObject({ family: 'minimax-h3-image', roles: ['diffusion'], issue: 'INT8 tensorwise/convrot is not supported by this bicore GGML build' });
  expect(result.issues).toHaveLength(1);
  expect(reads.reduce((total, read) => total + read.length, 0)).toBeLessThan(4096);
  expect(reads.every(read => read.offset + read.length < 4096)).toBe(true);
});

it('requires the H3 Image VAE and the complete pruned vision encoder instead of existing structural companions', async () => {
  const main = ggufFixture({ name: 'main.gguf', tensors: minimaxH3ImageTensors, metadata: {}, extraBytes: 0 }).file;
  const vae = safetensorsFixture({ name: 'vae.bin', tensors: minimaxH3ImageVaeTensors }).file;
  const lm = ggufFixture({ name: 'encoder.gguf', tensors: minimaxH3PrunedTextTensors, metadata: {}, extraBytes: 0 }).file;
  const otherVae = safetensorsFixture({ name: 'video.bin', tensors: wanVaeTensors }).file;
  const otherLm = ggufFixture({ name: 'qwen.gguf', tensors: qwenTextTensors({ width: 4096, layers: 36 }), metadata: { 'general.architecture': 'qwen3vl' }, extraBytes: 0 }).file;
  const inventory = await scanImageRepositories({ repositories: [main, vae, lm, otherVae, otherLm].map(file => repository({ file, config: undefined })), signal: undefined });
  expect(inventory.issues).toEqual([]);
  const primary = inventory.candidates[0]!;
  for (const requirement of componentRequirements({ family: primary.family })) {
    const match = defaultCompanion({ main: primary, candidates: inventory.candidates, requirement });
    expect(match).toBe(inventory.candidates[requirement.slot === 'vae' ? 1 : 2]!.candidateKey);
    expect(componentMatch({ candidate: inventory.candidates[requirement.slot === 'vae' ? 3 : 4]!, requirement })).toBe('incompatible');
  }
});

it.each([
  { name: 'missing encoder', tensors: minimaxH3ImageVaeTensors.slice(0, 2) },
  { name: 'different output projection', tensors: minimaxH3ImageVaeTensors.map(tensor => tensor.name === 'decoder.proj_out.weight' ? { ...tensor, shape: [768, 1280] } : tensor) },
  { name: 'different decoder input', tensors: minimaxH3ImageVaeTensors.map(tensor => tensor.name === 'decoder.x_embedder.weight' ? { ...tensor, shape: [1024, 128] } : tensor) },
  { name: 'different encoder dimensions', tensors: minimaxH3ImageVaeTensors.map(tensor => tensor.name === 'encoder.conv_in.weight' ? { ...tensor, shape: [128, 3, 3, 3] } : tensor) },
  { name: 'Wan VAE', tensors: wanVaeTensors },
  { name: 'Qwen VAE', tensors: qwenVaeTensors },
])('does not substitute $name for the H3 Image VAE', async ({ tensors }) => {
  const candidate = await inspect({ tensors, architecture: undefined, config: undefined });
  expect(candidate.classes).not.toContain('vae-minimax-h3-image');
});

it.each([undefined, 'qwen3vl'])('recognizes the pruned 50-layer H3 encoder with architecture %s and without a final norm', async architecture => {
  const candidate = await inspect({ tensors: minimaxH3PrunedTextTensors, architecture, config: undefined });
  expect(candidate).toMatchObject({ family: 'unknown', roles: ['lm'], classes: ['lm-minimax-h3-pruned-50'], variant: 'unknown' });
  expect(candidate.evidence).toContain('Qwen3-VL structure: 50 text layers, hidden 5120; 27 vision layers and 3 DeepStack mergers; no final norm');
  if (architecture === undefined) {
    expect(candidate.evidence).toContain('Text architecture: unverified; width: 5120; layers: 50');
  }
});

it.each([
  { name: 'missing inner text layer', tensors: minimaxH3PrunedTextTensors.filter(tensor => !tensor.name.startsWith('model.layers.25.')) },
  { name: 'generic 64-layer model', tensors: [...minimaxH3PrunedTextTensors, ...Array.from({ length: 14 }, (_value, index) => tensor({ name: `model.layers.${50 + index}.self_attn.q_proj.weight`, shape: [8192, 5120] }))] },
  { name: 'missing inner vision layer', tensors: minimaxH3PrunedTextTensors.filter(tensor => !tensor.name.startsWith('visual.blocks.13.')) },
  { name: 'missing merger', tensors: minimaxH3PrunedTextTensors.filter(tensor => !tensor.name.startsWith('visual.deepstack_merger_list.2.')) },
  { name: 'missing vision tower', tensors: minimaxH3PrunedTextTensors.filter(tensor => !tensor.name.startsWith('visual.')) },
  { name: 'different patch embedding', tensors: minimaxH3PrunedTextTensors.map(tensor => tensor.name === 'visual.patch_embed.proj.weight' ? { ...tensor, shape: [1152, 3, 16, 16] } : tensor) },
  { name: 'different merger width', tensors: minimaxH3PrunedTextTensors.map(tensor => tensor.name === 'visual.deepstack_merger_list.1.linear_fc2.weight' ? { ...tensor, shape: [4096, 4608] } : tensor) },
  { name: 'different key projection', tensors: minimaxH3PrunedTextTensors.map(tensor => tensor.name === 'model.layers.0.self_attn.k_proj.weight' ? { ...tensor, shape: [1024, 4096] } : tensor) },
  { name: 'unexpected final norm', tensors: [...minimaxH3PrunedTextTensors, tensor({ name: 'model.norm.weight', shape: [5120] })] },
])('does not accept an H3 encoder with $name', async ({ tensors }) => {
  expect((await inspect({ tensors, architecture: undefined, config: undefined })).classes).toEqual(['other-lm']);
});

it.each([
  { architecture: 'qwen3', config: undefined },
  { architecture: undefined, config: JSON.stringify({ model_type: 'qwen3' }) },
  { architecture: undefined, config: JSON.stringify({ text_config: { model_type: 'qwen2_5_vl_text' } }) },
])('does not override conflicting architecture/config metadata with DeepStack evidence', async ({ architecture, config }) => {
  expect((await inspect({ tensors: minimaxH3PrunedTextTensors, architecture, config })).classes).toEqual(['other-lm']);
});

export const TEST_ONLY = {
};
