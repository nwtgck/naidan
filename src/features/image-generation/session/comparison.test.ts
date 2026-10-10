import { expect, it } from 'vitest';
import { toImageGenerationSessionId } from '@/01-models/ids';
import { generationAssetFixture, generationRunFixture } from '@/00-storage/service/image-generation/test-support';
import { compareImageGenerationImages } from './comparison';

it('compares each actual output seed rather than a shared base seed', () => {
  const run = generationRunFixture({ id: 'run-aa', sessionId: toImageGenerationSessionId({ raw: 'session-aa' }), count: 2, seed: '9007199254740993' });
  const left = { run, asset: generationAssetFixture({ id: 'left-aa', run, index: 0 }) }, right = { run, asset: generationAssetFixture({ id: 'right-aa', run, index: 1 }) };
  const diff = compareImageGenerationImages({ left, right }).filter(value => !value.same);
  expect(diff).toEqual([{ key: 'seed', left: '"9007199254740993"', right: '"9007199254740994"', same: false }]);
  expect(run.request.parameters.seed).toBe('9007199254740993');
});

it('includes model file identity, adapters, input files and runtime rather than a misleading parameter-only equality', () => {
  const run = generationRunFixture({ id: 'run-aa', sessionId: toImageGenerationSessionId({ raw: 'session-aa' }), count: 1, seed: '42' });
  const left = { run, asset: generationAssetFixture({ id: 'asset-aa', run, index: 0 }) };
  const right = structuredClone(left); right.run.request.models[0]!.file.size++;
  right.run.request.loras[0]!.strength = 1; right.run.request.imageInputs.referenceImages = [];
  right.run.request.runtime.profile = 'webgpu-wasm32-jspi';
  expect(compareImageGenerationImages({ left, right }).filter(value => !value.same).map(value => value.key)).toEqual(['models', 'loras', 'inputs', 'runtime']);
});
