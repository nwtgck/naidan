import { expect, it } from 'vitest';
import { createImageForm } from './form';
import { imageSelectionParameters } from './selection-parameters';
import { applyImageRecommendedField, imageRecommendedHint, remoteImageRecommendation } from './recommended-fields';
import { recommendationForSelection } from '@/features/stable-diffusion-cpp-browser/recommendations';

it('exposes only transferable parameters remotely without rewriting native-only settings', () => {
  const parameters = createImageForm({ profile: 'webgpu-wasm32-asyncify' }).parameters.value;
  parameters.modelArguments = 'custom=true';
  const recommendation = remoteImageRecommendation({ recommendation: recommendationForSelection({ model: { family: 'qwen-image-2.1', variant: 'base', evidence: [] } }) })!;
  expect(imageRecommendedHint({ recommendation, field: 'guidance' })?.value).toBe(6);
  expect(imageRecommendedHint({ recommendation, field: 'modelArguments' })).toBeUndefined();
  expect(imageRecommendedHint({ recommendation, field: 'vaeTiling' })).toBeUndefined();
  expect(applyImageRecommendedField({ parameters, recommendation, field: 'modelArguments' })).toBe(parameters);
});

it('preserves incomplete Qwen Turbo preset restrictions remotely', () => {
  const recommendation = remoteImageRecommendation({ recommendation: recommendationForSelection({ model: { family: 'qwen-image-2.1', variant: 'turbo', evidence: [] } }) })!;
  const parameters = createImageForm({ profile: 'webgpu-wasm32-asyncify' }).parameters.value;
  parameters.steps = 33;
  expect(recommendation.recommendedFieldsOnly).toBe(true);
  expect(imageRecommendedHint({ recommendation, field: 'guidance' })?.value).toBe(1);
  expect(imageRecommendedHint({ recommendation, field: 'width' })?.value).toBe(1024);
  expect(imageRecommendedHint({ recommendation, field: 'steps' })).toBeUndefined();
  expect(imageRecommendedHint({ recommendation, field: 'scheduler' })).toBeUndefined();
  expect(applyImageRecommendedField({ parameters, recommendation, field: 'steps' }).steps).toBe(33);
});

it('shares selection-time values while applying native arguments only locally', () => {
  const parameters = createImageForm({ profile: 'webgpu-wasm32-asyncify' }).parameters.value;
  parameters.modelArguments = '';
  const local = imageSelectionParameters({ parameters, family: 'qwen-image-2.1', turbo: false, location: 'local' });
  const remote = imageSelectionParameters({ parameters, family: 'qwen-image-2.1', turbo: false, location: 'naidan_rpc' });
  expect(local.guidance).toBe(remote.guidance);
  expect(local.modelArguments).toBe('qwen_image_2_1_prefix_cache=false');
  expect(remote.modelArguments).toBe('');
  expect(imageSelectionParameters({ parameters, family: 'z-image', turbo: true, location: 'naidan_rpc' })).toMatchObject({ steps: 8, guidance: 1 });
  expect(imageSelectionParameters({ parameters, family: 'unknown', turbo: false, location: 'naidan_rpc' })).toBe(parameters);
});

export const TEST_ONLY = {
};
