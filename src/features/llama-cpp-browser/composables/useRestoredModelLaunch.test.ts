import { mount, flushPromises } from '@vue/test-utils';
import { computed, defineComponent, ref, shallowRef } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat, Settings } from '@/01-models/types';
import { DEFAULT_SETTINGS } from '@/01-models/types';
import { toChatId, toChatGroupId } from '@/01-models/ids';
import type { ChatModelLaunch, ModelLaunchTarget } from '@/01-models/llama-cpp-browser-model-launch';
import { useRestoredModelLaunch } from './useRestoredModelLaunch';
import type { ObservedLegacyModelDownload } from '@/features/llama-cpp-browser/model-launch/restore';
const calls = vi.hoisted(() => ({ target: vi.fn(), get: vi.fn() }));
const settings = ref<Settings>({ ...DEFAULT_SETTINGS, storageType: 'memory', endpoint: { type: 'openai', url: '' } });
let storageCurrent = true;
vi.mock('@/composables/useSettings', () => ({ useSettings: () => ({ settings }) }));
vi.mock('../model-launch/restore', () => ({ observeLegacyModelDownload: calls.target }));
vi.mock('@/00-storage/service', () => ({ storageService: { getModelLaunch: calls.get, captureModelLaunchStorage: () => () => storageCurrent } }));
const chatId = toChatId({ raw: 'saved-chat' });
const untrustedHistoryKey = '_internalNaidanLlamaCppBrowserModelLaunchView';
const chatGroupId = toChatGroupId({ raw: 'saved-cg' });
const target: ModelLaunchTarget = { modelId: 'hf.co/owner/Model-GGUF:Q4_K_M', mainFilePath: 'Model-Q4_K_M.gguf', selection: { repository: 'owner/Model-GGUF', revision: 'a'.repeat(40), files: [{ path: 'Model-Q4_K_M.gguf', size: 256 }] } };
const launch: ChatModelLaunch = {
  input: 'owner/Model-GGUF:Q4_K_M',
  requestedVariant: 'Q4_K_M',
  target,
  chatGroupId,
  phase: 'active',
  destination: { kind: 'opfs' },
  effectiveModelId: target.modelId,
  chatGroupName: 'Model',
  titleGeneration: DEFAULT_SETTINGS.titleGeneration,
};
const observed: ObservedLegacyModelDownload = { effectiveModelId: target.modelId, target, destination: { kind: 'opfs' }, expectedRoot: undefined, journal: { version: 1, selection: target.selection, bytes: [64], complete: [false] } };
const resolvedModelId = ref(target.modelId);
const current = shallowRef<Chat | null>(null);
const hosts: ReturnType<typeof mount>[] = [];

beforeEach(() => {
  vi.resetAllMocks();
  storageCurrent = true;
  resolvedModelId.value = target.modelId;
  settings.value = { ...DEFAULT_SETTINGS, storageType: 'memory', endpoint: { type: 'openai', url: '' } };
  current.value = { id: chatId, groupId: chatGroupId, title: null, root: { items: [] }, createdAt: 1, updatedAt: 1, debugEnabled: false };
  calls.get.mockReturnValue(undefined);
  calls.target.mockResolvedValue(observed);
});

afterEach(() => hosts.splice(0).forEach(host => host.unmount()));

async function start({ context, path }: { context: 'present' | 'absent', path: string }) {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }, { path: '/chat/:id', component: { template: '<div />' } }] });
  await router.push({ path, state: context === 'present' ? { [untrustedHistoryKey]: { chatId: 'another-chat', input: 'other/repo', modelId: 'hf.co/other/repo:Q8_0', revision: 'f'.repeat(40) } } : {} });
  let state: ReturnType<typeof useRestoredModelLaunch> | undefined;
  const host = mount(defineComponent({
    setup() {
      state = useRestoredModelLaunch({ chat: computed(() => current.value), resolved: computed(() => ({ endpoint: { type: 'llama_cpp_browser' }, modelId: resolvedModelId.value })) });
      return {};
    },
    template: '<div />',
  }), { global: { plugins: [router] } });
  hosts.push(host);
  if (state === undefined) {
    throw new Error('Missing setup');
  }
  return { state, router, host };
}

describe('restored embedded launch card', () => {
  it('observes checkpointed bytes after reload without recreating a Start receipt or adding fields to the chat', async () => {
    const before = structuredClone(current.value);
    const gate = Promise.withResolvers<ObservedLegacyModelDownload>();
    calls.target.mockReturnValueOnce(gate.promise);
    const { state, router } = await start({ context: 'present', path: '/chat/saved-chat' });
    expect(state.restoration.value).toBe('checking');
    gate.resolve(observed);
    await flushPromises();
    expect(state.launch.value).toBeUndefined();
    expect(state.observedDownload.value).toEqual(observed);
    expect(state.restoration.value).toBe('idle');
    expect(current.value).toEqual(before);
    expect(current.value).not.toHaveProperty('modelLaunch');
    expect(router.currentRoute.value.fullPath).toBe('/chat/saved-chat');
  });

  it('reads only the current binding journal even when an ordinary bookmark has no history hint', async () => {
    const { state } = await start({ context: 'absent', path: '/chat/saved-chat' });
    await flushPromises();
    expect(state.launch.value).toBeUndefined();
    expect(state.observedDownload.value).toEqual(observed);
    expect(calls.target).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ modelId: target.modelId }));
  });

  it('keeps a page-owned host identity without persisting its plan into navigation history', async () => {
    resolvedModelId.value = 'host/model-library/owner/Model-GGUF:Q4_K_M';
    const saved: ChatModelLaunch = { ...launch, destination: { kind: 'host', directoryId: 'host-directory' }, effectiveModelId: resolvedModelId.value };
    calls.get.mockReturnValue(saved);
    const { state, router } = await start({ context: 'absent', path: '/chat/saved-chat' });
    await flushPromises();
    expect(state.launch.value).toEqual(saved);
    expect(router.options.history.state).not.toHaveProperty(untrustedHistoryKey);
    expect(calls.target).not.toHaveBeenCalled();
  });

  it('does not let a different split pane consume or rewrite this route context', async () => {
    const { state, router } = await start({ context: 'present', path: '/chat/another-chat' });
    calls.get.mockReturnValue(launch);
    const original = structuredClone(router.options.history.state);
    state.synchronize();
    await flushPromises();
    expect(state.isCurrentRoute.value).toBe(false);
    expect(calls.target).not.toHaveBeenCalled();
    expect(router.options.history.state).toEqual(original);
  });

  it('cancels an old restore after navigation away without resurrecting the launch', async () => {
    const gate = Promise.withResolvers<ObservedLegacyModelDownload>();
    calls.target.mockReturnValueOnce(gate.promise);
    const { router, state } = await start({ context: 'present', path: '/chat/saved-chat' });
    await router.push('/');
    gate.resolve(observed);
    await flushPromises();
    expect(state.launch.value).toBeUndefined();
    expect(state.observedDownload.value).toBeUndefined();
  });

  it('can retry a local observation failure without ever issuing a launch restore', async () => {
    calls.target.mockRejectedValueOnce(new Error('unreadable journal'));
    const { state } = await start({ context: 'present', path: '/chat/saved-chat' });
    await flushPromises();
    expect(state.restoration.value).toBe('failed');
    expect(state.launch.value).toBeUndefined();
    state.retryRestoration();
    await flushPromises();
    expect(state.observedDownload.value).toEqual(observed);
    expect(state.launch.value).toBeUndefined();
  });

  it('does not hydrate a different storage provider after an asynchronous lookup', async () => {
    const gate = Promise.withResolvers<ObservedLegacyModelDownload>();
    calls.target.mockReturnValueOnce(gate.promise);
    const { state } = await start({ context: 'present', path: '/chat/saved-chat' });
    storageCurrent = false;
    gate.resolve(observed);
    await flushPromises();
    expect(state.launch.value).toBeUndefined();
    expect(state.observedDownload.value).toBeUndefined();
  });

  it('leaves a ready model without a journal on the ordinary Chat path despite a history hint', async () => {
    calls.target.mockResolvedValueOnce(undefined);
    const { state } = await start({ context: 'present', path: '/chat/saved-chat' });
    await flushPromises();
    expect(state.restoration.value).toBe('idle');
    expect(state.observedDownload.value).toBeUndefined();
    expect(state.launch.value).toBeUndefined();
  });
});
