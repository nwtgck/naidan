import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { computed, defineComponent, ref, type Ref } from 'vue';
import { toChatGroupId, toChatId, toMessageId } from '@/01-models/ids';
import type { Chat, Endpoint } from '@/01-models/types';
import type { LocalModel, Progress } from '@/features/llama-cpp-browser/types';
import { assertLocalModelLaunchReady, localModelLaunchSession, registerLocalModelLaunchSession, retireLocalModelLaunchSession } from './local-model-launch-session';
import { suspendLocalModelLaunchPreparation, useLocalModelLaunchChat } from './useLocalModelLaunchChat';

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), back: vi.fn(), listeners: new Set<() => void>(), pending: undefined as Ref<boolean> | undefined }));
vi.mock('@/features/llama-cpp-browser', () => ({ llamaCppBrowserService: { prepareModel: mocks.prepare } }));
vi.mock('@/composables/chat/chat-scoped/chat-model-binding-operations', () => ({ hasChatLocalModelPreparation: () => mocks.pending?.value ?? false }));
vi.mock('@/composables/useAppEntry', () => ({ useAppEntry: () => ({ returnToHome: mocks.back }) }));
vi.mock('../model-files', () => ({
  llamaCppBrowserModelFiles: {
    subscribeModelList: ({ listener }: { listener(): void }) => {
      mocks.listeners.add(listener);
      return () => {
        mocks.listeners.delete(listener);
      };
    },
  },
}));

const model: LocalModel = { modelId: 'temp/local:Q4', size: 128, importedAt: 1 };
const saved: LocalModel = { modelId: 'user/local-2', size: 128, importedAt: 2 };
const chatId = toChatId({ raw: 'local-session' });
const chatGroupId = toChatGroupId({ raw: 'local-session-group' });
const wrappers: VueWrapper[] = [];

function fixture({ register, homeOriginId }: { register: boolean, homeOriginId: string | undefined }) {
  const chat = ref<Chat | null>({ id: chatId, groupId: chatGroupId, title: null, root: { items: [] }, createdAt: 1, updatedAt: 1, debugEnabled: false });
  const binding = ref<{ endpoint: Endpoint, modelId: string | undefined }>({ endpoint: { type: 'llama_cpp_browser' }, modelId: model.modelId });
  let current = true;
  if (register && chat.value !== null) {
    registerLocalModelLaunchSession({
      chat: chat.value,
      model,
      homeOriginId,
      isCurrent: () => current,
      readBinding: () => ({ ...binding.value, chatGroupId: chat.value?.groupId }),
    });
  }
  let state: ReturnType<typeof useLocalModelLaunchChat> | undefined;
  const host = defineComponent({
    setup() {
      state = useLocalModelLaunchChat({ chat: computed(() => chat.value), resolved: computed(() => binding.value) });
      return {};
    },
    template: '<div />',
  });
  function render() {
    const wrapper = mount(host);
    wrappers.push(wrapper);
    if (state === undefined) {
      throw new Error('Missing local state');
    }
    return { wrapper, state };
  }
  return {
    chat,
    binding,
    render,
    invalidate: () => {
      current = false;
      for (const listener of mocks.listeners) {
        listener();
      }
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pending = ref(false);
  mocks.prepare.mockResolvedValue('ready');
});

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) {
    wrapper.unmount();
  }
  const session = localModelLaunchSession({ chatId });
  if (session !== undefined) {
    retireLocalModelLaunchSession({ session });
  }
});

it('shows only an explicitly started local session and blocks sending until actual preparation completes', async () => {
  const pending = Promise.withResolvers<'ready'>();
  mocks.prepare.mockReturnValue(pending.promise);
  const { render } = fixture({ register: true, homeOriginId: 'home' });
  const { state } = render();
  await flushPromises();
  expect(state.visible.value).toBe(true);
  expect(state.model.value).toEqual(model);
  expect(state.maySend.value).toBe(false);
  const progress: Progress = { phase: 'loading', completed: 32, total: 128 };
  mocks.prepare.mock.calls[0]?.[0].onProgress({ progress });
  expect(state.progress.value).toEqual(progress);
  pending.resolve('ready');
  await flushPromises();
  expect(state.status.value).toBe('ready');
  expect(state.maySend.value).toBe(true);
  expect(state.model.value).toEqual(model);
  await state.back();
  expect(mocks.back).toHaveBeenCalledWith({ homeOriginId: 'home' });
});

it('leaves an ordinary local-model chat outside the start presentation', async () => {
  const { render } = fixture({ register: false, homeOriginId: undefined });
  const { state } = render();
  await flushPromises();
  expect(state.visible.value).toBe(false);
  expect(state.maySend.value).toBe(true);
  expect(mocks.prepare).not.toHaveBeenCalled();
  await state.back();
  expect(mocks.back).not.toHaveBeenCalled();
});

it.each(['busy', 'runtime'])('keeps failed preparation blocked until an explicit retry (%s)', async reason => {
  if (reason === 'busy') {
    mocks.prepare.mockResolvedValueOnce('skipped-busy');
  } else {
    mocks.prepare.mockRejectedValueOnce(new Error('runtime failure'));
  }
  const { render } = fixture({ register: true, homeOriginId: undefined });
  const { state } = render();
  await flushPromises();
  expect(state.status.value).toBe('error');
  expect(state.maySend.value).toBe(false);
  expect(mocks.prepare).toHaveBeenCalledOnce();
  await state.retry();
  expect(state.status.value).toBe('ready');
  expect(mocks.prepare).toHaveBeenCalledTimes(2);
});

it.each(['model', 'endpoint', 'membership', 'source', 'message'])('retires the view when its owner changes (%s)', async change => {
  const { chat, binding, render, invalidate } = fixture({ register: true, homeOriginId: undefined });
  const { state } = render();
  await flushPromises();
  switch (change) {
  case 'model': binding.value = { ...binding.value, modelId: 'another-model' };
    break;
  case 'endpoint': binding.value = { ...binding.value, endpoint: { type: 'openai', url: '' } };
    break;
  case 'membership': if (chat.value) {
    chat.value.groupId = toChatGroupId({ raw: 'other' });
  }
    break;
  case 'source': invalidate();
    break;
  case 'message': if (chat.value) {
    chat.value.root.items.push({ id: toMessageId({ raw: 'message' }), role: 'user', modelId: undefined, lmParameters: undefined, parts: [], createdAt: 1, replies: { items: [] } });
  }
    break;
  default: throw new Error(change);
  }
  await flushPromises();
  expect(state.visible.value).toBe(false);
  expect(localModelLaunchSession({ chatId })).toBeUndefined();
});

it('keeps the session and pending preparation when the view leaves, then rechecks the real engine on return', async () => {
  const { render } = fixture({ register: true, homeOriginId: 'home' });
  const initial = render();
  await flushPromises();
  expect(initial.state.status.value).toBe('ready');
  initial.wrapper.unmount();
  expect(localModelLaunchSession({ chatId })).toBeDefined();
  const returned = render();
  await flushPromises();
  expect(returned.state.visible.value).toBe(true);
  expect(mocks.prepare).toHaveBeenCalledTimes(2);
});

it('shares one normal preparation between two views and rechecks after both leave', async () => {
  const { render } = fixture({ register: true, homeOriginId: undefined });
  const first = render();
  const second = render();
  await flushPromises();
  expect(first.state.maySend.value).toBe(true);
  expect(second.state.status.value).toBe('ready');
  expect(mocks.prepare).toHaveBeenCalledOnce();
  first.wrapper.unmount();
  expect(second.state.status.value).toBe('ready');
  second.wrapper.unmount();
  render();
  await flushPromises();
  expect(mocks.prepare).toHaveBeenCalledTimes(2);
});

it('defers a real re-entry warmup until the replacement preparation guard is released', async () => {
  const { render } = fixture({ register: true, homeOriginId: undefined });
  const first = render();
  await flushPromises();
  first.wrapper.unmount();
  mocks.pending!.value = true;
  render();
  await flushPromises();
  expect(mocks.prepare).toHaveBeenCalledOnce();
  mocks.pending!.value = false;
  await flushPromises();
  expect(mocks.prepare).toHaveBeenCalledTimes(2);
});

it('uses a preparation already pending on return without warming the model twice', async () => {
  const prepared = Promise.withResolvers<'ready'>();
  mocks.prepare.mockReturnValueOnce(prepared.promise);
  const { render } = fixture({ register: true, homeOriginId: undefined });
  const first = render();
  await flushPromises();
  first.wrapper.unmount();
  const returned = render();
  await flushPromises();
  prepared.resolve('ready');
  await flushPromises();
  expect(returned.state.status.value).toBe('ready');
  expect(mocks.prepare).toHaveBeenCalledOnce();
});

it('follows a saved model promotion and does not report loss of the old temporary files', async () => {
  const { chat, binding, render, invalidate } = fixture({ register: true, homeOriginId: 'home' });
  const { state } = render();
  await flushPromises();
  binding.value = { ...binding.value, modelId: saved.modelId };
  registerLocalModelLaunchSession({ chat: chat.value!, model: saved, homeOriginId: 'home', isCurrent: () => true, readBinding: () => ({ ...binding.value, chatGroupId }) });
  invalidate();
  await flushPromises();
  expect(state.visible.value).toBe(true);
  expect(state.model.value).toEqual(saved);
  expect(state.status.value).toBe('ready');
  expect(mocks.prepare.mock.calls[1]?.[0].modelId).toBe(saved.modelId);
});

it('checks preparation and source capability at public send admission without starting a load', async () => {
  const { chat, binding } = fixture({ register: true, homeOriginId: undefined });
  if (chat.value === null) {
    throw new Error('Missing chat');
  }
  const request = { chat: chat.value, ...binding.value };
  expect(() => assertLocalModelLaunchReady(request)).toThrow('busy');
  expect(mocks.prepare).not.toHaveBeenCalled();
  const session = localModelLaunchSession({ chatId });
  if (session === undefined) {
    throw new Error('Missing local session');
  }
  session.status = 'ready';
  const admission = assertLocalModelLaunchReady(request);
  expect(admission).toBeDefined();
  session.isCurrent = () => false;
  expect(() => assertLocalModelLaunchReady(request)).toThrow('missing-model');
  retireLocalModelLaunchSession({ session });
  expect(() => admission?.assertCurrent()).toThrow('missing-model');
  expect(mocks.prepare).not.toHaveBeenCalled();
});

it.each(['ready', 'skipped-busy'] as const)('starts a fresh session when the same model is explicitly selected again after %s', async outcome => {
  mocks.prepare.mockResolvedValueOnce(outcome);
  const { chat, binding, render } = fixture({ register: true, homeOriginId: undefined });
  const { state } = render();
  await flushPromises();
  await suspendLocalModelLaunchPreparation({ chatId });
  expect(localModelLaunchSession({ chatId })).toBeUndefined();
  registerLocalModelLaunchSession({ chat: chat.value!, model, homeOriginId: undefined, isCurrent: () => true, readBinding: () => ({ ...binding.value, chatGroupId }) });
  await flushPromises();
  expect(state.status.value).toBe('ready');
  expect(mocks.prepare).toHaveBeenCalledTimes(2);
});
