// @vitest-environment node
import { expect, it } from 'vitest';
import { shallowRef } from 'vue';
import { createImageForm } from './form';
import { imageModelParameterDefaults } from './model-parameter-defaults';
import type { ImageModelFacts } from '@/features/stable-diffusion-cpp-browser/recommendations';

it.each([
  ['z-image', 'turbo', 8, 1],
  ['z-image', 'base', 50, 5],
  ['flux2-klein-4b', 'distilled', 4, 1],
  ['anima', 'turbo', 10, 1],
  ['krea2', 'turbo', 8, 1],
  ['ernie-image', 'turbo', 8, 1],
  ['minimax-h3-image', 'unknown', 6, 1],
] as const)('uses reviewed %s %s numeric defaults', (family, variant, steps, guidance) => {
  expect(imageModelParameterDefaults({ model: { family, variant, evidence: [] } })).toEqual({
    steps: { value: steps, origin: 'recommended' },
    guidance: { value: guidance, origin: 'recommended' },
  });
});

it.each(['base', 'turbo'] as const)('labels Qwen %s steps as a browser standard while applying only its reviewed CFG', variant => {
  expect(imageModelParameterDefaults({ model: { family: 'qwen-image-2.1', variant, evidence: [] } })).toEqual({
    steps: { value: 20, origin: 'standard' },
    guidance: { value: variant === 'base' ? 6 : 1, origin: 'recommended' },
  });
});

it.each(['z-image', 'qwen-image-2.1', 'flux2-klein-4b', 'anima', 'krea2', 'ernie-image', 'sd-checkpoint', 'flux1', 'unknown'] as const)('keeps browser standards for unverified %s variants', family => {
  expect(imageModelParameterDefaults({ model: { family, variant: 'unknown', evidence: [] } })).toEqual({
    steps: { value: 20, origin: 'standard' },
    guidance: { value: 7, origin: 'standard' },
  });
});

it('follows model changes only for automatic values and preserves every other form setting', () => {
  const modelFacts = shallowRef<ImageModelFacts>({ family: 'minimax-h3-image', variant: 'unknown', evidence: [] });
  const form = createImageForm({ profile: 'webgpu-wasm32-asyncify', modelFacts });
  const parameters = { ...form.parameters.value };
  expect([form.resolvedSteps.value, form.resolvedGuidance.value]).toEqual([6, 1]);
  expect(form.resolvedVaeTileSize.value).toBe(16);
  modelFacts.value = { family: 'z-image', variant: 'base', evidence: [] };
  expect([form.resolvedSteps.value, form.resolvedGuidance.value]).toEqual([50, 5]);
  expect(form.resolvedVaeTileSize.value).toBe(32);
  form.stepsPreference.value = 20;
  form.guidancePreference.value = 7;
  modelFacts.value = { family: 'z-image', variant: 'turbo', evidence: [] };
  expect([form.resolvedSteps.value, form.resolvedGuidance.value]).toEqual([20, 7]);
  expect(form.parameters.value).toEqual(parameters);
  form.stepsPreference.value = 'auto';
  expect([form.resolvedSteps.value, form.resolvedGuidance.value]).toEqual([8, 7]);
});

export const TEST_ONLY = {
};
