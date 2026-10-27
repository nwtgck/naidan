// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryDirectory } from '@/features/stable-diffusion-cpp-browser/test-utils/storage.test-support';
import { temporaryModelFiles } from '@/logic/temporary-model-files';
import { localRepositories } from './runtime/local-repository-store';
import { resolveModel } from './runtime/model-resolution';
import { prepareModelRemoval } from './runtime/model-store';
import { cancelLocalRepositorySave, captureTemporaryModelSource, llamaCppBrowserModelFiles, localRepositorySaveState, saveLocalRepository, subscribeLocalRepositorySaves, TEST_ONLY } from './model-files';
import { DEFAULT_SETTINGS, type ChatContent } from '@/01-models/types';
import { toChatId, toMessageId } from '@/01-models/ids';
import { savedLocalModelReferences, sameLocalModelBinding, TEST_ONLY as referenceTest } from '@/00-storage/service/local-model-references';

const storage = vi.hoisted(() => ({ promote: vi.fn() }));
vi.mock('@/00-storage/service', () => ({
  storageService: {
    captureSettingsStorage: () => () => true,
    subscribeToChanges: () => () => {},
    loadHostModelDirectories: async () => [],
    promoteLocalModelReferences: storage.promote,
  },
}));
vi.mock('./index', () => {
  throw new Error('File registration must not initialize inference');
});
vi.mock('@/composables/useGlobalEvents', () => ({ useGlobalEvents: () => ({ addErrorEvent: vi.fn(), addInfoEvent: vi.fn() }) }));
const { StorageService } = await vi.importActual<typeof import('@/00-storage/service')>('@/00-storage/service');

function gguf({ path }: { path: string }): File {
  const data = new Uint8Array(32);
  data.set([71, 71, 85, 70, 3, 0, 0, 0]);
  return new File([data], path.split('/').at(-1)!, { lastModified: 123 });
}

function directory({ paths }: { paths: string[] }) {
  return { rootName: 'Repo', files: paths.map(relativePath => ({ relativePath, file: gguf({ path: relativePath }) })) };
}

let root: MemoryDirectory;
let locks: Set<string>;

beforeEach(() => {
  TEST_ONLY.resetPublications();
  referenceTest.reset();
  root = new MemoryDirectory('root');
  locks = new Set();
  const tails = new Map<string, Promise<unknown>>();
  const request = async (name: string, optionsOrOperation: LockOptions | LockGrantedCallback<unknown>, callback?: LockGrantedCallback<unknown>) => {
    const options = typeof optionsOrOperation === 'function' ? {} : optionsOrOperation;
    const operation = typeof optionsOrOperation === 'function' ? optionsOrOperation : callback;
    if (!operation) {
      throw new Error('Expected a Web Locks callback');
    }
    if (options.ifAvailable && locks.has(name)) {
      return operation(null);
    }
    const previous = tails.get(name) ?? Promise.resolve();
    const done = Promise.withResolvers<void>();
    tails.set(name, previous.then(() => done.promise));
    await previous;
    try {
      options.signal?.throwIfAborted();
      locks.add(name);
      return await operation({ name, mode: 'exclusive' });
    } finally {
      locks.delete(name);
      done.resolve();
    }
  };
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root }, locks: { request } });
  storage.promote.mockImplementation(async ({ mappings, withCurrentFiles }) => withCurrentFiles({ modelIds: mappings.map((mapping: { modelId: string }) => mapping.modelId), operation: async () => {} }));
  const remove = MemoryDirectory.prototype.removeEntry;
  vi.spyOn(MemoryDirectory.prototype, 'removeEntry').mockImplementation(async function(this: MemoryDirectory, name, options) {
    if (options?.recursive) {
      this.children.delete(name);
      return;
    }
    return remove.call(this, name, options);
  });
});

afterEach(async () => {
  for (const entry of temporaryModelFiles.list()) {
    temporaryModelFiles.remove({ rootPath: entry.rootPath });
  }
  // Retirement releases the cross-tab name only after copy/rollback/promotion.
  await vi.waitFor(() => expect([...locks]).toEqual([]));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  storage.promote.mockReset();
});

async function importedSource({ input, save }: { input: ReturnType<typeof directory>, save: 'browser' | 'later' }) {
  const receipt = await llamaCppBrowserModelFiles.importLocalDirectory({ directory: input, save, signal: undefined });
  const modelId = receipt.models[0]!.modelId;
  const capture = await captureTemporaryModelSource({ modelId, signal: undefined });
  if (!capture.localSource) {
    throw new Error('Expected a captured repository');
  }
  return { receipt, modelId, source: capture.localSource };
}

describe('File-first repository saving', () => {
  it('keeps accepted stream writes valid after unregistering a promoted File source and releases the identity after its last pin', async () => {
    const persisted = new StorageService();
    vi.spyOn(persisted, 'notify').mockImplementation(() => {});
    await persisted.init({ type: 'memory' });
    storage.promote.mockImplementation((input: Parameters<typeof persisted.promoteLocalModelReferences>[0]) => persisted.promoteLocalModelReferences(input));
    const input = directory({ paths: ['Model.gguf'] });
    const { source, modelId: pendingModelId } = await importedSource({ input, save: 'later' });
    const chatId = toChatId({ raw: 'accepted-file-stream' });
    await persisted.updateChatMeta({ id: chatId, updater: () => ({ id: chatId, title: 'Accepted stream', createdAt: 1, updatedAt: 1, debugEnabled: false, endpoint: { type: 'llama_cpp_browser' }, modelId: pendingModelId }) });
    const content: ChatContent = { root: { items: [] } };
    await persisted.updateChatContent({ id: chatId, write: persisted.createChatContentWrite({ id: chatId, content: undefined, binding: undefined }), updater: () => content });
    const write = persisted.createChatContentWrite({ id: chatId, content, binding: { groupId: undefined, endpoint: { type: 'llama_cpp_browser' }, modelId: pendingModelId, endpointSource: 'chat', modelSource: 'chat' } });
    const pin = localRepositories.pin({ source });
    using _operation = { [Symbol.dispose]: () => pin.release() };
    const finalPin = localRepositories.pin({ source });
    using _finalOperation = { [Symbol.dispose]: () => finalPin.release() };

    await saveLocalRepository({ source });
    const savedModelId = 'user/Repo/Model';
    expect((await persisted.loadChatMeta({ id: chatId }))?.modelId).toBe(savedModelId);
    temporaryModelFiles.remove({ rootPath: source.root.rootPath });
    expect(localRepositories.isCurrent({ source })).toBe(false);
    expect(localRepositories.sourceFor({ modelId: pendingModelId })).toBeUndefined();
    expect(savedLocalModelReferences({ modelIds: [pendingModelId] })).toEqual([]);
    const response: ChatContent = { root: { items: [{ id: toMessageId({ raw: 'finished-response' }), role: 'assistant', createdAt: 2, modelId: pendingModelId, lmParameters: undefined, interruption: undefined, parts: [{ type: 'text', text: 'Keep the completed response', completeness: 'complete' }], replies: { items: [] } }] } };
    await expect(persisted.updateChatContent({ id: chatId, write, updater: () => response })).resolves.toEqual(response);
    expect(await persisted.loadSettings()).toBeNull();
    expect(referenceTest.referenceCount()).toBe(1);

    pin.release();
    expect(referenceTest.referenceCount()).toBe(1);
    expect(sameLocalModelBinding({ left: { endpoint: { type: 'llama_cpp_browser' }, modelId: pendingModelId }, right: { endpoint: { type: 'llama_cpp_browser' }, modelId: savedModelId } })).toBe(true);
    finalPin.release();
    await vi.waitFor(() => expect(referenceTest.referenceCount()).toBe(0));
    expect(sameLocalModelBinding({ left: { endpoint: { type: 'llama_cpp_browser' }, modelId: pendingModelId }, right: { endpoint: { type: 'llama_cpp_browser' }, modelId: savedModelId } })).toBe(false);
    const next = await importedSource({ input, save: 'later' });
    expect(next.source.rootName).toBe(source.rootName);
    expect(next.source.sourceId).not.toBe(source.sourceId);
    expect(sameLocalModelBinding({ left: { endpoint: { type: 'llama_cpp_browser' }, modelId: next.modelId }, right: { endpoint: { type: 'llama_cpp_browser' }, modelId: savedModelId } })).toBe(false);
  });

  it('invalidates a pinned source identity when its saved files are deleted and reimported under the same public name', async () => {
    const persisted = new StorageService();
    vi.spyOn(persisted, 'notify').mockImplementation(() => {});
    await persisted.init({ type: 'memory' });
    await persisted.updateSettings({ updater: () => ({ ...structuredClone(DEFAULT_SETTINGS), storageType: 'memory', endpoint: { type: 'llama_cpp_browser' } }) });
    storage.promote.mockImplementation((input: Parameters<typeof persisted.promoteLocalModelReferences>[0]) => persisted.promoteLocalModelReferences(input));
    const input = directory({ paths: ['Model.gguf'] });
    const { source, modelId: pendingModelId } = await importedSource({ input, save: 'later' });
    const pin = localRepositories.pin({ source });
    using _operation = { [Symbol.dispose]: () => pin.release() };
    await saveLocalRepository({ source });
    const savedModelId = 'user/Repo/Model';
    expect(sameLocalModelBinding({ left: { endpoint: { type: 'llama_cpp_browser' }, modelId: pendingModelId }, right: { endpoint: { type: 'llama_cpp_browser' }, modelId: savedModelId } })).toBe(true);

    const { plan } = await prepareModelRemoval({ modelId: savedModelId, signal: undefined });
    expect(await llamaCppBrowserModelFiles.removeModel({ plan, signal: undefined })).toBe('deleted');
    expect(referenceTest.referenceCount()).toBe(0);
    await llamaCppBrowserModelFiles.importDirectory({ directory: input, storage: 'opfs', signal: undefined });
    expect((await llamaCppBrowserModelFiles.listModelEntries({ signal: undefined })).some(model => model.modelId === savedModelId)).toBe(true);
    expect(sameLocalModelBinding({ left: { endpoint: { type: 'llama_cpp_browser' }, modelId: pendingModelId }, right: { endpoint: { type: 'llama_cpp_browser' }, modelId: savedModelId } })).toBe(false);
  });

  it('publishes original File objects with save off and never copies or buffers their contents', async () => {
    const input = directory({ paths: ['Model-Q4.gguf'] });
    const file = input.files[0]!.file;
    const wholeFile = vi.spyOn(file, 'arrayBuffer').mockRejectedValue(new Error('Do not buffer a model'));
    const stream = vi.spyOn(file, 'stream');
    const { source, modelId } = await importedSource({ input, save: 'later' });
    expect(modelId).toBe('~user/Repo/Model-Q4');
    expect((await resolveModel({ modelId, signal: undefined })).directory.primaryFile.file).toBe(file);
    expect(wholeFile).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    expect(root.children.size).toBe(0);
    expect(localRepositorySaveState({ source }).phase).toBe('offered');
    expect((await llamaCppBrowserModelFiles.listModelEntries({ signal: undefined })).map(model => model.modelId)).toEqual([modelId]);
  });

  it('makes a saved-on selection usable before its background stream completes and preserves every repository path', async () => {
    const input = directory({ paths: ['Q4/Model-00001-of-00002.gguf', 'Q4/Model-00002-of-00002.gguf', 'Q8/Model.gguf', 'vision/mmproj-F16.gguf', 'vision/mmproj-BF16.gguf'] });
    input.files.push({ relativePath: 'README.md', file: new File(['model notes'], 'README.md') });
    const first = input.files[0]!.file;
    const began = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    using _release = { [Symbol.dispose]: () => release.resolve() };
    const stream = first.stream.bind(first);
    vi.spyOn(first, 'stream').mockImplementation(() => {
      const reader = stream().getReader();
      return new ReadableStream({
        async pull(controller) {
          began.resolve();
          await release.promise;
          const chunk = await reader.read();
          if (chunk.done) {
            controller.close();
          } else {
            controller.enqueue(chunk.value);
          }
        },
      });
    });
    const { source, modelId } = await importedSource({ input, save: 'browser' });
    await began.promise;
    expect(localRepositorySaveState({ source }).phase).toBe('saving');
    const before = await resolveModel({ modelId, signal: undefined });
    expect(before.directory.primaryFile.file).toBe(first);
    release.resolve();
    await saveLocalRepository({ source });
    expect(localRepositorySaveState({ source }).phase).toBe('saved');
    const folder = await (await (await root.getDirectoryHandle('models')).getDirectoryHandle('user')).getDirectoryHandle('Repo');
    expect([...folder.children.keys()]).toEqual(['Q4', 'Q8', 'vision', 'README.md']);
    expect([...((await folder.getDirectoryHandle('vision')).children.keys())]).toEqual(['mmproj-F16.gguf', 'mmproj-BF16.gguf']);
    expect([...((await folder.getDirectoryHandle('Q4')).children.keys())]).toHaveLength(2);
    const after = await resolveModel({ modelId: 'user/Repo/Q4/Model', signal: undefined });
    expect(after.location).toEqual({ ...before.location, savedRootName: 'Repo' });
    expect(after.directory.primaryFile.file).toBe(first);
    const listed = await llamaCppBrowserModelFiles.listModelEntries({ signal: undefined });
    expect(await llamaCppBrowserModelFiles.getModelEntry({ modelId: 'user/Repo/Q4/Model', signal: undefined })).toEqual(listed.find(model => model.modelId === 'user/Repo/Q4/Model'));
    expect(storage.promote).toHaveBeenCalledWith(expect.objectContaining({
      mappings: [
        { sourceModelId: '~user/Repo/Q4/Model', modelId: 'user/Repo/Q4/Model' },
        { sourceModelId: '~user/Repo/Q8/Model', modelId: 'user/Repo/Q8/Model' },
      ],
    }));
  });

  it('retries metadata failure against the completed collision-renamed copy without streaming a second time', async () => {
    const user = await (await root.getDirectoryHandle('models', { create: true })).getDirectoryHandle('user', { create: true });
    await user.getDirectoryHandle('Repo', { create: true });
    const input = directory({ paths: ['Model.gguf'] });
    const stream = vi.spyOn(input.files[0]!.file, 'stream');
    const { source } = await importedSource({ input, save: 'later' });
    storage.promote.mockImplementationOnce(async ({ mappings, withCurrentFiles }) => withCurrentFiles({
      modelIds: mappings.map((mapping: { modelId: string }) => mapping.modelId),
      operation: async () => {
        throw new Error('Settings write failed');
      },
    }));
    await saveLocalRepository({ source });
    expect(localRepositorySaveState({ source }).phase).toBe('failed');
    expect([...user.children.keys()]).toEqual(['Repo', 'Repo-2']);
    await saveLocalRepository({ source });
    expect(localRepositorySaveState({ source }).phase).toBe('saved');
    expect([...user.children.keys()]).toEqual(['Repo', 'Repo-2']);
    expect(stream).toHaveBeenCalledOnce();
    expect(localRepositories.savedModelId({ modelId: '~user/Repo/Model' })).toBe('user/Repo-2/Model');
  });

  it('cancels copying with rollback and reuses the File source for a new explicit save', async () => {
    const input = directory({ paths: ['Model.gguf'] });
    const { source } = await importedSource({ input, save: 'later' });
    using _progress = {
      [Symbol.dispose]: subscribeLocalRepositorySaves({
        listener: () => {
          const state = localRepositorySaveState({ source });
          if (state.phase === 'saving' && state.progress) {
            cancelLocalRepositorySave({ source });
          }
        },
      }),
    };
    await saveLocalRepository({ source });
    expect(localRepositorySaveState({ source }).phase).toBe('offered');
    expect((await (await root.getDirectoryHandle('models')).getDirectoryHandle('user')).children.size).toBe(0);
    expect(storage.promote).not.toHaveBeenCalled();
    expect(localRepositories.sourceFor({ modelId: '~user/Repo/Model' })).toBe(source);
  });

  it('does not cancel an accepted metadata write or expose a stale copy to a later selection', async () => {
    const { source } = await importedSource({ input: directory({ paths: ['Model.gguf'] }), save: 'later' });
    const began = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    using _release = { [Symbol.dispose]: () => release.resolve() };
    storage.promote.mockImplementationOnce(async ({ mappings, withCurrentFiles }) => withCurrentFiles({
      modelIds: mappings.map((mapping: { modelId: string }) => mapping.modelId),
      operation: async () => {
        began.resolve();
        await release.promise;
      },
    }));
    const save = saveLocalRepository({ source });
    await began.promise;
    expect(localRepositorySaveState({ source }).phase).toBe('finalizing');
    cancelLocalRepositorySave({ source });
    release.resolve();
    await save;
    expect(localRepositorySaveState({ source }).phase).toBe('saved');
    const parent = await (await root.getDirectoryHandle('models')).getDirectoryHandle('user');
    parent.children.delete('Repo');
    const latePromotion = storage.promote.mock.calls[0]![0];
    const write = vi.fn(async () => {});
    await expect(latePromotion.withCurrentFiles({ modelIds: ['user/Repo/Model'], operation: write })).rejects.toThrow('missing-model');
    expect(write).not.toHaveBeenCalled();
  });

  it('keeps sibling variant identity and shared projector files when deleting one saved variant', async () => {
    const { source } = await importedSource({ input: directory({ paths: ['Model-Q4.gguf', 'Model-Q8.gguf', 'mmproj.gguf'] }), save: 'later' });
    await saveLocalRepository({ source });
    const { plan, sharedPlan } = await prepareModelRemoval({ modelId: 'user/Repo/Model-Q4', signal: undefined });
    expect(sharedPlan).toBeDefined();
    expect(await llamaCppBrowserModelFiles.removeModel({ plan, signal: undefined })).toBe('deleted');
    const listed = await llamaCppBrowserModelFiles.listModelEntries({ signal: undefined });
    expect(listed.map(model => model.modelId)).toEqual(['user/Repo/Model-Q8']);
    const folder = await (await (await root.getDirectoryHandle('models')).getDirectoryHandle('user')).getDirectoryHandle('Repo');
    expect([...folder.children.keys()]).toEqual(['Model-Q8.gguf', 'mmproj.gguf']);
  });

  it('never replays source publication sidecars into OPFS', async () => {
    const input = directory({ paths: ['Model.gguf'] });
    for (const relativePath of ['.llama-cpp-import-pending', '.Model.gguf.pending', '.Model.gguf.complete']) {
      input.files.push({ relativePath, file: new File(['source receipt'], relativePath) });
    }
    const { source } = await importedSource({ input, save: 'later' });
    expect(source.root.files.map(file => file.relativePath)).toEqual(['Model.gguf']);
    await saveLocalRepository({ source });
    expect(localRepositorySaveState({ source }).phase).toBe('saved');
    const folder = await (await (await root.getDirectoryHandle('models')).getDirectoryHandle('user')).getDirectoryHandle('Repo');
    expect([...folder.children.keys()]).toEqual(['Model.gguf']);
  });
});
