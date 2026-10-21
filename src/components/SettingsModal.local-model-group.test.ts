import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { computed, defineComponent, ref, toRaw } from 'vue';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { toChatGroupId, toChatId } from '@/01-models/ids';
import { EMPTY_LM_PARAMETERS, type Chat, type Settings } from '@/01-models/types';
import type { LocalModel } from '@/features/llama-cpp-browser/types';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import SettingsModal from './SettingsModal.vue';

const mocks = vi.hoisted(() => ({
  listModelEntries: vi.fn(),
  createChatGroup: vi.fn(),
  createChatWithoutSelecting: vi.fn(),
  showConfirm: vi.fn(),
  updateGlobalModelAndEndpoint: vi.fn(),
  loadChatGroup: vi.fn(),
  loadHierarchy: vi.fn(),
  loadChat: vi.fn(),
}));
vi.mock('@/00-storage/service', () => ({ storageService: { loadChatGroup: mocks.loadChatGroup, loadHierarchy: mocks.loadHierarchy, loadChat: mocks.loadChat } }));
vi.mock('@/features/llama-cpp-browser', () => ({ llamaCppBrowserService: { listModelEntries: mocks.listModelEntries } }));
vi.mock('@/composables/chat/ui/useChatOrganization', () => ({ useChatOrganization: () => ({ createChatGroup: mocks.createChatGroup }) }));
vi.mock('@/composables/chat/ui/useChatLifecycle', () => ({ useChatLifecycle: () => ({ createChatWithoutSelecting: mocks.createChatWithoutSelecting }) }));
vi.mock('@/composables/useConfirm', () => ({ useConfirm: () => ({ showConfirm: mocks.showConfirm }) }));
vi.mock('@/composables/useToast', () => ({ useToast: () => ({ addToast: vi.fn() }) }));
vi.mock('@/composables/useLayout', () => ({ useLayout: () => ({ setActiveFocusArea: vi.fn() }) }));
vi.mock('@/composables/useFeatureFlags', () => ({ useFeatureFlags: () => ({ isFeatureEnabled: () => false }) }));
vi.mock('@/features/llama-cpp-browser/hugging-face/session', () => ({ provideHuggingFaceSession: () => {} }));
vi.mock('@/utils/vue', async importOriginal => {
  const actual = await importOriginal<typeof import('@/utils/vue')>();
  const { defineAsyncComponent } = await import('vue');
  return { ...actual, defineAsyncComponentAndLoadOnMounted: ({ loader }: { loader: import('vue').AsyncComponentLoader }) => defineAsyncComponent(loader) };
});
vi.mock('@/composables/useSettings', () => ({ useSettings: vi.fn() }));
import { useSettings } from '@/composables/useSettings';

const model: LocalModel = { modelId: 'hf.co/owner/repo:Q4_K_M', size: 128, importedAt: 1 };
const expectedChatGroupName = 'repo:Q4_K_M';
const chatGroupId = toChatGroupId({ raw: 'local-group' });
const chat: Chat = { id: toChatId({ raw: 'local-chat' }), groupId: chatGroupId, title: null, root: { items: [] }, createdAt: 1, updatedAt: 1, debugEnabled: false };
const settings: Settings = {
  endpoint: { type: 'openai', url: 'http://localhost:1234/v1' },
  defaultModelId: 'global-model',
  titleGeneration: { endpoint: 'same_scope', model: 'same_scope', lmParameters: EMPTY_LM_PARAMETERS },
  storageType: 'local',
  mounts: [],
  providerProfiles: [],
  systemPrompt: 'Saved prompt',
};
const wrappers: VueWrapper[] = [];
const managerStub = defineComponent({
  name: 'LlamaCppBrowserManager',
  props: ['createChatGroup', 'applyDefaultModel', 'defaultModel', 'suspended'],
  template: '<div data-testid="local-manager-stub" />',
});
const connectionStub = defineComponent({
  name: 'ConnectionTab',
  props: ['modelValue', 'hasUnsavedChanges'],
  emits: ['update:modelValue'],
  template: '<div data-testid="connection-stub" />',
});

async function render({ dirty }: { dirty: boolean }) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/chat/:id', component: { template: '<div />' } },
      { path: '/settings/:tab', component: { template: '<div />' } },
    ],
  });
  await router.push('/chat/existing?settings=connection&q=old-search');
  const host = defineComponent({
    components: { SettingsModal },
    props: { suspended: Boolean },
    setup() {
      return { open: computed(() => Boolean(router.currentRoute.value.query.settings) || router.currentRoute.value.path.startsWith('/settings')) };
    },
    template: '<SettingsModal :is-open="open" :suspended="suspended" />',
  });
  const wrapper = mount(host, {
    global: {
      plugins: [router],
      stubs: {
        ConnectionTab: connectionStub,
        LlamaCppBrowserManager: managerStub,
        ThemeToggle: true,
        LanguageSelector: true,
      },
    },
  });
  wrappers.push(wrapper);
  const modal = wrapper.getComponent(SettingsModal);
  if (dirty) {
    modal.getComponent(connectionStub).vm.$emit('update:modelValue', { ...settings, systemPrompt: 'Unsaved prompt' });
  }
  await router.push('/chat/existing?settings=llama-cpp-browser&q=old-search');
  await flushPromises();
  const create = modal.getComponent(managerStub).props('createChatGroup') as ({ model, signal }: { model: LocalModel, signal: AbortSignal }) => Promise<void>;
  return { wrapper, modal, router, create, controller: new AbortController() };
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.listModelEntries.mockResolvedValue([model]);
  mocks.createChatGroup.mockResolvedValue(chatGroupId);
  mocks.createChatWithoutSelecting.mockResolvedValue(chat);
  mocks.showConfirm.mockResolvedValue(true);
  mocks.loadChatGroup.mockResolvedValue({ id: chatGroupId, name: expectedChatGroupName, endpoint: { type: 'llama_cpp_browser' }, modelId: model.modelId });
  mocks.loadHierarchy.mockResolvedValue({ items: [{ type: 'chat_group', id: chatGroupId, chat_ids: [chat.id] }] });
  mocks.loadChat.mockResolvedValue(chat);
  vi.mocked(useSettings).mockReturnValue({
    settings: ref(structuredClone(settings)),
    availableModels: ref([]),
    isFetchingModels: ref(false),
    updateGlobalModelAndEndpoint: mocks.updateGlobalModelAndEndpoint,
  } as unknown as ReturnType<typeof useSettings>);
  await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) {
    wrapper.unmount();
  }
  vi.restoreAllMocks();
});

it('creates a local-model group and one inheriting chat, then closes Settings through one clean route navigation', async () => {
  const { modal, router, create, controller } = await render({ dirty: false });
  const push = vi.spyOn(router, 'push');
  const globalBefore = structuredClone(toRaw(useSettings().settings.value));
  await create({ model, signal: controller.signal });
  await flushPromises();
  expect(mocks.showConfirm).not.toHaveBeenCalled();
  expect(mocks.listModelEntries).toHaveBeenCalledWith({ signal: controller.signal });
  expect(mocks.createChatGroup).toHaveBeenCalledExactlyOnceWith({ name: expectedChatGroupName, options: { endpoint: { type: 'llama_cpp_browser' }, modelId: model.modelId } });
  expect(mocks.createChatWithoutSelecting).toHaveBeenCalledExactlyOnceWith({ groupId: chatGroupId, modelId: undefined, systemPrompt: undefined });
  expect(push).toHaveBeenCalledExactlyOnceWith('/chat/local-chat');
  expect(router.currentRoute.value.query).toEqual({});
  expect(modal.props('isOpen')).toBe(false);
  expect(modal.emitted('close')).toBeUndefined();
  expect(useSettings().settings.value).toEqual(globalBefore);
  expect(mocks.updateGlobalModelAndEndpoint).not.toHaveBeenCalled();
});

it('also leaves path-based Settings by navigating directly to the new chat', async () => {
  const { modal, router, create, controller } = await render({ dirty: false });
  await router.push('/settings/llama-cpp-browser');
  await create({ model, signal: controller.signal });
  await flushPromises();
  expect(router.currentRoute.value.fullPath).toBe('/chat/local-chat');
  expect(modal.props('isOpen')).toBe(false);
});

it('creates distinct chat groups with the same file-derived name on repeated successful launches', async () => {
  const secondChatGroupId = toChatGroupId({ raw: 'second-local-group' });
  const secondChat = { ...chat, id: toChatId({ raw: 'second-local-chat' }), groupId: secondChatGroupId };
  mocks.createChatGroup.mockResolvedValueOnce(chatGroupId).mockResolvedValueOnce(secondChatGroupId);
  mocks.createChatWithoutSelecting.mockResolvedValueOnce(chat).mockResolvedValueOnce(secondChat);
  const { router, create, controller } = await render({ dirty: false });
  await create({ model, signal: controller.signal });
  expect(router.currentRoute.value.fullPath).toBe('/chat/local-chat');
  await router.push('/chat/local-chat?settings=llama-cpp-browser');
  await create({ model, signal: new AbortController().signal });
  expect(mocks.createChatGroup).toHaveBeenCalledTimes(2);
  expect(mocks.createChatGroup.mock.calls.map(([input]) => input.name)).toEqual([expectedChatGroupName, expectedChatGroupName]);
  expect(mocks.createChatWithoutSelecting.mock.calls.map(([input]) => input.groupId)).toEqual([chatGroupId, secondChatGroupId]);
  expect(router.currentRoute.value.fullPath).toBe('/chat/second-local-chat');
  expect(mocks.loadChatGroup).not.toHaveBeenCalled();
  expect(mocks.loadHierarchy).not.toHaveBeenCalled();
});

it('asks before discarding Connection edits and creates nothing when the user keeps editing', async () => {
  mocks.showConfirm.mockResolvedValue(false);
  const { modal, create, controller } = await render({ dirty: true });
  await create({ model, signal: controller.signal });
  expect(mocks.showConfirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Discard Unsaved Changes?', confirmButtonText: 'Discard' }));
  expect(mocks.listModelEntries).not.toHaveBeenCalled();
  expect(mocks.createChatGroup).not.toHaveBeenCalled();
  expect(modal.props('isOpen')).toBe(true);
});

it('rejects a renamed model selection after confirmation', async () => {
  const confirm = Promise.withResolvers<boolean>();
  mocks.showConfirm.mockReturnValue(confirm.promise);
  const { create, controller } = await render({ dirty: true });
  const result = create({ model, signal: controller.signal });
  await flushPromises();
  expect(mocks.listModelEntries).not.toHaveBeenCalled();
  const renamed = { ...model, modelId: 'hf.co/owner/Renamed-GGUF:Q4_K_M' };
  mocks.listModelEntries.mockResolvedValue([renamed]);
  confirm.resolve(true);
  await expect(result).rejects.toThrow('Local model unavailable');
  expect(mocks.createChatGroup).not.toHaveBeenCalled();
});

it.each(['missing', 'listing failed'])('does not create or navigate when the local model is unavailable (%s)', async failure => {
  const { router, create, controller } = await render({ dirty: false });
  const push = vi.spyOn(router, 'push');
  if (failure === 'missing') {
    mocks.listModelEntries.mockResolvedValue([]);
  } else {
    mocks.listModelEntries.mockRejectedValue(new Error('storage unavailable'));
  }
  await expect(create({ model, signal: controller.signal })).rejects.toThrow();
  expect(mocks.createChatGroup).not.toHaveBeenCalled();
  expect(push).not.toHaveBeenCalled();
});

it('ignores a second request while confirmation or saving is in flight', async () => {
  const saving = Promise.withResolvers<typeof chatGroupId>();
  mocks.createChatGroup.mockReturnValue(saving.promise);
  const { create, controller } = await render({ dirty: false });
  const first = create({ model, signal: controller.signal });
  await flushPromises();
  await create({ model, signal: controller.signal });
  expect(mocks.createChatGroup).toHaveBeenCalledOnce();
  saving.resolve(chatGroupId);
  await first;
  expect(mocks.createChatWithoutSelecting).toHaveBeenCalledOnce();
});

it.each(['reject', 'busy'])('reuses a successfully created group after chat creation fails (%s)', async failure => {
  if (failure === 'reject') {
    mocks.createChatWithoutSelecting.mockRejectedValueOnce(new Error('save failure'));
  } else {
    mocks.createChatWithoutSelecting.mockResolvedValueOnce(null);
  }
  const { create, controller } = await render({ dirty: false });
  await expect(create({ model, signal: controller.signal })).rejects.toThrow();
  await create({ model, signal: controller.signal });
  expect(mocks.createChatGroup).toHaveBeenCalledOnce();
  expect(mocks.createChatWithoutSelecting).toHaveBeenCalledTimes(2);
  expect(mocks.createChatWithoutSelecting.mock.calls.every(([input]) => input.groupId === chatGroupId)).toBe(true);
});

it.each(['reject', 'navigation failure'])('reuses both saved ids when only navigation fails (%s)', async failure => {
  const { router, create, controller } = await render({ dirty: false });
  const push = vi.spyOn(router, 'push');
  let removeGuard: (() => void) | undefined;
  if (failure === 'reject') {
    push.mockRejectedValueOnce(new Error('navigation failed'));
  } else {
    removeGuard = router.beforeEach(() => false);
  }
  await expect(create({ model, signal: controller.signal })).rejects.toThrow();
  removeGuard?.();
  await create({ model, signal: controller.signal });
  expect(mocks.createChatGroup).toHaveBeenCalledOnce();
  expect(mocks.createChatWithoutSelecting).toHaveBeenCalledOnce();
  expect(push).toHaveBeenCalledTimes(2);
  expect(router.currentRoute.value.fullPath).toBe('/chat/local-chat');
});

it('does not reuse an unconfirmed group id after group creation rejects', async () => {
  mocks.createChatGroup.mockRejectedValueOnce(new Error('group save failed'));
  const { create, controller } = await render({ dirty: false });
  await expect(create({ model, signal: controller.signal })).rejects.toThrow('group save failed');
  expect(mocks.createChatWithoutSelecting).not.toHaveBeenCalled();
  await create({ model, signal: controller.signal });
  expect(mocks.createChatGroup).toHaveBeenCalledTimes(2);
  expect(mocks.createChatWithoutSelecting).toHaveBeenCalledOnce();
});

async function leaveSettings({ reason, wrapper, router, controller }: { reason: string, wrapper: VueWrapper, router: Router, controller: AbortController }): Promise<void> {
  switch (reason) {
  case 'close': await router.push('/chat/existing');
    break;
  case 'route': await router.push('/chat/existing?settings=tools');
    break;
  case 'suspend': await wrapper.setProps({ suspended: true });
    break;
  case 'abort': controller.abort();
    break;
  case 'unmount': wrapper.unmount();
    break;
  default: throw new Error(reason);
  }
}

it.each(['close', 'route', 'suspend', 'abort', 'unmount'])('does not create after a delayed confirmation is invalidated (%s)', async reason => {
  const confirm = Promise.withResolvers<boolean>();
  mocks.showConfirm.mockReturnValue(confirm.promise);
  const context = await render({ dirty: true });
  const result = context.create({ model, signal: context.controller.signal });
  await flushPromises();
  await leaveSettings({ reason, ...context });
  confirm.resolve(true);
  await result;
  expect(mocks.listModelEntries).not.toHaveBeenCalled();
  expect(mocks.createChatGroup).not.toHaveBeenCalled();
});

it.each(['close', 'route', 'suspend', 'abort', 'unmount'])('does not create or navigate after delayed listing is invalidated (%s)', async reason => {
  const list = Promise.withResolvers<LocalModel[]>();
  mocks.listModelEntries.mockReturnValue(list.promise);
  const context = await render({ dirty: false });
  const result = context.create({ model, signal: context.controller.signal });
  await flushPromises();
  await leaveSettings({ reason, ...context });
  list.resolve([model]);
  await result;
  expect(mocks.createChatGroup).not.toHaveBeenCalled();
  expect(mocks.createChatWithoutSelecting).not.toHaveBeenCalled();
});

it.each(['group', 'chat'])('stops before the next step when the modal closes during a successful save (%s)', async step => {
  const chatGroupSave = Promise.withResolvers<typeof chatGroupId>();
  const savingChat = Promise.withResolvers<Chat>();
  if (step === 'group') {
    mocks.createChatGroup.mockReturnValue(chatGroupSave.promise);
  } else {
    mocks.createChatWithoutSelecting.mockReturnValue(savingChat.promise);
  }
  const context = await render({ dirty: false });
  const result = context.create({ model, signal: context.controller.signal });
  await flushPromises();
  await context.router.push('/chat/existing');
  const push = vi.spyOn(context.router, 'push');
  chatGroupSave.resolve(chatGroupId);
  savingChat.resolve(chat);
  await result;
  expect(push).not.toHaveBeenCalled();
  if (step === 'group') {
    expect(mocks.createChatWithoutSelecting).not.toHaveBeenCalled();
  }
});

it('suppresses a late failure after the user navigates away', async () => {
  const list = Promise.withResolvers<LocalModel[]>();
  mocks.listModelEntries.mockReturnValue(list.promise);
  const { router, create, controller } = await render({ dirty: false });
  const result = create({ model, signal: controller.signal });
  await flushPromises();
  await router.push('/chat/existing?settings=tools');
  list.reject(new Error('late failure'));
  await expect(result).resolves.toBeUndefined();
  expect(mocks.createChatGroup).not.toHaveBeenCalled();
});

it.each(['missing group', 'changed endpoint', 'changed model', 'missing hierarchy', 'missing chat', 'moved chat', 'changed chat endpoint', 'changed chat model', 'missing membership'])('stops retrying saved ids if another operation changed them (%s)', async change => {
  const { router, create, controller } = await render({ dirty: false });
  const push = vi.spyOn(router, 'push').mockRejectedValueOnce(new Error('navigation failed'));
  await expect(create({ model, signal: controller.signal })).rejects.toThrow();
  switch (change) {
  case 'missing group': mocks.loadChatGroup.mockResolvedValue(null);
    break;
  case 'changed endpoint': mocks.loadChatGroup.mockResolvedValue({ endpoint: { type: 'openai', url: 'https://other.invalid' }, modelId: model.modelId });
    break;
  case 'changed model': mocks.loadChatGroup.mockResolvedValue({ endpoint: { type: 'llama_cpp_browser' }, modelId: 'another-model' });
    break;
  case 'missing hierarchy': mocks.loadHierarchy.mockResolvedValue({ items: [] });
    break;
  case 'missing chat': mocks.loadChat.mockResolvedValue(null);
    break;
  case 'moved chat': mocks.loadChat.mockResolvedValue({ ...chat, groupId: toChatGroupId({ raw: 'another-group' }) });
    break;
  case 'changed chat endpoint': mocks.loadChat.mockResolvedValue({ ...chat, endpoint: { type: 'openai', url: 'https://other.invalid' } });
    break;
  case 'changed chat model': mocks.loadChat.mockResolvedValue({ ...chat, modelId: 'another-model' });
    break;
  case 'missing membership': mocks.loadHierarchy.mockResolvedValue({ items: [{ type: 'chat_group', id: chatGroupId, chat_ids: [] }] });
    break;
  default: throw new Error(change);
  }
  await expect(create({ model, signal: controller.signal })).rejects.toThrow('changed');
  expect(mocks.createChatGroup).toHaveBeenCalledOnce();
  expect(mocks.createChatWithoutSelecting).toHaveBeenCalledOnce();
  expect(push).toHaveBeenCalledOnce();
});
