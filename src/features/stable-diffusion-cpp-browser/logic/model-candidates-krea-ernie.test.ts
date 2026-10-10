// @vitest-environment node
import { expect, it } from 'vitest';
import { scanImageRepositories, componentMatch, componentRequirements } from './model-candidates';
import { ggufFixture, krea2Tensors, krea2GgufTensors, ernieImageTensors, qwenTextTensors, ministralTextTensors } from '@/features/stable-diffusion-cpp-browser/test-utils/weights';
import type { TensorInfo } from './model-metadata';

async function candidate({ tensors, architecture }: { tensors: TensorInfo[], architecture: string | undefined }) {
  const file = ggufFixture({ name: 'renamed.gguf', tensors, metadata: architecture ? { 'general.architecture': architecture } : {}, extraBytes: 0 }).file;
  const inventory = await scanImageRepositories({ signal: undefined, repositories: [{ id: 'user/renamed', name: 'renamed', files: [{ path: file.name, file }] }] });
  expect(inventory.issues).toEqual([]); return inventory.candidates[0]!;
}

it.each(['txtfusion', 'text_fusion'])('recognizes Krea2 %s with matching image dimensions, never from the marker alone', async name => {
  const tensors = krea2Tensors.map(tensor => ({ ...tensor, name: tensor.name.replace('txtfusion', name) }));
  expect(await candidate({ tensors, architecture: undefined })).toMatchObject({ family: 'krea2', roles: ['diffusion'], variant: 'unknown' });
  expect((await candidate({ tensors: tensors.slice(0, 1), architecture: undefined })).family).toBe('unknown');
});

it('recognizes the flattened Krea2 GGUF projector only with architecture and image dimensions', async () => {
  expect(await candidate({ tensors: krea2GgufTensors, architecture: 'krea2' })).toMatchObject({ family: 'krea2', roles: ['diffusion'] });
  for (const architecture of [undefined, 'flux']) {
    expect((await candidate({ tensors: krea2GgufTensors, architecture })).family).toBe('unknown');
  }
  for (const tensors of [
    [], krea2GgufTensors.slice(0, 1), krea2GgufTensors.slice(1),
    krea2GgufTensors.map(tensor => tensor.name === 'first.weight' ? { ...tensor, shape: [3072, 64] } : tensor),
    krea2GgufTensors.map(tensor => tensor.name === 'txtfusion.projector.weight' ? { ...tensor, shape: [13] } : tensor),
  ]) {
    expect((await candidate({ tensors, architecture: 'krea2' })).family).toBe('unknown');
  }
});

it('recognizes ERNIE by its image, text and normalization structures together', async () => {
  expect(await candidate({ tensors: ernieImageTensors, architecture: undefined })).toMatchObject({ family: 'ernie-image', roles: ['diffusion'], variant: 'unknown' });
  const wrong = ernieImageTensors.map(tensor => tensor.name === 'text_proj.weight' ? { ...tensor, shape: [4096, 4096] } : tensor);
  expect((await candidate({ tensors: wrong, architecture: undefined })).family).toBe('unknown');
});

it('distinguishes Qwen3-VL 4B from same-width Qwen3 and from Qwen3-VL 8B', async () => {
  const requirement = componentRequirements({ family: 'krea2' }).find(item => item.slot === 'lm')!;
  const tensors = qwenTextTensors({ width: 2560, layers: 36 });
  expect(componentMatch({ candidate: await candidate({ tensors, architecture: 'qwen3vl' }), requirement })).toBe('matching');
  expect(componentMatch({ candidate: await candidate({ tensors, architecture: 'qwen3' }), requirement })).toBe('incompatible');
  expect(componentMatch({ candidate: await candidate({ tensors: qwenTextTensors({ width: 4096, layers: 36 }), architecture: 'qwen3vl' }), requirement })).toBe('incompatible');
});

it('requires Ministral architecture and size evidence and leaves a stripped unknown encoder unverified', async () => {
  const requirement = componentRequirements({ family: 'ernie-image' }).find(item => item.slot === 'lm')!;
  expect(componentMatch({ candidate: await candidate({ tensors: ministralTextTensors, architecture: 'mistral3' }), requirement })).toBe('matching');
  expect(componentMatch({ candidate: await candidate({ tensors: ministralTextTensors, architecture: 'llama' }), requirement })).toBe('incompatible');
  expect(componentMatch({ candidate: await candidate({ tensors: ministralTextTensors, architecture: undefined }), requirement })).toBe('unverified');
  const wrongLayers = ministralTextTensors.map(tensor => ({ ...tensor, name: tensor.name.replace('blk.25.', 'blk.31.') }));
  expect(componentMatch({ candidate: await candidate({ tensors: wrongLayers, architecture: 'mistral3' }), requirement })).toBe('incompatible');
});
