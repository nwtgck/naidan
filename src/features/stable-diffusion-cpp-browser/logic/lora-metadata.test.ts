// @vitest-environment node
import { expect, it } from 'vitest';
import { hasLoraTensors } from './lora-metadata';
import { scanImageRepositories } from './model-candidates';
import { ggufFixture, safetensorsFixture, tensor, zImageTensors } from '@/features/stable-diffusion-cpp-browser/test-utils/weights';

it.each([
  ['layer.lora_down.weight', 'layer.lora_up.weight'],
  ['layer.lora.down.weight', 'layer.lora.up.weight'],
  ['layer_lora.down.weight', 'layer_lora.up.weight'],
  ['layer.lora_A.weight', 'layer.lora_B.weight'],
  ['layer.lora_A.default.weight', 'layer.lora_B.default.weight'],
  ['layer.lora_A', 'layer.lora_B'],
  ['lora.layer.weight.lora_down', 'lora.layer.weight.lora_up'],
  ['layer.hada_w1_a', 'layer.hada_w1_b', 'layer.hada_w2_a', 'layer.hada_w2_b'],
  ['layer.lokr_w1', 'layer.lokr_w2'],
  ['layer.lokr_w1_a', 'layer.lokr_w1_b', 'layer.lokr_w2_a', 'layer.lokr_w2_b'],
  ['layer.lokr_w1', 'layer.lokr_w2_a', 'layer.lokr_w2_b'],
  ['layer.diff'], ['layer.diff_b'],
])('identifies native adapter tensor groups %j without inferring a compatible base', (...names) => {
  expect(hasLoraTensors({ tensors: names.map(name => tensor({ name, shape: [4, 8] })) })).toBe(true);
});

it.each([
  ['layer.lora_down.weight'], ['a.lora_A.weight', 'b.lora_B.weight'],
  ['layer.hada_w1_a', 'layer.hada_w1_b'], ['layer.lokr_w1_a', 'layer.lokr_w2_b'],
  ['layer.alpha'], ['a_lora_model.weight'], ['layer.different'],
  ['layer.lora_A.default', 'layer.lora_B.default'],
  ['layer.lora_down', 'layer.lora_up'],
])('leaves orphan factors and ordinary weights unclassified %j', (...names) => {
  expect(hasLoraTensors({ tensors: names.map(name => tensor({ name, shape: [4, 8] })) })).toBe(false);
});

it('recognizes raw deltas for one-dimensional native weights', () => {
  expect(hasLoraTensors({ tensors: [tensor({ name: 'layer.diff', shape: [8] })] })).toBe(true);
});

it('recognizes saved GGUF and safetensors adapters without a filename or publication hint', async () => {
  const tensors = ['layer.lora_A.weight', 'layer.lora_B.weight'].map(name => tensor({ name, shape: [4, 8] }));
  const files = [ggufFixture({ name: 'opaque.gguf', tensors, metadata: {}, extraBytes: 0 }).file,
    safetensorsFixture({ name: 'opaque.safetensors', tensors }).file,
    safetensorsFixture({ name: 'named-lora.safetensors', tensors: zImageTensors }).file];
  const inventory = await scanImageRepositories({ repositories: [{ id: 'user/adapters', name: 'adapters', files: files.map(file => ({ path: file.name, file })) }], signal: undefined });
  expect(inventory.candidates.filter(candidate => candidate.classes.includes('lora')).map(candidate => candidate.path)).toEqual(['opaque.gguf', 'opaque.safetensors']);
  expect(inventory.candidates.filter(candidate => candidate.classes.includes('lora')).every(candidate => candidate.family === 'unknown' && candidate.roles.length === 0)).toBe(true);
  expect(inventory.candidates.find(candidate => candidate.path === 'named-lora.safetensors')?.family).toBe('z-image');
});
