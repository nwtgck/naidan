// @vitest-environment node
import { expect, it } from 'vitest';
import { recommendationForSelection, TEST_ONLY } from './recommendations';
import { parametersSchema, previewSettingsSchema, defaultPreviewSettings } from './types';
import { parametersFixture } from './test-fixtures';
import { scanImageRepositories } from './logic/model-candidates';
import { imageModelRecipes } from './model-recipes';
import { ggufFixture, zImageTensors, qwenImageTensors, flux2KleinTensors, animaTensors, krea2Tensors, ernieImageTensors } from './test-utils/weights';
it.each(['z-image-turbo', 'z-image-base', 'qwen-image-2.1', 'flux2-klein-4b', 'anima-turbo-1.1', 'krea2-turbo', 'ernie-image-turbo'] as const)('validates every field in the static %s starting point without replacing prompt or seed', id => {
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

it.each([{ id: 'z-image-turbo', steps: 8 }, { id: 'z-image-base', steps: 50 }, { id: 'flux2-klein-4b', steps: 4 }, { id: 'anima-turbo-1.1', steps: 10 }])('uses a reviewed receipt plus tensor evidence for metadata-stripped $id weights', async ({ id, steps }) => {
  const option = imageModelRecipes.find(recipe => recipe.id === id)!.components.find(item => item.role === 'diffusion')!.options[0]!;
  const file = ggufFixture({ name: 'renamed.gguf', tensors: id === 'flux2-klein-4b' ? flux2KleinTensors : id === 'anima-turbo-1.1' ? animaTensors : zImageTensors, metadata: {}, extraBytes: 0 }).file;
  const receipt = {
    version: 1 as const,
    kind: 'naidan-model-file' as const,
    size: file.size,
    lastModified: file.lastModified,
    source: { kind: 'hugging-face' as const, repository: option.repository, revision: option.revision, path: option.path, sha256: '0'.repeat(64) },
  };
  const scan = (revision: string) => scanImageRepositories({
    signal: undefined,
    repositories: [{
    id: 'user/x',
    name: 'x',
    files: [
    { path: file.name, file, receipt: { ...receipt, source: { ...receipt.source, revision } } },
  ],
  }],
  });
  const known = await scan(option.revision);
  expect(recommendationForSelection({ model: known.candidates[0] })?.parameters.steps).toBe(steps);
  const unreviewed = await scan('f'.repeat(40));
  expect(recommendationForSelection({ model: unreviewed.candidates[0] })).toBeUndefined();
});

it('leaves a Klein Base or renamed manual Klein file without a guessed distilled preset', async () => {
  for (const name of ['flux-2-klein-base-4b.gguf', 'flux-2-klein-4b-distilled.gguf']) {
    const file = ggufFixture({ name, tensors: flux2KleinTensors, metadata: { 'general.name': name }, extraBytes: 0 }).file;
    const result = await scanImageRepositories({ repositories: [{ id: 'user/klein', name: 'klein', files: [{ path: name, file }] }], signal: undefined });
    expect(result.candidates[0]).toMatchObject({ family: 'flux2-klein-4b', variant: 'unknown' });
    expect(recommendationForSelection({ model: result.candidates[0] })).toBeUndefined();
  }
});

it('does not infer Anima Turbo from a filename or family structure', async () => {
  const file = ggufFixture({ name: 'anima-turbo-v1.1.gguf', tensors: animaTensors, metadata: {}, extraBytes: 0 }).file;
  const result = await scanImageRepositories({ repositories: [{ id: 'user/anima', name: 'anima', files: [{ path: file.name, file }] }], signal: undefined });
  expect(result.candidates[0]?.variant).toBe('unknown');
  expect(recommendationForSelection({ model: result.candidates[0] })).toBeUndefined();
});

it.each([
  { id: 'krea2-turbo', tensors: krea2Tensors },
  { id: 'ernie-image-turbo', tensors: ernieImageTensors },
])('requires the reviewed release receipt before using eight-step $id settings', async ({ id, tensors }) => {
  const entry = imageModelRecipes.find(recipe => recipe.id === id)!.files[0]!;
  const file = ggufFixture({ name: `${id}.gguf`, tensors, metadata: { 'general.name': id }, extraBytes: 0 }).file;
  const source = { kind: 'hugging-face' as const, repository: entry.repository, revision: entry.revision, path: entry.path, sha256: '0'.repeat(64) };
  const receipt = { version: 1 as const, kind: 'naidan-model-file' as const, size: file.size, lastModified: file.lastModified, source };
  for (const proof of [undefined, receipt, { ...receipt, source: { ...source, revision: '0'.repeat(40) } }]) {
    const result = await scanImageRepositories({ repositories: [{ id: 'user/renamed', name: 'renamed', files: [{ path: file.name, file, ...(proof ? { receipt: proof } : {}) }] }], signal: undefined });
    const preset = recommendationForSelection({ model: result.candidates[0] });
    if (proof === receipt) expect(preset).toMatchObject({ id, parameters: { steps: 8, guidance: 1 } });
    else expect(preset).toBeUndefined();
  }
});
