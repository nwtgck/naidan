import { mount, flushPromises } from '@vue/test-utils';
import { computed, defineComponent, ref } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStorageProvider } from '@/00-storage/service/memory-storage';
import { prepareModelLaunchChat, readModelLaunch, type ModelLaunchChatRequest } from '@/00-storage/service/model-launch';
import type { RepositoryCatalog } from '@/features/llama-cpp-browser/hugging-face/catalog';
import { useModelLaunchCoordinator } from './useModelLaunchCoordinator';
import { confirmModelLaunchSelection, modelLaunchEntryState, registerModelLaunchEntryContext, retireModelLaunch, startModelLaunch, retryModelLaunch, TEST_ONLY } from '@/features/llama-cpp-browser/model-launch/entry-state';
import { consumeModelLaunchSession, readModelLaunchSession, TEST_ONLY as sessionTestOnly } from '@/features/llama-cpp-browser/model-launch/session';
import type { ModelLaunchDefaultSnapshot } from '@/features/llama-cpp-browser/model-launch/defaults';
import { DEFAULT_SETTINGS } from '@/01-models/types';
const initialized = ref(true);
const settings = ref({ ...DEFAULT_SETTINGS, storageType: 'memory' as const, endpoint: { type: 'openai' as const, url: '' } });
const interaction = ref('enabled');
let provider: MemoryStorageProvider;
let storageCurrent = true;
const inspect = vi.fn();
const enqueue = vi.fn();
const captureDefaults = vi.fn<() => Promise<ModelLaunchDefaultSnapshot | undefined>>(async () => undefined);
let entryRouter: ReturnType<typeof createRouter>;
let homeOriginId: string | undefined;
let handoffPath: string | undefined;
const contextOwner = ref(Symbol('entry'));
const prepare = vi.fn(async ({ request }: { request: ModelLaunchChatRequest }) => prepareModelLaunchChat({ provider, request }));
vi.mock('@/composables/useSettings', () => ({ useSettings: () => ({ initialized, settings, captureModelLaunchDefaults: captureDefaults }) }));
vi.mock('@/composables/useAppEntry', () => ({
  useAppEntry: () => ({
    interaction: computed(() => interaction.value === 'enabled' ? 'ready' : 'blocked'),
    intent: computed(() => ({ owner: contextOwner.value })),
    captureModelLaunchContext: () => {
      const fullPath = entryRouter.currentRoute.value.fullPath;
      const owner = contextOwner.value;
      return {
        owner,
        homeOriginId,
        mode: homeOriginId === undefined ? 'model-preview' : 'home',
        fullPath,
        routePath: entryRouter.currentRoute.value.path,
        isCurrent: () => contextOwner.value === owner && (entryRouter.currentRoute.value.fullPath === fullPath || entryRouter.currentRoute.value.path === handoffPath),
      };
    },
    prepareModelLaunchHandoff: ({ chatPath }: { chatPath: string }) => {
      handoffPath = chatPath;
      return true;
    },
  }),
}));
vi.mock('@/composables/useAppPresentation', () => ({ useAppPresentation: () => ({ appInteraction: interaction }), isAppInteractionEnabled: ({ interaction }: { interaction: string }) => interaction === 'enabled' }));
vi.mock('@/composables/chat/global/chat-core-singletons', () => ({ loadData: vi.fn(async () => {}), registerLiveInstance: vi.fn() }));
vi.mock('../hugging-face/download-queue', () => ({ getDownloadQueue: () => ({ enqueue }) }));
vi.mock('../model-launch/readiness', () => ({ isModelLaunchTargetReady: vi.fn(async () => false) }));
vi.mock('../hugging-face/metadata-session', () => ({ getMetadataSession: () => ({ inspect }) }));
vi.mock('@/00-storage/service', () => ({
  storageService: {
    loadChatMeta: ({ id }: Parameters<MemoryStorageProvider['loadChatMeta']>[0]) => provider.loadChatMeta({ id }),
    loadChat: ({ id }: Parameters<MemoryStorageProvider['loadChat']>[0]) => provider.loadChat({ id }),
    loadChatContent: ({ id }: Parameters<MemoryStorageProvider['loadChatContent']>[0]) => provider.loadChatContent({ id }),
    loadChatGroup: ({ id }: Parameters<MemoryStorageProvider['loadChatGroup']>[0]) => provider.loadChatGroup({ id }),
    loadHierarchy: async () => (await provider.loadHierarchy()) ?? { items: [] },
    getModelLaunch: ({ chatId }: { chatId: ModelLaunchChatRequest['chatId'] }) => readModelLaunch({ provider, chatId }),
    prepareModelLaunchChat: (args: { request: ModelLaunchChatRequest }) => prepare(args),
    captureModelLaunchStorage: () => () => storageCurrent,
    subscribeToChanges: vi.fn(() => () => {}),
  },
}));
const catalog: RepositoryCatalog = { repository: 'owner/Model-GGUF', revision: 'a'.repeat(40), projectors: [], models: [{ label: 'Model-Q4_K_M', size: 256, files: [{ path: 'Model-Q4_K_M.gguf', size: 256 }] }] };
const hosts: ReturnType<typeof mount>[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  provider = new MemoryStorageProvider();
  storageCurrent = true;
  initialized.value = true;
  interaction.value = 'enabled';
  TEST_ONLY.reset();
  sessionTestOnly.reset();
  homeOriginId = undefined;
  handoffPath = undefined;
  contextOwner.value = Symbol('entry');
  window.history.replaceState({}, '');
  inspect.mockResolvedValue(catalog);
  captureDefaults.mockResolvedValue(undefined);
});

afterEach(() => {
  hosts.splice(0).forEach(wrapper => wrapper.unmount());
});

async function mountCoordinator({ path, beforeMount }: { path: string, beforeMount?: () => void | Promise<void> }) {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }, { path: '/home', component: { template: '<div />' } }, { path: '/settings/connection', component: { template: '<div />' } }, { path: '/chat/:id', component: { template: '<div />' } }, { path: '/elsewhere', component: { template: '<div />' } }] });
  entryRouter = router;
  await router.push(path);
  await router.isReady();
  await beforeMount?.();
  const wrapper = mount(defineComponent({
    setup() {
      useModelLaunchCoordinator();
      return {};
    },
    template: '<div />',
  }), { global: { plugins: [router] } });
  hosts.push(wrapper);
  return router;
}

function clickStart() {
  const rawInput = entryRouter.currentRoute.value.query['llama-cpp-browser-model'];
  const input = typeof rawInput === 'string' ? rawInput : '';
  return startModelLaunch({
    request: {
      input,
      requestedVariant: input.includes(':') ? input.split(':').at(-1) : undefined,
      destination: { kind: 'opfs' },
      multimodal: 'auto',
      source: 'model-url',
    },
  });
}

async function start({ path }: { path: string }) {
  const router = await mountCoordinator({ path });
  clickStart();
  return router;
}

describe('direct-chat model link coordinator', () => {
  it('uses the first real quantization when an unspecified link is started before preview metadata finishes', async () => {
    const pending = Promise.withResolvers<RepositoryCatalog>();
    inspect.mockReturnValueOnce(pending.promise);
    const router = await mountCoordinator({ path: '/?llama-cpp-browser-model=owner/Model-GGUF' });
    clickStart();
    await flushPromises();
    expect(prepare).not.toHaveBeenCalled();
    pending.resolve({
      ...catalog,
      models: ['Model-Q8_0.gguf', 'Model-Q4_K_M.gguf'].map(path => ({ label: path, files: [{ path, size: 256 }], size: 256 })),
    });
    await vi.waitFor(() => expect(router.currentRoute.value.path).toMatch(/^\/chat\//));
    expect(prepare.mock.calls[0]![0].request.target.mainFilePath).toBe('Model-Q4_K_M.gguf');
  });

  it('drains one Start accepted before the runtime chunk activates', async () => {
    let unregister = () => {};
    using _cleanup = {
      [Symbol.dispose]() {
        unregister();
      },
    };
    const router = await mountCoordinator({
      path: '/?llama-cpp-browser-model=owner/Model-GGUF',
      beforeMount: () => {
        unregister = registerModelLaunchEntryContext({ capture: () => ({ owner: contextOwner.value, isCurrent: () => true, defaults: captureDefaults() }) });
        const operation = clickStart();
        expect(clickStart()).toBe(operation);
        expect(inspect).not.toHaveBeenCalled();
      },
    });
    await vi.waitFor(() => expect(router.currentRoute.value.path).toMatch(/^\/chat\//));
    expect(inspect).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledOnce();
  });

  it('keeps the click-time default snapshot when settings change and clear before runtime activation', async () => {
    const snapshot: ModelLaunchDefaultSnapshot = { endpoint: { type: 'openai', url: '' }, modelId: undefined, revision: 1, storedMatches: true, isStorageCurrent: () => true };
    const laterSnapshot = { ...snapshot, revision: 3 };
    captureDefaults.mockResolvedValueOnce(snapshot).mockResolvedValue(laterSnapshot);
    let unregister = () => {};
    using _cleanup = {
      [Symbol.dispose]() {
        unregister();
      },
    };
    const router = await mountCoordinator({
      path: '/?llama-cpp-browser-model=owner/Model-GGUF',
      beforeMount: () => {
        unregister = registerModelLaunchEntryContext({ capture: () => ({ owner: contextOwner.value, isCurrent: () => true, defaults: captureDefaults() }) });
        clickStart();
        settings.value = { ...settings.value, defaultModelId: 'user-selection' };
        settings.value = { ...settings.value, defaultModelId: undefined };
        expect(captureDefaults).toHaveBeenCalledOnce();
      },
    });
    await vi.waitFor(() => expect(router.currentRoute.value.path).toMatch(/^\/chat\//));
    const chatId = prepare.mock.calls[0]![0].request.chatId;
    const session = readModelLaunchSession({ chatId });
    expect(await session?.defaults).toBe(snapshot);
    expect(captureDefaults).toHaveBeenCalledOnce();
  });

  it('discards a queued Start whose entry owner retired before runtime activation', async () => {
    let unregister = () => {};
    using _cleanup = {
      [Symbol.dispose]() {
        unregister();
      },
    };
    const router = await mountCoordinator({
      path: '/?llama-cpp-browser-model=owner/Model-GGUF',
      beforeMount: async () => {
        const source = entryRouter.currentRoute.value.fullPath;
        unregister = registerModelLaunchEntryContext({ capture: () => ({ owner: contextOwner.value, isCurrent: () => entryRouter.currentRoute.value.fullPath === source, defaults: captureDefaults() }) });
        clickStart();
        await entryRouter.push('/elsewhere');
      },
    });
    await flushPromises();
    expect(inspect).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(router.currentRoute.value.path).toBe('/elsewhere');
    expect(modelLaunchEntryState.value.status).toBe('idle');
  });

  it('keeps a newer queued Start when an older view retires after runtime loading begins', async () => {
    let unregister = () => {};
    using _cleanup = {
      [Symbol.dispose]() {
        unregister();
      },
    };
    const router = await mountCoordinator({
      path: '/?llama-cpp-browser-model=owner/Model-GGUF',
      beforeMount: () => {
        unregister = registerModelLaunchEntryContext({ capture: () => ({ owner: contextOwner.value, isCurrent: () => true, defaults: captureDefaults() }) });
        const first = clickStart();
        retireModelLaunch({ operation: first });
        const second = clickStart();
        expect(second).not.toBe(first);
        retireModelLaunch({ operation: first });
        expect(modelLaunchEntryState.value).toMatchObject({ status: 'checking', operation: second });
      },
    });
    await vi.waitFor(() => expect(router.currentRoute.value.path).toMatch(/^\/chat\//));
    expect(inspect).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledOnce();
  });

  it.each(['/', '/chat/existing', '/settings/connection'])('does no remote or durable work before Start on %s', async path => {
    const router = await mountCoordinator({ path: `${path}?llama-cpp-browser-model=owner/Model-GGUF&q=ignored&data-zip=ignored` });
    const original = router.currentRoute.value.fullPath;
    await flushPromises();
    expect(inspect).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(router.currentRoute.value.fullPath).toBe(original);
  });

  it('saves after Start before replacing the root URL and discards every ignored query', async () => {
    const router = await start({ path: '/?llama-cpp-browser-model=hf.co/owner/Model-GGUF:Q4_K_M&q=DO-NOT-SEND&other=value' });
    await vi.waitFor(() => expect(router.currentRoute.value.path).toMatch(/^\/chat\//));
    expect(router.currentRoute.value.query).toEqual({});
    expect(prepare).toHaveBeenCalledOnce();
    const req = prepare.mock.calls[0]![0].request;
    expect((await provider.loadChat({ id: req.chatId }))?.root.items).toEqual([]);
    expect((await provider.loadChatGroup({ id: (await provider.loadChat({ id: req.chatId }))!.groupId! }))?.endpoint).toEqual({ type: 'llama_cpp_browser' });
    expect(await readModelLaunchSession({ chatId: req.chatId })?.defaults).toBeUndefined();
    expect(captureDefaults).not.toHaveBeenCalled();
  });

  it('does not process before startup permits interaction', async () => {
    interaction.value = 'blocked-by-startup';
    const router = await start({ path: '/?llama-cpp-browser-model=owner/Model-GGUF' });
    await flushPromises();
    expect(inspect).not.toHaveBeenCalled();
    interaction.value = 'enabled';
    await flushPromises();
    expect(inspect).not.toHaveBeenCalled();
    clickStart();
    await vi.waitFor(() => expect(router.currentRoute.value.path).toMatch(/^\/chat\//));
  });

  it('does not steal navigation after a late metadata response, even if the transport ignores abort', async () => {
    const pending = Promise.withResolvers<RepositoryCatalog>();
    inspect.mockReturnValueOnce(pending.promise);
    const router = await start({ path: '/?llama-cpp-browser-model=owner/Model-GGUF' });
    await vi.waitFor(() => expect(inspect).toHaveBeenCalledOnce());
    await router.push('/elsewhere');
    pending.resolve(catalog);
    await flushPromises();
    expect(prepare).not.toHaveBeenCalled();
    expect(router.currentRoute.value.path).toBe('/elsewhere');
  });

  it('retires a pending home launch when a new home owner keeps the same path', async () => {
    homeOriginId = 'first-home-origin';
    const pending = Promise.withResolvers<RepositoryCatalog>();
    inspect.mockReturnValueOnce(pending.promise);
    const router = await mountCoordinator({ path: '/home' });
    const request = { input: catalog.repository, requestedVariant: 'Q4_K_M', multimodal: 'auto' as const, destination: { kind: 'opfs' as const }, source: 'home' as const };
    startModelLaunch({ request });
    await vi.waitFor(() => expect(inspect).toHaveBeenCalledOnce());
    homeOriginId = 'second-home-origin';
    contextOwner.value = Symbol('new-home-entry');
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/home');
    expect(modelLaunchEntryState.value.status).toBe('idle');
    pending.resolve(catalog);
    await flushPromises();
    expect(prepare).not.toHaveBeenCalled();
    startModelLaunch({ request });
    await vi.waitFor(() => expect(router.currentRoute.value.path).toMatch(/^\/chat\//));
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(prepare).toHaveBeenCalledOnce();
  });

  it('does not transfer an old metadata result to a different storage provider', async () => {
    const pending = Promise.withResolvers<RepositoryCatalog>();
    inspect.mockReturnValueOnce(pending.promise);
    const router = await start({ path: '/?llama-cpp-browser-model=owner/Model-GGUF' });
    await vi.waitFor(() => expect(inspect).toHaveBeenCalledOnce());
    storageCurrent = false;
    pending.resolve(catalog);
    await flushPromises();
    expect(prepare).not.toHaveBeenCalled();
    expect(router.currentRoute.value.path).toBe('/');
  });

  it.each(['/?llama-cpp-browser-model=', '/?llama-cpp-browser-model=one&llama-cpp-browser-model=two', '/?llama-cpp-browser-model=https://external.example/model'])('rejects invalid source %s without a download or storage write', async path => {
    const router = await start({ path });
    await flushPromises();
    expect(modelLaunchEntryState.value.status).toBe('failed');
    expect(inspect).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(router.currentRoute.value.path).toBe('/');
  });

  it('reuses a preserved reservation on a new explicit Start after an ignored query changes', async () => {
    const pending = Promise.withResolvers<RepositoryCatalog>();
    inspect.mockReturnValueOnce(pending.promise);
    const router = await start({ path: '/?llama-cpp-browser-model=owner/Model-GGUF' });
    const removeGuard = router.beforeEach(to => to.path.startsWith('/chat/') ? false : true);
    pending.resolve(catalog);
    await vi.waitFor(() => expect(modelLaunchEntryState.value.status).toBe('failed'));
    const first = prepare.mock.calls[0]![0].request;
    removeGuard();
    await router.replace({ query: { ...router.currentRoute.value.query, settings: 'llama-cpp-browser' }, state: { ...router.options.history.state } });
    clickStart();
    await vi.waitFor(() => expect(router.currentRoute.value.path).toMatch(/^\/chat\//));
    expect(prepare.mock.calls[1]![0].request.chatId).toBe(first.chatId);
    expect(inspect).toHaveBeenCalledOnce();
    expect((await provider.loadHierarchy())?.items).toHaveLength(1);
  });

  it('retains the parameter on storage failure and retries the same reserved identifiers', async () => {
    prepare.mockRejectedValueOnce(new Error('quota'));
    const router = await start({ path: '/?llama-cpp-browser-model=owner/Model-GGUF' });
    await vi.waitFor(() => expect(modelLaunchEntryState.value.status).toBe('failed'));
    expect(router.currentRoute.value.query['llama-cpp-browser-model']).toBeDefined();
    const first = prepare.mock.calls[0]![0].request;
    retryModelLaunch();
    await vi.waitFor(() => expect(router.currentRoute.value.path).toMatch(/^\/chat\//));
    expect(prepare.mock.calls[1]![0].request.chatId).toBe(first.chatId);
  });

  it('accepts a later identical link as a new chat in the same chat group', async () => {
    const source = '/?llama-cpp-browser-model=owner/Model-GGUF';
    const router = await start({ path: source });
    await vi.waitFor(() => expect(router.currentRoute.value.path).toMatch(/^\/chat\//));
    const first = router.currentRoute.value.path;
    await router.push(source);
    clickStart();
    await vi.waitFor(() => expect(router.currentRoute.value.path).toMatch(/^\/chat\//));
    expect(router.currentRoute.value.path).not.toBe(first);
    expect((await provider.loadHierarchy())?.items).toHaveLength(1);
  });

  it('confirms real main and companion choices from the original catalog without another inspect', async () => {
    const original = {
      ...catalog,
      projectors: ['mmproj-vision-a.gguf', 'mmproj-vision-b.gguf'].map(path => ({ path, size: 256 })),
      models: ['first-Q4_K_M.gguf', 'second-Q4_K_M.gguf'].map(path => ({ label: path, size: 256, files: [{ path, size: 256 }] })),
    };
    inspect.mockResolvedValueOnce(original);
    await mountCoordinator({ path: '/?llama-cpp-browser-model=owner/Model-GGUF:Q4_K_M' });
    const operation = clickStart();
    expect(clickStart()).toBe(operation);
    await vi.waitFor(() => expect(modelLaunchEntryState.value.status).toBe('needs-selection'));
    expect(prepare).not.toHaveBeenCalled();
    inspect.mockResolvedValue({ ...original, revision: 'b'.repeat(40) });
    confirmModelLaunchSelection({ operation, mainFilePath: 'second-Q4_K_M.gguf', companionFilePath: 'mmproj-vision-b.gguf' });
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    expect(inspect).toHaveBeenCalledOnce();
    expect(prepare.mock.calls[0]![0].request.target.selection).toEqual({
      repository: catalog.repository,
      revision: catalog.revision,
      files: [{ path: 'second-Q4_K_M.gguf', size: 256 }, { path: 'mmproj-vision-b.gguf', size: 256 }],
    });
  });

  it('retires metadata on an explicit close even when the response ignores abort', async () => {
    const pending = Promise.withResolvers<RepositoryCatalog>();
    inspect.mockReturnValueOnce(pending.promise);
    const router = await mountCoordinator({ path: '/?llama-cpp-browser-model=owner/Model-GGUF' });
    const operation = clickStart();
    await vi.waitFor(() => expect(inspect).toHaveBeenCalledOnce());
    retireModelLaunch({ operation });
    pending.resolve(catalog);
    await flushPromises();
    expect(prepare).not.toHaveBeenCalled();
    expect(router.currentRoute.value.path).toBe('/');
  });

  it('returns to an eligible home chat before resolving newer remote metadata', async () => {
    homeOriginId = 'home-origin';
    const router = await mountCoordinator({ path: '/home' });
    const request = { input: catalog.repository, requestedVariant: 'Q4_K_M', multimodal: 'auto' as const, destination: { kind: 'opfs' as const }, source: 'home' as const };
    startModelLaunch({ request });
    await vi.waitFor(() => expect(router.currentRoute.value.path).toMatch(/^\/chat\//));
    const firstPath = router.currentRoute.value.path;
    await router.push('/home');
    inspect.mockResolvedValue({ ...catalog, revision: 'b'.repeat(40) });
    startModelLaunch({ request });
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe(firstPath));
    expect(inspect).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledOnce();
    consumeModelLaunchSession({ chatId: prepare.mock.calls[0]![0].request.chatId });
    await router.push('/home');
    startModelLaunch({ request });
    await vi.waitFor(() => expect(router.currentRoute.value.path).not.toBe('/home'));
    expect(router.currentRoute.value.path).not.toBe(firstPath);
    expect(prepare).toHaveBeenCalledTimes(2);
  });
});

it('distinguishes metadata waiting from durable chat creation without guessing a target early', async () => {
  const metadata = Promise.withResolvers<RepositoryCatalog>();
  const saving = Promise.withResolvers<void>();
  inspect.mockReturnValueOnce(metadata.promise);
  prepare.mockImplementationOnce(async ({ request }) => {
    await saving.promise;
    return prepareModelLaunchChat({ provider, request });
  });
  const router = await start({ path: '/?llama-cpp-browser-model=owner/Model-GGUF:Q4_K_M' });
  await flushPromises();
  expect(modelLaunchEntryState.value).toMatchObject({ status: 'checking', phase: 'metadata' });
  expect(prepare).not.toHaveBeenCalled();
  metadata.resolve(catalog);
  await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
  expect(modelLaunchEntryState.value).toMatchObject({ status: 'checking', phase: 'opening-chat' });
  expect(router.currentRoute.value.path).toBe('/');
  saving.resolve();
  await vi.waitFor(() => expect(router.currentRoute.value.path).toMatch(/^\/chat\//));
});
