import { mount, flushPromises } from '@vue/test-utils';
import { computed, defineComponent, ref, shallowRef } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat, Settings } from '@/01-models/types';
import { DEFAULT_SETTINGS } from '@/01-models/types';
import { toChatId, toChatGroupId } from '@/01-models/ids';
import type { ChatModelLaunch, ModelLaunchTarget } from '@/01-models/llama-cpp-browser-model-launch';
import { modelLaunchViewHistoryKey, modelLaunchViewState } from '@/features/llama-cpp-browser/model-launch/history';
import { useRestoredModelLaunch } from './useRestoredModelLaunch';
const calls = vi.hoisted(() => ({ target: vi.fn(), restore: vi.fn(), get: vi.fn() }));
const settings = ref<Settings>({ ...DEFAULT_SETTINGS, storageType: 'memory', endpoint: { type: 'openai', url: '' } });
let storageCurrent = true;
vi.mock('@/composables/useSettings', () => ({ useSettings: () => ({ settings }) }));
vi.mock('../model-launch/restore', () => ({ restoreModelLaunchTarget: calls.target }));
vi.mock('@/00-storage/service', () => ({ storageService: { getModelLaunch: calls.get, restoreModelLaunch: calls.restore, captureModelLaunchStorage: () => () => storageCurrent } }));
const chatId = toChatId({ raw: 'saved-chat' });
const chatGroupId = toChatGroupId({ raw: 'saved-cg' });
const target: ModelLaunchTarget = { modelId: 'hf.co/owner/Model-GGUF:Model-Q4_K_M.gguf', mainFilePath: 'Model-Q4_K_M.gguf', selection: { repository: 'owner/Model-GGUF', revision: 'a'.repeat(40), files: [{ path: 'Model-Q4_K_M.gguf', size: 256 }] } };
const launch: ChatModelLaunch = { version: 1, input: 'owner/Model-GGUF:Q4_K_M', requestedVariant: 'Q4_K_M', target, chatGroupId, phase: 'active' };
const current = shallowRef<Chat | null>(null);
const hosts: ReturnType<typeof mount>[] = [];
beforeEach(() => {
  vi.resetAllMocks(); storageCurrent = true; settings.value = { ...DEFAULT_SETTINGS, storageType: 'memory', endpoint: { type: 'openai', url: '' } };
  current.value = { id: chatId, groupId: chatGroupId, title: null, root: { items: [] }, createdAt: 1, updatedAt: 1, debugEnabled: false };
  calls.get.mockReturnValue(undefined); calls.target.mockResolvedValue(target); calls.restore.mockResolvedValue(launch);
});
afterEach(() => hosts.splice(0).forEach(host => host.unmount()));
async function start({ context, path }: { context: 'present' | 'absent', path: string }) {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }, { path: '/chat/:id', component: { template: '<div />' } }] });
  await router.push({ path, state: context === 'present' ? { [modelLaunchViewHistoryKey]: modelLaunchViewState({ chatId, input: launch.input, modelId: target.modelId, revision: target.selection.revision }) } : {} });
  let state: ReturnType<typeof useRestoredModelLaunch> | undefined;
  const host = mount(defineComponent({ setup() {
    state = useRestoredModelLaunch({ chat: computed(() => current.value), resolved: computed(() => ({ endpoint: { type: 'llama_cpp_browser' }, modelId: target.modelId })) });
    return {};
  }, template: '<div />' }), { global: { plugins: [router] } });
  hosts.push(host);
  if (state === undefined) throw new Error('Missing setup');
  return { state, router, host };
}
describe('restored embedded launch card', () => {
  it('rebuilds transient card state in the existing chat after reload without adding fields to that chat', async () => {
    const before = structuredClone(current.value);
    const { state, router } = await start({ context: 'present', path: '/chat/saved-chat' });
    expect(state.restoration.value).toBe('checking');
    await flushPromises(); expect(state.launch.value).toEqual(launch); expect(state.restoration.value).toBe('idle');
    expect(state.launch.value?.requestedVariant).toBe('Q4_K_M');
    expect(current.value).toEqual(before); expect(current.value).not.toHaveProperty('modelLaunch');
    expect(router.currentRoute.value.fullPath).toBe('/chat/saved-chat'); expect(calls.restore).toHaveBeenCalledOnce();
  });
  it('does not discover external metadata for an ordinary bookmark with no model-link context', async () => {
    const { state } = await start({ context: 'absent', path: '/chat/saved-chat' }); await flushPromises();
    expect(state.launch.value).toBeUndefined(); expect(calls.target).not.toHaveBeenCalled();
  });
  it('does not let a different split pane consume or rewrite this route context', async () => {
    const { state, router } = await start({ context: 'present', path: '/chat/another-chat' });
    calls.get.mockReturnValue(launch); const original = structuredClone(router.options.history.state);
    state.synchronize(); await flushPromises();
    expect(state.isCurrentRoute.value).toBe(false); expect(calls.target).not.toHaveBeenCalled();
    expect(router.options.history.state).toEqual(original);
  });
  it('cancels an old restore after navigation away without resurrecting the launch', async () => {
    const gate = Promise.withResolvers<ModelLaunchTarget>(); calls.target.mockReturnValueOnce(gate.promise);
    const { router, state } = await start({ context: 'present', path: '/chat/saved-chat' });
    await router.push('/'); gate.resolve(target); await flushPromises();
    expect(calls.restore).not.toHaveBeenCalled(); expect(state.launch.value).toBeUndefined();
  });
  it('rejects restoration when saved endpoint/model or membership no longer permits it', async () => {
    calls.restore.mockResolvedValueOnce(undefined);
    const { state } = await start({ context: 'present', path: '/chat/saved-chat' }); await flushPromises();
    expect(state.restoration.value).toBe('failed'); expect(state.launch.value).toBeUndefined();
    state.retryRestoration(); await flushPromises(); expect(state.launch.value).toEqual(launch);
  });
  it('does not hydrate a different storage provider after an asynchronous lookup', async () => {
    const gate = Promise.withResolvers<ModelLaunchTarget>(); calls.target.mockReturnValueOnce(gate.promise);
    const { state } = await start({ context: 'present', path: '/chat/saved-chat' });
    storageCurrent = false; gate.resolve(target); await flushPromises();
    expect(calls.restore).not.toHaveBeenCalled(); expect(state.launch.value).toBeUndefined();
  });
});
