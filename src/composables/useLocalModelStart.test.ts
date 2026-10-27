import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, ref } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { idToRaw } from '@/01-models/ids';
import { DEFAULT_SETTINGS, type Chat } from '@/01-models/types';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import type { ModelLaunchStartContext } from './useAppEntry';
import type { LocalModel } from '@/features/llama-cpp-browser/types';
import { startLocalModelInput, useBrowserModelLocalInputSelection, useLocalModelStart } from './useLocalModelStart';

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  getModel: vi.fn(),
  importDirectory: vi.fn(),
  captureSource: vi.fn(),
  captureDefaults: vi.fn(),
  initializeDefaults: vi.fn(),
  navigate: vi.fn(),
  registerLive: vi.fn(),
  registerOrigin: vi.fn(),
  offer: vi.fn(),
  storageCurrent: true,
  sourceCurrent: true,
  publicationCurrent: true,
  warning: vi.fn(),
  registerSession: vi.fn(),
  loadData: vi.fn(),
  modelListeners: new Set<() => void>(),
}));
vi.mock('@/00-storage/service', () => ({ storageService: { captureModelLaunchStorage: () => () => mocks.storageCurrent, prepareLocalModelChat: mocks.prepare } }));
vi.mock('@/composables/useAppEntry', () => ({ handoffAppEntryToChat: mocks.navigate, useAppEntry: () => ({ captureModelLaunchContext: () => ({ homeOriginId: undefined }) }) }));
vi.mock('@/composables/useToast', () => ({ useToast: () => ({ addToast: mocks.warning }) }));
vi.mock('@/features/llama-cpp-browser/composables/local-model-launch-session', () => ({ registerLocalModelLaunchSession: mocks.registerSession }));
vi.mock('@/composables/useSettings', () => ({ useSettings: () => ({ settings: ref(DEFAULT_SETTINGS), captureModelLaunchDefaults: mocks.captureDefaults, initializeModelLaunchDefaults: mocks.initializeDefaults }) }));
vi.mock('@/composables/chat/global/chat-core-singletons', () => ({ registerLiveInstance: mocks.registerLive, loadData: mocks.loadData }));
vi.mock('@/composables/chat/chat-scoped/chat-model-binding-operations', () => ({ registerChatModelBindingOrigin: mocks.registerOrigin }));
vi.mock('@/features/llama-cpp-browser/model-files', () => ({
  llamaCppBrowserModelFiles: {
    getModelEntry: mocks.getModel,
    importLocalDirectory: mocks.importDirectory,
    subscribeModelList: ({ listener }: { listener(): void }) => {
      mocks.modelListeners.add(listener);
      return () => {
        mocks.modelListeners.delete(listener);
      };
    },
  },
  captureTemporaryModelSource: mocks.captureSource,
}));
vi.mock('@/features/llama-cpp-browser/composables/useTemporaryModelSave', () => ({ offerTemporaryModelSave: mocks.offer }));

const first: LocalModel = { modelId: '~user/local/Model-Q4', size: 128, importedAt: 1 };
const second: LocalModel = { modelId: '~user/local/Model-Q8', size: 256, importedAt: 1 };
const wrappers: VueWrapper[] = [];

function notifyModels(): void {
  for (const listener of [...mocks.modelListeners]) {
    listener();
  }
}

function savedChat({ request }: { request: { chatId: Chat['id'], chatGroupId: Chat['groupId'] } }): Chat {
  return { id: request.chatId, groupId: request.chatGroupId, title: null, root: { items: [] }, createdAt: 1, updatedAt: 1, debugEnabled: false };
}

function context({ isCurrent }: { isCurrent(): boolean }): ModelLaunchStartContext {
  return { owner: Symbol('entry'), homeOriginId: 'home', mode: 'home', fullPath: '/', routePath: '/', isCurrent, defaults: mocks.captureDefaults() };
}

async function render() {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] });
  await router.push('/');
  let command: ReturnType<typeof useLocalModelStart> | undefined;
  const wrapper = mount(defineComponent({
    setup() {
      command = useLocalModelStart();
      return {};
    },
    template: '<div />',
  }), { global: { plugins: [router] } });
  wrappers.push(wrapper);
  if (!command) {
    throw new Error('Missing command');
  }
  return { router, wrapper, ...command };
}

beforeEach(async () => {
  vi.resetAllMocks();
  await ensureAllStringsForTest({ locale: 'en' });
  useBrowserModelLocalInputSelection().cancel();
  mocks.storageCurrent = true;
  mocks.modelListeners.clear();
  mocks.sourceCurrent = true;
  mocks.publicationCurrent = true;
  mocks.captureDefaults.mockResolvedValue({ endpoint: { type: 'openai', url: '' }, modelId: undefined, revision: 0, storedMatches: true, isStorageCurrent: () => mocks.storageCurrent });
  mocks.initializeDefaults.mockResolvedValue('applied');
  mocks.navigate.mockResolvedValue(true);
  mocks.getModel.mockResolvedValue(first);
  mocks.loadData.mockResolvedValue(undefined);
  mocks.captureSource.mockImplementation(async ({ modelId }: { modelId: string }) => ({ model: modelId === second.modelId ? second : first, rootPath: 'temp/local', registrationRevision: 1, isCurrent: () => mocks.sourceCurrent }));
  mocks.importDirectory.mockResolvedValue({ models: [first], publication: { generation: 1, isCurrent: () => mocks.publicationCurrent } });
  mocks.prepare.mockImplementation(async ({ request }: { request: { chatId: Chat['id'], chatGroupId: Chat['groupId'] } }) => ({ id: request.chatId, groupId: request.chatGroupId, title: null, root: { items: [] }, createdAt: 1, updatedAt: 1, debugEnabled: false }));
});

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) {
    wrapper.unmount();
  }
});

it('registers the actual temporary model before creating its chat, initializing defaults, navigating and offering save', async () => {
  const directory = { rootName: 'local', files: [{ relativePath: 'model.gguf', file: new File(['gguf'], 'model.gguf') }] };
  const controller = new AbortController();
  await startLocalModelInput({ directories: Promise.resolve([directory]), controller, context: context({ isCurrent: () => true }) });
  expect(mocks.importDirectory).toHaveBeenCalledExactlyOnceWith({ directory, save: 'later', signal: controller.signal });
  const request = mocks.prepare.mock.calls[0]?.[0].request;
  expect(request).toMatchObject({ modelId: first.modelId, chatGroupName: 'Model-Q4' });
  expect(mocks.initializeDefaults).toHaveBeenCalledWith({ modelId: first.modelId, expected: expect.objectContaining({ modelId: undefined }) });
  expect(mocks.navigate).toHaveBeenCalledWith(expect.objectContaining({ chatPath: `/chat/${idToRaw({ id: request.chatId })}` }));
  expect(mocks.registerLive.mock.invocationCallOrder[0]).toBeLessThan(mocks.registerOrigin.mock.invocationCallOrder[0]!);
  expect(mocks.registerOrigin.mock.invocationCallOrder[0]).toBeLessThan(mocks.navigate.mock.invocationCallOrder[0]!);
  expect(mocks.offer).toHaveBeenCalledWith({ chatId: request.chatId, source: expect.objectContaining({ registrationRevision: 1 }), chatGroupId: request.chatGroupId });
});

it.each(['browser', 'later'] as const)('starts a confirmed repository with %s persistence without asking for its layout again', async save => {
  const directory = {
    rootName: 'local',
    files: ['Q4/model.gguf', 'Q8/model.gguf'].map(relativePath => ({ relativePath, file: new File(['gguf'], 'model.gguf') })),
  };
  const controller = new AbortController();
  await startLocalModelInput({ directories: Promise.resolve([directory]), controller, context: context({ isCurrent: () => true }), save, repositoryLayout: 'confirmed' });
  expect(mocks.importDirectory).toHaveBeenCalledExactlyOnceWith({ directory, save, signal: controller.signal });
  expect(mocks.prepare).toHaveBeenCalledOnce();
  expect(useBrowserModelLocalInputSelection().selection.value).toBeUndefined();
});

it('requires a real configuration choice and preserves the first default snapshot while waiting', async () => {
  mocks.importDirectory.mockResolvedValue({ models: [first, second], publication: { generation: 1, isCurrent: () => mocks.publicationCurrent } });
  const controller = new AbortController();
  await startLocalModelInput({ directories: Promise.resolve([{ rootName: 'local', files: [] }]), controller, context: context({ isCurrent: () => true }) });
  const { selection, choose } = useBrowserModelLocalInputSelection();
  expect(selection.value?.models.map(model => model.modelId)).toEqual([first.modelId, second.modelId]);
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.navigate).not.toHaveBeenCalled();
  await choose({ modelId: second.modelId });
  expect(mocks.prepare.mock.calls[0]?.[0].request.modelId).toBe(second.modelId);
  expect(mocks.captureDefaults).toHaveBeenCalledOnce();
  expect(mocks.importDirectory).toHaveBeenCalledOnce();
});

it('confirms raw repositories before handing files to an existing chat without pairing across repositories', async () => {
  const directory = {
    rootName: 'Models',
    files: [
      { relativePath: 'Text/model.gguf', file: new File(['gguf'], 'model.gguf') },
      { relativePath: 'Other/mmproj.gguf', file: new File(['gguf'], 'mmproj.gguf') },
    ],
  };
  const controller = new AbortController();
  const acceptFiles = vi.fn();
  const pending = startLocalModelInput({ directories: Promise.resolve([directory]), controller, context: context({ isCurrent: () => true }), save: 'browser', acceptFiles });
  const { selection, cancel } = useBrowserModelLocalInputSelection();
  await vi.waitFor(() => expect(selection.value?.kind).toBe('layout'));
  expect(acceptFiles).not.toHaveBeenCalled();
  const choice = selection.value;
  if (choice?.kind !== 'layout') {
    throw new Error('Expected a repository layout choice');
  }
  choice.chooseLayout({ layout: 'repositories' });
  await pending;
  expect(acceptFiles).toHaveBeenCalledOnce();
  const request = acceptFiles.mock.calls[0]?.[0];
  await expect(request.directories).resolves.toEqual([{ rootName: 'Text', files: [{ relativePath: 'model.gguf', file: directory.files[0]!.file }] }]);
  expect(request).toMatchObject({ controller, save: 'browser' });
  expect(mocks.importDirectory).not.toHaveBeenCalled();
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.navigate).not.toHaveBeenCalled();
  cancel();
  expect(controller.signal.aborted).toBe(false);
});

it.each(['route', 'storage', 'abort'])('does not import after file enumeration loses its capability (%s)', async reason => {
  let routeCurrent = true;
  const directories = Promise.withResolvers<[]>();
  const controller = new AbortController();
  const result = startLocalModelInput({ directories: directories.promise, controller, context: context({ isCurrent: () => routeCurrent }) });
  if (reason === 'route') {
    routeCurrent = false;
  }
  if (reason === 'storage') {
    mocks.storageCurrent = false;
  }
  if (reason === 'abort') {
    controller.abort();
  }
  directories.resolve([]);
  await result;
  expect(mocks.importDirectory).not.toHaveBeenCalled();
  expect(mocks.prepare).not.toHaveBeenCalled();
});

it('retries a failed single configuration with the same ids and without registering its files again', async () => {
  mocks.prepare.mockRejectedValueOnce(new Error('partial write'));
  await expect(startLocalModelInput({ directories: Promise.resolve([{ rootName: 'local', files: [] }]), controller: new AbortController(), context: context({ isCurrent: () => true }) })).rejects.toThrow('partial write');
  const { selection, choose } = useBrowserModelLocalInputSelection();
  expect(selection.value?.error).toBe('start-failed');
  await choose({ modelId: first.modelId });
  expect(mocks.prepare.mock.calls[1]?.[0].request).toEqual(mocks.prepare.mock.calls[0]?.[0].request);
  expect(mocks.importDirectory).toHaveBeenCalledOnce();
});

it('coalesces duplicate input dispatch and duplicate local-model clicks', async () => {
  const controller = new AbortController();
  const directories = Promise.withResolvers<[]>();
  const captured = context({ isCurrent: () => true });
  const pending = startLocalModelInput({ directories: directories.promise, controller, context: captured });
  expect(startLocalModelInput({ directories: directories.promise, controller, context: captured })).toBe(pending);
  directories.resolve([]);
  await expect(pending).rejects.toThrow();
  const modelRead = Promise.withResolvers<LocalModel>();
  mocks.getModel.mockReturnValue(modelRead.promise);
  const { startLocalModel } = await render();
  const one = startLocalModel({ model: first, signal: controller.signal });
  const two = startLocalModel({ model: first, signal: controller.signal });
  expect(one).toBe(two);
  modelRead.resolve(first);
  await one;
  expect(mocks.prepare).toHaveBeenCalledOnce();
  expect(mocks.initializeDefaults).not.toHaveBeenCalled();
});

it.each(['route', 'route roundtrip', 'storage', 'source', 'abort', 'unmount'])('never navigates after a saved local chat loses its capability (%s)', async reason => {
  const saved = Promise.withResolvers<Chat>();
  mocks.prepare.mockReturnValue(saved.promise);
  const { router, wrapper, startLocalModel } = await render();
  const controller = new AbortController();
  const pending = startLocalModel({ model: first, signal: controller.signal });
  await flushPromises();
  if (reason === 'route' || reason === 'route roundtrip') {
    await router.push('/elsewhere');
  }
  if (reason === 'route roundtrip') {
    await router.push('/');
  }
  if (reason === 'storage') {
    mocks.storageCurrent = false;
  }
  if (reason === 'source') {
    mocks.sourceCurrent = false;
  }
  if (reason === 'abort') {
    controller.abort();
  }
  if (reason === 'unmount') {
    wrapper.unmount();
  }
  const push = vi.spyOn(router, 'push');
  saved.resolve({ id: mocks.prepare.mock.calls[0]?.[0].request.chatId, groupId: mocks.prepare.mock.calls[0]?.[0].request.chatGroupId, title: null, root: { items: [] }, createdAt: 1, updatedAt: 1, debugEnabled: false });
  if (reason === 'source') {
    await expect(pending).rejects.toThrow('files changed');
  } else {
    await pending;
  }
  expect(push).not.toHaveBeenCalled();
  expect(mocks.offer).not.toHaveBeenCalled();
});

it('uses new reservation ids for a newly registered temporary source after an earlier partial launch settled', async () => {
  let registration = 1;
  mocks.captureSource.mockImplementation(async () => {
    const captured = registration;
    return { model: first, rootPath: 'temp/local', registrationRevision: captured, isCurrent: () => registration === captured };
  });
  mocks.prepare.mockRejectedValueOnce(new Error('partial write'));
  const { startLocalModel } = await render();
  const signal = new AbortController().signal;
  await expect(startLocalModel({ model: first, signal })).rejects.toThrow('partial write');
  registration++;
  await startLocalModel({ model: first, signal });
  expect(mocks.prepare).toHaveBeenCalledTimes(2);
  expect(mocks.prepare.mock.calls[1]![0].request.chatId).not.toBe(mocks.prepare.mock.calls[0]![0].request.chatId);
  expect(mocks.prepare.mock.calls[1]![0].request.chatGroupId).not.toBe(mocks.prepare.mock.calls[0]![0].request.chatGroupId);
  expect(mocks.captureSource).toHaveBeenCalledTimes(2);
  expect(mocks.offer).toHaveBeenCalledWith(expect.objectContaining({ source: expect.objectContaining({ registrationRevision: 2 }) }));
});

it('retires an earlier file input when a newer input starts in the same home', async () => {
  const earlier = Promise.withResolvers<[]>();
  const priorController = new AbortController();
  const captured = context({ isCurrent: () => true });
  const pending = startLocalModelInput({ directories: earlier.promise, controller: priorController, context: captured });
  await startLocalModelInput({ directories: Promise.resolve([{ rootName: 'local', files: [] }]), controller: new AbortController(), context: captured });
  earlier.resolve([]);
  await pending;
  expect(priorController.signal.aborted).toBe(true);
  expect(mocks.prepare).toHaveBeenCalledOnce();
});

it('invalidates local-model admission when a newer model is selected', async () => {
  const firstRead = Promise.withResolvers<LocalModel>();
  mocks.getModel.mockReturnValueOnce(firstRead.promise).mockResolvedValue(second);
  const { startLocalModel } = await render();
  const signal = new AbortController().signal;
  const previous = startLocalModel({ model: first, signal });
  await flushPromises();
  await startLocalModel({ model: second, signal });
  firstRead.resolve(first);
  await previous;
  expect(mocks.prepare).toHaveBeenCalledOnce();
  expect(mocks.prepare.mock.calls[0]?.[0].request.modelId).toBe(second.modelId);
});

it.each(['capture', 'save'])('opens the saved local chat and offers file storage after the default setting fails (%s)', async failure => {
  if (failure === 'capture') {
    mocks.captureDefaults.mockRejectedValueOnce(new Error('settings unavailable'));
  } else {
    mocks.initializeDefaults.mockRejectedValueOnce(new Error('settings quota exceeded'));
  }
  await startLocalModelInput({ directories: Promise.resolve([{ rootName: 'local', files: [] }]), controller: new AbortController(), context: context({ isCurrent: () => true }) });
  expect(mocks.prepare).toHaveBeenCalledOnce();
  expect(mocks.navigate).toHaveBeenCalledOnce();
  expect(mocks.offer).toHaveBeenCalledOnce();
  expect(mocks.warning).toHaveBeenCalledExactlyOnceWith({ message: 'Could not save the default model. Your chat is ready.', duration: 5000 });
  expect(mocks.initializeDefaults).toHaveBeenCalledTimes(failure === 'capture' ? 0 : 1);
  expect(useBrowserModelLocalInputSelection().selection.value).toBeUndefined();
});

it('uses only the default snapshot captured by the original click when the lazy command arrives later', async () => {
  const clickContext = context({ isCurrent: () => true });
  mocks.captureDefaults.mockResolvedValue({ endpoint: { type: 'openai', url: 'https://changed.example' }, modelId: undefined, revision: 2, storedMatches: true, isStorageCurrent: () => true });
  await startLocalModelInput({ directories: Promise.resolve([{ rootName: 'local', files: [] }]), controller: new AbortController(), context: clickContext });
  expect(mocks.captureDefaults).toHaveBeenCalledOnce();
  expect(mocks.initializeDefaults).toHaveBeenCalledWith({ modelId: first.modelId, expected: expect.objectContaining({ endpoint: { type: 'openai', url: '' }, revision: 0 }) });
});

it('opens the local chat without acquiring new default authority when the click had none', async () => {
  const clickContext: ModelLaunchStartContext = { ...context({ isCurrent: () => true }), defaults: Promise.resolve(undefined) };
  mocks.captureDefaults.mockClear();
  await startLocalModelInput({ directories: Promise.resolve([{ rootName: 'local', files: [] }]), controller: new AbortController(), context: clickContext });
  expect(mocks.captureDefaults).not.toHaveBeenCalled();
  expect(mocks.initializeDefaults).not.toHaveBeenCalled();
  expect(mocks.navigate).toHaveBeenCalledOnce();
});

it('continues the selected model after another model notifies while its initial file read is pending', async () => {
  const read = Promise.withResolvers<LocalModel>();
  mocks.getModel.mockReturnValueOnce(read.promise);
  const { router, startLocalModel } = await render();
  const pending = startLocalModel({ model: first, signal: new AbortController().signal });
  await flushPromises();
  notifyModels();
  read.resolve(first);
  await pending;
  expect(mocks.prepare).toHaveBeenCalledOnce();
  expect(router.currentRoute.value.path).toMatch(/^\/chat\//);
  expect(mocks.getModel.mock.calls.every(([request]) => request.modelId === first.modelId)).toBe(true);
  expect(mocks.captureSource).toHaveBeenCalledOnce();
});

it.each(['storage', 'sidebar'])('waits for selected-model revalidation and still hands off after an unrelated notification during %s', async stage => {
  const saved = Promise.withResolvers<Chat>();
  const sidebar = Promise.withResolvers<void>();
  const revalidated = Promise.withResolvers<LocalModel>();
  if (stage === 'storage') {
    mocks.prepare.mockReturnValueOnce(saved.promise);
  } else {
    mocks.loadData.mockReturnValueOnce(sidebar.promise);
  }
  const { router, startLocalModel } = await render();
  const pending = startLocalModel({ model: first, signal: new AbortController().signal });
  await flushPromises();
  mocks.getModel.mockReturnValueOnce(revalidated.promise);
  notifyModels();
  if (stage === 'storage') {
    saved.resolve(savedChat({ request: mocks.prepare.mock.calls[0]![0].request }));
  } else {
    sidebar.resolve();
  }
  await flushPromises();
  expect(router.currentRoute.value.path).toBe('/');
  revalidated.resolve(first);
  await pending;
  expect(mocks.prepare).toHaveBeenCalledOnce();
  expect(router.currentRoute.value.path).toMatch(/^\/chat\//);
  expect(mocks.offer).toHaveBeenCalledOnce();
  expect(mocks.captureSource).toHaveBeenCalledOnce();
});

it('retries the same unwritten storage reservation when a generic notice reaches its synchronous guard before validation finishes', async () => {
  const stored: LocalModel = { ...first, modelId: 'user/local' };
  const revalidated = Promise.withResolvers<LocalModel>();
  const commit = vi.fn();
  mocks.getModel.mockResolvedValueOnce(stored).mockReturnValueOnce(revalidated.promise).mockResolvedValue(stored);
  mocks.prepare.mockImplementationOnce(async ({ isCurrent }: { isCurrent(): boolean }) => {
    notifyModels();
    expect(isCurrent()).toBe(false);
    throw new Error('The local model launch source changed');
  }).mockImplementation(async ({ request }: { request: { chatId: Chat['id'], chatGroupId: Chat['groupId'] } }) => {
    commit();
    return savedChat({ request });
  });
  const { router, startLocalModel } = await render();
  const pending = startLocalModel({ model: stored, signal: new AbortController().signal });
  await flushPromises();
  expect(mocks.prepare).toHaveBeenCalledOnce();
  expect(commit).not.toHaveBeenCalled();
  revalidated.resolve(stored);
  await pending;
  expect(mocks.prepare).toHaveBeenCalledTimes(2);
  expect(mocks.prepare.mock.calls[1]![0].request).toEqual(mocks.prepare.mock.calls[0]![0].request);
  expect(commit).toHaveBeenCalledOnce();
  expect(router.currentRoute.value.path).toMatch(/^\/chat\//);
});

it.each(['removed', 'replaced'])('rejects visibly when the selected stored model is %s during a saved-chat wait', async change => {
  const stored: LocalModel = { ...first, modelId: 'user/local' };
  const saved = Promise.withResolvers<Chat>();
  mocks.getModel.mockResolvedValue(stored);
  mocks.prepare.mockReturnValueOnce(saved.promise);
  const { router, startLocalModel } = await render();
  const pending = startLocalModel({ model: stored, signal: new AbortController().signal });
  await flushPromises();
  if (change === 'removed') {
    mocks.getModel.mockRejectedValue(new Error('Selected local model unavailable'));
  } else {
    mocks.getModel.mockResolvedValue({ ...stored, importedAt: stored.importedAt + 1 });
  }
  notifyModels();
  await flushPromises();
  saved.resolve(savedChat({ request: mocks.prepare.mock.calls[0]![0].request }));
  await expect(pending).rejects.toThrow(change === 'removed' ? 'unavailable' : 'files changed');
  expect(router.currentRoute.value.path).toBe('/');
  expect(mocks.offer).not.toHaveBeenCalled();
});

it('rejects the original temporary registration in flight and lets a new explicit Start capture its replacement after settlement', async () => {
  let registration = 1;
  const saved = Promise.withResolvers<Chat>();
  mocks.captureSource.mockImplementation(async () => {
    const captured = registration;
    return { model: first, rootPath: 'temp/local', registrationRevision: captured, isCurrent: () => registration === captured };
  });
  mocks.prepare.mockReturnValueOnce(saved.promise);
  const { router, startLocalModel } = await render();
  const pending = startLocalModel({ model: first, signal: new AbortController().signal });
  await flushPromises();
  registration++;
  notifyModels();
  expect(startLocalModel({ model: first, signal: new AbortController().signal })).toBe(pending);
  expect(mocks.captureSource).toHaveBeenCalledOnce();
  saved.resolve(savedChat({ request: mocks.prepare.mock.calls[0]![0].request }));
  await expect(pending).rejects.toThrow('files changed');
  expect(mocks.captureSource).toHaveBeenCalledOnce();
  expect(router.currentRoute.value.path).toBe('/');
  await startLocalModel({ model: first, signal: new AbortController().signal });
  expect(mocks.captureSource).toHaveBeenCalledTimes(2);
  expect(mocks.prepare).toHaveBeenCalledTimes(2);
  expect(mocks.prepare.mock.calls[1]![0].request.chatId).not.toBe(mocks.prepare.mock.calls[0]![0].request.chatId);
  expect(mocks.prepare.mock.calls[1]![0].request.chatGroupId).not.toBe(mocks.prepare.mock.calls[0]![0].request.chatGroupId);
  expect(router.currentRoute.value.path).toMatch(/^\/chat\//);
});

it('does not let an older successful read authorize a newer selected-model removal notification', async () => {
  const stored: LocalModel = { ...first, modelId: 'user/local' };
  const stale = Promise.withResolvers<LocalModel>();
  const saved = Promise.withResolvers<Chat>();
  mocks.getModel.mockResolvedValueOnce(stored).mockReturnValueOnce(stale.promise).mockRejectedValue(new Error('Selected local model unavailable'));
  mocks.prepare.mockReturnValueOnce(saved.promise);
  const { router, startLocalModel } = await render();
  const pending = startLocalModel({ model: stored, signal: new AbortController().signal });
  await flushPromises();
  notifyModels();
  notifyModels();
  stale.resolve(stored);
  await flushPromises();
  saved.resolve(savedChat({ request: mocks.prepare.mock.calls[0]![0].request }));
  await expect(pending).rejects.toThrow('unavailable');
  expect(router.currentRoute.value.path).toBe('/');
});

it('revalidates the selected model immediately before handoff even without a list notification', async () => {
  const stored: LocalModel = { ...first, modelId: 'user/local' };
  mocks.getModel.mockResolvedValue(stored);
  mocks.loadData.mockImplementationOnce(async () => {
    mocks.getModel.mockRejectedValue(new Error('Selected local model unavailable'));
  });
  const { router, startLocalModel } = await render();
  await expect(startLocalModel({ model: stored, signal: new AbortController().signal })).rejects.toThrow('unavailable');
  expect(mocks.prepare).toHaveBeenCalledOnce();
  expect(router.currentRoute.value.path).toBe('/');
  expect(mocks.offer).not.toHaveBeenCalled();
});

it('suppresses a late model-read failure only after the user has left the originating route', async () => {
  const read = Promise.withResolvers<LocalModel>();
  mocks.getModel.mockReturnValueOnce(read.promise);
  const { router, startLocalModel } = await render();
  const pending = startLocalModel({ model: first, signal: new AbortController().signal });
  await flushPromises();
  await router.push('/elsewhere');
  read.reject(new Error('Selected local model unavailable'));
  await expect(pending).resolves.toBeUndefined();
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(router.currentRoute.value.path).toBe('/elsewhere');
});

it('reports a changed dropped File registration while the original input UI remains current', async () => {
  const saved = Promise.withResolvers<Chat>();
  mocks.prepare.mockReturnValueOnce(saved.promise);
  const pending = startLocalModelInput({ directories: Promise.resolve([{ rootName: 'local', files: [] }]), controller: new AbortController(), context: context({ isCurrent: () => true }) });
  await flushPromises();
  mocks.sourceCurrent = false;
  saved.resolve(savedChat({ request: mocks.prepare.mock.calls[0]![0].request }));
  await expect(pending).rejects.toThrow('files changed');
  expect(mocks.navigate).not.toHaveBeenCalled();
  expect(mocks.offer).not.toHaveBeenCalled();
  expect(useBrowserModelLocalInputSelection().selection.value?.error).toBe('start-failed');
});

it('does not adopt a replacement stored model when its original selection read was still pending', async () => {
  const stored: LocalModel = { ...first, modelId: 'user/local' };
  const read = Promise.withResolvers<LocalModel>();
  mocks.getModel.mockReturnValueOnce(read.promise).mockResolvedValue({ ...stored, importedAt: stored.importedAt + 1 });
  const { router, startLocalModel } = await render();
  const pending = startLocalModel({ model: stored, signal: new AbortController().signal });
  await flushPromises();
  notifyModels();
  read.resolve(stored);
  await expect(pending).rejects.toThrow('files changed');
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(router.currentRoute.value.path).toBe('/');
});

it('does not retry an actual storage I/O failure just because an unrelated notification happened first', async () => {
  mocks.prepare.mockImplementationOnce(async ({ isCurrent }: { isCurrent(): boolean }) => {
    notifyModels();
    await flushPromises();
    expect(isCurrent()).toBe(true);
    throw new Error('Storage quota exceeded');
  });
  const { router, startLocalModel } = await render();
  await expect(startLocalModel({ model: first, signal: new AbortController().signal })).rejects.toThrow('Storage quota exceeded');
  expect(mocks.prepare).toHaveBeenCalledOnce();
  expect(router.currentRoute.value.path).toBe('/');
});

it('keeps a changed input File registration visible as a failure after waiting for the click default snapshot', async () => {
  const defaults = Promise.withResolvers<Awaited<ModelLaunchStartContext['defaults']>>();
  const clickContext = { ...context({ isCurrent: () => true }), defaults: defaults.promise };
  const pending = startLocalModelInput({ directories: Promise.resolve([{ rootName: 'local', files: [] }]), controller: new AbortController(), context: clickContext });
  await flushPromises();
  mocks.sourceCurrent = false;
  defaults.resolve(undefined);
  await expect(pending).rejects.toThrow('files changed');
  expect(mocks.navigate).not.toHaveBeenCalled();
  expect(useBrowserModelLocalInputSelection().selection.value?.error).toBe('start-failed');
});

it('does not erase an observed selected-model read failure when another generic notice arrives meanwhile', async () => {
  const read = Promise.withResolvers<LocalModel>();
  mocks.getModel.mockReturnValueOnce(read.promise);
  const { router, startLocalModel } = await render();
  const pending = startLocalModel({ model: first, signal: new AbortController().signal });
  await flushPromises();
  notifyModels();
  read.reject(new Error('Selected local model unavailable'));
  await expect(pending).rejects.toThrow('unavailable');
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(router.currentRoute.value.path).toBe('/');
});
