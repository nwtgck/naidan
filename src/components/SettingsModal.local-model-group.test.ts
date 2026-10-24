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
  prepare: vi.fn(),
  captureStorage: vi.fn(),
  registerLive: vi.fn(),
  showConfirm: vi.fn(),
  updateGlobalModelAndEndpoint: vi.fn(),
  loadChatGroup: vi.fn(),
  loadHierarchy: vi.fn(),
  loadChat: vi.fn(),
}));
vi.mock('@/00-storage/service', () => ({ storageService: { prepareLocalModelChat: mocks.prepare, captureModelLaunchStorage: mocks.captureStorage } }));
vi.mock('@/features/llama-cpp-browser/model-files', () => ({ llamaCppBrowserModelFiles: { getModelEntry: mocks.listModelEntries, subscribeModelList: () => () => {} }, captureTemporaryModelSource: vi.fn() }));
vi.mock('@/composables/chat/global/chat-core-singletons', () => ({ registerLiveInstance: mocks.registerLive, loadData: vi.fn(async () => {}) }));
vi.mock('@/composables/chat/chat-scoped/chat-model-binding-operations', () => ({ registerChatModelBindingOrigin: vi.fn() }));
vi.mock('@/features/llama-cpp-browser/composables/useTemporaryModelSave', () => ({ offerTemporaryModelSave: vi.fn() }));
vi.mock('@/features/llama-cpp-browser/composables/local-model-launch-session', () => ({ registerLocalModelLaunchSession: vi.fn() }));
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
  mocks.listModelEntries.mockResolvedValue(model);
  mocks.captureStorage.mockReturnValue(() => true);
  mocks.prepare.mockImplementation(async ({ request }: { request: { chatId: Chat['id'], chatGroupId: Chat['groupId'] } }) => ({ ...chat, id: request.chatId, groupId: request.chatGroupId }));
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
  expect(mocks.listModelEntries).toHaveBeenCalledWith({ modelId: model.modelId, signal: expect.any(AbortSignal) });
  expect(mocks.prepare).toHaveBeenCalledExactlyOnceWith({ request: expect.objectContaining({ chatGroupName: expectedChatGroupName, modelId: model.modelId }), signal: expect.any(AbortSignal), isCurrent: expect.any(Function) });
  expect(push).toHaveBeenCalledExactlyOnceWith({ path: expect.stringMatching(/^\/chat\//), query: {} });
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
  expect(router.currentRoute.value.fullPath).toMatch(/^\/chat\//);
  expect(modal.props('isOpen')).toBe(false);
});

it('creates distinct chat groups with the same file-derived name on repeated successful launches', async () => {
  const { router, create, controller } = await render({ dirty: false });
  await create({ model, signal: controller.signal });
  expect(router.currentRoute.value.fullPath).toMatch(/^\/chat\//);
  await router.push('/chat/local-chat?settings=llama-cpp-browser');
  await create({ model, signal: new AbortController().signal });
  expect(mocks.prepare).toHaveBeenCalledTimes(2);
  expect(mocks.prepare.mock.calls.map(([input]) => input.request.chatGroupName)).toEqual([expectedChatGroupName, expectedChatGroupName]);
  expect(mocks.prepare.mock.calls[0]?.[0].request.chatGroupId).not.toBe(mocks.prepare.mock.calls[1]?.[0].request.chatGroupId);
  expect(router.currentRoute.value.fullPath).toMatch(/^\/chat\//);
  expect(mocks.loadChatGroup).not.toHaveBeenCalled();
  expect(mocks.loadHierarchy).not.toHaveBeenCalled();
});

it('asks before discarding Connection edits and creates nothing when the user keeps editing', async () => {
  mocks.showConfirm.mockResolvedValue(false);
  const { modal, create, controller } = await render({ dirty: true });
  await create({ model, signal: controller.signal });
  expect(mocks.showConfirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Discard Unsaved Changes?', confirmButtonText: 'Discard' }));
  expect(mocks.listModelEntries).not.toHaveBeenCalled();
  expect(mocks.prepare).not.toHaveBeenCalled();
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
  mocks.listModelEntries.mockResolvedValue(renamed);
  confirm.resolve(true);
  await expect(result).rejects.toThrow('Local model unavailable');
  expect(mocks.prepare).not.toHaveBeenCalled();
});

it.each(['missing', 'listing failed'])('does not create or navigate when the local model is unavailable (%s)', async failure => {
  const { router, create, controller } = await render({ dirty: false });
  const push = vi.spyOn(router, 'push');
  if (failure === 'missing') {
    mocks.listModelEntries.mockRejectedValue(new Error('Local model unavailable'));
  } else {
    mocks.listModelEntries.mockRejectedValue(new Error('storage unavailable'));
  }
  await expect(create({ model, signal: controller.signal })).rejects.toThrow();
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(push).not.toHaveBeenCalled();
});

it('ignores a second request while confirmation or saving is in flight', async () => {
  const saving = Promise.withResolvers<Chat>();
  mocks.prepare.mockReturnValue(saving.promise);
  const { create, controller } = await render({ dirty: false });
  const first = create({ model, signal: controller.signal });
  await flushPromises();
  await create({ model, signal: controller.signal });
  expect(mocks.prepare).toHaveBeenCalledOnce();
  saving.resolve(chat);
  await first;
  expect(mocks.prepare).toHaveBeenCalledOnce();
});

it.each(['reject', 'busy'])('reuses a successfully created group after chat creation fails (%s)', async failure => {
  if (failure === 'reject') {
    mocks.prepare.mockRejectedValueOnce(new Error('save failure'));
  } else {
    mocks.prepare.mockRejectedValueOnce(new Error('Chat creation is already in progress'));
  }
  const { create, controller } = await render({ dirty: false });
  await expect(create({ model, signal: controller.signal })).rejects.toThrow();
  await create({ model, signal: controller.signal });
  expect(mocks.prepare).toHaveBeenCalledTimes(2);
  expect(mocks.prepare.mock.calls[1]?.[0].request).toEqual(mocks.prepare.mock.calls[0]?.[0].request);
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
  expect(mocks.prepare).toHaveBeenCalledTimes(2);
  expect(mocks.prepare.mock.calls[1]?.[0].request).toEqual(mocks.prepare.mock.calls[0]?.[0].request);
  expect(push).toHaveBeenCalledTimes(2);
  expect(router.currentRoute.value.fullPath).toMatch(/^\/chat\//);
});

it('retains stable reserved ids when the service rejects before confirming a group', async () => {
  mocks.prepare.mockRejectedValueOnce(new Error('group save failed'));
  const { create, controller } = await render({ dirty: false });
  await expect(create({ model, signal: controller.signal })).rejects.toThrow('group save failed');
  expect(mocks.createChatWithoutSelecting).not.toHaveBeenCalled();
  await create({ model, signal: controller.signal });
  expect(mocks.prepare).toHaveBeenCalledTimes(2);
  expect(mocks.prepare.mock.calls[1]?.[0].request).toEqual(mocks.prepare.mock.calls[0]?.[0].request);
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
  expect(mocks.prepare).not.toHaveBeenCalled();
});

it.each(['close', 'route', 'suspend', 'abort', 'unmount'])('does not create or navigate after delayed listing is invalidated (%s)', async reason => {
  const list = Promise.withResolvers<LocalModel>();
  mocks.listModelEntries.mockReturnValue(list.promise);
  const context = await render({ dirty: false });
  const result = context.create({ model, signal: context.controller.signal });
  await flushPromises();
  await leaveSettings({ reason, ...context });
  list.resolve(model);
  await result;
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.createChatWithoutSelecting).not.toHaveBeenCalled();
});

it.each(['group', 'chat'])('stops before the next step when the modal closes during a successful save (%s)', async step => {
  const chatGroupSave = Promise.withResolvers<typeof chatGroupId>();
  const savingChat = Promise.withResolvers<Chat>();
  mocks.prepare.mockReturnValue(savingChat.promise);
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
  const list = Promise.withResolvers<LocalModel>();
  mocks.listModelEntries.mockReturnValue(list.promise);
  const { router, create, controller } = await render({ dirty: false });
  const result = create({ model, signal: controller.signal });
  await flushPromises();
  await router.push('/chat/existing?settings=tools');
  list.reject(new Error('late failure'));
  await expect(result).resolves.toBeUndefined();
  expect(mocks.prepare).not.toHaveBeenCalled();
});

it.each(['missing group', 'changed endpoint', 'changed model', 'missing hierarchy', 'missing chat', 'moved chat', 'changed chat endpoint', 'changed chat model', 'missing membership'])('stops retrying saved ids if another operation changed them (%s)', async change => {
  const { router, create, controller } = await render({ dirty: false });
  const push = vi.spyOn(router, 'push').mockRejectedValueOnce(new Error('navigation failed'));
  await expect(create({ model, signal: controller.signal })).rejects.toThrow();
  mocks.prepare.mockRejectedValueOnce(new Error(`The local model chat changed: ${change}`));
  await expect(create({ model, signal: controller.signal })).rejects.toThrow('changed');
  expect(mocks.prepare).toHaveBeenCalledTimes(2);
  expect(mocks.prepare.mock.calls[1]?.[0].request).toEqual(mocks.prepare.mock.calls[0]?.[0].request);
  expect(push).toHaveBeenCalledOnce();
});
