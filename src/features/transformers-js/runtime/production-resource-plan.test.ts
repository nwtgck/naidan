import { expect, it } from 'vitest';
import { productionCandidateResourcePlanSchema, runtimeArtifactPreparationResultSchema } from './production-resource-plan';

it('rejects a ready plan that does not establish any resource path', () => {
  expect(productionCandidateResourcePlanSchema.safeParse({ status: 'ready', paths: [] }).success).toBe(false);
});

it('rejects a planning failure carrying a second successful path authority', () => {
  expect(productionCandidateResourcePlanSchema.safeParse({
    status: 'planning-failed', paths: ['onnx/model_q4.onnx'],
    error: { name: 'ProductionResourceCandidateError', message: 'Invalid selected declaration' },
  }).success).toBe(false);
});

it('does not reinterpret a global failure as candidate-specific unavailability', () => {
  expect(productionCandidateResourcePlanSchema.safeParse({
    status: 'planning-failed', error: { name: 'UnsupportedRuntimeVersion', message: 'Unreviewed runtime' },
  }).success).toBe(false);
});

it('validates every returned candidate entry at the Worker result boundary', () => {
  expect(runtimeArtifactPreparationResultSchema.safeParse({
    processor: 'tokenizer', modelType: 'llama',
    resourcePlansByCandidate: {
      'webgpu/q4f16': { status: 'ready', paths: ['onnx/model_q4f16.onnx'] },
      'webgpu/q4': { status: 'planning-failed' },
    },
  }).success).toBe(false);
});
