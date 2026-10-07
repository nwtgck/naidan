import { computed, effectScope, ref, shallowRef } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { Chat, Endpoint, Settings } from '@/01-models/types';
import { DEFAULT_SETTINGS } from '@/01-models/types';
import { toChatId } from '@/01-models/ids';
import type { ModelLaunchTarget } from '@/01-models/llama-cpp-browser-model-launch';
import { LlamaCppBrowserError, type EngineState } from '@/features/llama-cpp-browser/types';
import { createDownloadQueue } from '@/features/llama-cpp-browser/hugging-face/download-queue';
import { localModelAvailability } from '@/features/llama-cpp-browser/model-recovery/availability';
import LlamaCppBrowserModelRecovery from '@/features/llama-cpp-browser/components/LlamaCppBrowserModelRecovery.vue';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { useMissingLlamaCppBrowserModel } from './useMissingLlamaCppBrowserModel';

const calls = vi.hoisted(() => ({ read: vi.fn(), plan: vi.fn(), installed: vi.fn(), download: vi.fn() }));
const settings = ref<Settings>({ ...DEFAULT_SETTINGS, endpoint: { type: 'llama_cpp_browser' }, storageType: 'opfs' });
const current = shallowRef<Chat | null>(null);
const resolved = ref<{ endpoint: Endpoint, modelId: string | undefined }>({ endpoint: { type: 'llama_cpp_browser' }, modelId: undefined });
const enabled = ref(true);
let storageVersion = 0;
let queue: ReturnType<typeof createDownloadQueue>;
const tasks: { cancelled: boolean, task: () => Promise<void> }[] = [];
const modelListeners = new Set<() => void>();
const stateListeners = new Set<({ state }: { state: EngineState }) => void>();
vi.mock('@/utils/idle-task', () => ({
  scheduleIdleTask: ({ task }: { task: () => Promise<void> }) => {
  const entry = { cancelled: false, task }; tasks.push(entry); return {
    cancel: () => {
    entry.cancelled = true;
  },
  };
},
}));
vi.mock('@/composables/useSettings', () => ({ useSettings: () => ({ settings }) }));
vi.mock('@/00-storage/service', () => ({
  storageService: {
  captureModelLaunchStorage: () => {
  const version = storageVersion; return () => version === storageVersion;
},
},
}));
vi.mock('../runtime/model-store', () => ({ storedModelDirectory: calls.read }));
vi.mock('../model-recovery/download-target', () => ({ resolveRecoveryDownload: calls.plan }));
vi.mock('../hugging-face/storage', () => ({ installedSelection: calls.installed }));
vi.mock('../hugging-face/download-queue', async importOriginal => ({ ...await importOriginal<typeof import('@/features/llama-cpp-browser/hugging-face/download-queue')>(), getDownloadQueue: () => queue }));
vi.mock('@/features/llama-cpp-browser', () => ({
  llamaCppBrowserService: {
  subscribeModelList: ({ listener }: { listener: () => void }) => {
    modelListeners.add(listener); return () => modelListeners.delete(listener);
  },
  subscribe: ({ listener }: { listener: ({ state }: { state: EngineState }) => void }) => {
    stateListeners.add(listener); return () => stateListeners.delete(listener);
  },
},
}));
const target: ModelLaunchTarget = { modelId: 'hf.co/owner/Model:Model-Q4_K_M.gguf', mainFilePath: 'Model-Q4_K_M.gguf', selection: { repository: 'owner/Model', revision: 'a'.repeat(40), files: [{ path: 'Model-Q4_K_M.gguf', size: 256 }] } };
const scopes: ReturnType<typeof effectScope>[] = [];
const wrappers: ReturnType<typeof mount>[] = [];
function start() {
  const scope = effectScope(); scopes.push(scope);
  const state = scope.run(() => useMissingLlamaCppBrowserModel({ chat: computed(() => current.value), resolved: computed(() => resolved.value), enabled: computed(() => enabled.value) }));
  if (state === undefined) throw new Error('Missing hook');
  return { state, scope };
}
async function checkNow(): Promise<void> {
  await flushPromises();
  for (let round = 0; tasks.length > 0 && round < 5; round++) {
    const batch = tasks.splice(0);
    await Promise.all(batch.filter(entry => !entry.cancelled).map(entry => entry.task()));
    await flushPromises();
  }
}
beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  vi.resetAllMocks(); tasks.length = 0; storageVersion = 0; enabled.value = true;
  localModelAvailability.invalidate(); settings.value = { ...DEFAULT_SETTINGS, endpoint: { type: 'llama_cpp_browser' }, storageType: 'opfs' };
  current.value = { id: toChatId({ raw: 'ordinary-chat' }), title: null, root: { items: [] }, createdAt: 1, updatedAt: 1, debugEnabled: false };
  resolved.value = { endpoint: { type: 'llama_cpp_browser' }, modelId: target.modelId };
  calls.read.mockRejectedValue(new LlamaCppBrowserError({ code: 'missing-model' }));
  calls.plan.mockResolvedValue(target); calls.installed.mockResolvedValue(undefined); calls.download.mockResolvedValue(undefined);
  queue = createDownloadQueue({ download: calls.download });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});
afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount()); scopes.splice(0).forEach(scope => scope.stop());
  tasks.length = 0; expect(modelListeners.size).toBe(0); expect(stateListeners.size).toBe(0);
});
describe('ordinary Chat model recovery', () => {
  it('renders the Chat first, inspects locally later, and never inspects remote metadata on mount', async () => {
    const before = structuredClone(current.value);
    const { state } = start();
    expect(calls.read).not.toHaveBeenCalled(); expect(state.visible.value).toBe(false);
    await checkNow();
    expect(state.availability.value).toBe('missing'); expect(state.visible.value).toBe(true); expect(state.maySend.value).toBe(false);
    expect(calls.plan).not.toHaveBeenCalled(); expect(calls.download).not.toHaveBeenCalled(); expect(current.value).toEqual(before);
    expect(state).not.toHaveProperty('composerVisibility');
  });
  it('does not interfere with another endpoint or the dedicated model-link screen', async () => {
    enabled.value = false; const { state } = start(); await checkNow(); expect(calls.read).not.toHaveBeenCalled(); expect(state.maySend.value).toBe(true);
    enabled.value = true; resolved.value.endpoint = { type: 'openai', url: 'https://example.invalid' }; await checkNow();
    expect(calls.read).not.toHaveBeenCalled(); expect(state.visible.value).toBe(false);
  });
  it('uses the effective model even if the Chat has no local model override', async () => {
    const { state } = start(); await checkNow(); expect(calls.read).toHaveBeenCalledWith({ name: target.modelId });
    resolved.value.modelId = 'user/changed'; await checkNow(); expect(state.modelId.value).toBe('user/changed');
    expect(calls.read).toHaveBeenLastCalledWith({ name: 'user/changed' }); expect(state.canDownload.value).toBe(false);
  });
  it('shares the observation across rapid Chat changes instead of scanning on each open', async () => {
    calls.read.mockResolvedValue({}); const { state } = start(); await checkNow();
    current.value = { ...current.value!, id: toChatId({ raw: 'second-chat' }) }; await checkNow();
    expect(calls.read).toHaveBeenCalledOnce(); expect(state.maySend.value).toBe(true);
    const second = start(); await checkNow(); expect(calls.read).toHaveBeenCalledOnce(); expect(second.state.maySend.value).toBe(true);
  });
  it('requires review and size confirmation before downloading without modifying the Chat', async () => {
    const before = structuredClone(current.value); const { state } = start(); await checkNow();
    await state.download(); expect(calls.download).not.toHaveBeenCalled();
    await state.review(); expect(state.target.value).toEqual(target); expect(calls.plan).toHaveBeenCalledOnce(); expect(calls.download).not.toHaveBeenCalled();
    await state.download(); await flushPromises(); expect(calls.download).toHaveBeenCalledOnce(); expect(current.value).toEqual(before);
  });
  it('does not download again when another tab installed the reviewed files', async () => {
    const { state } = start(); await checkNow(); await state.review();
    calls.installed.mockResolvedValue({ id: target.modelId }); calls.read.mockResolvedValue({});
    await state.download(); await checkNow(); expect(calls.download).not.toHaveBeenCalled(); expect(state.visible.value).toBe(false);
  });
  it('does not guess a download for imported or ambiguous model identities', async () => {
    resolved.value.modelId = 'user/Original'; const { state } = start(); await checkNow();
    await state.review(); await state.download(); expect(calls.plan).not.toHaveBeenCalled(); expect(calls.download).not.toHaveBeenCalled();
  });
  it('does not show a download on a permission error and can recheck after it is resolved', async () => {
    calls.read.mockRejectedValue(new DOMException('private path', 'NotAllowedError')); const { state } = start(); await checkNow();
    expect(state.availability.value).toBe('unreadable'); await state.review(); expect(calls.plan).not.toHaveBeenCalled();
    calls.read.mockResolvedValue({}); state.retry(); await checkNow(); expect(state.visible.value).toBe(false); expect(state.maySend.value).toBe(true);
  });
  it('ignores a delayed result after changing models', async () => {
    const gate = Promise.withResolvers<unknown>(); calls.read.mockReturnValueOnce(gate.promise);
    const { state } = start(); const pending = tasks.shift()!.task(); await flushPromises();
    resolved.value.modelId = 'user/new'; calls.read.mockResolvedValue({}); await checkNow();
    gate.reject(new LlamaCppBrowserError({ code: 'missing-model' })); await pending;
    expect(state.availability.value).toBe('available'); expect(state.modelId.value).toBe('user/new');
  });
  it('does not retain ready state from a replaced storage provider', async () => {
    const gate = Promise.withResolvers<unknown>(); calls.read.mockReturnValueOnce(gate.promise);
    const { state } = start(); const pending = tasks.shift()!.task(); await flushPromises();
    storageVersion++; gate.resolve({}); await pending;
    expect(state.availability.value).toBe('unreadable'); expect(state.maySend.value).toBe(false);
  });
  it('does not adopt a review result after navigation', async () => {
    const gate = Promise.withResolvers<ModelLaunchTarget>(); calls.plan.mockReturnValueOnce(gate.promise);
    const { state } = start(); await checkNow(); const action = state.review(); await flushPromises();
    current.value = { ...current.value!, id: toChatId({ raw: 'different-chat' }) }; await checkNow(); gate.resolve(target); await action;
    expect(state.target.value).toBeUndefined(); expect(calls.download).not.toHaveBeenCalled();
  });
  it('does not enqueue after an asynchronous local check if settings or storage changed', async () => {
    const gate = Promise.withResolvers<undefined>(); const { state } = start(); await checkNow(); await state.review();
    calls.installed.mockReturnValueOnce(gate.promise); const pending = state.download(); await flushPromises(); storageVersion++; gate.resolve(undefined); await pending;
    expect(calls.download).not.toHaveBeenCalled();
  });
  it('rechecks on file changes, focus and runtime missing-model, but not byte progress', async () => {
    calls.read.mockResolvedValue({}); const { state } = start(); await checkNow(); calls.read.mockClear();
    for (const listener of stateListeners) listener({ state: { status: 'working', progress: { phase: 'loading', completed: 1, total: 100 } } });
    await checkNow(); expect(calls.read).not.toHaveBeenCalled();
    calls.read.mockRejectedValue(new LlamaCppBrowserError({ code: 'missing-model' }));
    for (const listener of modelListeners) listener(); await checkNow(); expect(state.availability.value).toBe('missing');
    calls.read.mockResolvedValue({}); window.dispatchEvent(new Event('focus')); await checkNow(); expect(state.availability.value).toBe('available');
    calls.read.mockRejectedValue(new LlamaCppBrowserError({ code: 'missing-model' }));
    for (const listener of stateListeners) listener({ state: { status: 'error', code: 'missing-model' } });
    await checkNow(); expect(state.availability.value).toBe('missing');
  });
  it('deduplicates double clicks, leaves an explicit download page-owned, and checks after completion', async () => {
    const gate = Promise.withResolvers<void>(); calls.download.mockReturnValueOnce(gate.promise);
    const { state, scope } = start(); await checkNow(); await state.review();
    const first = state.download(); await state.download(); await first; await flushPromises(); expect(calls.download).toHaveBeenCalledOnce();
    scope.stop(); calls.read.mockResolvedValue({}); gate.resolve(); await flushPromises();
    expect(queue.jobs.value[0]?.status).toBe('complete');
  });
});
describe('ordinary recovery notice with real controls', () => {
  async function render() {
    const { state } = start();
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }] }); await router.push('/');
    const wrapper = mount(LlamaCppBrowserModelRecovery, { props: { state }, global: { plugins: [router] } }); wrappers.push(wrapper);
    return { state, wrapper, router };
  }
  it('appears only on a confirmed problem, reviews size, then starts the exact download', async () => {
    const { state, wrapper } = await render(); expect(wrapper.find('[data-testid="model-recovery"]').exists()).toBe(false);
    await checkNow(); expect(wrapper.get('[data-testid="model-recovery-name"]').text()).toContain('Model-Q4_K_M.gguf');
    await wrapper.get('[data-testid="model-recovery-review"]').trigger('click'); await flushPromises();
    expect(wrapper.get('[data-testid="model-recovery-size"]').text()).toContain('256'); expect(calls.download).not.toHaveBeenCalled();
    calls.read.mockResolvedValue({}); await wrapper.get('[data-testid="model-recovery-download"]').trigger('click'); await checkNow();
    expect(state.visible.value).toBe(false); expect(wrapper.find('[data-testid="model-recovery"]').exists()).toBe(false);
  });
  it('provides model management without changing Chat or navigating to a new Chat', async () => {
    resolved.value.modelId = 'user/original'; const { wrapper, router } = await render(); await checkNow();
    expect(wrapper.find('[data-testid="model-recovery-review"]').exists()).toBe(false);
    await wrapper.get('[data-testid="model-recovery-manage"]').trigger('click'); await flushPromises();
    expect(router.currentRoute.value.query.settings).toBe('llama-cpp-browser'); expect(router.currentRoute.value.path).toBe('/');
  });
  it('does not advertise a transfer when storage cannot be inspected', async () => {
    calls.read.mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    const { wrapper } = await render(); await checkNow();
    expect(wrapper.text()).toContain('Could not check'); expect(wrapper.find('[data-testid="model-recovery-review"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="model-recovery-download"]').exists()).toBe(false);
  });
});
