import { formatHuggingFaceModelId } from '@/01-models/llama-cpp-browser-model-id';
import { isModelLaunchTargetReady } from '@/features/llama-cpp-browser/model-launch/readiness';
import type { ChatModelLaunch } from '@/01-models/llama-cpp-browser-model-launch';
import LlamaCppBrowserModelLaunchCard from '@/features/llama-cpp-browser/components/LlamaCppBrowserModelLaunchCard.vue';
import { createRouter, createMemoryHistory, RouterView, useRoute, useRouter, type Router } from 'vue-router';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { lazyStrings } from '@/strings';
import { computed, defineComponent, effectScope, h, hasInjectionContext, ref, shallowRef } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat, Settings, MessageNode } from '@/01-models/types';
import { DEFAULT_SETTINGS } from '@/01-models/types';
import { toChatId, toChatGroupId, toMessageId } from '@/01-models/ids';
import { createDownloadQueue } from '@/features/llama-cpp-browser/hugging-face/download-queue';
import type { DownloadSelection } from '@/features/llama-cpp-browser/hugging-face/types';
import { useModelLaunchChat } from './useModelLaunchChat';
import { rememberLaunchCatalog, resolveModelLaunchTarget, targetForChoice, TEST_ONLY } from '@/features/llama-cpp-browser/model-launch/target';
import type { RepositoryCatalog } from '@/features/llama-cpp-browser/hugging-face/catalog';
import type { ModelLaunchChatRequest } from '@/00-storage/service/model-launch';
import { provideDocumentMetadata } from '@/composables/useDocumentMetadata';
import LlamaCppBrowserModelLaunchEntry from '@/features/llama-cpp-browser/components/LlamaCppBrowserModelLaunchEntry.vue';
import { useModelLaunchCoordinator } from './useModelLaunchCoordinator';
import { TEST_ONLY as entryTestOnly } from '@/features/llama-cpp-browser/model-launch/entry-state';
import { readModelLaunchSession, rememberModelLaunchSession, TEST_ONLY as sessionTestOnly } from '@/features/llama-cpp-browser/model-launch/session';
import { isModelLaunchPrepared, TEST_ONLY as preparationTestOnly } from '@/features/llama-cpp-browser/model-launch/preparation';
import type { ObservedLegacyModelDownload } from '@/features/llama-cpp-browser/model-launch/restore';
import type { HostModelDirectoryHandle } from '@/00-storage/service/host-model-handles';
const settings = ref<Settings>({ ...DEFAULT_SETTINGS, storageType: 'memory', endpoint: { type: 'openai', url: '' } });
let queue: ReturnType<typeof createDownloadQueue>;
const download = vi.fn();
const installed = new Set<string>();
const capture = vi.fn(async () => ({ endpoint: settings.value.endpoint, modelId: settings.value.defaultModelId, revision: 0, storedMatches: true, isStorageCurrent: () => true }));
const initialize = vi.fn(async () => 'applied' as const);
const inspect = vi.fn();
const observe = vi.fn();
const captureBinding = vi.fn();
const prepare = vi.fn();
const prepareModel = vi.fn();
const returnHome = vi.fn(async () => {});
let activeLaunch: ChatModelLaunch;
let launchEnabled = true;
let storageVersion = 0;
let modelListListener: (() => void) | undefined;
const getState = vi.fn(() => ({ status: 'idle' as const }));
const currentChat = shallowRef<Chat | null>(null);
vi.mock('@/composables/useSettings', () => ({ useSettings: () => ({ settings, initialized: ref(true), captureModelLaunchDefaults: capture, initializeModelLaunchDefaults: initialize }) }));
vi.mock('@/composables/useAppPresentation', () => ({ useAppPresentation: () => ({ appInteraction: ref('enabled') }), isAppInteractionEnabled: ({ interaction }: { interaction: string }) => interaction === 'enabled' }));
vi.mock('@/composables/useAppEntry', () => ({
  useAppEntry: () => {
    const router = hasInjectionContext() ? useRouter() : undefined;
    let handoff: string | undefined;
    return {
      interaction: ref('ready'),
      returnToHome: returnHome,
      captureModelLaunchContext: () => {
        const path = router?.currentRoute.value.fullPath;
        return {
          owner: Symbol('entry'),
          homeOriginId: undefined,
          mode: 'model-preview',
          fullPath: path ?? '',
          routePath: router?.currentRoute.value.path ?? '',
          isCurrent: () => path === router?.currentRoute.value.fullPath || handoff === router?.currentRoute.value.path,
        };
      },
      prepareModelLaunchHandoff: ({ chatPath }: { chatPath: string }) => {
        handoff = chatPath;
        return true;
      },
      previewVariantSelection: ref({ kind: 'initial' }),
      intent: computed(() => ({ kind: 'model-preview', routePath: router?.currentRoute.value.path ?? '/' })),
    };
  },
}));
vi.mock('@/features/llama-cpp-browser', () => ({
  llamaCppBrowserService: {
    prepareModel: (args: unknown) => prepareModel(args),
    getState: () => getState(),
    subscribe: vi.fn(() => () => {}),
    subscribeModelList: ({ listener }: { listener: () => void }) => {
      modelListListener = listener;
      return () => {
        modelListListener = undefined;
      };
    },
  },
}));
vi.mock('../hugging-face/download-queue', async importOriginal => ({ ...await importOriginal<typeof import('@/features/llama-cpp-browser/hugging-face/download-queue')>(), getDownloadQueue: () => queue }));
vi.mock('../hugging-face/storage', () => ({
  repositoryFolder: vi.fn(async () => {
    throw new Error('missing');
  }),
  readJournal: vi.fn(),
  isMissing: () => true,
}));
vi.mock('../model-launch/readiness', async importOriginal => ({ ...await importOriginal<typeof import('@/features/llama-cpp-browser/model-launch/readiness')>(), isModelLaunchTargetReady: vi.fn(async ({ target }) => installed.has(target.modelId)) }));
vi.mock('../hugging-face/metadata-session', () => ({ getMetadataSession: () => ({ inspect }) }));
vi.mock('../model-launch/restore', () => ({ observeLegacyModelDownload: (args: unknown) => observe(args) }));
vi.mock('@/00-storage/service', () => ({
  storageService: {
    getModelLaunch: () => launchEnabled ? activeLaunch : undefined,
    prepareModelLaunchChat: (args: { request: ModelLaunchChatRequest }) => prepare(args),
    captureModelLaunchStorage: () => {
      const version = storageVersion;
      return () => version === storageVersion;
    },
    captureModelBinding: (args: unknown) => captureBinding(args),
    loadChat: async () => currentChat.value,
    loadChatMeta: async () => currentChat.value,
    loadChatContent: async () => currentChat.value === null ? null : { root: currentChat.value.root },
    loadHierarchy: async () => ({ items: [] }),
    loadChatGroup: async () => ({ id: activeLaunch.chatGroupId, endpoint: { type: 'llama_cpp_browser' }, modelId: activeLaunch.effectiveModelId }),
    subscribeToChanges: vi.fn(() => () => {}),
  },
}));
vi.mock('@/composables/chat/global/chat-core-singletons', () => ({
  loadData: vi.fn(async () => {}),
  registerLiveInstance: ({ chat }: { chat: Chat }) => {
    currentChat.value = chat;
  },
}));
const catalog: RepositoryCatalog = { repository: 'owner/Model-GGUF', revision: 'a'.repeat(40), projectors: [], models: ['Q4_K_M', 'Q8_0'].map(quant => ({ label: quant, size: 256, files: [{ path: `Model-${quant}.gguf`, size: 256 }] })) };
const base = resolveModelLaunchTarget({ input: catalog.repository, catalog });
const scopes: ReturnType<typeof effectScope>[] = [];

function mountState() {
  const scope = effectScope();
  scopes.push(scope);
  const state = scope.run(() => useModelLaunchChat({ chat: computed(() => currentChat.value), resolved: computed(() => ({ endpoint: { type: 'llama_cpp_browser' as const }, modelId: activeLaunch.target.modelId })) }))!;
  return { scope, state };
}

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  vi.clearAllMocks();
  installed.clear();
  launchEnabled = true;
  modelListListener = undefined;
  storageVersion = 0;
  vi.mocked(isModelLaunchTargetReady).mockReset().mockImplementation(async ({ target }) => installed.has(target.modelId));
  TEST_ONLY.reset();
  sessionTestOnly.reset();
  preparationTestOnly.reset();
  rememberLaunchCatalog({ catalog });
  currentChat.value = { id: toChatId({ raw: 'launch-chat' }), groupId: toChatGroupId({ raw: 'launch-cg' }), title: null, root: { items: [] }, debugEnabled: false, createdAt: 1, updatedAt: 1 };
  activeLaunch = {
    input: catalog.repository,
    ...base,
    destination: { kind: 'opfs' },
    effectiveModelId: base.target.modelId,
    chatGroupName: 'Model',
    titleGeneration: DEFAULT_SETTINGS.titleGeneration,
    chatGroupId: toChatGroupId({ raw: 'launch-cg' }),
    phase: 'active',
  };
  rememberModelLaunchSession({
    session: {
      chatId: currentChat.value!.id,
      homeOriginId: undefined,
      requestKey: 'initial',
      target: activeLaunch.target,
      destination: activeLaunch.destination,
      effectiveModelId: activeLaunch.effectiveModelId,
      expectedRoot: undefined,
      defaults: capture(),
      isStorageCurrent: () => storageVersion === 0,
      defaultAttempted: false,
      consumed: false,
    },
  });
  prepareModel.mockResolvedValue('ready');
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  download.mockImplementation(async ({ selection }: { selection: DownloadSelection }) => {
    const path = selection.files[0]!.path;
    installed.add(formatHuggingFaceModelId({ repository: selection.repository, mainFilePath: path }));
  });
  queue = createDownloadQueue({ download });
  prepare.mockImplementation(async ({ request }: { request: ModelLaunchChatRequest }): Promise<Chat> => {
    activeLaunch = { ...activeLaunch, target: request.target, destination: request.destination, effectiveModelId: request.effectiveModelId, chatGroupId: request.newChatGroupId, phase: 'active' };
    return { ...currentChat.value!, groupId: request.newChatGroupId };
  });
  initialize.mockResolvedValue('applied');
  inspect.mockResolvedValue(catalog);
  observe.mockReset().mockResolvedValue(undefined);
  captureBinding.mockReset().mockImplementation(async ({ sourceModelId }: { sourceModelId: string }) => ({ sourceModelId, revision: 0 }));
});

afterEach(() => scopes.splice(0).forEach(scope => scope.stop()));

function metadataOwner({ router, content }: { router: Router, content: ReturnType<typeof defineComponent> }) {
  return mount(defineComponent({
    setup() {
      provideDocumentMetadata({ router, document, homeIntroduction: ref({ kind: 'inactive' }), finishHomeIntroduction: () => {} });
      return () => h(content);
    },
  }), { global: { plugins: [router] } });
}

describe('model guide document metadata', () => {
  it('uses the model title only in the preview and application metadata as soon as the chat is saved', async () => {
    entryTestOnly.reset();
    document.head.innerHTML = '';
    launchEnabled = false;
    currentChat.value = null;
    const metadata = Promise.withResolvers<RepositoryCatalog>();
    const transfer = Promise.withResolvers<void>();
    download.mockImplementationOnce(async () => {
      await transfer.promise;
    });
    inspect.mockReturnValueOnce(metadata.promise);
    prepare.mockImplementationOnce(async ({ request }: { request: ModelLaunchChatRequest }): Promise<Chat> => {
      activeLaunch = { ...activeLaunch, input: request.input, target: request.target, requestedVariant: request.requestedVariant, destination: request.destination, effectiveModelId: request.effectiveModelId, chatGroupId: request.newChatGroupId, phase: 'active' };
      launchEnabled = true;
      currentChat.value = { id: request.chatId, groupId: request.newChatGroupId, title: null, root: { items: [] }, debugEnabled: false, createdAt: 1, updatedAt: 1 };
      return currentChat.value;
    });
    const Entry = defineComponent({
      setup() {
        const route = useRoute();
        return () => h(LlamaCppBrowserModelLaunchEntry, { input: route.query['llama-cpp-browser-model'] });
      },
    });
    const Guide = defineComponent({
      setup() {
        const route = useRoute();
        const state = useModelLaunchChat({ chat: computed(() => currentChat.value), resolved: computed(() => ({ endpoint: { type: 'llama_cpp_browser' as const }, modelId: activeLaunch.target.modelId })) });
        return () => h(LlamaCppBrowserModelLaunchCard, { state, routePath: route.path });
      },
    });
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: Entry }, { path: '/chat/:id', component: Guide }] });
    await router.push('/?llama-cpp-browser-model=owner/Model-GGUF:Q4_K_M');
    const Content = defineComponent({
      setup() {
        useModelLaunchCoordinator();
        return () => h(RouterView);
      },
    });
    const wrapper = metadataOwner({ router, content: Content });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
        entryTestOnly.reset();
        transfer.resolve();
      },
    };
    await flushPromises();
    expect(document.title).toBe('Run Model-GGUF in your browser | Naidan');
    expect(wrapper.find('[data-testid="model-launch-entry"]').exists()).toBe(true);
    expect(inspect).toHaveBeenCalledOnce();
    expect(download).not.toHaveBeenCalled();
    expect(currentChat.value).toBeNull();
    await wrapper.get('[data-testid="start-preview-model"]').trigger('click');
    metadata.resolve(catalog);
    await flushPromises();
    expect(router.currentRoute.value.path).toMatch(/^\/chat\//);
    expect(router.currentRoute.value.query['llama-cpp-browser-model']).toBeUndefined();
    expect(wrapper.find('[data-testid="model-launch-card"]').exists()).toBe(true);
    await flushPromises();
    expect(document.title).toBe('Naidan');
    expect(download).toHaveBeenCalledOnce();
    expect(prepareModel).not.toHaveBeenCalled();
  });

  it('keeps application metadata and the editable composer through download and warmup', async () => {
    const transfer = Promise.withResolvers<void>();
    const warmup = Promise.withResolvers<'ready'>();
    prepareModel.mockReturnValueOnce(warmup.promise);
    download.mockImplementationOnce(async () => {
      await transfer.promise;
      installed.add(base.target.modelId);
    });
    const { state } = mountState();
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/chat/:id', component: { template: '<div />' } }] });
    await router.push('/chat/launch-chat');
    const Content = defineComponent({ setup: () => () => h(LlamaCppBrowserModelLaunchCard, { state, routePath: '/chat/launch-chat' }) });
    const wrapper = metadataOwner({ router, content: Content });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
        warmup.resolve('ready');
      },
    };
    await flushPromises();
    expect(document.title).toBe('Naidan');
    await wrapper.get('[data-testid="start-preview-model"]').trigger('click');
    await flushPromises();
    expect(state.composerVisibility.value).toBe('visible');
    expect(document.title).toBe('Naidan');
    transfer.resolve();
    await flushPromises();
    expect(state.composerVisibility.value).toBe('visible');
    expect(state.warmup.value).toBe('loading');
    expect(document.title).toBe('Naidan');
    expect(state.maySend.value).toBe(false);
    warmup.resolve('ready');
    await flushPromises();
    expect(document.title).toBe('Naidan');
    expect(document.querySelector('meta[property="og:title"]')?.getAttribute('content')).toBe('Naidan');
  });
});

describe('model launch chat workflow', () => {
  it('checks local files but never downloads or fetches metadata on mount', async () => {
    const { state } = mountState();
    await flushPromises();
    expect(state.readiness.value).toBe('missing');
    expect(state.maySend.value).toBe(false);
    expect(download).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
    expect(initialize).not.toHaveBeenCalled();
  });

  it('downloads once on explicit action, reports readiness, and initializes only after verification', async () => {
    const gate = Promise.withResolvers<void>();
    download.mockImplementationOnce(async () => {
      await gate.promise;
      installed.add(base.target.modelId);
    });
    const { state } = mountState();
    await flushPromises();
    const action = state.adoptAndDownload();
    await state.adoptAndDownload();
    await action;
    await flushPromises();
    expect(download).toHaveBeenCalledOnce();
    expect(state.job.value?.status).toBe('downloading');
    expect(state.maySend.value).toBe(false);
    expect(initialize).not.toHaveBeenCalled();
    gate.resolve();
    await vi.waitFor(() => expect(state.maySend.value).toBe(true));
    expect(state.readiness.value).toBe('ready');
    expect(initialize).toHaveBeenCalledOnce();
  });

  it('does not mutate shared settings merely because an unpinned selector changed', async () => {
    const { state } = mountState();
    await flushPromises();
    state.selectPath({ path: 'Model-Q8_0.gguf' });
    await flushPromises();
    expect(prepare).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
    expect(activeLaunch.target.modelId).toBe(base.target.modelId);
    expect(state.maySend.value).toBe(false);
    await state.adoptAndDownload();
    await flushPromises();
    expect(prepare).toHaveBeenCalledOnce();
    expect(prepare.mock.calls[0]![0].request.mode).toBe('retarget');
    expect(activeLaunch.target.mainFilePath).toBe('Model-Q8_0.gguf');
  });

  it('uses an already installed newly selected model without a payload download', async () => {
    const other = targetForChoice({ catalog, path: 'Model-Q8_0.gguf' });
    installed.add(other.modelId);
    const { state } = mountState();
    await flushPromises();
    state.selectPath({ path: other.mainFilePath });
    await flushPromises();
    expect(state.maySend.value).toBe(false);
    await state.adoptAndDownload();
    await flushPromises();
    expect(download).not.toHaveBeenCalled();
    expect(state.maySend.value).toBe(true);
  });

  it('allows changing the initial URL quantization through the card selector action', async () => {
    activeLaunch = { ...activeLaunch, requestedVariant: 'Q4_K_M' };
    const { state } = mountState();
    await flushPromises();
    state.selectPath({ path: 'Model-Q8_0.gguf' });
    expect(state.selectedPath.value).toBe('Model-Q8_0.gguf');
  });

  it('keeps a page-owned download alive when its card unmounts, without applying stale global changes', async () => {
    const gate = Promise.withResolvers<void>();
    download.mockImplementationOnce(async () => {
      await gate.promise;
      installed.add(base.target.modelId);
    });
    const { scope, state } = mountState();
    await flushPromises();
    await state.adoptAndDownload();
    await flushPromises();
    scope.stop();
    gate.resolve();
    await flushPromises();
    expect(queue.jobs.value[0]?.status).toBe('complete');
    expect(initialize).not.toHaveBeenCalled();
  });

  it('pauses only the selected model before returning to model selection and can resume it', async () => {
    readModelLaunchSession({ chatId: currentChat.value!.id })!.homeOriginId = 'home-origin';
    const gate = Promise.withResolvers<void>();
    download.mockImplementationOnce(async ({ signal }: { signal: AbortSignal }) => {
      signal.addEventListener('abort', () => gate.reject(new DOMException('Paused', 'AbortError')), { once: true });
      await gate.promise;
    });
    const { state } = mountState();
    await flushPromises();
    await state.adoptAndDownload();
    await flushPromises();
    expect(state.job.value?.status).toBe('downloading');
    const other = targetForChoice({ catalog, path: 'Model-Q8_0.gguf' });
    const otherDownload = queue.enqueue({ key: 'other-model', repository: catalog.repository, source: 'repository', prepare: async () => other.selection });
    returnHome.mockImplementationOnce(async () => {
      expect(state.job.value?.status).toBe('pausing');
    });

    await state.returnToHome();
    await flushPromises();

    expect(returnHome).toHaveBeenCalledExactlyOnceWith({ homeOriginId: 'home-origin' });
    expect(state.job.value?.status).toBe('paused');
    expect((await otherDownload.done).status).toBe('complete');
    expect(installed.has(base.target.modelId)).toBe(false);

    await state.adoptAndDownload();
    await flushPromises();

    expect(state.job.value?.status).toBe('complete');
    expect(installed.has(base.target.modelId)).toBe(true);
    expect(inspect).not.toHaveBeenCalled();
  });

  it('does not pause a download when there is no model selection page to return to', async () => {
    const gate = Promise.withResolvers<void>();
    download.mockImplementationOnce(async ({ signal }: { signal: AbortSignal }) => {
      signal.addEventListener('abort', () => gate.reject(new DOMException('Paused', 'AbortError')), { once: true });
      await gate.promise;
    });
    const { state } = mountState();
    await flushPromises();
    await state.adoptAndDownload();
    await flushPromises();

    await state.returnToHome();

    expect(returnHome).not.toHaveBeenCalled();
    expect(state.job.value?.status).toBe('downloading');
    queue.cancel({ id: state.job.value!.id });
    await flushPromises();
  });

  it('allows chat after file verification even if writing global defaults fails', async () => {
    installed.add(base.target.modelId);
    initialize.mockRejectedValueOnce(new Error('quota'));
    const { state } = mountState();
    await flushPromises();
    expect(state.defaultWarning.value).toBe(true);
    expect(state.maySend.value).toBe(true);
  });

  it('invalidates readiness when files are removed and does not refresh metadata', async () => {
    installed.add(base.target.modelId);
    const { state } = mountState();
    await flushPromises();
    expect(state.maySend.value).toBe(true);
    installed.clear();
    await state.refresh();
    expect(state.maySend.value).toBe(false);
    expect(inspect).not.toHaveBeenCalled();
  });

  it('repairs a saved incomplete reservation without automatically downloading', async () => {
    activeLaunch = { ...activeLaunch, phase: 'reserved' };
    const { state } = mountState();
    expect(state.maySend.value).toBe(false);
    expect(state.visible.value).toBe(true);
    expect(state.needsRecovery.value).toBe(true);
    await flushPromises();
    expect(prepare).not.toHaveBeenCalled();
    await state.recover();
    await flushPromises();
    expect(prepare).toHaveBeenCalledOnce();
    expect(state.launch.value?.phase).toBe('active');
    expect(download).not.toHaveBeenCalled();
  });
});

describe('model launch card rendering', () => {
  async function renderCard() {
    const { state } = mountState();
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }] });
    await router.push('/');
    const wrapper = mount(LlamaCppBrowserModelLaunchCard, { props: { state, routePath: '/chat/launch-chat' }, global: { plugins: [router] } });
    await flushPromises();
    return { wrapper, state };
  }

  it('shows quantization choices for an unpinned link and exposes an explicit download button', async () => {
    const { wrapper } = await renderCard();
    expect(wrapper.find('[data-testid="model-preview-quantization"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="start-preview-model"]').exists()).toBe(true);
    expect(download).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('keeps quantization editable when the link specifies an initial variant', async () => {
    activeLaunch = { ...activeLaunch, requestedVariant: 'Q4_K_M' };
    const { wrapper, state } = await renderCard();
    const selection = wrapper.get('[data-testid="model-preview-quantization"]');
    expect(selection.attributes('disabled')).toBeUndefined();
    expect(wrapper.find('[data-testid="model-preview-quantization"]').text()).toContain('Q4_K_M');
    await selection.setValue('Model-Q8_0.gguf');
    await flushPromises();
    expect(state.selectedPath.value).toBe('Model-Q8_0.gguf');
    expect(state.selectionChanged.value).toBe(true);
    expect(download).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('renders the ready status for verified local files without downloading', async () => {
    installed.add(base.target.modelId);
    const { wrapper, state } = await renderCard();
    expect(wrapper.get('[data-testid="model-preparation-ready"]').text()).toBe(lazyStrings.LlamaCppBrowserModelLaunch__ready_when_you_are());
    expect(wrapper.find('[data-testid="start-preview-model"]').exists()).toBe(false);
    expect(state.maySend.value).toBe(true);
    expect(download).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('allows a ready model to change quantization and gates sending until the new selection is adopted', async () => {
    installed.add(base.target.modelId);
    const { wrapper, state } = await renderCard();
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    expect(state.maySend.value).toBe(true);
    const selection = wrapper.get('[data-testid="model-preview-quantization"]');
    expect(selection.attributes('disabled')).toBeUndefined();
    await selection.setValue('Model-Q8_0.gguf');
    await flushPromises();
    expect(state.selectionChanged.value).toBe(true);
    expect(state.maySend.value).toBe(false);
    expect(wrapper.find('[data-testid="model-preparation-ready"]').exists()).toBe(false);
    expect(download).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="start-preview-model"]').trigger('click');
    await flushPromises();
    expect(prepare.mock.calls[0]![0].request.mode).toBe('retarget');
    expect(activeLaunch.target.mainFilePath).toBe('Model-Q8_0.gguf');
  });

  it('shows a verified existing conversation as ready without an initial model preload', async () => {
    installed.add(base.target.modelId);
    const node: MessageNode = {
      id: toMessageId({ raw: 'existing-message' }),
      role: 'user',
      createdAt: 1,
      modelId: undefined,
      lmParameters: undefined,
      parts: [{ type: 'text', text: 'Existing conversation', completeness: 'complete' }],
      replies: { items: [] },
    };
    currentChat.value = { ...currentChat.value!, root: { items: [node] } };
    const { wrapper, state } = await renderCard();
    expect(state.maySend.value).toBe(true);
    expect(prepareModel).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="model-preparation-ready"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="model-launch-checking"]').exists()).toBe(false);
    wrapper.unmount();
  });
});

describe('automatic local preparation', () => {
  it('prepares only once after files are verified and keeps sending blocked during the load', async () => {
    const gate = Promise.withResolvers<'ready'>();
    prepareModel.mockReturnValueOnce(gate.promise);
    installed.add(base.target.modelId);
    const { state, scope } = mountState();
    await flushPromises();
    expect(prepareModel).toHaveBeenCalledOnce();
    expect(state.warmup.value).toBe('loading');
    expect(state.maySend.value).toBe(false);
    expect(isModelLaunchPrepared({ chatId: currentChat.value!.id, target: activeLaunch.target, destination: activeLaunch.destination, effectiveModelId: activeLaunch.effectiveModelId })).toBe(false);
    await state.refresh();
    await flushPromises();
    expect(prepareModel).toHaveBeenCalledOnce();
    gate.resolve('ready');
    await flushPromises();
    expect(state.warmup.value).toBe('ready');
    expect(isModelLaunchPrepared({ chatId: currentChat.value!.id, target: activeLaunch.target, destination: activeLaunch.destination, effectiveModelId: activeLaunch.effectiveModelId })).toBe(true);
    expect(download).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
    scope.stop();
    expect(isModelLaunchPrepared({ chatId: currentChat.value!.id, target: activeLaunch.target, destination: activeLaunch.destination, effectiveModelId: activeLaunch.effectiveModelId })).toBe(false);
  });

  it('waits until a hidden tab becomes visible', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    installed.add(base.target.modelId);
    const { state } = mountState();
    await flushPromises();
    expect(prepareModel).not.toHaveBeenCalled();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();
    expect(prepareModel).toHaveBeenCalledOnce();
    expect(state.warmup.value).toBe('ready');
  });

  it('cancels only its own preparation when leaving and ignores late success', async () => {
    const gate = Promise.withResolvers<'ready'>();
    prepareModel.mockReturnValueOnce(gate.promise);
    installed.add(base.target.modelId);
    const { scope, state } = mountState();
    await flushPromises();
    const signal: AbortSignal = prepareModel.mock.calls[0]![0].signal;
    scope.stop();
    expect(signal.aborted).toBe(true);
    gate.resolve('ready');
    await flushPromises();
    expect(state.warmup.value).not.toBe('ready');
  });

  it('does not spin when another operation owns the worker', async () => {
    prepareModel.mockResolvedValueOnce('skipped-busy');
    installed.add(base.target.modelId);
    const { state } = mountState();
    await flushPromises();
    expect(state.warmup.value).toBe('deferred');
    await state.refresh();
    window.dispatchEvent(new Event('focus'));
    await flushPromises();
    expect(prepareModel).toHaveBeenCalledOnce();
    expect(state.maySend.value).toBe(false);
  });

  it('keeps the first send blocked until failed preparation is retried', async () => {
    prepareModel.mockRejectedValueOnce(new Error('device lost'));
    installed.add(base.target.modelId);
    const { state } = mountState();
    await flushPromises();
    expect(state.warmup.value).toBe('failed');
    expect(state.maySend.value).toBe(false);
    state.retryWarmup();
    await flushPromises();
    expect(state.maySend.value).toBe(true);
    expect(download).not.toHaveBeenCalled();
  });
});

describe('stable file verification and focused setup', () => {
  async function renderCard() {
    const { state } = mountState();
    const wrapper = mount(LlamaCppBrowserModelLaunchCard, { props: { state, routePath: '/chat/launch-chat' } });
    await flushPromises();
    return { wrapper, state };
  }

  it('does not briefly offer Start while an installed model is being checked on mount', async () => {
    const gate = Promise.withResolvers<boolean>();
    vi.mocked(isModelLaunchTargetReady).mockReturnValue(gate.promise);
    const { wrapper, state } = await renderCard();
    expect(state.composerVisibility.value).toBe('visible');
    expect(wrapper.find('[data-testid="model-launch-checking"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="start-preview-model"]').exists()).toBe(false);
    gate.resolve(true);
    await flushPromises();
    expect(state.composerVisibility.value).toBe('visible');
    expect(wrapper.find('[data-testid="model-preparation-ready"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="start-preview-model"]').exists()).toBe(false);
    expect(download).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('keeps the ready presentation and composer during revalidation but gates submission', async () => {
    installed.add(base.target.modelId);
    const { wrapper, state } = await renderCard();
    const readyNode = wrapper.get('[data-testid="model-preparation-ready"]').element;
    const gate = Promise.withResolvers<boolean>();
    vi.mocked(isModelLaunchTargetReady).mockReturnValueOnce(gate.promise);
    const check = state.refresh();
    await flushPromises();
    expect(state.verification.value).toBe('checking');
    expect(state.readiness.value).toBe('ready');
    expect(state.maySend.value).toBe(false);
    expect(state.composerVisibility.value).toBe('visible');
    expect(wrapper.find('[data-testid="start-preview-model"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="model-preparation-ready"]').element).toBe(readyNode);
    gate.resolve(true);
    await check;
    await flushPromises();
    expect(state.maySend.value).toBe(true);
    expect(prepareModel).toHaveBeenCalledOnce();
    wrapper.unmount();
  });

  it('keeps the same Start button during a recheck of missing files without permitting a transfer', async () => {
    const { wrapper, state } = await renderCard();
    const button = wrapper.get('[data-testid="start-preview-model"]');
    expect(button.text()).toBe('Start with this model');
    const gate = Promise.withResolvers<boolean>();
    vi.mocked(isModelLaunchTargetReady).mockReturnValueOnce(gate.promise);
    const check = state.refresh();
    await flushPromises();
    expect(wrapper.get('[data-testid="start-preview-model"]').element).toBe(button.element);
    expect(button.attributes('disabled')).toBeDefined();
    await state.adoptAndDownload();
    expect(download).not.toHaveBeenCalled();
    gate.resolve(false);
    await check;
    await flushPromises();
    expect(button.attributes('disabled')).toBeUndefined();
    expect(state.composerVisibility.value).toBe('visible');
    wrapper.unmount();
  });

  it('changes the presentation only after a recheck confirms file deletion', async () => {
    installed.add(base.target.modelId);
    const { wrapper, state } = await renderCard();
    const gate = Promise.withResolvers<boolean>();
    vi.mocked(isModelLaunchTargetReady).mockReturnValueOnce(gate.promise);
    const check = state.refresh();
    await flushPromises();
    expect(state.composerVisibility.value).toBe('visible');
    gate.resolve(false);
    await check;
    await flushPromises();
    expect(state.readiness.value).toBe('missing');
    expect(state.composerVisibility.value).toBe('visible');
    expect(wrapper.find('[data-testid="start-preview-model"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('keeps the same disabled Start button when an old completed job no longer has its files', async () => {
    download.mockResolvedValueOnce(undefined);
    const { wrapper, state } = await renderCard();
    await state.adoptAndDownload();
    await flushPromises();
    expect(state.job.value?.status).toBe('complete');
    expect(state.readiness.value).toBe('missing');
    const button = wrapper.get('[data-testid="start-preview-model"]');
    const gate = Promise.withResolvers<boolean>();
    vi.mocked(isModelLaunchTargetReady).mockReturnValueOnce(gate.promise);
    const check = state.refresh();
    await flushPromises();
    expect(wrapper.get('[data-testid="start-preview-model"]').element).toBe(button.element);
    expect(button.attributes('disabled')).toBeDefined();
    expect(wrapper.find('[data-testid="model-launch-checking"]').exists()).toBe(false);
    gate.resolve(false);
    await check;
    await flushPromises();
    expect(button.attributes('disabled')).toBeUndefined();
    wrapper.unmount();
  });

  it('does not suggest redownloading when the file check itself failed', async () => {
    installed.add(base.target.modelId);
    const { wrapper, state } = await renderCard();
    vi.mocked(isModelLaunchTargetReady).mockRejectedValueOnce(new Error('storage unavailable'));
    await state.refresh();
    await flushPromises();
    expect(state.readiness.value).toBe('failed');
    expect(state.maySend.value).toBe(false);
    expect(state.composerVisibility.value).toBe('visible');
    expect(wrapper.find('[data-testid="start-preview-model"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="model-launch-check-retry"]').exists()).toBe(true);
    expect(download).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('ignores a late successful check for a formerly selected model', async () => {
    installed.add(base.target.modelId);
    const { state } = mountState();
    await flushPromises();
    const gate = Promise.withResolvers<boolean>();
    vi.mocked(isModelLaunchTargetReady).mockReturnValueOnce(gate.promise);
    const check = state.refresh();
    state.selectPath({ path: 'Model-Q8_0.gguf' });
    await flushPromises();
    expect(state.readiness.value).toBe('missing');
    gate.resolve(true);
    await check;
    await flushPromises();
    expect(state.selectedTarget.value?.mainFilePath).toBe('Model-Q8_0.gguf');
    expect(state.readiness.value).toBe('missing');
    expect(state.composerVisibility.value).toBe('visible');
    expect(state.maySend.value).toBe(false);
  });

  it('keeps only the latest concurrent verification result', async () => {
    const { state } = mountState();
    await flushPromises();
    const old = Promise.withResolvers<boolean>();
    vi.mocked(isModelLaunchTargetReady).mockReturnValueOnce(old.promise);
    const first = state.refresh();
    installed.add(base.target.modelId);
    await state.refresh();
    old.resolve(false);
    await first;
    await flushPromises();
    expect(state.readiness.value).toBe('ready');
    expect(state.verification.value).toBe('idle');
    expect(state.maySend.value).toBe(true);
  });

  it('uses one transfer action, keeps pause operable, and offers only one resume', async () => {
    const gate = Promise.withResolvers<void>();
    download.mockImplementationOnce(async ({ signal }: { signal: AbortSignal }) => {
      signal.addEventListener('abort', () => gate.reject(new DOMException('Paused', 'AbortError')), { once: true });
      await gate.promise;
    });
    const { wrapper, state } = await renderCard();
    await wrapper.get('[data-testid="start-preview-model"]').trigger('click');
    await flushPromises();
    expect(state.composerVisibility.value).toBe('visible');
    expect(wrapper.text()).toContain('Downloading model');
    expect(wrapper.find('[data-testid="start-preview-model"]').exists()).toBe(false);
    const pause = wrapper.get('[data-testid="llama-download-pause"]');
    expect(pause.attributes('disabled')).toBeUndefined();
    await pause.trigger('click');
    await flushPromises();
    expect(state.job.value?.status).toBe('paused');
    expect(wrapper.findAll('[data-testid="llama-download-resume"]')).toHaveLength(1);
    expect(wrapper.find('[data-testid="start-preview-model"]').exists()).toBe(false);
    await wrapper.get('[data-testid="llama-download-resume"]').trigger('click');
    await flushPromises();
    expect(download).toHaveBeenCalledTimes(2);
    expect(state.composerVisibility.value).toBe('visible');
    expect(wrapper.find('[data-testid="llama-download-job"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('shows one retry for a failed transfer, not a second Start button', async () => {
    download.mockRejectedValueOnce(new Error('network'));
    const { wrapper } = await renderCard();
    await wrapper.get('[data-testid="start-preview-model"]').trigger('click');
    await flushPromises();
    expect(wrapper.findAll('[data-testid="llama-download-resume"]')).toHaveLength(1);
    expect(wrapper.find('[data-testid="start-preview-model"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('does not revive Start in the gap between transfer completion and file verification', async () => {
    const transfer = Promise.withResolvers<void>();
    download.mockImplementationOnce(() => transfer.promise);
    const { wrapper, state } = await renderCard();
    await state.adoptAndDownload();
    await flushPromises();
    const check = Promise.withResolvers<boolean>();
    vi.mocked(isModelLaunchTargetReady).mockReturnValue(check.promise);
    transfer.resolve();
    await flushPromises();
    expect(state.job.value?.status).toBe('complete');
    expect(state.verification.value).toBe('checking');
    expect(state.maySend.value).toBe(false);
    expect(wrapper.find('[data-testid="start-preview-model"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="model-launch-checking"]').exists()).toBe(true);
    expect(state.composerVisibility.value).toBe('visible');
    check.resolve(true);
    await flushPromises();
    expect(state.composerVisibility.value).toBe('visible');
    expect(wrapper.find('[data-testid="start-preview-model"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('keeps ordinary chats visible even when they have no local model files', async () => {
    launchEnabled = false;
    const { state } = mountState();
    await flushPromises();
    expect(state.visible.value).toBe(false);
    expect(state.composerVisibility.value).toBe('visible');
    expect(state.launch.value).toBeUndefined();
    expect(queue.jobs.value).toHaveLength(0);
    expect(inspect).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(initialize).not.toHaveBeenCalled();
  });

  it('restores the ordinary composer when the user selects a different endpoint', async () => {
    const scope = effectScope();
    scopes.push(scope);
    const state = scope.run(() => useModelLaunchChat({
      chat: computed(() => currentChat.value),
      resolved: computed(() => ({ endpoint: { type: 'openai' as const, url: 'https://example.invalid' }, modelId: 'chosen-model' })),
    }))!;
    await flushPromises();
    expect(state.isActive.value).toBe(false);
    expect(state.visible.value).toBe(false);
    expect(state.composerVisibility.value).toBe('visible');
    expect(state.maySend.value).toBe(true);
  });

  it('leaves a detached page receipt on the ordinary Chat path without displaying its former model card', async () => {
    activeLaunch = { ...activeLaunch, phase: 'detached' };
    const { state } = mountState();
    await flushPromises();
    expect(state.visible.value).toBe(false);
    expect(state.maySend.value).toBe(true);
    expect(state.needsRecovery.value).toBe(false);
    expect(prepareModel).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it('does not keep the former active model card after the effective model binding changes', async () => {
    const scope = effectScope();
    scopes.push(scope);
    const state = scope.run(() => useModelLaunchChat({
      chat: computed(() => currentChat.value),
      resolved: computed(() => ({ endpoint: { type: 'llama_cpp_browser' as const }, modelId: 'hf.co/other/repo:Q8_0' })),
    }))!;
    await flushPromises();
    expect(state.isActive.value).toBe(false);
    expect(state.visible.value).toBe(false);
    expect(state.maySend.value).toBe(true);
    expect(prepareModel).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });
});

describe('model-list notifications after preload', () => {
  it('does not flash a Start button on focus or model-list notifications', async () => {
    installed.add(base.target.modelId);
    const { state } = mountState();
    const wrapper = mount(LlamaCppBrowserModelLaunchCard, { props: { state, routePath: '/chat/launch-chat' } });
    await flushPromises();
    const gate = Promise.withResolvers<boolean>();
    vi.mocked(isModelLaunchTargetReady).mockReturnValue(gate.promise);
    window.dispatchEvent(new Event('focus'));
    modelListListener?.();
    await flushPromises();
    expect(state.readiness.value).toBe('ready');
    expect(state.verification.value).toBe('checking');
    expect(state.composerVisibility.value).toBe('visible');
    expect(wrapper.find('[data-testid="start-preview-model"]').exists()).toBe(false);
    gate.resolve(true);
    await flushPromises();
    expect(prepareModel).toHaveBeenCalledOnce();
    wrapper.unmount();
  });
});

describe('composer scope boundaries', () => {
  it('does not hide an existing conversation when its setup model files are missing', async () => {
    const node: MessageNode = {
      id: toMessageId({ raw: 'existing-message' }),
      role: 'user',
      createdAt: 1,
      modelId: undefined,
      lmParameters: undefined,
      parts: [{ type: 'text', text: 'Existing conversation', completeness: 'complete' }],
      replies: { items: [] },
    };
    currentChat.value = { ...currentChat.value!, root: { items: [node] } };
    const { state } = mountState();
    await flushPromises();
    expect(state.composerVisibility.value).toBe('visible');
    expect(state.maySend.value).toBe(false);
    expect(prepareModel).not.toHaveBeenCalled();
  });

  it('does not reuse a ready result after the underlying storage provider was replaced', async () => {
    installed.add(base.target.modelId);
    const { state } = mountState();
    await flushPromises();
    const gate = Promise.withResolvers<boolean>();
    vi.mocked(isModelLaunchTargetReady).mockReturnValueOnce(gate.promise);
    const check = state.refresh();
    storageVersion++;
    gate.resolve(true);
    await check;
    await flushPromises();
    expect(state.readiness.value).toBe('checking');
    expect(state.maySend.value).toBe(false);
    expect(state.composerVisibility.value).toBe('visible');
  });
});

describe('operation-scoped model loading display', () => {
  it('renders measured weights progress and indeterminate initialization without advertising readiness early', async () => {
    const gate = Promise.withResolvers<'ready'>();
    prepareModel.mockReturnValueOnce(gate.promise);
    installed.add(base.target.modelId);
    const { state, scope } = mountState();
    await flushPromises();
    const wrapper = mount(LlamaCppBrowserModelLaunchCard, { props: { state, routePath: '/chat/launch-chat' } });
    const callback = prepareModel.mock.calls[0]![0].onProgress;
    callback({ progress: { phase: 'loading', completed: 0.37, total: 1 } });
    await flushPromises();
    expect(wrapper.get('[data-testid="model-launch-loading"]').text()).toContain('Loading model');
    expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('37');
    callback({ progress: { phase: 'loading', completed: 1, total: 1 } });
    await flushPromises();
    expect(wrapper.find('[data-testid="model-preparation-ready"]').exists()).toBe(false);
    callback({ progress: { phase: 'initializing', completed: 0, total: 0 } });
    await flushPromises();
    expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBeUndefined();
    expect(wrapper.find('[data-testid="model-load-percentage"]').exists()).toBe(false);
    scope.stop();
    const before = state.warmupProgress.value;
    callback({ progress: { phase: 'loading', completed: 0.99, total: 1 } });
    expect(state.warmupProgress.value).toBe(before);
    gate.resolve('ready');
    await flushPromises();
    wrapper.unmount();
  });

  it('does not accept late load progress after the storage provider changes', async () => {
    const gate = Promise.withResolvers<'ready'>();
    prepareModel.mockReturnValueOnce(gate.promise);
    installed.add(base.target.modelId);
    const { state } = mountState();
    await flushPromises();
    const callback = prepareModel.mock.calls[0]![0].onProgress;
    storageVersion++;
    callback({ progress: { phase: 'loading', completed: 0.5, total: 1 } });
    expect(state.warmupProgress.value).toBeUndefined();
    gate.resolve('ready');
    await flushPromises();
    expect(state.warmup.value).not.toBe('ready');
  });
});

describe('reload journal observation without launch authority', () => {
  function interrupted(): ObservedLegacyModelDownload {
    return { effectiveModelId: base.target.modelId, target: base.target, destination: { kind: 'opfs' }, expectedRoot: undefined, journal: { version: 1, selection: base.target.selection, bytes: [64], complete: [false] } };
  }
  function mountObserved({ observed }: { observed: ObservedLegacyModelDownload }) {
    launchEnabled = false;
    observe.mockResolvedValue(observed);
    const scope = effectScope();
    scopes.push(scope);
    const state = scope.run(() => useModelLaunchChat({ chat: computed(() => currentChat.value), resolved: computed(() => ({ endpoint: { type: 'llama_cpp_browser' as const }, modelId: currentChat.value?.modelId ?? observed.effectiveModelId })) }))!;
    return { state, scope };
  }

  it('shows only checkpointed paused progress after reload without metadata, transfer, warmup, or settings writes', async () => {
    const { state } = mountObserved({ observed: interrupted() });
    await flushPromises();
    const wrapper = mount(LlamaCppBrowserModelLaunchCard, { props: { state, routePath: '/chat/launch-chat' } });
    expect(state.launch.value).toBeUndefined();
    expect(state.maySend.value).toBe(false);
    expect(wrapper.get('[data-testid="model-launch-observed-download"]').text()).toContain(lazyStrings.llamaCppBrowserDownloads__paused());
    expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('25');
    expect(wrapper.find('[data-testid="start-preview-model"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="model-launch-refresh-choices"]').attributes('disabled')).toBeDefined();
    state.selectPath({ path: 'Model-Q8_0.gguf' });
    await state.refreshChoices();
    expect(state.selectedTarget.value).toEqual(base.target);
    expect(inspect).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(prepareModel).not.toHaveBeenCalled();
    expect(initialize).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('resumes the journal pinned files only on a click and returns to ordinary Chat on completion', async () => {
    const observed = interrupted();
    const { state } = mountObserved({ observed });
    await flushPromises();
    download.mockImplementationOnce(async () => {
      installed.add(observed.target.modelId);
      observe.mockResolvedValue(undefined);
    });
    await state.adoptAndDownload();
    await flushPromises();
    expect(download).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ selection: observed.journal.selection }));
    expect(state.launch.value).toBeUndefined();
    expect(state.visible.value).toBe(false);
    expect(state.maySend.value).toBe(true);
    expect(prepare).not.toHaveBeenCalled();
    expect(initialize).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
    expect(prepareModel).not.toHaveBeenCalled();
  });

  it('rejects a replaced journal instead of silently resuming a different pinned revision', async () => {
    const observed = interrupted();
    const { state } = mountObserved({ observed });
    await flushPromises();
    const selection = { ...observed.target.selection, revision: 'b'.repeat(40) };
    const replacement: ObservedLegacyModelDownload = { ...observed, target: { ...observed.target, selection }, journal: { ...observed.journal, selection } };
    observe.mockResolvedValue(replacement);
    await state.adoptAndDownload();
    expect(state.error.value).toBe(true);
    expect(download).not.toHaveBeenCalled();
    expect(queue.jobs.value).toHaveLength(0);
    expect(prepare).not.toHaveBeenCalled();
    await flushPromises();
    expect(state.observedDownload.value).toEqual(replacement);
    download.mockImplementationOnce(async () => {
      observe.mockResolvedValue(undefined);
    });
    await state.adoptAndDownload();
    await flushPromises();
    expect(download).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ selection }));
  });

  it('rejects a changed current binding between the click and journal verification', async () => {
    const { state } = mountObserved({ observed: interrupted() });
    await flushPromises();
    captureBinding.mockResolvedValueOnce({ revision: 1 }).mockResolvedValueOnce({ revision: 2 });
    await state.adoptAndDownload();
    expect(state.error.value).toBe(true);
    expect(download).not.toHaveBeenCalled();
    expect(queue.jobs.value).toHaveLength(0);
  });

  it('does not enqueue after the storage provider changed during local reinspection', async () => {
    const observed = interrupted();
    const { state } = mountObserved({ observed });
    await flushPromises();
    const gate = Promise.withResolvers<ObservedLegacyModelDownload>();
    observe.mockReturnValueOnce(gate.promise);
    const pending = state.adoptAndDownload();
    await flushPromises();
    storageVersion++;
    gate.resolve(observed);
    await pending;
    expect(download).not.toHaveBeenCalled();
    expect(queue.jobs.value).toHaveLength(0);
  });

  it('rechecks the binding again when a previously accepted resume reaches the queue', async () => {
    const held = Promise.withResolvers<void>();
    const other = { ...base.target.selection, repository: 'other/repo' };
    download.mockImplementationOnce(() => held.promise);
    const blocker = queue.enqueue({ key: 'blocker', repository: other.repository, source: 'repository', prepare: async () => other });
    await flushPromises();
    const { state } = mountObserved({ observed: interrupted() });
    await flushPromises();
    let revision = 1;
    captureBinding.mockImplementation(async () => ({ revision }));
    await state.adoptAndDownload();
    await flushPromises();
    expect(state.job.value?.status).toBe('queued');
    revision = 2;
    held.resolve();
    await blocker.done;
    await flushPromises();
    expect(download).toHaveBeenCalledTimes(1);
    expect(state.job.value?.status).toBe('failed');
    expect(prepare).not.toHaveBeenCalled();
  });

  it('asks for host write permission only at Resume and refuses a substituted physical root without OPFS fallback', async () => {
    const originalRoot = { requestPermission: vi.fn(async () => 'granted' as const), isSameEntry: vi.fn(async () => false) } as unknown as HostModelDirectoryHandle;
    const replacementRoot = { name: 'Replacement' } as HostModelDirectoryHandle;
    const observed: ObservedLegacyModelDownload = { ...interrupted(), effectiveModelId: 'host/Library/owner/Model-GGUF:Q4_K_M', destination: { kind: 'host', directoryId: 'host-root' }, expectedRoot: originalRoot };
    const { state } = mountObserved({ observed });
    await flushPromises();
    expect(originalRoot.requestPermission).not.toHaveBeenCalled();
    observe.mockResolvedValue({ ...observed, expectedRoot: replacementRoot });
    await state.adoptAndDownload();
    expect(originalRoot.requestPermission).toHaveBeenCalledExactlyOnceWith({ mode: 'readwrite' });
    expect(state.error.value).toBe(true);
    expect(download).not.toHaveBeenCalled();
    expect(queue.jobs.value).toHaveLength(0);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('keeps ordinary missing-model recovery usable when a journal cannot be read', async () => {
    launchEnabled = false;
    observe.mockRejectedValueOnce(new Error('corrupt journal'));
    const { state } = mountState();
    await flushPromises();
    expect(state.visible.value).toBe(false);
    expect(state.maySend.value).toBe(true);
    expect(state.launch.value).toBeUndefined();
  });

  it('hides an observed download immediately when the effective model changes', async () => {
    const { state } = mountObserved({ observed: interrupted() });
    await flushPromises();
    expect(state.visible.value).toBe(true);
    currentChat.value = { ...currentChat.value!, modelId: 'hf.co/other/repo:Q8_0' };
    expect(state.visible.value).toBe(false);
    expect(state.maySend.value).toBe(true);
    await flushPromises();
    expect(state.visible.value).toBe(false);
    expect(download).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });
});
