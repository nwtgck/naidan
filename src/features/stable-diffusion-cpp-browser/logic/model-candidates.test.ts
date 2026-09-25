// @vitest-environment node
import { expect, it } from 'vitest';
import { scanImageRepositories, componentRequirements, defaultCompanion, componentMatch } from './model-candidates';
import { ggufFixture, safetensorsFixture, zImageTensors, qwenImageTensors, fluxVaeTensors, qwenVaeTensors, qwenTextTensors, tensor } from '@/features/stable-diffusion-cpp-browser/test-utils/weights';
import type { LocalImageRepository } from './repository-store';
function repository({ id, file }: { id: string, file: File }): LocalImageRepository {
  return { id, name: id, files: [{ path: file.name, file }] };
}

it('recognizes Z-Image by tensors, and resolves VAE and Qwen3 across repositories', async () => {
  const main = ggufFixture({ name: 'opaque.gguf', tensors: zImageTensors, metadata: {}, extraBytes: 0 }).file;
  const vae = safetensorsFixture({ name: 'not-named-vae.bin', tensors: fluxVaeTensors }).file;
  const lm = ggufFixture({ name: 'text.gguf', tensors: qwenTextTensors({ width: 2560, layers: 36 }), metadata: { 'general.architecture': 'qwen3' }, extraBytes: 0 }).file;
  const result = await scanImageRepositories({ repositories: [repository({ id: 'user/A', file: main }), repository({ id: 'user/B', file: vae }), repository({ id: 'user/C', file: lm })], signal: undefined });
  const model = result.candidates.find(candidate => candidate.family === 'z-image')!;
  expect(model.repositoryId).toBe('user/A');
  for (const requirement of componentRequirements({ family: model.family })) {
    const candidate = result.candidates.find(entry => entry.id === defaultCompanion({ main: model, candidates: result.candidates, requirement }))!;
    expect(candidate.repositoryId).not.toBe(model.repositoryId);
    expect(componentMatch({ candidate, requirement })).toBe('matching');
  }
});
it('does not classify a Gemma, wrong-size Qwen, or named impostor as a compatible text encoder', async () => {
  const files = ['gemma', 'qwen2.5vl', 'qwen3'].map(architecture => ggufFixture({ name: 'Qwen3-4B-instruct.gguf', tensors: qwenTextTensors({ width: architecture === 'qwen3' ? 2048 : 2560, layers: 36 }), metadata: { 'general.architecture': architecture }, extraBytes: 0 }).file);
  const result = await scanImageRepositories({ repositories: files.map((file, i) => repository({ id: `user/${i}`, file })), signal: undefined });
  expect(result.candidates).toHaveLength(3);
  expect(result.candidates.every(candidate => componentMatch({ candidate, requirement: { slot: 'lm', accepts: ['lm-qwen3-4b'] } }) === 'incompatible')).toBe(true);
});
it('requires the Qwen Image 2.1 VAE and VL encoder structures, not the old Qwen or Flux names', async () => {
  const files = [
    ggufFixture({ name: 'main.gguf', tensors: qwenImageTensors, metadata: {}, extraBytes: 0 }).file,
    safetensorsFixture({ name: 'decoder.bin', tensors: qwenVaeTensors }).file,
    safetensorsFixture({ name: 'qwen_image_2.1_vae.safetensors', tensors: fluxVaeTensors }).file,
    ggufFixture({ name: 'lm.gguf', tensors: qwenTextTensors({ width: 4096, layers: 32 }), metadata: { 'general.architecture': 'qwen3vl' }, extraBytes: 0 }).file,
  ];
  const result = await scanImageRepositories({ repositories: files.map((file, i) => repository({ id: `user/${i}`, file })), signal: undefined });
  const main = result.candidates[0]!; expect(main.family).toBe('qwen-image-2.1');
  const required = componentRequirements({ family: main.family });
  expect(defaultCompanion({ main, candidates: result.candidates, requirement: required[0]! })).toBe(result.candidates[1]!.id);
  expect(defaultCompanion({ main, candidates: result.candidates, requirement: required[1]! })).toBe(result.candidates[3]!.id);
});
it('groups complete GGUF shards without merging file bytes, and blocks missing shards', async () => {
  const files = zImageTensors.slice(0, 2).map((t, i) => ({ path: `model-0000${i + 1}-of-00002.gguf`, file: ggufFixture({ name: `model-0000${i + 1}-of-00002.gguf`, tensors: [t], metadata: { 'split.no': i, 'split.count': 2, 'split.tensors.count': 2 }, extraBytes: 0 }).file }));
  const repo = { id: 'user/group', name: 'group', files };
  const complete = await scanImageRepositories({ repositories: [repo], signal: undefined });
  expect(complete.candidates).toHaveLength(1); expect(complete.candidates[0]!.issue).toBeUndefined(); expect(complete.candidates[0]!.files).toHaveLength(2);
  const partial = await scanImageRepositories({ repositories: [{ ...repo, files: files.slice(0, 1) }], signal: undefined });
  expect(partial.candidates[0]!.issue).toBeDefined();
});
it('resolves safetensors index siblings, retaining relative paths and rejecting traversal', async () => {
  const shard = safetensorsFixture({ name: 'part.safetensors', tensors: [tensor({ name: 'x', shape: [1] })] }).file;
  const index = new File([JSON.stringify({ weight_map: { x: 'part.safetensors' } })], 'model.safetensors.index.json');
  const repo = { id: 'user/index', name: 'index', files: [{ path: 'encoder/part.safetensors', file: shard }, { path: 'encoder/model.safetensors.index.json', file: index }] };
  const result = await scanImageRepositories({ repositories: [repo], signal: undefined });
  expect(result.candidates).toHaveLength(1); expect(result.candidates[0]!.files.map(file => file.path)).toEqual(['encoder/model.safetensors.index.json', 'encoder/part.safetensors']);
  expect(result.candidates[0]!.issue).toBeUndefined();
  repo.files[1]!.file = new File(['{"weight_map":{"x":"../part.safetensors"}}'], index.name);
  const bad = await scanImageRepositories({ repositories: [repo], signal: undefined });
  expect(bad.candidates.find(candidate => candidate.format === 'safetensors-index')?.issue).toContain('unsafe');
});
it('does not infer a model family or compatibility from filenames alone', async () => {
  const file = ggufFixture({ name: 'z_image_turbo-Q4_K.gguf', tensors: [tensor({ name: 'opaque.weight', shape: [4] })], metadata: { 'general.name': 'Qwen Image 2.1' }, extraBytes: 0 }).file;
  const result = await scanImageRepositories({ repositories: [repository({ id: 'user/Qwen-Image', file })], signal: undefined });
  expect(result.candidates[0]!.family).toBe('unknown'); expect(result.candidates[0]!.classes).toEqual([]);
});

it('leaves a dimension-matching encoder without family evidence unverified rather than claiming incompatibility', async () => {
  const file = ggufFixture({ name: 'unknown.gguf', tensors: qwenTextTensors({ width: 4096, layers: 32 }), metadata: {}, extraBytes: 0 }).file;
  const result = await scanImageRepositories({ repositories: [repository({ id: 'user/unknown', file })], signal: undefined });
  const candidate = result.candidates[0]!;
  expect(componentMatch({ candidate, requirement: { slot: 'lm', accepts: ['lm-qwen3vl-8b'] } })).toBe('unverified');
  expect(defaultCompanion({ main: { ...candidate, id: 'other' }, candidates: [candidate], requirement: { slot: 'lm', accepts: ['lm-qwen3vl-8b'] } })).toBeUndefined();
});
