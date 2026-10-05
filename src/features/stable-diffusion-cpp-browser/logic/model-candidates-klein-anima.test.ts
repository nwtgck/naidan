// @vitest-environment node
import { expect, it } from 'vitest';
import { scanImageRepositories, componentRequirements, componentMatch, defaultCompanion } from './model-candidates';
import { ggufFixture, safetensorsFixture, flux2KleinTensors, animaTensors, flux2VaeTensors, wanVaeTensors, fluxVaeTensors, qwenVaeTensors, qwenTextTensors, tensor } from '@/features/stable-diffusion-cpp-browser/test-utils/weights';

it.each([
  { family: 'flux2-klein-4b' as const, tensors: flux2KleinTensors, vae: flux2VaeTensors, width: 2560, layers: 36 },
  { family: 'anima' as const, tensors: animaTensors, vae: wanVaeTensors, width: 1024, layers: 28 },
])('recognizes $family without filenames and selects only its structural companions', async ({ family, tensors, vae, width, layers }) => {
  const files = [
    ggufFixture({ name: 'opaque.gguf', tensors, metadata: {}, extraBytes: 0 }).file,
    safetensorsFixture({ name: 'opaque-decoder', tensors: vae }).file,
    ggufFixture({ name: 'opaque-text', tensors: qwenTextTensors({ width, layers }), metadata: { 'general.architecture': 'qwen3' }, extraBytes: 0 }).file,
    safetensorsFixture({ name: 'flux-vae.safetensors', tensors: fluxVaeTensors }).file,
    safetensorsFixture({ name: 'qwen-2.1-vae.safetensors', tensors: qwenVaeTensors }).file,
    ggufFixture({ name: 'wrong-text.gguf', tensors: qwenTextTensors({ width: width === 1024 ? 2560 : 1024, layers: layers === 28 ? 36 : 28 }), metadata: { 'general.architecture': 'qwen3' }, extraBytes: 0 }).file,
  ];
  const inventory = await scanImageRepositories({ repositories: files.map((file, index) => ({ id: `user/${index}`, name: 'renamed', files: [{ path: file.name, file }] })), signal: undefined });
  expect(inventory.issues).toEqual([]);
  const main = inventory.candidates[0]!;
  expect(main).toMatchObject({ family, roles: ['diffusion'], variant: 'unknown' });
  const requirements = componentRequirements({ family });
  expect(requirements.map(item => item.slot)).toEqual(['vae', 'lm']);
  for (const [index, requirement] of requirements.entries()) {
    expect(defaultCompanion({ main, candidates: inventory.candidates, requirement })).toBe(inventory.candidates[index + 1]!.id);
    for (const wrong of inventory.candidates.slice(3)) expect(componentMatch({ candidate: wrong, requirement })).toBe('incompatible');
  }
});

it('does not classify Klein 9B or FLUX.2-dev widths as either Klein 4B or FLUX.1', async () => {
  for (const width of [4096, 6144]) {
    const tensors = flux2KleinTensors.map(value => value.name === 'txt_in.weight' ? { ...value, shape: [width, 12288] } : value);
    tensors.push(tensor({ name: 'double_blocks.0.img_attn.qkv.weight', shape: [12, 4] }), tensor({ name: 'single_blocks.0.linear1.weight', shape: [12, 4] }));
    const file = ggufFixture({ name: 'flux-klein-4b.gguf', tensors, metadata: { 'general.name': 'FLUX.2 klein' }, extraBytes: 0 }).file;
    const inventory = await scanImageRepositories({ repositories: [{ id: 'user/klein', name: 'klein', files: [{ path: file.name, file }] }], signal: undefined });
    expect(inventory.candidates[0]!.family).toBe('unknown');
  }
});

it('requires Anima image and adapter structure together, not an adapter-like name alone', async () => {
  const file = safetensorsFixture({ name: 'anima.safetensors', tensors: animaTensors.slice(0, 1) }).file;
  const inventory = await scanImageRepositories({ repositories: [{ id: 'user/anima', name: 'anima', files: [{ path: file.name, file }] }], signal: undefined });
  expect(inventory.candidates[0]!.family).toBe('unknown');
});

it('does not call a different architecture or a 36-layer Qwen a Qwen3 0.6B companion', async () => {
  for (const descriptor of [{ architecture: 'gemma', layers: 28 }, { architecture: 'qwen3', layers: 36 }]) {
    const file = ggufFixture({ name: 'qwen_3_06b_base.gguf', tensors: qwenTextTensors({ width: 1024, layers: descriptor.layers }), metadata: { 'general.architecture': descriptor.architecture }, extraBytes: 0 }).file;
    const inventory = await scanImageRepositories({ repositories: [{ id: 'user/text', name: 'text', files: [{ path: file.name, file }] }], signal: undefined });
    expect(componentMatch({ candidate: inventory.candidates[0]!, requirement: { slot: 'lm', accepts: ['lm-qwen3-06b'] } })).toBe('incompatible');
  }
});
