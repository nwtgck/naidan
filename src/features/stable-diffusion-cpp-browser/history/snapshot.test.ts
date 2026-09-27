// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { requestFixture, ggufFile } from '@/features/stable-diffusion-cpp-browser/test-fixtures';
import { snapshotImageGeneration, finishImageGenerationSnapshot } from './snapshot';
import { prepareImageHistoryReuse } from './reuse';
import { imageGenerationDownloadBlob } from './download';
import type { ImageGenerationModelFile } from '@/01-models/image-generation-history';

function locateFile({ file }: { file: File }): ImageGenerationModelFile {
  return { type: 'opfs', name: file.name, path: `models/user/example/${file.name}`, size: file.size, lastModified: file.lastModified };
}
function source() {
  const request = requestFixture();
  request.parameters = { ...request.parameters, prompt: '癒しの猫', seed: '-1' };
  request.imageInputs = { initImage: new File(['init'], 'init.png', { type: 'image/png' }), strength: 0.5,
    referenceImages: [new File(['first'], 'first.png', { type: 'image/png' }), new File(['second'], 'second.png', { type: 'image/png' })] };
  request.loras = [{ file: ggufFile(), path: 'disabled.gguf', strength: 0 }, { file: ggufFile(), path: 'enabled.gguf', strength: 0.8 }];
  return request;
}
function completed() {
  const request = source();
  const snapshot = snapshotImageGeneration({ request, sourceCommit: 'a'.repeat(40), locateFile, createdAt: 1 });
  const saved = finishImageGenerationSnapshot({ snapshot, result: { png: new Blob(['final'], { type: 'image/png' }), width: 256, height: 256, modelVersion: 'fixture', uniformOutput: false },
    previews: [{ type: 'naidan-image-preview-v1', runId: 1, revision: 2, step: 4, steps: 20, width: 128, height: 128, mode: 'projection', png: new Blob(['preview'], { type: 'image/png' }) }], elapsedMs: 500 });
  return { request, snapshot, ...saved };
}

describe('image history request snapshots', () => {
  it('freezes settings, ordered inputs and requested adapter strengths before generation', () => {
    const request = source();
    const snapshot = snapshotImageGeneration({ request, sourceCommit: 'a'.repeat(40), locateFile, createdAt: 1 });
    request.parameters.prompt = 'changed'; request.parameters.seed = '99';
    request.imageInputs.referenceImages.reverse(); request.imageInputs.strength = 1;
    request.loras[0]!.strength = 5; request.preview.mode = 'projection';
    expect(snapshot.request.parameters).toMatchObject({ prompt: '癒しの猫', seed: '-1' });
    expect(snapshot.request.imageInputs.referenceImages.map(image => image.name)).toEqual(['first.png', 'second.png']);
    expect(snapshot.request.imageInputs.strength).toBe(0.5);
    expect(snapshot.request.loras.map(lora => lora.strength)).toEqual([0, 0.8]);
    expect(snapshot.request.preview.mode).toBe('vae');
    expect(snapshot.inputFiles.map(file => file.name)).toEqual(['init.png', 'first.png', 'second.png']);
  });
  it('links final, captured preview and input bytes without copying model weights', () => {
    const { record, files, snapshot } = completed();
    expect(record.request).toEqual(snapshot.request);
    expect(record.previews[0]).toMatchObject({ step: 4, steps: 20, width: 128, height: 128, mode: 'projection' });
    expect(files.map(file => file.name)).toEqual(['init.png', 'first.png', 'second.png', 'generated-image.png', 'preview-step-4.png']);
    expect(new Set(files.map(file => file.binaryObjectId)).size).toBe(5);
    expect(files.find(file => file.binaryObjectId === record.result.binaryObjectId)?.blob.size).toBe(5);
  });
  it('resolves a whole restore locally and keeps image/LoRA order', async () => {
    const { record, files, request } = completed();
    const getImage = vi.fn(async ({ binaryObjectId }) => files.find(file => file.binaryObjectId === binaryObjectId)?.blob);
    const restored = await prepareImageHistoryReuse({ record, findFile: () => request.models[0]!.file, getImage });
    expect(restored.missing).toEqual([]);
    expect(restored.loras.map(lora => [lora.enabled, lora.strength])).toEqual([[false, 0], [true, 0.8]]);
    expect(restored.imageInputs.referenceImages.map(file => file.name)).toEqual(['first.png', 'second.png']);
    expect(restored.imageInputs.strength).toBe(0.5);
    expect(restored.parameters.seed).toBe('-1');
  });
  it('restores editable settings but leaves all weight choices empty when a source is unavailable', async () => {
    const { record, files } = completed();
    const restored = await prepareImageHistoryReuse({ record, findFile: () => undefined, getImage: async ({ binaryObjectId }) => files.find(file => file.binaryObjectId === binaryObjectId)?.blob });
    expect(restored.parameters.prompt).toBe('癒しの猫');
    expect(restored.models).toEqual([]); expect(restored.loras).toEqual([]);
    expect(restored.missing).toHaveLength(2); expect(restored.missingInactive).toHaveLength(1);
  });
  it('keeps a complete base model when only its enabled adapter is missing', async () => {
    const { record, files, request } = completed();
    const missingAdapter = record.request.loras[1]!.file;
    const restored = await prepareImageHistoryReuse({ record,
      findFile: ({ location }) => location === missingAdapter ? undefined : request.models[0]!.file,
      getImage: async ({ binaryObjectId }) => files.find(file => file.binaryObjectId === binaryObjectId)?.blob });
    expect(restored.models.map(model => model.slot)).toEqual(request.models.map(model => model.slot));
    expect(restored.loras.map(lora => [lora.path, lora.strength, lora.enabled])).toEqual([['disabled.gguf', 0, false]]);
    expect(restored.missing).toEqual([missingAdapter.name]);
  });
  it('preserves available adapters in their original order when another is missing', async () => {
    const { record, files, request } = completed();
    record.request.loras = [
      { path: 'first.gguf', file: locateFile({ file: ggufFile() }), strength: 0.6 },
      { path: 'missing.gguf', file: locateFile({ file: ggufFile() }), strength: 1 },
      { path: 'last.gguf', file: locateFile({ file: ggufFile() }), strength: 0.9 },
    ];
    const missingAdapter = record.request.loras[1]!.file;
    const restored = await prepareImageHistoryReuse({ record,
      findFile: ({ location }) => location === missingAdapter ? undefined : request.models[0]!.file,
      getImage: async ({ binaryObjectId }) => files.find(file => file.binaryObjectId === binaryObjectId)?.blob });
    expect(restored.models).toHaveLength(request.models.length);
    expect(restored.loras.map(lora => [lora.path, lora.strength])).toEqual([['first.gguf', 0.6], ['last.gguf', 0.9]]);
    expect(restored.missing).toEqual([missingAdapter.name]);
  });
  it('reports a missing disabled adapter without making it a generation requirement', async () => {
    const { record, files, request } = completed();
    const disabledAdapter = record.request.loras[0]!.file;
    const restored = await prepareImageHistoryReuse({ record,
      findFile: ({ location }) => location === disabledAdapter ? undefined : request.models[0]!.file,
      getImage: async ({ binaryObjectId }) => files.find(file => file.binaryObjectId === binaryObjectId)?.blob });
    expect(restored.models).toHaveLength(request.models.length);
    expect(restored.loras.map(lora => [lora.path, lora.strength])).toEqual([['enabled.gguf', 0.8]]);
    expect(restored.missing).toEqual([]);
    expect(restored.missingInactive).toEqual([disabledAdapter.name]);
  });
  it('rejects a missing input instead of silently changing the generation request', async () => {
    const { record } = completed();
    await expect(prepareImageHistoryReuse({ record, findFile: () => ggufFile(), getImage: async () => undefined })).rejects.toThrow('input is missing');
  });
});

it('embeds Unicode request settings and actual preview dimensions only into the downloaded PNG', async () => {
  const bytes = new Uint8Array(45);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  new DataView(bytes.buffer).setUint32(8, 13);
  bytes.set([73, 72, 68, 82], 12); bytes.set([73, 69, 78, 68], 37);
  const png = new Blob([bytes], { type: 'image/png' });
  const { record } = completed();
  const image = { kind: 'preview' as const, width: 128, height: 128, step: 4, steps: 20, mode: 'projection' as const };
  expect(await imageGenerationDownloadBlob({ png, request: record.request, image, format: 'png', includeMetadata: false })).toBe(png);
  const output = await imageGenerationDownloadBlob({ png, request: record.request, image, format: 'png', includeMetadata: true });
  const text = new TextDecoder().decode(await output.arrayBuffer());
  expect(text).toContain('iTXt'); expect(text).toContain('癒しの猫'); expect(text).toContain('"seed":"-1"');
  expect(text).toContain('"image":{"kind":"preview","width":128,"height":128,"step":4');
  expect(new Uint8Array(await png.arrayBuffer())).toEqual(bytes);
});
