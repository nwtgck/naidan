// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { directoryForModelFile, normalizeModelDirectoryInput } from './model-directory-input';
import { TEST_ONLY } from './temporary-model-store';
import { temporarySourceDirectory } from './temporary-model-source';
import { isTemporaryModelReference, parseTemporaryModelReference, temporaryModelReference } from './temporary-model-reference';
import { generateInputSchema, modelSchema, type ModelDirectoryInput } from '@/features/llama-cpp-browser/types';

function gguf({ name = 'model.gguf', lastModified = 123, marker = 0 }: { name?: string, lastModified?: number, marker?: number } = {}): File {
  const bytes = new Uint8Array(32);
  bytes.set([71, 71, 85, 70, 3, 0, 0, 0]);
  bytes[24] = marker;
  return new File([bytes], name, { lastModified });
}

function tree({ name = 'Models', paths }: { name?: string, paths: string[] }): ModelDirectoryInput {
  return { name, files: paths.map(path => ({ path, file: gguf({ name: path.split('/').at(-1)! }) })) };
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
    expect(directory).toEqual({ name: 'Qwen3-Q4-GGUF', files: [{ path: file.name, file }] });
    const [model] = await store.registerDirectory({ directory, signal: undefined });
    expect(model).toMatchObject({ id: 'temp/Qwen3-Q4-GGUF', name: 'temp/Qwen3-Q4-GGUF', size: 32 });
    expect(store.source({ name: model!.id })!.files[0]!.file).toBe(file);
    expect(read).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
  });

  it('preserves a dropped root and nested paths without inventing a repository', async () => {
    const store = TEST_ONLY.createTemporaryModelStore();
    const [model] = await store.registerDirectory({ directory: tree({ name: 'dir1', paths: ['dir2/model.gguf'] }), signal: undefined });
    expect(model!.id).toBe('temp/dir1');
    const source = store.source({ name: model!.id });
    expect(source!.files[0]!.path).toBe('dir2/model.gguf');
    expect(temporarySourceDirectory({ name: model!.id, source }).modelPath).toBe('dir2/model.gguf');
  });

  it('enumerates linked-root layouts and independent variants while retaining repository paths', async () => {
    const store = TEST_ONLY.createTemporaryModelStore();
    const models = await store.registerDirectory({ directory: tree({ paths: ['Qwen/Model/Q4/model.gguf', 'Qwen/Model/Q8/model.gguf', 'other/Repo/model.gguf'] }), signal: undefined });
    expect(models.map(model => model.id).sort()).toEqual(['temp/Models/Qwen/Model:Q4%2Fmodel.gguf', 'temp/Models/Qwen/Model:Q8%2Fmodel.gguf', 'temp/Models/other/Repo:model.gguf'].sort());
    for (const model of models) {
      const source = store.source({ name: model.id });
      expect(source!.files).toHaveLength(1);
      expect(temporarySourceDirectory({ name: model.id, source }).modelPath).toBe(source!.files[0]!.path);
      expect(modelSchema.safeParse(model).success).toBe(true);
    }
  });

  it('never borrows a projector from another repository in a linked-layout root', async () => {
    const store = TEST_ONLY.createTemporaryModelStore();
    const models = await store.registerDirectory({ directory: tree({ paths: ['owner/WithProjector/model.gguf', 'owner/WithProjector/mmproj.gguf', 'owner/TextOnly/model.gguf'] }), signal: undefined });
    expect(models).toHaveLength(2);
    const multimodal = store.source({ name: 'temp/Models/owner/WithProjector:model.gguf' })!;
    const text = store.source({ name: 'temp/Models/owner/TextOnly:model.gguf' })!;
    expect(multimodal.projectorPath).toBe('mmproj.gguf');
    expect(text.projectorPath).toBeUndefined();
    expect(text.files.map(file => file.path)).toEqual(['model.gguf']);
  });

  it('ignores companion-only repositories without losing independent models or crossing repository boundaries', async () => {
    const store = TEST_ONLY.createTemporaryModelStore();
    const [model] = await store.registerDirectory({ directory: tree({ paths: ['owner/Chat/model.gguf', 'owner/Companion/mmproj.gguf'] }), signal: undefined });
    expect(model!.id).toBe('temp/Models/owner/Chat:model.gguf');
    expect(store.list()).toHaveLength(1);
    expect(store.source({ name: model!.id })!.projectorPath).toBeUndefined();
    await expect(store.registerDirectory({ directory: tree({ paths: ['owner/Companion/mmproj.gguf'] }), signal: undefined })).rejects.toThrow('unsupported-input');
    expect(store.list()).toHaveLength(1);
  });

  it('publishes no part of a multi-repository root when one repository has incomplete shards', async () => {
    const store = TEST_ONLY.createTemporaryModelStore();
    await expect(store.registerDirectory({ directory: tree({ paths: ['owner/Good/model.gguf', 'owner/Broken/model-00001-of-00002.gguf'] }), signal: undefined })).rejects.toThrow('invalid-gguf');
    expect(store.list()).toEqual([]);
    expect((await store.registerDirectory({ directory: tree({ paths: ['model.gguf'] }), signal: undefined }))[0]!.id).toBe('temp/Models');
  });

  it('groups split files and the selected companion as one model', async () => {
    const store = TEST_ONLY.createTemporaryModelStore();
    const models = await store.registerDirectory({ directory: tree({ name: 'split', paths: ['weights/model-00001-of-00002.gguf', 'weights/model-00002-of-00002.gguf', 'mmproj.gguf'] }), signal: undefined });
    expect(models).toHaveLength(1);
    const source = store.source({ name: 'temp/split' })!;
    expect(source.files).toHaveLength(3);
    expect(source.projectorPath).toBe('mmproj.gguf');
    expect(source.modelPath).toBe('weights/model-00001-of-00002.gguf');
  });

  it('uses selectors for multiple loose variants rather than changing the file tree', async () => {
    const store = TEST_ONLY.createTemporaryModelStore();
    const models = await store.registerDirectory({ directory: tree({ name: 'variants', paths: ['Q4.gguf', 'Q8.gguf'] }), signal: undefined });
    expect(models.map(model => model.id)).toEqual(['temp/variants:Q4.gguf', 'temp/variants:Q8.gguf']);
  });

  it('reserves only live root names and permits intentional same-name replacement', async () => {
    const store = TEST_ONLY.createTemporaryModelStore();
    const input = tree({ name: 'Models', paths: ['model.gguf'] });
    const first = (await store.registerDirectory({ directory: input, signal: undefined }))[0]!;
    const before = store.source({ name: first.id })!;
    await store.registerDirectory({ directory: tree({ name: 'Models-2', paths: ['model.gguf'] }), signal: undefined });
    const next = (await store.registerDirectory({ directory: input, signal: undefined }))[0]!;
    expect(next.id).toBe('temp/Models-3');
    store.remove({ name: first.id });
    expect(() => store.source({ name: first.id })).toThrow('missing-model');
    const replacement = gguf({ marker: 7 });
    const replaced = (await store.registerDirectory({ directory: { name: 'Models', files: [{ path: 'model.gguf', file: replacement }] }, signal: undefined }))[0]!;
    expect(replaced.id).toBe(first.id);
    const after = store.source({ name: replaced.id })!;
    expect(after.files[0]!.file).toBe(replacement);
    expect(after.revision).not.toBe(before.revision);
    expect(before.files[0]!.file).not.toBe(replacement);
    // A page reload needs no persisted generation, tombstone, or DTO migration.
    const reloaded = TEST_ONLY.createTemporaryModelStore();
    expect((await reloaded.registerDirectory({ directory: input, signal: undefined }))[0]!.id).toBe(first.id);
  });

  it('allocates different root names for concurrent asynchronous registrations', async () => {
    const store = TEST_ONLY.createTemporaryModelStore();
    const directory = tree({ paths: ['model.gguf'] });
    const results = await Promise.all(Array.from({ length: 4 }, () => store.registerDirectory({ directory, signal: undefined })));
    expect(new Set(results.flat().map(model => model.id)).size).toBe(4);
    expect(store.list()).toHaveLength(4);
  });

  it('removes only the selected variant and releases the root when its last model is removed', async () => {
    const store = TEST_ONLY.createTemporaryModelStore();
    const models = await store.registerDirectory({ directory: tree({ paths: ['Q4.gguf', 'Q8.gguf', 'mmproj.gguf'] }), signal: undefined });
    store.remove({ name: models[0]!.id });
    expect(store.list().map(model => model.id)).toEqual([models[1]!.id]);
    expect(store.source({ name: models[1]!.id })!.projectorPath).toBe('mmproj.gguf');
    store.remove({ name: models[1]!.id });
    expect(store.list()).toEqual([]);
    expect((await store.registerDirectory({ directory: tree({ paths: ['model.gguf'] }), signal: undefined }))[0]!.id).toBe('temp/Models');
  });

  it('does not expose mutable file lists and notifies observers only for accepted changes', async () => {
    const store = TEST_ONLY.createTemporaryModelStore();
    const listener = vi.fn();
    using _subscription = { [Symbol.dispose]: store.subscribe({ listener }) };
    await store.registerDirectory({ directory: tree({ paths: ['model.gguf'] }), signal: undefined });
    const source = store.source({ name: 'temp/Models' })!;
    source.files.length = 0;
    expect(store.source({ name: 'temp/Models' })!.files).toHaveLength(1);
    store.remove({ name: 'temp/Models' });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it.each(['model-00002-of-00002.gguf', 'model-00001-of-00002.gguf', 'mmproj.gguf'])('rejects incomplete model %s without publishing a partial root', async path => {
    const store = TEST_ONLY.createTemporaryModelStore();
    await expect(store.registerDirectory({ directory: tree({ paths: [path] }), signal: undefined })).rejects.toThrow();
    expect(store.list()).toEqual([]);
  });

  it('rejects invalid GGUF headers and keeps any previously registered root unchanged', async () => {
    const store = TEST_ONLY.createTemporaryModelStore();
    await store.registerDirectory({ directory: tree({ paths: ['model.gguf'] }), signal: undefined });
    await expect(store.registerDirectory({ directory: { name: 'bad', files: [{ path: 'bad.gguf', file: new File(['not a model'], 'bad.gguf') }] }, signal: undefined })).rejects.toThrow('invalid-gguf');
    expect(store.list().map(model => model.id)).toEqual(['temp/Models']);
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
    await expect(store.registerDirectory({ directory: { name: 'cancelled', files: [{ path: 'model.gguf', file }] }, signal: controller.signal })).rejects.toThrow();
    expect(store.list()).toEqual([]);
  });

  it('disambiguates maximum-size UTF-8 root names without creating an invalid path', async () => {
    const store = TEST_ONLY.createTemporaryModelStore();
    const name = '界'.repeat(85);
    const directory = tree({ name, paths: ['model.gguf'] });
    await store.registerDirectory({ directory, signal: undefined });
    const second = (await store.registerDirectory({ directory, signal: undefined }))[0]!;
    const parsed = parseTemporaryModelReference({ name: second.id });
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

  it.each(['temp/', 'temp/..', 'temp/.hidden', 'temp/root/owner/repo', 'temp/root:..%2Fmodel.gguf', 'temp/root:%2Fmodel.gguf', 'temp/root:model.txt', 'temp/root:dir%2fmodel.gguf', 'temp/root:%ZZ', 'temp/root:dir/model.gguf'])('rejects noncanonical model name %s', name => {
    expect(isTemporaryModelReference({ name })).toBe(false);
    expect(modelSchema.shape.id.safeParse(name).success).toBe(false);
    expect(generateInputSchema.shape.model.safeParse(name).success).toBe(false);
  });

  it('round-trips literal percent, colon and Unicode in a file selector without double decoding', () => {
    const parts = { rootName: 'Models', repository: 'owner/repo', modelPath: '日本語/a%2Fb:model.gguf' };
    const name = temporaryModelReference(parts);
    expect(parseTemporaryModelReference({ name })).toEqual(parts);
  });

  it('binds worker sources to the requested model and recomputes the selected file layout', async () => {
    const store = TEST_ONLY.createTemporaryModelStore();
    await store.registerDirectory({ directory: tree({ paths: ['model.gguf'] }), signal: undefined });
    const source = store.source({ name: 'temp/Models' })!;
    expect(() => temporarySourceDirectory({ name: 'temp/elsewhere', source })).toThrow('missing-model');
    expect(() => temporarySourceDirectory({ name: source.id, source: { ...source, modelPath: 'other.gguf' } })).toThrow('invalid-gguf');
    expect(() => temporarySourceDirectory({ name: source.id, source: undefined })).toThrow('missing-model');
  });
});
