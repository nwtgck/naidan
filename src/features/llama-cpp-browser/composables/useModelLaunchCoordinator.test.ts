import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, ref } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStorageProvider } from '@/00-storage/service/memory-storage';
import { prepareModelLaunchChat, readModelLaunch, type ModelLaunchChatRequest } from '@/00-storage/service/model-launch';
import type { RepositoryCatalog } from '@/features/llama-cpp-browser/hugging-face/catalog';
import { useModelLaunchCoordinator } from './useModelLaunchCoordinator';
import { modelLaunchEntryState, retryModelLaunch, TEST_ONLY } from '@/features/llama-cpp-browser/model-launch/entry-state';
import { DEFAULT_SETTINGS } from '@/01-models/types';
const initialized = ref(true);
const settings = ref({ ...DEFAULT_SETTINGS, storageType: 'memory' as const, endpoint: { type: 'openai' as const, url: '' } });
const interaction = ref('enabled');
let provider: MemoryStorageProvider;
let storageCurrent = true;
const inspect = vi.fn();
const prepare = vi.fn(async ({ request }: { request: ModelLaunchChatRequest }) => prepareModelLaunchChat({ provider, request }));
vi.mock('@/composables/useSettings', () => ({ useSettings: () => ({ initialized, settings }) }));
vi.mock('@/composables/useAppPresentation', () => ({ useAppPresentation: () => ({ appInteraction: interaction }), isAppInteractionEnabled: ({ interaction }: { interaction: string }) => interaction === 'enabled' }));
vi.mock('@/composables/chat/global/chat-core-singletons', () => ({ loadData: vi.fn(async () => {}) }));
vi.mock('../hugging-face/metadata-session', () => ({ getMetadataSession: () => ({ inspect }) }));
vi.mock('@/00-storage/service', () => ({
  storageService: {
    loadChatMeta: ({ id }: Parameters<MemoryStorageProvider['loadChatMeta']>[0]) => provider.loadChatMeta({ id }),
    getModelLaunch: ({ chatId }: { chatId: ModelLaunchChatRequest['chatId'] }) => readModelLaunch({ provider, chatId }),
    prepareModelLaunchChat: (args: { request: ModelLaunchChatRequest }) => prepare(args),
    captureModelLaunchStorage: () => () => storageCurrent,
  },
}));
const catalog: RepositoryCatalog = { repository: 'owner/Model-GGUF', revision: 'a'.repeat(40), projectors: [], models: [{ label: 'Model-Q4_K_M', size: 256, files: [{ path: 'Model-Q4_K_M.gguf', size: 256 }] }] };
const hosts: ReturnType<typeof mount>[] = [];

beforeEach(() => {
  vi.clearAllMocks(); provider = new MemoryStorageProvider(); storageCurrent = true; initialized.value = true; interaction.value = 'enabled'; TEST_ONLY.reset(); window.history.replaceState({}, ''); inspect.mockResolvedValue(catalog);
});

afterEach(() => {
  hosts.splice(0).forEach(wrapper => wrapper.unmount());
});

async function start({ path }: { path: string }) {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }, { path: '/chat/:id', component: { template: '<div />' } }, { path: '/elsewhere', component: { template: '<div />' } }] });
  await router.push(path); await router.isReady();
  const wrapper = mount(defineComponent({
    setup() {
      useModelLaunchCoordinator(); return {};
    },
    template: '<div />',
  }), { global: { plugins: [router] } });
  hosts.push(wrapper); return router;
}

describe('direct-chat model link coordinator', () => {
  it('saves before replacing the root URL, strips auto-send, and keeps unrelated query parameters', async () => {
    const router = await start({ path: '/?llama-cpp-browser-model=hf.co/owner/Model-GGUF:Q4_K_M&q=DO-NOT-SEND&other=value' });
    await vi.waitFor(() => expect(router.currentRoute.value.path).toMatch(/^\/chat\//));
    expect(router.currentRoute.value.query).toEqual({ other: 'value' });
    expect(prepare).toHaveBeenCalledOnce();
    const req = prepare.mock.calls[0]![0].request;
    expect((await provider.loadChat({ id: req.chatId }))?.root.items).toEqual([]);
    expect((await provider.loadChatGroup({ id: (await provider.loadChat({ id: req.chatId }))!.groupId! }))?.endpoint).toEqual({ type: 'llama_cpp_browser' });
  });

  it('does not process before startup permits interaction', async () => {
    interaction.value = 'blocked-by-startup';
    const router = await start({ path: '/?llama-cpp-browser-model=owner/Model-GGUF' });
    await flushPromises(); expect(inspect).not.toHaveBeenCalled();
    interaction.value = 'enabled';
    await vi.waitFor(() => expect(router.currentRoute.value.path).toMatch(/^\/chat\//));
  });

  it('does not steal navigation after a late metadata response, even if the transport ignores abort', async () => {
    const pending = Promise.withResolvers<RepositoryCatalog>(); inspect.mockReturnValueOnce(pending.promise);
    const router = await start({ path: '/?llama-cpp-browser-model=owner/Model-GGUF' });
    await vi.waitFor(() => expect(inspect).toHaveBeenCalledOnce());
    await router.push('/elsewhere'); pending.resolve(catalog); await flushPromises();
    expect(prepare).not.toHaveBeenCalled(); expect(router.currentRoute.value.path).toBe('/elsewhere');
  });

  it('does not transfer an old metadata result to a different storage provider', async () => {
    const pending = Promise.withResolvers<RepositoryCatalog>(); inspect.mockReturnValueOnce(pending.promise);
    const router = await start({ path: '/?llama-cpp-browser-model=owner/Model-GGUF' });
    await vi.waitFor(() => expect(inspect).toHaveBeenCalledOnce()); storageCurrent = false;
    pending.resolve(catalog); await flushPromises(); expect(prepare).not.toHaveBeenCalled(); expect(router.currentRoute.value.path).toBe('/');
  });

  it.each(['/?llama-cpp-browser-model=', '/?llama-cpp-browser-model=one&llama-cpp-browser-model=two', '/?llama-cpp-browser-model=https://external.example/model'])('rejects invalid source %s without a download or storage write', async path => {
    const router = await start({ path }); await flushPromises();
    expect(modelLaunchEntryState.value.status).toBe('failed'); expect(inspect).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled(); expect(router.currentRoute.value.path).toBe('/');
  });

  it('reuses a saved reservation when navigation is denied, even if settings query changes', async () => {
    const pending = Promise.withResolvers<RepositoryCatalog>(); inspect.mockReturnValueOnce(pending.promise);
    const router = await start({ path: '/?llama-cpp-browser-model=owner/Model-GGUF' });
    const removeGuard = router.beforeEach(to => to.path.startsWith('/chat/') ? false : true);
    pending.resolve(catalog); await vi.waitFor(() => expect(modelLaunchEntryState.value.status).toBe('failed'));
    const first = prepare.mock.calls[0]![0].request;
    removeGuard(); await router.replace({ query: { ...router.currentRoute.value.query, settings: 'llama-cpp-browser' } });
    await vi.waitFor(() => expect(router.currentRoute.value.path).toMatch(/^\/chat\//));
    expect(prepare.mock.calls[1]![0].request.chatId).toBe(first.chatId);
    expect(inspect).toHaveBeenCalledOnce(); expect((await provider.loadHierarchy())?.items).toHaveLength(1);
  });

  it('retains the parameter on storage failure and retries the same reserved identifiers', async () => {
    prepare.mockRejectedValueOnce(new Error('quota'));
    const router = await start({ path: '/?llama-cpp-browser-model=owner/Model-GGUF' });
    await vi.waitFor(() => expect(modelLaunchEntryState.value.status).toBe('failed'));
    expect(router.currentRoute.value.query['llama-cpp-browser-model']).toBeDefined(); const first = prepare.mock.calls[0]![0].request;
    retryModelLaunch(); await vi.waitFor(() => expect(router.currentRoute.value.path).toMatch(/^\/chat\//));
    expect(prepare.mock.calls[1]![0].request.chatId).toBe(first.chatId);
  });

  it('accepts a later identical link as a new chat in the same chat group', async () => {
    const source = '/?llama-cpp-browser-model=owner/Model-GGUF';
    const router = await start({ path: source }); await vi.waitFor(() => expect(router.currentRoute.value.path).toMatch(/^\/chat\//));
    const first = router.currentRoute.value.path;
    await router.push(source); await vi.waitFor(() => expect(router.currentRoute.value.path).toMatch(/^\/chat\//));
    expect(router.currentRoute.value.path).not.toBe(first); expect((await provider.loadHierarchy())?.items).toHaveLength(1);
  });
});

it('distinguishes metadata waiting from durable chat creation without guessing a target early', async () => {
  const metadata = Promise.withResolvers<RepositoryCatalog>(); const saving = Promise.withResolvers<void>();
  inspect.mockReturnValueOnce(metadata.promise);
  prepare.mockImplementationOnce(async ({ request }) => {
    await saving.promise; return prepareModelLaunchChat({ provider, request });
  });
  const router = await start({ path: '/?llama-cpp-browser-model=owner/Model-GGUF:Q4_K_M' });
  await flushPromises();
  expect(modelLaunchEntryState.value).toMatchObject({ status: 'checking', phase: 'metadata' });
  expect(prepare).not.toHaveBeenCalled();
  metadata.resolve(catalog); await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
  expect(modelLaunchEntryState.value).toMatchObject({ status: 'checking', phase: 'opening-chat' });
  expect(router.currentRoute.value.path).toBe('/');
  saving.resolve(); await vi.waitFor(() => expect(router.currentRoute.value.path).toMatch(/^\/chat\//));
});
