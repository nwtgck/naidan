// @vitest-environment node
import { createTemporaryModelFiles } from '@/logic/temporary-model-files';
import { describe, expect, it, vi } from 'vitest';
import { directoryForModelFile, normalizeModelDirectoryInput } from './model-directory-input';
import { TEST_ONLY } from './temporary-model-store';
import { resolvedModelSchema } from './resolved-model-schema';
import { isTemporaryModelReference, parseTemporaryModelReference, temporaryModelReference } from './temporary-model-reference';
import { generateInputSchema, modelSchema, type ModelDirectoryInput } from '@/features/llama-cpp-browser/types';

function gguf({ name = 'model.gguf', lastModified = 123, marker = 0 }: { name?: string, lastModified?: number, marker?: number } = {}): File {
  const bytes = new Uint8Array(32);
  bytes.set([71, 71, 85, 70, 3, 0, 0, 0]);
  bytes[24] = marker;
  return new File([bytes], name, { lastModified });
}

function tree({ rootName = 'Models', paths }: { rootName?: string, paths: string[] }): ModelDirectoryInput {
  return { rootName, files: paths.map(relativePath => ({ relativePath, file: gguf({ name: relativePath.split('/').at(-1)! }) })) };
}

describe('page-local model directories', () => {
  it('wraps loose GGUF files using the saved-import directory rule and never buffers the whole file', async () => {
    const store = TEST_ONLY.createTemporaryModelStore();
    const file = gguf({ name: 'Qwen3-Q4.gguf' });
    const read = vi.spyOn(file, 'arrayBuffer').mockRejectedValue(new Error('Full-file buffering is forbidden'));
    const stream = vi.spyOn(file, 'stream').mockImplementation(() => {
      throw new Error('Persistence is forbidden');
    });
    const directory = directoryForModelFile({ file });
    expect(directory).toEqual({ rootName: 'Qwen3-Q4-GGUF', files: [{ relativePath: file.name, file }] });
    const [model] = await store.registerDirectory({ directory, signal: undefined });
    expect(model).toMatchObject({ modelId: 'temp/Qwen3-Q4-GGUF', size: 32 });
    expect((await store.resolveModel({ modelId: model!.modelId, signal: undefined }))!.directory.files[0]!.file).toBe(file);
    expect(read).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
  });

  it('preserves a dropped root and nested paths without inventing a repository', async () => {
    const store = TEST_ONLY.createTemporaryModelStore();
    const [model] = await store.registerDirectory({ directory: tree({ rootName: 'dir1', paths: ['dir2/model.gguf'] }), signal: undefined });
    expect(model!.modelId).toBe('temp/dir1');
    const resolvedModel = (await store.resolveModel({ modelId: model!.modelId, signal: undefined }));
    expect(resolvedModel!.directory.files[0]!.relativePath).toBe('dir2/model.gguf');
    expect(resolvedModel!.directory.primaryFile).toBe(resolvedModel!.directory.files[0]);
  });

  it('enumerates linked-root layouts and independent variants while retaining repository paths', async () => {
    const store = TEST_ONLY.createTemporaryModelStore();
    const models = await store.registerDirectory({ directory: tree({ paths: ['Qwen/Model/Q4/model.gguf', 'Qwen/Model/Q8/model.gguf', 'other/Repo/model.gguf'] }), signal: undefined });
    expect(models.map(model => model.modelId).sort()).toEqual(['temp/Models/Qwen/Model:Q4/model', 'temp/Models/Qwen/Model:Q8/model', 'temp/Models/other/Repo:model'].sort());
    for (const model of models) {
      const resolvedModel = (await store.resolveModel({ modelId: model.modelId, signal: undefined }));
      expect(resolvedModel!.directory.files).toHaveLength(1);
      expect(resolvedModel!.directory.primaryFile).toBe(resolvedModel!.directory.files[0]);
      expect(modelSchema.safeParse(model).success).toBe(true);
    }
  });

  it('uses the shared repository quantization label rather than the literal filename', async () => {
    const store = TEST_ONLY.createTemporaryModelStore();
    const repository = 'google/gemma-4-E2B-it-qat-q4_0-gguf';
    const file = 'gemma-4-E2B_q4_0-it.gguf';
    const [model] = await store.registerDirectory({ directory: tree({ rootName: 'models-for-browser-2', paths: [`${repository}/${file}`] }), signal: undefined });
    expect(model!.modelId).toBe(`temp/models-for-browser-2/${repository}:q4_0-it`);
    expect((await store.resolveModel({ modelId: model!.modelId, signal: undefined }))?.directory.primaryFile.relativePath).toBe(file);
    expect(resolvedModelSchema.safeParse(await store.resolveModel({ modelId: model!.modelId, signal: undefined })).success).toBe(true);
  });

  it('keeps selectors stable when a duplicate root gets a numeric suffix', async () => {
    const store = TEST_ONLY.createTemporaryModelStore();
    const input = tree({ rootName: 'Model-GGUF', paths: ['Model-Q4.gguf', 'Model-Q8.gguf'] });
    const first = await store.registerDirectory({ directory: input, signal: undefined });
    const second = await store.registerDirectory({ directory: input, signal: undefined });
    expect(first.map(model => model.modelId)).toEqual(['temp/Model-GGUF:Q4', 'temp/Model-GGUF:Q8']);
    expect(second.map(model => model.modelId)).toEqual(['temp/Model-GGUF-2:Q4', 'temp/Model-GGUF-2:Q8']);
    expect((await store.resolveModel({ modelId: second[0]!.modelId, signal: undefined }))!.directory.primaryFile.relativePath).toBe('Model-Q4.gguf');
    expect(resolvedModelSchema.safeParse(await store.resolveModel({ modelId: second[0]!.modelId, signal: undefined })).success).toBe(true);
  });

  it('rejects colliding repository labels rather than registering an ambiguous temporary name', async () => {
    const store = TEST_ONLY.createTemporaryModelStore();
    await expect(store.registerDirectory({
      directory: tree({ paths: ['owner/Model-GGUF/Model-Q4.gguf', 'owner/Model-GGUF/Q4/Model-Q4.gguf'] }),
      signal: undefined,
    })).rejects.toThrow('unsupported-input');
    expect(store.list()).toEqual([]);
  });

  it('never borrows a projector from another repository in a linked-layout root', async () => {
    const store = TEST_ONLY.createTemporaryModelStore();
    const models = await store.registerDirectory({ directory: tree({ paths: ['owner/WithProjector/model.gguf', 'owner/WithProjector/mmproj.gguf', 'owner/TextOnly/model.gguf'] }), signal: undefined });
    expect(models).toHaveLength(2);
    const multimodal = (await store.resolveModel({ modelId: 'temp/Models/owner/WithProjector:model', signal: undefined }))!;
    const text = (await store.resolveModel({ modelId: 'temp/Models/owner/TextOnly:model', signal: undefined }))!;
    expect(multimodal.directory.projectorFile?.relativePath).toBe('mmproj.gguf');
    expect(text.directory.projectorFile?.relativePath).toBeUndefined();
    expect(text.directory.files.map(file => file.relativePath)).toEqual(['model.gguf']);
  });

  it('ignores companion-only repositories without losing independent models or crossing repository boundaries', async () => {
    const store = TEST_ONLY.createTemporaryModelStore();
    const [model] = await store.registerDirectory({ directory: tree({ paths: ['owner/Chat/model.gguf', 'owner/Companion/mmproj.gguf'] }), signal: undefined });
    expect(model!.modelId).toBe('temp/Models/owner/Chat:model');
    expect(store.list()).toHaveLength(1);
    expect((await store.resolveModel({ modelId: model!.modelId, signal: undefined }))!.directory.projectorFile?.relativePath).toBeUndefined();
    await expect(store.registerDirectory({ directory: tree({ paths: ['owner/Companion/mmproj.gguf'] }), signal: undefined })).rejects.toThrow('unsupported-input');
    expect(store.list()).toHaveLength(1);
  });

  it('publishes no part of a multi-repository root when one repository has incomplete shards', async () => {
    const store = TEST_ONLY.createTemporaryModelStore();
    await expect(store.registerDirectory({ directory: tree({ paths: ['owner/Good/model.gguf', 'owner/Broken/model-00001-of-00002.gguf'] }), signal: undefined })).rejects.toThrow('invalid-gguf');
    expect(store.list()).toEqual([]);
    expect((await store.registerDirectory({ directory: tree({ paths: ['model.gguf'] }), signal: undefined }))[0]!.modelId).toBe('temp/Models-2');
  });

  it('groups split files and the selected companion as one model', async () => {
    const store = TEST_ONLY.createTemporaryModelStore();
    const models = await store.registerDirectory({ directory: tree({ rootName: 'split', paths: ['weights/model-00001-of-00002.gguf', 'weights/model-00002-of-00002.gguf', 'mmproj.gguf'] }), signal: undefined });
    expect(models).toHaveLength(1);
    const resolvedModel = (await store.resolveModel({ modelId: 'temp/split', signal: undefined }))!;
    expect(resolvedModel.directory.files).toHaveLength(3);
    expect(resolvedModel.directory.projectorFile?.relativePath).toBe('mmproj.gguf');
    expect(resolvedModel.directory.primaryFile.relativePath).toBe('weights/model-00001-of-00002.gguf');
  });

  it('uses selectors for multiple loose variants rather than changing the file tree', async () => {
    const store = TEST_ONLY.createTemporaryModelStore();
    const models = await store.registerDirectory({ directory: tree({ rootName: 'variants', paths: ['Q4.gguf', 'Q8.gguf'] }), signal: undefined });
    expect(models.map(model => model.modelId)).toEqual(['temp/variants:Q4', 'temp/variants:Q8']);
  });

  it('matches only readable variants and keeps literal percent and whitespace distinct', async () => {
    const store = TEST_ONLY.createTemporaryModelStore();
    const models = await store.registerDirectory({ directory: tree({ rootName: 'Model-GGUF', paths: ['Q4.gguf', 'Q4.gguf.gguf', 'Q%20A.gguf', 'Q A.gguf'] }), signal: undefined });
    expect(models).toHaveLength(4);
    expect(models.map(model => model.modelId)).toEqual(expect.arrayContaining(['temp/Model-GGUF:Q A', 'temp/Model-GGUF:Q%20A', 'temp/Model-GGUF:Q4', 'temp/Model-GGUF:Q4.gguf']));
    const expected = new Map([
      ['temp/Model-GGUF:Q A', 'Q A.gguf'],
      ['temp/Model-GGUF:Q%20A', 'Q%20A.gguf'],
      ['temp/Model-GGUF:Q4', 'Q4.gguf'],
      ['temp/Model-GGUF:Q4.gguf', 'Q4.gguf.gguf'],
    ]);
    for (const { modelId } of models) {
      expect((await store.resolveModel({ modelId, signal: undefined }))?.directory.primaryFile.relativePath).toBe(expected.get(modelId));
    }
  });

  it('resolves nested model paths and literal percent filenames without URL-decoding selectors', async () => {
    const store = TEST_ONLY.createTemporaryModelStore();
    const paths = ['..%2Fmodel.gguf', '%ZZ.gguf', 'dir/model.gguf'];
    const models = await store.registerDirectory({ directory: tree({ rootName: 'root', paths }), signal: undefined });
    expect(models.map(model => model.modelId)).toEqual(['temp/root:..%2Fmodel', 'temp/root:%ZZ', 'temp/root:dir/model']);
    for (const [index, path] of paths.entries()) {
      const modelId = models[index]!.modelId;
      expect(modelSchema.shape.modelId.parse(modelId)).toBe(modelId);
      expect(generateInputSchema.shape.modelId.parse(modelId)).toBe(modelId);
      const resolvedModel = (await store.resolveModel({ modelId, signal: undefined }))!;
      expect(resolvedModel.directory.primaryFile.relativePath).toBe(path);
      expect(resolvedModel.directory.files.map(file => file.relativePath)).toEqual([path]);
      expect(resolvedModel.directory.primaryFile).toBe(resolvedModel.directory.files[0]);
    }
  });

  it('reserves only live root names and permits intentional same-name replacement', async () => {
    const registry = createTemporaryModelFiles();
    const store = TEST_ONLY.createWithRegistry({ registry });
    const input = tree({ rootName: 'Models', paths: ['model.gguf'] });
    const first = (await store.registerDirectory({ directory: input, signal: undefined }))[0]!;
    const before = (await store.resolveModel({ modelId: first.modelId, signal: undefined }))!;
    await store.registerDirectory({ directory: tree({ rootName: 'Models-2', paths: ['model.gguf'] }), signal: undefined });
    const next = (await store.registerDirectory({ directory: input, signal: undefined }))[0]!;
    expect(next.modelId).toBe('temp/Models-3');
    if (before.location.kind !== 'temp') {
      throw new Error('Expected temporary root location');
    }
    registry.remove({ rootPath: before.location.rootPath });
    await expect(store.resolveModel({ modelId: first.modelId, signal: undefined })).rejects.toThrow('missing-model');
    const replacement = gguf({ marker: 7 });
    const replaced = (await store.registerDirectory({ directory: { rootName: 'Models', files: [{ relativePath: 'model.gguf', file: replacement }] }, signal: undefined }))[0]!;
    expect(replaced.modelId).toBe(first.modelId);
    const after = (await store.resolveModel({ modelId: replaced.modelId, signal: undefined }))!;
    expect(after.directory.files[0]!.file).toBe(replacement);
    const beforeFile = before.directory.files[0]!;
    const afterFile = after.directory.files[0]!;
    if (afterFile.storageKind !== 'temp' || beforeFile.storageKind !== 'temp') {
      throw new Error('Expected temporary file provenance');
    }
    expect(afterFile.registrationRevision).not.toBe(beforeFile.registrationRevision);
    expect(before.directory.files[0]!.file).not.toBe(replacement);
    // A page reload needs no persisted generation, tombstone, or DTO migration.
    const reloaded = TEST_ONLY.createTemporaryModelStore();
    expect((await reloaded.registerDirectory({ directory: input, signal: undefined }))[0]!.modelId).toBe(first.modelId);
  });

  it('allocates different root names for concurrent asynchronous registrations', async () => {
    const store = TEST_ONLY.createTemporaryModelStore();
    const directory = tree({ paths: ['model.gguf'] });
    const results = await Promise.all(Array.from({ length: 4 }, () => store.registerDirectory({ directory, signal: undefined })));
    expect(new Set(results.flat().map(model => model.modelId)).size).toBe(4);
    expect(store.list()).toHaveLength(4);
  });

  it('removes only the selected variant without deleting files shared with image generation', async () => {
    const store = TEST_ONLY.createTemporaryModelStore();
    const models = await store.registerDirectory({ directory: tree({ paths: ['Q4.gguf', 'Q8.gguf', 'mmproj.gguf'] }), signal: undefined });
    store.removeModel({ modelId: models[0]!.modelId });
    expect(store.list().map(model => model.modelId)).toEqual([models[1]!.modelId]);
    expect((await store.resolveModel({ modelId: models[1]!.modelId, signal: undefined }))!.directory.projectorFile?.relativePath).toBe('mmproj.gguf');
    store.removeModel({ modelId: models[1]!.modelId });
    expect(store.list()).toEqual([]);
    expect((await store.registerDirectory({ directory: tree({ paths: ['model.gguf'] }), signal: undefined }))[0]!.modelId).toBe('temp/Models-2');
  });

  it('does not expose mutable file lists and notifies observers only for accepted changes', async () => {
    const store = TEST_ONLY.createTemporaryModelStore();
    const listener = vi.fn();
    using _subscription = { [Symbol.dispose]: store.subscribe({ listener }) };
    await store.registerDirectory({ directory: tree({ paths: ['model.gguf'] }), signal: undefined });
    const resolvedModel = (await store.resolveModel({ modelId: 'temp/Models', signal: undefined }))!;
    resolvedModel.directory.files.length = 0;
    expect((await store.resolveModel({ modelId: 'temp/Models', signal: undefined }))!.directory.files).toHaveLength(1);
    store.removeModel({ modelId: 'temp/Models' });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('does not claim a modelId from another storage source', async () => {
    const store = TEST_ONLY.createTemporaryModelStore();
    expect(await store.resolveModel({ modelId: 'hf.co/owner/repo:Q4', signal: undefined })).toBeUndefined();
  });

  it.each(['model-00002-of-00002.gguf', 'model-00001-of-00002.gguf', 'mmproj.gguf'])('rejects incomplete model %s without publishing a partial root', async path => {
    const store = TEST_ONLY.createTemporaryModelStore();
    await expect(store.registerDirectory({ directory: tree({ paths: [path] }), signal: undefined })).rejects.toThrow();
    expect(store.list()).toEqual([]);
  });

  it('rejects invalid GGUF headers and keeps any previously registered root unchanged', async () => {
    const store = TEST_ONLY.createTemporaryModelStore();
    await store.registerDirectory({ directory: tree({ paths: ['model.gguf'] }), signal: undefined });
    await expect(store.registerDirectory({ directory: { rootName: 'bad', files: [{ relativePath: 'bad.gguf', file: new File(['not a model'], 'bad.gguf') }] }, signal: undefined })).rejects.toThrow('invalid-gguf');
    expect(store.list().map(model => model.modelId)).toEqual(['temp/Models']);
  });

  it('honors cancellation after an asynchronous header read without registering anything', async () => {
    const store = TEST_ONLY.createTemporaryModelStore();
    const controller = new AbortController();
    const file = gguf();
    const slice = file.slice.bind(file);
    vi.spyOn(file, 'slice').mockImplementation((start, end) => {
      controller.abort();
      return slice(start, end);
    });
    await expect(store.registerDirectory({ directory: { rootName: 'cancelled', files: [{ relativePath: 'model.gguf', file }] }, signal: controller.signal })).rejects.toThrow();
    expect(store.list()).toEqual([]);
  });

  it('disambiguates maximum-size UTF-8 root names without creating an invalid path', async () => {
    const store = TEST_ONLY.createTemporaryModelStore();
    const rootName = '界'.repeat(85);
    const directory = tree({ rootName, paths: ['model.gguf'] });
    await store.registerDirectory({ directory, signal: undefined });
    const second = (await store.registerDirectory({ directory, signal: undefined }))[0]!;
    const parsed = parseTemporaryModelReference({ modelId: second.modelId });
    expect(parsed.rootName.endsWith('-2')).toBe(true);
    expect(new TextEncoder().encode(parsed.rootName).length).toBeLessThanOrEqual(255);
  });
});

describe('shared input and temporary-reference boundaries', () => {
  it.each(['../model.gguf', '/model.gguf', 'a//model.gguf', 'a/./model.gguf', 'a/../model.gguf', 'a\\model.gguf', '.llama-cpp-import-pending/model.gguf'])('rejects unsafe path %s', path => {
    expect(() => normalizeModelDirectoryInput({ directory: tree({ paths: [path] }) })).toThrow('invalid-gguf');
  });

  it('rejects file-directory collisions and duplicate paths', () => {
    for (const paths of [['a', 'a/model.gguf'], ['model.gguf', 'model.gguf']]) {
      expect(() => normalizeModelDirectoryInput({ directory: tree({ paths }) })).toThrow('invalid-gguf');
    }
  });

  it.each(['temp/', 'temp/..', 'temp/.hidden', 'temp/root/owner/repo', 'temp/root:..', 'temp/root:/model', 'temp/root:dir//model', 'temp/root:dir/../model', 'temp/root:dir/./model', 'temp/root:dir\\model'])('distinguishes temporary source parsing from modelId data: %s', modelId => {
    expect(isTemporaryModelReference({ modelId })).toBe(false);
    expect(modelSchema.shape.modelId.parse(modelId)).toBe(modelId);
    expect(generateInputSchema.shape.modelId.parse(modelId)).toBe(modelId);
  });

  it('round-trips public variant labels with literal percent, colon and Unicode without decoding', () => {
    const parts = { rootName: 'Models', repository: 'owner/repo', selector: '日本語/a%2Fb:model' };
    const modelId = temporaryModelReference(parts);
    expect(parseTemporaryModelReference({ modelId })).toEqual(parts);
  });

  it('validates resolved temporary files and recomputes the selected file layout', async () => {
    const store = TEST_ONLY.createTemporaryModelStore();
    await store.registerDirectory({ directory: tree({ paths: ['model.gguf'] }), signal: undefined });
    const resolved = (await store.resolveModel({ modelId: 'temp/Models', signal: undefined }))!;
    expect(resolvedModelSchema.safeParse(resolved).success).toBe(true);
    expect(resolved.location).toEqual({ kind: 'temp', rootPath: 'temp/Models' });
    expect(resolvedModelSchema.safeParse({ ...resolved, modelId: 'temp/elsewhere' }).success).toBe(false);
    expect(resolvedModelSchema.safeParse({ ...resolved, directory: { ...resolved.directory, primaryFile: { ...resolved.directory.primaryFile, relativePath: 'other.gguf' } } }).success).toBe(false);
    expect(resolvedModelSchema.safeParse(undefined).success).toBe(false);
  });
});

it('projects a root registered by the image tab and keeps every non-GGUF companion available there', async () => {
  const registry = createTemporaryModelFiles();
  const store = TEST_ONLY.createWithRegistry({ registry });
  const file = gguf();
  const root = registry.register({ directory: { rootName: 'shared', files: [{ relativePath: 'owner/repo/model.gguf', file }, { relativePath: 'owner/repo/vae.safetensors', file: new File(['vae'], 'vae.safetensors') }, { relativePath: 'vae.safetensors', file: new File(['vae'], 'vae.safetensors') }] }, signal: undefined });
  const resolvedModel = await store.resolveModel({ modelId: 'temp/shared/owner/repo:model', signal: undefined });
  expect(resolvedModel?.directory.files[0]?.file).toBe(file);
  store.removeModel({ modelId: resolvedModel!.modelId });
  expect(store.list()).toEqual([]);
  expect(registry.get({ rootPath: root.rootPath })?.files).toHaveLength(3);
  await store.ensure({ signal: undefined });
  expect(store.list()).toEqual([]);
  await expect(store.resolveModel({ modelId: resolvedModel!.modelId, signal: undefined })).rejects.toThrow('missing-model');
  registry.remove({ rootPath: root.rootPath });
  await expect(store.resolveModel({ modelId: resolvedModel!.modelId, signal: undefined })).rejects.toThrow('missing-model');
  registry.register({ directory: { rootName: root.rootName, files: [{ relativePath: 'owner/repo/model.gguf', file }] }, signal: undefined });
  const restored = await store.resolveModel({ modelId: resolvedModel!.modelId, signal: undefined });
  expect(restored?.directory.primaryFile.file).toBe(file);
  expect(restored?.directory.primaryFile).not.toEqual(resolvedModel!.directory.primaryFile);
});

it('keeps an image-only directory without inventing a language model', async () => {
  const registry = createTemporaryModelFiles();
  const store = TEST_ONLY.createWithRegistry({ registry });
  expect(await store.registerDirectory({ directory: { rootName: 'images', files: [{ relativePath: 'model.safetensors', file: new File(['weights'], 'model.safetensors') }] }, signal: undefined })).toEqual([]);
  expect(registry.list()[0]?.rootPath).toBe('temp/images');
  expect(store.issues()).toEqual([]);
});

it('retains invalid language files for other engines while reporting the projection failure', async () => {
  const registry = createTemporaryModelFiles();
  const store = TEST_ONLY.createWithRegistry({ registry });
  const directory = { rootName: 'mixed', files: [{ relativePath: 'bad.gguf', file: new File(['bad'], 'bad.gguf') }, { relativePath: 'image.safetensors', file: new File(['weights'], 'image.safetensors') }] };
  await expect(store.registerDirectory({ directory, signal: undefined })).rejects.toThrow('invalid-gguf');
  expect(registry.list()[0]?.files).toHaveLength(2);
  expect(store.issues()).toEqual([{ rootPath: 'temp/mixed', message: 'llama.cpp browser: invalid-gguf' }]);
  registry.remove({ rootPath: 'temp/mixed' });
  expect(store.issues()).toEqual([]);
});

it('does not publish a delayed language projection after its shared root was replaced', async () => {
  const registry = createTemporaryModelFiles();
  const store = TEST_ONLY.createWithRegistry({ registry });
  const oldFile = gguf();
  const original = oldFile.slice.bind(oldFile);
  const gate = Promise.withResolvers<void>();
  vi.spyOn(oldFile, 'slice').mockImplementation((start, end) => ({
    arrayBuffer: async () => {
      await gate.promise;
      return original(start, end).arrayBuffer();
    },
  }) as Blob);
  const root = registry.register({ directory: { rootName: 'shared', files: [{ relativePath: 'model.gguf', file: oldFile }] }, signal: undefined });
  const pending = store.ensure({ signal: undefined });
  registry.remove({ rootPath: root.rootPath });
  const replacement = gguf({ marker: 7 });
  registry.register({ directory: { rootName: 'shared', files: [{ relativePath: 'model.gguf', file: replacement }] }, signal: undefined });
  await store.ensure({ signal: undefined });
  gate.resolve();
  await pending;
  expect((await store.resolveModel({ modelId: 'temp/shared', signal: undefined }))?.directory.files[0]?.file).toBe(replacement);
});
