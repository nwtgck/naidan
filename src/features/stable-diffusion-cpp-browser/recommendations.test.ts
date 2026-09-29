// @vitest-environment node
import { expect, it } from 'vitest';
import { recommendationForSelection, TEST_ONLY } from './recommendations';
import { parametersSchema, previewSettingsSchema, defaultPreviewSettings } from './types';
import { parametersFixture } from './test-fixtures';
import { scanImageRepositories } from './logic/model-candidates';
import { imageModelRecipes } from './model-recipes';
import { ggufFixture, zImageTensors, qwenImageTensors } from './test-utils/weights';
it.each(['z-image-turbo', 'z-image-base', 'qwen-image-2.1'] as const)('validates every field in the static %s starting point without replacing prompt or seed', id => {
  const preset = TEST_ONLY.presets[id], original = { ...parametersFixture(), prompt: 'private', negativePrompt: 'custom', seed: '123' };
  const settings = parametersSchema.parse({ ...original, ...preset.parameters });
  expect(settings).toMatchObject({ prompt: 'private', negativePrompt: 'custom', seed: '123' });
  expect(previewSettingsSchema.parse({ ...defaultPreviewSettings, enabled: false, ...preset.preview }).enabled).toBe(false);
  expect(preset.sources.every(source => /^https:\/\/(github.com|huggingface.co)\//.test(source.url))).toBe(true);
});
it('does not infer Turbo from a filename or from missing variant evidence', async () => {
  const file = ggufFixture({ name: 'Z-Image-Turbo.gguf', tensors: zImageTensors, metadata: {}, extraBytes: 0 }).file;
  const result = await scanImageRepositories({ repositories: [{ id: 'user/Z-Image-Turbo', name: 'Turbo', files: [{ path: file.name, file }] }], signal: undefined });
  expect(result.candidates[0]).toMatchObject({ family: 'z-image', variant: 'unknown', turboHint: false });
  expect(recommendationForSelection({ model: result.candidates[0] })).toBeUndefined();
});
it.each(['Turbo', 'Base'])('uses %s metadata even for renamed files', async variant => {
  const file = ggufFixture({ name: 'nothing.data', tensors: zImageTensors, metadata: { 'general.finetune': variant }, extraBytes: 0 }).file;
  const result = await scanImageRepositories({ repositories: [{ id: 'user/x', name: 'x', files: [{ path: file.name, file }] }], signal: undefined });
  expect(recommendationForSelection({ model: result.candidates[0] })?.id).toBe(variant === 'Turbo' ? 'z-image-turbo' : 'z-image-base');
});
it('identifies Qwen from tensor structure independently of the filename', async () => {
  const file = ggufFixture({ name: 'renamed.data', tensors: qwenImageTensors, metadata: {}, extraBytes: 0 }).file;
  const result = await scanImageRepositories({ repositories: [{ id: 'user/x', name: 'x', files: [{ path: file.name, file }] }], signal: undefined });
  expect(recommendationForSelection({ model: result.candidates[0] })?.parameters).toMatchObject({ guidance: 6, sampler: 'euler' });
});

it('uses a reviewed receipt plus tensor evidence for metadata-stripped catalog Turbo weights', async () => {
  const option = imageModelRecipes[0]!.components.find(item => item.role === 'diffusion')!.options[0]!;
  const file = ggufFixture({ name: 'renamed.gguf', tensors: zImageTensors, metadata: {}, extraBytes: 0 }).file;
  const receipt = { version: 1 as const, kind: 'naidan-model-file' as const, size: file.size, lastModified: file.lastModified,
    source: { kind: 'hugging-face' as const, repository: option.repository, revision: option.revision, path: option.path, sha256: '0'.repeat(64) } };
  const scan = (revision: string) => scanImageRepositories({ signal: undefined, repositories: [{ id: 'user/x', name: 'x', files: [
    { path: file.name, file, receipt: { ...receipt, source: { ...receipt.source, revision } } },
  ] }] });
  const known = await scan(option.revision);
  expect(recommendationForSelection({ model: known.candidates[0] })?.parameters.steps).toBe(8);
  const unreviewed = await scan('f'.repeat(40));
  expect(recommendationForSelection({ model: unreviewed.candidates[0] })).toBeUndefined();
});
