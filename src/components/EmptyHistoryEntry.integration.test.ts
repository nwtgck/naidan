import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, ref, shallowRef } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { storageService } from '@/00-storage/service';
import { DEFAULT_SETTINGS, type Settings } from '@/01-models/types';
import { idToRaw } from '@/01-models/ids';
import { provideAppEntry, type AppEntry } from '@/composables/useAppEntry';
import { provideAppPresentation } from '@/composables/useAppPresentation';
import { chatDataStore, creatingChat, loadData, rootItems } from '@/composables/chat/global/chat-core-singletons';
import { useChatLifecycle } from '@/composables/chat/ui/useChatLifecycle';
import { useChatOrganization } from '@/composables/chat/ui/useChatOrganization';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import type { StartupState } from '@/logic/startup/types';
import ChatPage from '@/pages/chat/[id].vue';
import ChatGroupPage from '@/pages/chat-group/[id].vue';
import UnknownPage from '@/pages/[...path].vue';
import AppCommandRuntime from './AppCommandRuntime.vue';
import MainAppSurface from './MainAppSurface.vue';
import OnBoardingModalV2 from './OnBoardingModalV2.vue';
import BrowserModelDialog from './BrowserModelDialog.vue';

enableAutoUnmount(afterEach);
const settings = ref<Settings>({ ...DEFAULT_SETTINGS, storageType: 'memory', endpoint: { type: 'openai', url: '' }, defaultModelId: undefined });
vi.mock('@/composables/useSettings', () => ({
  useSettings: () => ({
    settings,
    initialized: ref(true),
    captureExperimentalStorage: () => storageService.captureSettingsStorage(),
    captureModelLaunchDefaults: async () => undefined,
    deferModelRefresh: vi.fn(),
    resumeModelRefresh: vi.fn(),
  }),
}));
vi.mock('@/features/tools/composables/useChatTools', () => ({
  useChatTools: () => ({ setCurrentChatId: vi.fn(), setToolEnabled: vi.fn() }),
  getEffectiveToolConfigsForChat: () => [],
}));
vi.mock('@/features/tools/wesh/chat-workspace', () => ({ ensureChatWorkspaceMounted: vi.fn() }));
vi.mock('@/features/llama-cpp-browser/composables/useModelLaunchCoordinator', () => ({ useModelLaunchCoordinator: vi.fn() }));
vi.mock('@/composables/useToast', () => ({ useToast: () => ({ addToast: vi.fn(() => 'toast') }) }));
vi.mock('@/composables/useGlobalEvents', () => ({ useGlobalEvents: () => ({ addErrorEvent: vi.fn(), addInfoEvent: vi.fn() }) }));
vi.mock('@/composables/useLayout', () => ({ useLayout: () => ({ isSidebarOpen: ref(false), isDebugOpen: ref(false), setActiveFocusArea: vi.fn() }) }));
vi.mock('@/components/Sidebar.vue', () => ({ default: { template: '<aside />' } }));
vi.mock('@/components/HomeWelcome.vue', () => ({ default: { template: '<div data-testid="root-home" />' } }));
vi.mock('@/components/AppEntrySurface.vue', () => ({ __esModule: true, __isTeleport: false, default: { template: '<div data-testid="model-preview" />' } }));
vi.mock('@/components/ChatPane.vue', () => ({ default: { props: ['chatId'], template: '<div data-testid="selected-chat" :data-chat-id="chatId" />' } }));
vi.mock('@/components/ChatGroupSettingsPanel.vue', () => ({ default: { template: '<div data-testid="chat-group-settings" />' } }));
vi.mock('@/components/BrowserModelWelcome.vue', () => ({ default: { template: '<div data-testid="model-welcome" />' } }));

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  await storageService.init({ type: 'memory' });
  chatDataStore.TEST_ONLY.resetLiveState();
  rootItems.value = [];
  creatingChat.value = false;
});

async function open({ path }: { path: string }) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/chat/:id', component: ChatPage },
      { path: '/chat-group/:id', component: ChatGroupPage },
      { path: '/:path(.*)', component: UnknownPage },
    ],
  });
  await router.push(path);
  await loadData();
  let entry: AppEntry | undefined;
  const host = defineComponent({
    setup() {
      const startupState = shallowRef<StartupState>({ kind: 'ready', mainApp: MainAppSurface });
      const current = provideAppEntry({ startupState });
      entry = current;
      provideAppPresentation({ startupState, modelSelectionVisible: computed(() => current.modelSelection.value !== undefined || current.notFoundRecovery.value !== undefined) });
      return () => h('div', [
        h(MainAppSurface, { postStartupFeatures: 'active' }),
        h(AppCommandRuntime),
        current.modelSelection.value === undefined ? undefined : h(OnBoardingModalV2),
      ]);
    },
  });
  const view = mount(host, { global: { plugins: [router], stubs: { teleport: true } }, attachTo: document.body });
  await flushPromises();
  if (entry === undefined) {
    throw new Error('Expected application entry');
  }
  return { router, entry, view };
}

describe('empty history recovery', () => {
  for (const path of ['/chat/missing', '/chat-group/missing', '/myunknown']) {
    it(`recovers ${path} with an empty-history dialog, then saves one real chat after X fully closes`, async () => {
      const { router, entry, view } = await open({ path: `${path}?q=must-not-send&chat-group=must-not-create` });
      expect(router.currentRoute.value.fullPath).toBe('/');
      expect(view.findAll('[data-testid="browser-model-dialog"]')).toHaveLength(1);
      expect(entry.modelSelection.value?.target.kind).toBe('home');
      expect(await storageService.listChats()).toHaveLength(0);
      expect(await storageService.listChatGroups()).toHaveLength(0);
      await view.get('[data-testid="browser-model-dialog-close"]').trigger('click');
      expect(entry.modelSelection.value?.phase).toBe('closing');
      await flushPromises();
      expect(await storageService.listChats()).toHaveLength(0);
      view.getComponent(BrowserModelDialog).vm.$emit('closed');
      await flushPromises();
      const chats = await storageService.listChats();
      expect(chats).toHaveLength(1);
      expect(router.currentRoute.value.fullPath).toBe(`/chat/${idToRaw({ id: chats[0]!.id })}`);
      expect(view.get('[data-testid="selected-chat"]').attributes('data-chat-id')).toBe(chats[0]!.id);
      expect(await storageService.loadChat({ id: chats[0]!.id })).toMatchObject({ root: { items: [] } });
      expect(await storageService.listChatGroups()).toHaveLength(0);
    });

    it.each(['chat', 'chat-group'] as const)(`recovers ${path} to the root without dialog or creation when a %s remains`, async kind => {
      switch (kind) {
      case 'chat': await useChatLifecycle().createChatWithoutSelecting({ groupId: undefined, modelId: undefined, systemPrompt: undefined });
        break;
      case 'chat-group': await useChatOrganization().createChatGroup({ name: 'Empty chat group', options: undefined });
        break;
      default: {
        const exhaustive: never = kind;
        throw new Error(String(exhaustive));
      }
      }
      const { router, entry, view } = await open({ path });
      expect(router.currentRoute.value.fullPath).toBe('/');
      expect(entry.modelSelection.value).toBeUndefined();
      expect(view.find('[data-testid="browser-model-dialog"]').exists()).toBe(false);
      expect(view.find('[data-testid="root-home"]').exists()).toBe(true);
      expect((await storageService.listChats()).length + (await storageService.listChatGroups()).length).toBe(1);
    });
  }

  it('keeps an explicit model entry on an unknown path ahead of Not Found recovery', async () => {
    const path = '/myunknown?llama-cpp-browser-model=owner/model&q=ignored';
    const { router, entry, view } = await open({ path });
    expect(router.currentRoute.value.fullPath).toBe(path);
    expect(entry.modelSelection.value).toBeUndefined();
    expect(view.find('[data-testid="model-preview"]').exists()).toBe(true);
    expect(await storageService.listChats()).toHaveLength(0);
  });

  it('gives a newly registered page priority over the unknown-path route', async () => {
    const { router, entry, view } = await open({ path: '/myunknown?llama-cpp-browser-model=owner/model' });
    router.addRoute({ path: '/new-feature', component: { template: '<div data-testid="new-feature" />' } });
    await router.push('/new-feature');
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/new-feature');
    expect(view.find('[data-testid="new-feature"]').exists()).toBe(true);
    expect(entry.modelSelection.value).toBeUndefined();
    expect(await storageService.listChats()).toHaveLength(0);
  });

  it('keeps an unknown URL retryable after a history read failure rather than treating unreadable data as empty', async () => {
    const readSidebar = storageService.getSidebarStructure.bind(storageService);
    using _read = vi.spyOn(storageService, 'getSidebarStructure')
      .mockImplementationOnce(readSidebar)
      .mockRejectedValueOnce(new Error('Storage permission unavailable'));
    const { router, entry, view } = await open({ path: '/myunknown' });
    expect(router.currentRoute.value.path).toBe('/myunknown');
    expect(entry.notFoundRecovery.value).toBeUndefined();
    expect(entry.modelSelection.value).toBeUndefined();
    expect(await storageService.listChats()).toHaveLength(0);
    await view.get('[data-testid="unknown-page-retry"]').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe('/');
    expect(entry.modelSelection.value?.phase).toBe('open');
    expect(await storageService.listChats()).toHaveLength(0);
  });

  it('replenishes the last deleted chat without replaying the dialog and preserves both chats on Undo', async () => {
    const lifecycle = useChatLifecycle();
    const original = await lifecycle.createChatWithoutSelecting({ groupId: undefined, modelId: undefined, systemPrompt: undefined });
    if (original === null) {
      throw new Error('Expected saved chat');
    }
    const { router, entry, view } = await open({ path: `/chat/${idToRaw({ id: original.id })}` });
    let undo: (() => void | Promise<void>) | undefined;
    await lifecycle.deleteChat({
      id: original.id,
      injectAddToast: ({ onAction }) => {
        undo = onAction;
        return 'undo-toast';
      },
    });
    await router.push('/');
    await flushPromises();
    expect(entry.modelSelection.value).toBeUndefined();
    expect(view.find('[data-testid="selected-chat"]').exists()).toBe(true);
    const sidebar = await storageService.getSidebarStructure();
    expect(sidebar).toHaveLength(1);
    const params = router.currentRoute.value.params;
    const newId = 'id' in params ? params.id : undefined;
    expect(newId).toBeDefined();
    expect(newId).not.toBe(idToRaw({ id: original.id }));
    expect(undo).toBeDefined();
    await undo!();
    await flushPromises();
    const restored = await storageService.getSidebarStructure();
    expect(restored).toHaveLength(2);
    expect(restored.map(item => item.type)).toEqual(['chat', 'chat']);
    expect(await storageService.loadChat({ id: original.id })).not.toBeNull();
    expect((await storageService.listChats()).map(chat => idToRaw({ id: chat.id }))).toContain(newId);
  });

  it('leaves the root unseeded after deletion when an empty chat group remains', async () => {
    const lifecycle = useChatLifecycle();
    await useChatOrganization().createChatGroup({ name: 'Keep this chat group', options: undefined });
    const original = await lifecycle.createChatWithoutSelecting({ groupId: undefined, modelId: undefined, systemPrompt: undefined });
    if (original === null) {
      throw new Error('Expected saved chat');
    }
    const { router, entry, view } = await open({ path: `/chat/${idToRaw({ id: original.id })}` });
    await lifecycle.deleteChat({ id: original.id, injectAddToast: () => 'undo-toast' });
    await router.push('/');
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe('/');
    expect(entry.modelSelection.value).toBeUndefined();
    expect(view.find('[data-testid="root-home"]').exists()).toBe(true);
    expect((await storageService.getSidebarStructure()).map(item => item.type)).toEqual(['chat_group']);
  });

  it('does not add a plain chat when a model action saves its chat group and hands off its chat', async () => {
    const { router, entry, view } = await open({ path: '/myunknown' });
    expect(entry.modelSelection.value?.phase).toBe('open');
    const context = entry.captureModelLaunchContext();
    const chatGroupId = await useChatOrganization().createChatGroup({ name: 'Selected model', options: undefined });
    const chat = await useChatLifecycle().createChatWithoutSelecting({ groupId: chatGroupId, modelId: undefined, systemPrompt: undefined });
    if (chat === null) {
      throw new Error('Expected model chat');
    }
    const chatPath = `/chat/${idToRaw({ id: chat.id })}`;
    expect(await entry.handoffToChat({ context, chatPath })).toBe(true);
    await flushPromises();
    view.getComponent(BrowserModelDialog).vm.$emit('closed');
    await flushPromises();
    expect(router.currentRoute.value.path).toBe(chatPath);
    expect(await storageService.listChats()).toHaveLength(1);
    expect(await storageService.listChatGroups()).toHaveLength(1);
  });
});
