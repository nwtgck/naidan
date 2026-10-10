import { isModelLaunchTargetReady } from '@/features/llama-cpp-browser/model-launch/readiness';
import type { ChatModelLaunch } from '@/01-models/llama-cpp-browser-model-launch';
import LlamaCppBrowserModelLaunchCard from '@/features/llama-cpp-browser/components/LlamaCppBrowserModelLaunchCard.vue';
import { createRouter, createMemoryHistory } from 'vue-router';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { lazyStrings } from '@/strings';
import { computed, effectScope, ref, shallowRef } from 'vue';
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
const settings = ref<Settings>({ ...DEFAULT_SETTINGS, storageType: 'memory', endpoint: { type: 'openai', url: '' } });
let queue: ReturnType<typeof createDownloadQueue>;
const download = vi.fn();
const installed = new Set<string>();
const capture = vi.fn(async () => ({ endpoint: settings.value.endpoint, modelId: settings.value.defaultModelId, revision: 0, isStorageCurrent: () => true }));
const initialize = vi.fn(async () => 'applied' as const);
const inspect = vi.fn();
const prepare = vi.fn();
const prepareModel = vi.fn();
let activeLaunch: ChatModelLaunch;
let launchEnabled = true;
let storageVersion = 0;
let modelListListener: (() => void) | undefined;
const getState = vi.fn(() => ({ status: 'idle' as const }));
const currentChat = shallowRef<Chat | null>(null);
vi.mock('@/composables/useSettings', () => ({ useSettings: () => ({ settings, captureModelLaunchDefaults: capture, initializeModelLaunchDefaults: initialize }) }));
vi.mock('@/features/llama-cpp-browser', () => ({
  llamaCppBrowserService: {
    prepareModel: (args: unknown) => prepareModel(args),
    getState: () => getState(),
    subscribe: vi.fn(() => () => {}),
    subscribeModelList: ({ listener }: { listener: () => void }) => {
      modelListListener = listener; return () => {
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
vi.mock('@/00-storage/service', () => ({
  storageService: {
    getModelLaunch: () => launchEnabled ? activeLaunch : undefined,
    prepareModelLaunchChat: (args: { request: ModelLaunchChatRequest }) => prepare(args),
    captureModelLaunchStorage: () => {
      const version = storageVersion; return () => version === storageVersion;
    },
    loadChat: async () => currentChat.value,
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
  const scope = effectScope(); scopes.push(scope);
  const state = scope.run(() => useModelLaunchChat({ chat: computed(() => currentChat.value), resolved: computed(() => ({ endpoint: { type: 'llama_cpp_browser' as const }, modelId: activeLaunch.target.modelId })) }))!;
  return { scope, state };
}

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  vi.clearAllMocks(); installed.clear(); launchEnabled = true; modelListListener = undefined; storageVersion = 0;
  vi.mocked(isModelLaunchTargetReady).mockReset().mockImplementation(async ({ target }) => installed.has(target.modelId)); TEST_ONLY.reset(); rememberLaunchCatalog({ catalog });
  currentChat.value = { id: toChatId({ raw: 'launch-chat' }), groupId: toChatGroupId({ raw: 'launch-cg' }), title: null, root: { items: [] }, debugEnabled: false, createdAt: 1, updatedAt: 1 };
  activeLaunch = { version: 1, input: catalog.repository, ...base, chatGroupId: toChatGroupId({ raw: 'launch-cg' }), phase: 'active' };
  prepareModel.mockResolvedValue('ready');
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  download.mockImplementation(async ({ selection }: { selection: DownloadSelection }) => {
    const path = selection.files[0]!.path; installed.add(`hf.co/${selection.repository}:${encodeURIComponent(path)}`);
  });
  queue = createDownloadQueue({ download });
  prepare.mockImplementation(async ({ request }: { request: ModelLaunchChatRequest }): Promise<Chat> => {
    activeLaunch = { ...activeLaunch, target: request.target, chatGroupId: request.newChatGroupId, phase: 'active' }; return { ...currentChat.value!, groupId: request.newChatGroupId };
  });
  initialize.mockResolvedValue('applied'); inspect.mockResolvedValue(catalog);
});

afterEach(() => scopes.splice(0).forEach(scope => scope.stop()));

describe('model launch chat workflow', () => {
  it('checks local files but never downloads or fetches metadata on mount', async () => {
    const { state } = mountState(); await flushPromises();
    expect(state.readiness.value).toBe('missing'); expect(state.maySend.value).toBe(false);
    expect(download).not.toHaveBeenCalled(); expect(inspect).not.toHaveBeenCalled(); expect(initialize).not.toHaveBeenCalled();
  });

  it('downloads once on explicit action, reports readiness, and initializes only after verification', async () => {
    const gate = Promise.withResolvers<void>();
    download.mockImplementationOnce(async () => {
      await gate.promise; installed.add(base.target.modelId);
    });
    const { state } = mountState(); await flushPromises();
    const action = state.adoptAndDownload(); await state.adoptAndDownload(); await action; await flushPromises();
    expect(download).toHaveBeenCalledOnce(); expect(state.job.value?.status).toBe('downloading'); expect(state.maySend.value).toBe(false); expect(initialize).not.toHaveBeenCalled();
    gate.resolve(); await vi.waitFor(() => expect(state.maySend.value).toBe(true));
    expect(state.readiness.value).toBe('ready'); expect(initialize).toHaveBeenCalledOnce();
  });

  it('does not mutate shared settings merely because an unpinned selector changed', async () => {
    const { state } = mountState(); await flushPromises();
    state.selectPath({ path: 'Model-Q8_0.gguf' }); await flushPromises();
    expect(prepare).not.toHaveBeenCalled(); expect(download).not.toHaveBeenCalled();
    expect(activeLaunch.target.modelId).toBe(base.target.modelId); expect(state.maySend.value).toBe(false);
    await state.adoptAndDownload(); await flushPromises();
    expect(prepare).toHaveBeenCalledOnce(); expect(prepare.mock.calls[0]![0].request.mode).toBe('retarget');
    expect(activeLaunch.target.mainFilePath).toBe('Model-Q8_0.gguf');
  });

  it('uses an already installed newly selected model without a payload download', async () => {
    const other = targetForChoice({ catalog, path: 'Model-Q8_0.gguf' }); installed.add(other.modelId);
    const { state } = mountState(); await flushPromises(); state.selectPath({ path: other.mainFilePath }); await flushPromises();
    expect(state.maySend.value).toBe(false); await state.adoptAndDownload(); await flushPromises();
    expect(download).not.toHaveBeenCalled(); expect(state.maySend.value).toBe(true);
  });

  it('cannot change a URL-pinned quantization through the card selector action', async () => {
    activeLaunch = { ...activeLaunch, requestedVariant: 'Q4_K_M' };
    const { state } = mountState(); await flushPromises(); state.selectPath({ path: 'Model-Q8_0.gguf' });
    expect(state.selectedPath.value).toBe('Model-Q4_K_M.gguf');
  });

  it('keeps a page-owned download alive when its card unmounts, without applying stale global changes', async () => {
    const gate = Promise.withResolvers<void>(); download.mockImplementationOnce(async () => {
      await gate.promise; installed.add(base.target.modelId);
    });
    const { scope, state } = mountState(); await flushPromises(); await state.adoptAndDownload(); await flushPromises();
    scope.stop(); gate.resolve(); await flushPromises();
    expect(queue.jobs.value[0]?.status).toBe('complete'); expect(initialize).not.toHaveBeenCalled();
  });

  it('allows chat after file verification even if writing global defaults fails', async () => {
    installed.add(base.target.modelId); initialize.mockRejectedValueOnce(new Error('quota'));
    const { state } = mountState(); await flushPromises();
    expect(state.defaultWarning.value).toBe(true); expect(state.maySend.value).toBe(true);
  });

  it('invalidates readiness when files are removed and does not refresh metadata', async () => {
    installed.add(base.target.modelId); const { state } = mountState(); await flushPromises(); expect(state.maySend.value).toBe(true);
    installed.clear(); await state.refresh(); expect(state.maySend.value).toBe(false); expect(inspect).not.toHaveBeenCalled();
  });

  it('repairs a saved incomplete reservation without automatically downloading', async () => {
    activeLaunch = { ...activeLaunch, phase: 'reserved' };
    const { state } = mountState(); expect(state.maySend.value).toBe(false); await flushPromises();
    expect(prepare).toHaveBeenCalledOnce(); expect(state.launch.value?.phase).toBe('active'); expect(download).not.toHaveBeenCalled();
  });
});

describe('model launch card rendering', () => {
  async function renderCard() {
    const { state } = mountState();
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }] });
    await router.push('/');
    const wrapper = mount(LlamaCppBrowserModelLaunchCard, { props: { state }, global: { plugins: [router] } });
    await flushPromises(); return { wrapper, state };
  }

  it('shows quantization choices for an unpinned link and exposes an explicit download button', async () => {
    const { wrapper } = await renderCard();
    expect(wrapper.find('[data-testid="model-launch-quantization"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="model-launch-download"]').exists()).toBe(true);
    expect(download).not.toHaveBeenCalled(); wrapper.unmount();
  });

  it('hides only the central quantization selector when the link specifies a variant', async () => {
    activeLaunch = { ...activeLaunch, requestedVariant: 'Q4_K_M' };
    const { wrapper } = await renderCard();
    expect(wrapper.find('select').exists()).toBe(false);
    expect(wrapper.find('[data-testid="model-launch-fixed-quantization"]').text()).toContain('Q4_K_M');
    wrapper.unmount();
  });

  it('renders the ready status for verified local files without downloading', async () => {
    installed.add(base.target.modelId);
    const { wrapper, state } = await renderCard();
    expect(wrapper.get('[data-testid="model-launch-ready"]').text()).toBe(lazyStrings.LlamaCppBrowserModelLaunch__ready_when_you_are());
    expect(wrapper.find('[data-testid="model-launch-download"]').exists()).toBe(false);
    expect(state.maySend.value).toBe(true);
    expect(download).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});

describe('automatic local preparation', () => {
  it('prepares only once after files are verified and does not block sending during the load', async () => {
    const gate = Promise.withResolvers<'ready'>(); prepareModel.mockReturnValueOnce(gate.promise); installed.add(base.target.modelId);
    const { state } = mountState(); await flushPromises();
    expect(prepareModel).toHaveBeenCalledOnce(); expect(state.warmup.value).toBe('loading'); expect(state.maySend.value).toBe(true);
    await state.refresh(); await flushPromises(); expect(prepareModel).toHaveBeenCalledOnce();
    gate.resolve('ready'); await flushPromises(); expect(state.warmup.value).toBe('ready');
    expect(download).not.toHaveBeenCalled(); expect(inspect).not.toHaveBeenCalled();
  });

  it('waits until a hidden tab becomes visible', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); installed.add(base.target.modelId);
    const { state } = mountState(); await flushPromises(); expect(prepareModel).not.toHaveBeenCalled();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange')); await flushPromises();
    expect(prepareModel).toHaveBeenCalledOnce(); expect(state.warmup.value).toBe('ready');
  });

  it('cancels only its own preparation when leaving and ignores late success', async () => {
    const gate = Promise.withResolvers<'ready'>(); prepareModel.mockReturnValueOnce(gate.promise); installed.add(base.target.modelId);
    const { scope, state } = mountState(); await flushPromises(); const signal: AbortSignal = prepareModel.mock.calls[0]![0].signal;
    scope.stop(); expect(signal.aborted).toBe(true); gate.resolve('ready'); await flushPromises(); expect(state.warmup.value).not.toBe('ready');
  });

  it('does not spin when another operation owns the worker', async () => {
    prepareModel.mockResolvedValueOnce('skipped-busy'); installed.add(base.target.modelId); const { state } = mountState(); await flushPromises();
    expect(state.warmup.value).toBe('deferred'); await state.refresh(); window.dispatchEvent(new Event('focus')); await flushPromises();
    expect(prepareModel).toHaveBeenCalledOnce(); expect(state.maySend.value).toBe(true);
  });

  it('does not prevent a normal send after speculative preparation failed', async () => {
    prepareModel.mockRejectedValueOnce(new Error('device lost')); installed.add(base.target.modelId); const { state } = mountState(); await flushPromises();
    expect(state.warmup.value).toBe('failed'); expect(state.maySend.value).toBe(true); expect(download).not.toHaveBeenCalled();
  });
});

describe('stable file verification and focused setup', () => {
  async function renderCard() {
    const { state } = mountState();
    const wrapper = mount(LlamaCppBrowserModelLaunchCard, { props: { state } });
    await flushPromises();
    return { wrapper, state };
  }

  it('does not briefly offer Start while an installed model is being checked on mount', async () => {
    const gate = Promise.withResolvers<boolean>();
    vi.mocked(isModelLaunchTargetReady).mockReturnValue(gate.promise);
    const { wrapper, state } = await renderCard();
    expect(state.composerVisibility.value).toBe('hidden');
    expect(wrapper.find('[data-testid="model-launch-checking"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="model-launch-download"]').exists()).toBe(false);
    gate.resolve(true); await flushPromises();
    expect(state.composerVisibility.value).toBe('visible');
    expect(wrapper.find('[data-testid="model-launch-ready"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="model-launch-download"]').exists()).toBe(false);
    expect(download).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('keeps the ready presentation and composer during revalidation but gates submission', async () => {
    installed.add(base.target.modelId);
    const { wrapper, state } = await renderCard();
    const readyNode = wrapper.get('[data-testid="model-launch-ready"]').element;
    const gate = Promise.withResolvers<boolean>();
    vi.mocked(isModelLaunchTargetReady).mockReturnValueOnce(gate.promise);
    const check = state.refresh(); await flushPromises();
    expect(state.verification.value).toBe('checking');
    expect(state.readiness.value).toBe('ready');
    expect(state.maySend.value).toBe(false);
    expect(state.composerVisibility.value).toBe('visible');
    expect(wrapper.find('[data-testid="model-launch-download"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="model-launch-ready"]').element).toBe(readyNode);
    gate.resolve(true); await check; await flushPromises();
    expect(state.maySend.value).toBe(true);
    expect(prepareModel).toHaveBeenCalledOnce();
    wrapper.unmount();
  });

  it('keeps the same Start button during a recheck of missing files without permitting a transfer', async () => {
    const { wrapper, state } = await renderCard();
    const button = wrapper.get('[data-testid="model-launch-download"]');
    expect(button.text()).toBe('Start with this model');
    const gate = Promise.withResolvers<boolean>();
    vi.mocked(isModelLaunchTargetReady).mockReturnValueOnce(gate.promise);
    const check = state.refresh(); await flushPromises();
    expect(wrapper.get('[data-testid="model-launch-download"]').element).toBe(button.element);
    expect(button.attributes('disabled')).toBeDefined();
    await state.adoptAndDownload();
    expect(download).not.toHaveBeenCalled();
    gate.resolve(false); await check; await flushPromises();
    expect(button.attributes('disabled')).toBeUndefined();
    expect(state.composerVisibility.value).toBe('hidden');
    wrapper.unmount();
  });

  it('changes the presentation only after a recheck confirms file deletion', async () => {
    installed.add(base.target.modelId);
    const { wrapper, state } = await renderCard();
    const gate = Promise.withResolvers<boolean>();
    vi.mocked(isModelLaunchTargetReady).mockReturnValueOnce(gate.promise);
    const check = state.refresh(); await flushPromises();
    expect(state.composerVisibility.value).toBe('visible');
    gate.resolve(false); await check; await flushPromises();
    expect(state.readiness.value).toBe('missing');
    expect(state.composerVisibility.value).toBe('hidden');
    expect(wrapper.find('[data-testid="model-launch-download"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('does not suggest redownloading when the file check itself failed', async () => {
    installed.add(base.target.modelId);
    const { wrapper, state } = await renderCard();
    vi.mocked(isModelLaunchTargetReady).mockRejectedValueOnce(new Error('storage unavailable'));
    await state.refresh(); await flushPromises();
    expect(state.readiness.value).toBe('failed');
    expect(state.maySend.value).toBe(false);
    expect(state.composerVisibility.value).toBe('hidden');
    expect(wrapper.find('[data-testid="model-launch-download"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="model-launch-check-retry"]').exists()).toBe(true);
    expect(download).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('ignores a late successful check for a formerly selected model', async () => {
    installed.add(base.target.modelId);
    const { state } = mountState(); await flushPromises();
    const gate = Promise.withResolvers<boolean>();
    vi.mocked(isModelLaunchTargetReady).mockReturnValueOnce(gate.promise);
    const check = state.refresh();
    state.selectPath({ path: 'Model-Q8_0.gguf' }); await flushPromises();
    expect(state.readiness.value).toBe('missing');
    gate.resolve(true); await check; await flushPromises();
    expect(state.selectedTarget.value?.mainFilePath).toBe('Model-Q8_0.gguf');
    expect(state.readiness.value).toBe('missing');
    expect(state.composerVisibility.value).toBe('hidden');
    expect(state.maySend.value).toBe(false);
  });

  it('keeps only the latest concurrent verification result', async () => {
    const { state } = mountState(); await flushPromises();
    const old = Promise.withResolvers<boolean>();
    vi.mocked(isModelLaunchTargetReady).mockReturnValueOnce(old.promise);
    const first = state.refresh();
    installed.add(base.target.modelId);
    await state.refresh();
    old.resolve(false); await first; await flushPromises();
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
    await wrapper.get('[data-testid="model-launch-download"]').trigger('click'); await flushPromises();
    expect(state.composerVisibility.value).toBe('hidden');
    expect(wrapper.text()).toContain('Downloading model');
    expect(wrapper.find('[data-testid="model-launch-download"]').exists()).toBe(false);
    const pause = wrapper.get('[data-testid="llama-download-pause"]');
    expect(pause.attributes('disabled')).toBeUndefined();
    await pause.trigger('click'); await flushPromises();
    expect(state.job.value?.status).toBe('paused');
    expect(wrapper.findAll('[data-testid="llama-download-resume"]')).toHaveLength(1);
    expect(wrapper.find('[data-testid="model-launch-download"]').exists()).toBe(false);
    await wrapper.get('[data-testid="llama-download-resume"]').trigger('click'); await flushPromises();
    expect(download).toHaveBeenCalledTimes(2);
    expect(state.composerVisibility.value).toBe('visible');
    expect(wrapper.find('[data-testid="llama-download-job"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('shows one retry for a failed transfer, not a second Start button', async () => {
    download.mockRejectedValueOnce(new Error('network'));
    const { wrapper } = await renderCard();
    await wrapper.get('[data-testid="model-launch-download"]').trigger('click'); await flushPromises();
    expect(wrapper.findAll('[data-testid="llama-download-resume"]')).toHaveLength(1);
    expect(wrapper.find('[data-testid="model-launch-download"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('does not revive Start in the gap between transfer completion and file verification', async () => {
    const transfer = Promise.withResolvers<void>();
    download.mockImplementationOnce(() => transfer.promise);
    const { wrapper, state } = await renderCard();
    await state.adoptAndDownload(); await flushPromises();
    const check = Promise.withResolvers<boolean>();
    vi.mocked(isModelLaunchTargetReady).mockReturnValue(check.promise);
    transfer.resolve(); await flushPromises();
    expect(state.job.value?.status).toBe('complete');
    expect(wrapper.find('[data-testid="model-launch-download"]').exists()).toBe(false);
    expect(state.composerVisibility.value).toBe('hidden');
    check.resolve(true); await flushPromises();
    expect(state.composerVisibility.value).toBe('visible');
    wrapper.unmount();
  });

  it('keeps ordinary chats visible even when they have no local model files', async () => {
    launchEnabled = false;
    const { state } = mountState(); await flushPromises();
    expect(state.visible.value).toBe(false);
    expect(state.composerVisibility.value).toBe('visible');
  });

  it('restores the ordinary composer when the user selects a different endpoint', async () => {
    const scope = effectScope(); scopes.push(scope);
    const state = scope.run(() => useModelLaunchChat({
      chat: computed(() => currentChat.value),
      resolved: computed(() => ({ endpoint: { type: 'openai' as const, url: 'https://example.invalid' }, modelId: 'chosen-model' })),
    }))!;
    await flushPromises();
    expect(state.isActive.value).toBe(false);
    expect(state.composerVisibility.value).toBe('visible');
    expect(state.maySend.value).toBe(true);
  });
});

describe('model-list notifications after preload', () => {
  it('does not flash a Start button on focus or model-list notifications', async () => {
    installed.add(base.target.modelId);
    const { state } = mountState();
    const wrapper = mount(LlamaCppBrowserModelLaunchCard, { props: { state } });
    await flushPromises();
    const gate = Promise.withResolvers<boolean>();
    vi.mocked(isModelLaunchTargetReady).mockReturnValue(gate.promise);
    window.dispatchEvent(new Event('focus'));
    modelListListener?.();
    await flushPromises();
    expect(state.readiness.value).toBe('ready');
    expect(state.verification.value).toBe('checking');
    expect(state.composerVisibility.value).toBe('visible');
    expect(wrapper.find('[data-testid="model-launch-download"]').exists()).toBe(false);
    gate.resolve(true); await flushPromises();
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
    const { state } = mountState(); await flushPromises();
    expect(state.composerVisibility.value).toBe('visible');
    expect(state.maySend.value).toBe(false);
    expect(prepareModel).not.toHaveBeenCalled();
  });

  it('does not reuse a ready result after the underlying storage provider was replaced', async () => {
    installed.add(base.target.modelId);
    const { state } = mountState(); await flushPromises();
    const gate = Promise.withResolvers<boolean>();
    vi.mocked(isModelLaunchTargetReady).mockReturnValueOnce(gate.promise);
    const check = state.refresh();
    storageVersion++;
    gate.resolve(true); await check; await flushPromises();
    expect(state.readiness.value).toBe('checking');
    expect(state.maySend.value).toBe(false);
    expect(state.composerVisibility.value).toBe('hidden');
  });
});

describe('operation-scoped model loading display', () => {
  it('renders measured weights progress and indeterminate initialization without advertising readiness early', async () => {
    const gate = Promise.withResolvers<'ready'>(); prepareModel.mockReturnValueOnce(gate.promise); installed.add(base.target.modelId);
    const { state, scope } = mountState(); await flushPromises();
    const wrapper = mount(LlamaCppBrowserModelLaunchCard, { props: { state } });
    const callback = prepareModel.mock.calls[0]![0].onProgress;
    callback({ progress: { phase: 'loading', completed: 0.37, total: 1 } }); await flushPromises();
    expect(wrapper.get('[data-testid="model-launch-loading"]').text()).toContain('Loading model');
    expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('37');
    callback({ progress: { phase: 'loading', completed: 1, total: 1 } }); await flushPromises();
    expect(wrapper.find('[data-testid="model-launch-ready"]').exists()).toBe(false);
    callback({ progress: { phase: 'initializing', completed: 0, total: 0 } }); await flushPromises();
    expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBeUndefined();
    expect(wrapper.find('[data-testid="model-load-percentage"]').exists()).toBe(false);
    scope.stop(); const before = state.warmupProgress.value;
    callback({ progress: { phase: 'loading', completed: 0.99, total: 1 } });
    expect(state.warmupProgress.value).toBe(before);
    gate.resolve('ready'); await flushPromises(); wrapper.unmount();
  });

  it('does not accept late load progress after the storage provider changes', async () => {
    const gate = Promise.withResolvers<'ready'>(); prepareModel.mockReturnValueOnce(gate.promise); installed.add(base.target.modelId);
    const { state } = mountState(); await flushPromises(); const callback = prepareModel.mock.calls[0]![0].onProgress;
    storageVersion++;
    callback({ progress: { phase: 'loading', completed: 0.5, total: 1 } });
    expect(state.warmupProgress.value).toBeUndefined(); gate.resolve('ready'); await flushPromises();
    expect(state.warmup.value).not.toBe('ready');
  });
});
