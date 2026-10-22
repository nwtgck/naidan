// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryDirectory } from '@/features/stable-diffusion-cpp-browser/test-utils/storage.test-support';
import { temporaryModelFiles } from '@/logic/temporary-model-files';
import { temporaryModels } from './runtime/temporary-model-store';
import { captureTemporaryModelSource, copyTemporaryModel, llamaCppBrowserModelFiles, publishModelImport, TEST_ONLY, withSavedTemporaryModelFiles, type ModelImportReceipt } from './model-files';

const storage = vi.hoisted(() => ({ current: true }));
vi.mock('@/00-storage/service', () => ({
  storageService: {
    captureSettingsStorage: () => () => storage.current,
    subscribeToChanges: () => () => {},
    loadHostModelDirectories: async () => [],
  },
}));
vi.mock('./index', () => {
  throw new Error('File operations must not initialize an inference runtime');
});

function gguf({ name, marker }: { name: string, marker: number }): File {
  const data = new Uint8Array(32);
  data.set([71, 71, 85, 70, 3, 0, 0, 0]);
  data[24] = marker;
  return new File([data], name, { lastModified: 123 });
}

let root: MemoryDirectory;
let lockNames: string[];

beforeEach(() => {
  for (const entry of temporaryModelFiles.list()) {
    temporaryModelFiles.remove({ rootPath: entry.rootPath });
  }
  TEST_ONLY.resetPublications();
  storage.current = true;
  root = new MemoryDirectory('root');
  lockNames = [];
  vi.stubGlobal('navigator', {
    storage: { getDirectory: async () => root },
    locks: {
      request: async (name: string, optionsOrOperation: LockOptions | (() => Promise<unknown>), operation?: (lock: Lock | null) => Promise<unknown>) => {
        lockNames.push(name);
        return typeof optionsOrOperation === 'function' ? optionsOrOperation() : operation?.({ name, mode: 'exclusive' } as Lock);
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('local model publication and saving', () => {
  it('replays exact committed receipts and never revives a removed registration', async () => {
    const first = await llamaCppBrowserModelFiles.importModel({ file: gguf({ name: 'model.gguf', marker: 1 }), storage: 'temp', signal: undefined });
    const modelId = first.models[0]!.modelId;
    const receipts: ModelImportReceipt[] = [];
    using _subscription = { [Symbol.dispose]: llamaCppBrowserModelFiles.subscribeModelImports({ listener: ({ receipt }) => receipts.push(receipt) }) };
    expect(receipts).toEqual([first]);
    temporaryModelFiles.remove({ rootPath: 'temp/model-GGUF' });
    const second = await llamaCppBrowserModelFiles.importModel({ file: gguf({ name: 'model.gguf', marker: 2 }), storage: 'temp', signal: undefined });
    expect(second.models[0]!.modelId).toBe(modelId);
    expect(first.publication.isCurrent({ modelId })).toBe(false);
    expect(second.publication.isCurrent({ modelId })).toBe(true);
    publishModelImport({ storage: 'temp', models: first.models, isCurrent: () => false });
    expect(second.publication.isCurrent({ modelId })).toBe(true);
    expect(receipts).toEqual([first, second]);
    storage.current = false;
    expect(second.publication.isCurrent({ modelId })).toBe(false);
  });

  it('rejects an old resolved File snapshot after the visible root is reused', async () => {
    const imported = await llamaCppBrowserModelFiles.importModel({ file: gguf({ name: 'model.gguf', marker: 1 }), storage: 'temp', signal: undefined });
    const modelId = imported.models[0]!.modelId;
    const resolved = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const resolveModel = temporaryModels.resolveModel.bind(temporaryModels);
    vi.spyOn(temporaryModels, 'resolveModel').mockImplementationOnce(async ({ modelId, signal }) => {
      const snapshot = await resolveModel({ modelId, signal });
      resolved.resolve();
      await resume.promise;
      return snapshot;
    });
    const captured = captureTemporaryModelSource({ modelId, signal: undefined });
    await resolved.promise;
    temporaryModelFiles.remove({ rootPath: 'temp/model-GGUF' });
    const replacement = await llamaCppBrowserModelFiles.importModel({ file: gguf({ name: 'model.gguf', marker: 2 }), storage: 'temp', signal: undefined });
    expect(replacement.models[0]!.modelId).toBe(modelId);
    const rejected = expect(captured).rejects.toThrow('llama.cpp browser: missing-model');
    resume.resolve();
    await rejected;
    const current = await captureTemporaryModelSource({ modelId, signal: undefined });
    expect(current.isCurrent()).toBe(true);
  });

  it('copies every shard and the selected projector outside the generation lock', async () => {
    const files = ['model-00001-of-00002.gguf', 'model-00002-of-00002.gguf', 'mmproj.gguf'].map((name, index) => ({ relativePath: name, file: gguf({ name, marker: index }) }));
    const imported = await llamaCppBrowserModelFiles.importDirectory({ directory: { rootName: 'split', files }, storage: 'temp', signal: undefined });
    const source = await captureTemporaryModelSource({ modelId: imported.models[0]!.modelId, signal: undefined });
    const progress: number[] = [];
    const saved = await copyTemporaryModel({ source, signal: undefined, onProgress: ({ progress: next }) => progress.push(next.completed) });
    expect(saved.model.modelId).toBe('user/split');
    expect(saved.model.size).toBe(96);
    expect(progress.at(-1)).toBe(96);
    expect(lockNames).not.toContain('naidan-llama-cpp-browser-model-store');
    const commit = vi.fn(async () => 'bound');
    expect(await withSavedTemporaryModelFiles({ source, saved, signal: undefined, operation: commit })).toEqual({ status: 'completed', value: 'bound' });
    const parent = await (await root.getDirectoryHandle('models')).getDirectoryHandle('user');
    parent.children.delete('split');
    const replacement = await parent.getDirectoryHandle('split', { create: true });
    const file = await replacement.getFileHandle('model.gguf', { create: true });
    file.data = new Uint8Array(await gguf({ name: 'model.gguf', marker: 9 }).arrayBuffer());
    expect(await withSavedTemporaryModelFiles({ source, saved, signal: undefined, operation: commit })).toEqual({ status: 'changed' });
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('invalidates an OPFS receipt after inventory observes another tab replacing its root', async () => {
    const imported = await llamaCppBrowserModelFiles.importModel({ file: gguf({ name: 'model.gguf', marker: 1 }), storage: 'opfs', signal: undefined });
    const modelId = imported.models[0]!.modelId;
    const notified = vi.fn();
    using _subscription = { [Symbol.dispose]: llamaCppBrowserModelFiles.subscribeModelList({ listener: notified }) };
    await llamaCppBrowserModelFiles.listModelEntries({ signal: undefined });
    expect(notified).not.toHaveBeenCalled();
    const parent = await (await root.getDirectoryHandle('models')).getDirectoryHandle('user');
    parent.children.delete('model-GGUF');
    const replacement = await parent.getDirectoryHandle('model-GGUF', { create: true });
    const file = await replacement.getFileHandle('model.gguf', { create: true });
    file.data = new Uint8Array(await gguf({ name: 'model.gguf', marker: 2 }).arrayBuffer());
    const models = await llamaCppBrowserModelFiles.listModelEntries({ signal: undefined });
    expect(models.some(model => model.modelId === modelId)).toBe(true);
    expect(imported.publication.isCurrent({ modelId })).toBe(false);
    expect(notified).toHaveBeenCalledOnce();
    await llamaCppBrowserModelFiles.listModelEntries({ signal: undefined });
    expect(notified).toHaveBeenCalledOnce();
  });

  it('returns the actual collision-safe saved ID and preserves temporary ownership', async () => {
    const receipt = await llamaCppBrowserModelFiles.importModel({ file: gguf({ name: 'model.gguf', marker: 1 }), storage: 'temp', signal: undefined });
    const source = await captureTemporaryModelSource({ modelId: receipt.models[0]!.modelId, signal: undefined });
    const first = await copyTemporaryModel({ source, signal: undefined, onProgress: () => {} });
    const second = await copyTemporaryModel({ source, signal: undefined, onProgress: () => {} });
    expect(first.model.modelId).toBe('user/model-GGUF');
    expect(second.model.modelId).toBe('user/model-GGUF-2');
    expect(source.isCurrent()).toBe(true);
    await llamaCppBrowserModelFiles.removeTemporaryModel({ modelId: source.model.modelId, signal: undefined });
    expect(source.isCurrent()).toBe(false);
    expect(await withSavedTemporaryModelFiles({ source, saved: second, signal: undefined, operation: async () => 'must not bind' })).toEqual({ status: 'changed' });
  });
});
