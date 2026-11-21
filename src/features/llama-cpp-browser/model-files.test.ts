// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryDirectory } from '@/features/stable-diffusion-cpp-browser/test-utils/storage.test-support';
import { temporaryModelFiles } from '@/logic/temporary-model-files';
import { temporaryModels } from './runtime/temporary-model-store';
import { captureTemporaryModelSource, copyTemporaryModel, llamaCppBrowserModelFiles, publishModelImport, TEST_ONLY, withSavedTemporaryModelFiles, type ModelImportReceipt } from './model-files';
import { createModelFileExplorerOptions } from './model-file-explorer';
import { mapFileExplorerModalOptionsToRootDescriptor } from '@/features/file-explorer/composables/useFileExplorerModal';
import { createFileExplorerWorker } from '@/features/file-explorer/worker/impl';
import { connectFileExplorerRemoteMounts } from '@/features/file-explorer/worker/remote-mounts';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import { storageService } from '@/00-storage/service';
import { hostModelHandles } from '@/00-storage/service/host-model-handles';
import { toHostModelDirectoryId } from '@/01-models/ids';

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
  it('opens a Hugging Face model at the same files in the physical folder and model hierarchy', async () => {
    const opfs = new MockFileSystemDirectoryHandle({ name: 'root' });
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => opfs }, locks: navigator.locks });
    let folder = opfs;
    for (const segment of ['models', 'huggingface.co', 'owner', 'Repo-GGUF', 'resolve', 'main']) {
      folder = await folder.getDirectoryHandle(segment, { create: true });
    }
    const weights = await folder.getDirectoryHandle('Q8_0', { create: true });
    const file = await weights.getFileHandle('Repo-Q8_0.gguf', { create: true });
    file.content = new Uint8Array(await gguf({ name: file.name, marker: 1 }).arrayBuffer());
    const model = await llamaCppBrowserModelFiles.inspectModelFiles({ modelId: 'hf.co/owner/Repo-GGUF:Q8_0', signal: undefined });
    const { signal } = new AbortController();
    const location = await createModelFileExplorerOptions({ model, view: 'folder', title: 'Models', signal });
    expect(location).toEqual({ kind: 'opfs-root', initialPath: ['models', 'huggingface.co', 'owner', 'Repo-GGUF', 'resolve', 'main', 'Q8_0'] });
    const hierarchy = await createModelFileExplorerOptions({ model, view: 'models', title: 'Models', signal });
    expect(hierarchy).toMatchObject({ kind: 'wesh-mounts', initialPath: ['hf.co', 'owner', 'Repo-GGUF', 'Q8_0'], initialLocked: true });
    if (hierarchy.kind !== 'wesh-mounts') {
      throw new Error('Expected a model hierarchy');
    }
    expect(hierarchy.mounts).toContainEqual({ type: 'directory', handle: folder, path: '/hf.co/owner/Repo-GGUF', readOnly: false });
    const worker = createFileExplorerWorker();
    const { sessionId } = await worker.prepareSession({ request: { root: mapFileExplorerModalOptionsToRootDescriptor({ options: hierarchy }) } });
    await using _session = {
      async [Symbol.asyncDispose]() {
        await worker.disposeSession({ request: { sessionId } });
      },
    };
    const repository = '/hf.co/owner/Repo-GGUF';
    const namespace = await worker.readDirectory({ request: { sessionId, path: '/hf.co/owner' } });
    expect(namespace.readOnly).toBe(true);
    expect(namespace.entries).toEqual([expect.objectContaining({ path: repository, canMutate: false })]);
    await worker.deleteEntries({ request: { sessionId, paths: [`${repository}/Q8_0/Repo-Q8_0.gguf`] } });
    await expect(weights.getFileHandle('Repo-Q8_0.gguf')).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('starts disk navigation at the linked root and uses the public alias only in the model hierarchy', async () => {
    const host = Object.assign(new MockFileSystemDirectoryHandle({ name: 'Models on disk' }), {
      queryPermission: async (): Promise<PermissionState> => 'granted',
      requestPermission: async (): Promise<PermissionState> => 'granted',
    });
    const owner = await host.getDirectoryHandle('owner', { create: true });
    const repository = await owner.getDirectoryHandle('Repo-GGUF', { create: true });
    const quantization = await repository.getDirectoryHandle('Q8_0', { create: true });
    const weight = await quantization.getFileHandle('Repo-Q8_0.gguf', { create: true });
    weight.content = new Uint8Array(await gguf({ name: weight.name, marker: 1 }).arrayBuffer());
    const id = toHostModelDirectoryId({ raw: 'linked-directory' });
    vi.spyOn(storageService, 'loadHostModelDirectories').mockResolvedValue([{ id, name: 'Library' }]);
    vi.spyOn(hostModelHandles, 'get').mockResolvedValue(host);
    const model = await llamaCppBrowserModelFiles.inspectModelFiles({ modelId: 'host/Library/owner/Repo-GGUF:Q8_0', signal: undefined });
    const { signal } = new AbortController();
    const disk = await createModelFileExplorerOptions({ model, view: 'folder', title: 'Models', signal });
    expect(disk).toEqual({ kind: 'native-directory', title: 'Models on disk', rootName: 'Models on disk', handle: host, readOnly: false, initialPath: ['owner', 'Repo-GGUF', 'Q8_0'], initialLocked: true });
    const hierarchy = await createModelFileExplorerOptions({ model, view: 'models', title: 'Models', signal });
    expect(hierarchy).toMatchObject({ kind: 'wesh-mounts', initialPath: ['host', 'Library', 'owner', 'Repo-GGUF', 'Q8_0'] });
  });

  it('deletes a temporary companion through File Explorer and guards other open sessions against stale edits', async () => {
    const name = 'ExplorerRepo';
    const previouslyRegistered = temporaryModelFiles.register({ directory: { rootName: name, files: [{ relativePath: 'file.txt', file: new File(['other'], 'file.txt') }] }, signal: undefined });
    using _otherRoot = { [Symbol.dispose]: () => temporaryModelFiles.remove({ rootPath: previouslyRegistered.rootPath }) };
    const receipt = await llamaCppBrowserModelFiles.importLocalDirectory({
      directory: { rootName: name, files: ['Repo-Q4.gguf', 'Repo-Q8.gguf', 'vision/mmproj.gguf'].map(relativePath => ({ relativePath, file: gguf({ name: relativePath.split('/').at(-1)!, marker: 1 }) })) },
      save: 'later',
      signal: undefined,
    });
    const modelId = receipt.models[0]!.modelId;
    const model = await llamaCppBrowserModelFiles.inspectModelFiles({ modelId, signal: undefined });
    if (model.location.kind !== 'local-files') {
      throw new Error('Expected a temporary local repository');
    }
    const { rootPath } = model.location;
    using _repository = { [Symbol.dispose]: () => temporaryModelFiles.remove({ rootPath }) };
    const { signal } = new AbortController();
    const options = await createModelFileExplorerOptions({ model, view: 'models', title: 'Models', signal });
    if (options.kind !== 'wesh-mounts') {
      throw new Error('Expected a model hierarchy');
    }
    expect(options.initialPath).toEqual(['~user', name]);
    expect(rootPath).toBe('temp/ExplorerRepo-2');
    const descriptor = mapFileExplorerModalOptionsToRootDescriptor({ options });
    const access = await connectFileExplorerRemoteMounts({ root: descriptor, remoteMounts: options.remoteMounts });
    const worker = createFileExplorerWorker();
    const { sessionId } = await worker.prepareSession({ request: { root: descriptor } }, undefined, access.remote);
    await using _session = {
      async [Symbol.asyncDispose]() {
        await worker.disposeSession({ request: { sessionId } });
        await access.dispose();
      },
    };
    const folder = `/~user/${name}`;
    const listing = await worker.readDirectory({ request: { sessionId, path: folder } });
    expect(listing.entries.map(entry => entry.name).sort()).toEqual(['Repo-Q4.gguf', 'Repo-Q8.gguf', 'vision']);
    const oldAccess = await createModelFileExplorerOptions({ model, view: 'models', title: 'Models', signal });
    if (oldAccess.kind !== 'wesh-mounts') {
      throw new Error('Expected another model hierarchy');
    }
    await worker.deleteEntries({ request: { sessionId, paths: [`${folder}/vision/mmproj.gguf`] } });
    const staleMount = oldAccess.remoteMounts?.find(mount => mount.path === folder);
    expect(await staleMount?.access.request({ request: { type: 'remove_entry', parentId: 'directory:', name: 'Repo-Q4.gguf', recursive: false } })).toMatchObject({ status: 'error', name: 'NotFoundError' });
    expect(temporaryModelFiles.get({ rootPath })?.files.map(file => file.relativePath)).toEqual(['Repo-Q4.gguf', 'Repo-Q8.gguf']);
    for (const { modelId: current } of receipt.models) {
      const currentFiles = await llamaCppBrowserModelFiles.captureModelFiles({ modelId: current, signal: undefined });
      expect(currentFiles.files).toHaveLength(1);
    }
  });

  it('captures selected File snapshots without exposing storage handles or starting inference', async () => {
    const file = gguf({ name: 'model.gguf', marker: 1 });
    const receipt = await llamaCppBrowserModelFiles.importModel({ file, storage: 'temp', signal: undefined });
    const captured = await llamaCppBrowserModelFiles.captureModelFiles({ modelId: receipt.models[0]!.modelId, signal: undefined });
    expect(captured).toEqual({ primaryRelativePath: 'model.gguf', files: [{ relativePath: 'model.gguf', file }] });
    expect(captured.files[0]!.file).toBe(file);
    captured.files.length = 0;
    expect((await llamaCppBrowserModelFiles.captureModelFiles({ modelId: receipt.models[0]!.modelId, signal: undefined })).files).toHaveLength(1);
  });

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

  it('keeps a copied receipt usable after its temporary source is removed', async () => {
    const imported = await llamaCppBrowserModelFiles.importModel({ file: gguf({ name: 'model.gguf', marker: 1 }), storage: 'temp', signal: undefined });
    const modelId = imported.models[0]!.modelId;
    const source = await captureTemporaryModelSource({ modelId, signal: undefined });
    const saved = await copyTemporaryModel({ source, signal: undefined, onProgress: () => {} });
    await llamaCppBrowserModelFiles.removeTemporaryModel({ modelId, signal: undefined });
    expect(source.isCurrent()).toBe(false);
    const operation = vi.fn(async () => 'bound');
    expect(await withSavedTemporaryModelFiles({ source, saved, signal: undefined, operation })).toEqual({ status: 'completed', value: 'bound' });
    expect(operation).toHaveBeenCalledOnce();
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
    expect(models.some(model => model.modelId === 'user/model-GGUF/model')).toBe(true);
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
    expect(await withSavedTemporaryModelFiles({ source, saved: second, signal: undefined, operation: async () => 'bound' })).toEqual({ status: 'completed', value: 'bound' });
  });
});
