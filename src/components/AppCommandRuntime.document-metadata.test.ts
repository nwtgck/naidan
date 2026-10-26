import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, ref, shallowRef } from 'vue';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '@/App.vue';
import OnBoardingModalV2 from './OnBoardingModalV2.vue';
import { DEFAULT_SETTINGS, type Chat, type Settings, type SidebarItem } from '@/01-models/types';
import { idToRaw, toChatId } from '@/01-models/ids';
import type { useSettings } from '@/composables/useSettings';
import { startApp } from '@/logic/startup/app-startup';
import { createInitialNavigationGate } from '@/logic/startup/initial-navigation-gate';
import type { StartupState } from '@/logic/startup/types';
import { APPLICATION_METADATA, AUDIO_METADATA, HOME_METADATA, IMAGE_METADATA, applyDocumentMetadata, type PageMetadata } from '@/logic/document-metadata';

const initialized = ref(false);
const isOnboardingDismissed = ref(false);
const settings = ref<Settings>({ ...DEFAULT_SETTINGS, storageType: 'memory', endpoint: { type: 'openai', url: '' } });
const init = vi.fn();
const loadChats = vi.fn();
const chats = ref<Chat[]>([]);
const currentChat = ref<Chat | null>(null);
const automaticChat: Chat = { id: toChatId({ raw: 'automatic' }), groupId: undefined, title: null, root: { items: [] }, debugEnabled: false, createdAt: 1, updatedAt: 1 };
const sidebarItems = computed<SidebarItem[]>(() => chats.value.map(chat => ({ type: 'chat', id: `chat:${idToRaw({ id: chat.id })}`, chat: { id: chat.id, title: chat.title, updatedAt: chat.updatedAt, groupId: chat.groupId } })));
const settingsStore = { initialized, isOnboardingDismissed, settings, init, captureExperimentalStorage: () => () => true, deferModelRefresh: vi.fn(), resumeModelRefresh: vi.fn() };
const createNewChat = vi.fn(async () => {
  currentChat.value = automaticChat;
  chats.value = [automaticChat];
  return automaticChat;
});
vi.mock('@/components/MainAppSurface.vue', () => ({ default: defineComponent({ setup: () => () => h(RouterView) }) }));
vi.mock('@/components/AppAuxiliaryUi.vue', () => ({ __esModule: true, __isTeleport: false, default: { template: '<div />' } }));
vi.mock('@/composables/useSettings', () => ({ useSettings: () => settingsStore }));
vi.mock('@/00-storage/service', () => ({
  storageService: {
    getSidebarStructure: async () => sidebarItems.value,
    subscribeToChanges: () => () => {},
  },
}));
vi.mock('@/composables/chat/ui/useChatBootstrap', () => ({ loadChatsForAppStartup: () => loadChats(), useChatBootstrap: () => ({}) }));
vi.mock('@/composables/chat/ui/useCurrentChatState', () => ({ useCurrentChatState: () => ({ currentChat: computed(() => currentChat.value), chatGroups: ref([]), sidebarItems }) }));
vi.mock('@/composables/chat/ui/useChatListData', () => ({ useChatListData: () => ({ chats }) }));
vi.mock('@/composables/chat/ui/useChatLifecycle', () => ({ useChatLifecycle: () => ({ createNewChat }) }));
vi.mock('@/composables/chat/ui/useChatOrganization', () => ({ useChatOrganization: () => ({}) }));
vi.mock('@/composables/useRecentChats', () => ({ useRecentChats: () => ({ addRecentChat: vi.fn(), toggleRecent: vi.fn() }) }));
vi.mock('@/composables/useLayout', () => ({ useLayout: () => ({ setActiveFocusArea: vi.fn() }) }));
vi.mock('@/features/global-search/composables/useGlobalSearch', () => ({ useGlobalSearch: () => ({ toggleSearch: vi.fn() }) }));
vi.mock('@/features/llama-cpp-browser/composables/useModelLaunchCoordinator', () => ({ useModelLaunchCoordinator: vi.fn() }));
vi.mock('@/features/naidan-rpc-integration/runtime/feature', () => ({ startRpcAutomaticConnections: () => () => {} }));
vi.mock('@/logic/settings/global-settings-query', () => ({ applyInitialGlobalSettingsQuery: async () => undefined, installGlobalSettingsQuerySync: () => () => {} }));
vi.mock('@/logic/startup/presentation-frame', () => ({ waitForPresentationPaint: async () => {} }));
vi.mock('@/components/AppEntrySurface.vue', () => ({ default: { template: '<div data-testid="entry-surface" />' } }));
vi.mock('@/components/GlobalDialogHost.vue', () => ({ default: { template: '<div />' } }));
vi.mock('@/components/ToastContainer.vue', () => ({ default: { template: '<div />' } }));

function expectMetadata({ metadata }: { metadata: PageMetadata }): void {
  expect(document.title).toBe(metadata.title);
  expect(document.querySelector('meta[name="description"]')?.getAttribute('content')).toBe(metadata.description);
  expect(document.querySelector('meta[property="og:title"]')?.getAttribute('content')).toBe(metadata.title);
  expect(document.querySelector('meta[name="twitter:title"]')?.getAttribute('content')).toBe(metadata.title);
}

beforeEach(() => {
  vi.clearAllMocks();
  initialized.value = false;
  chats.value = [];
  currentChat.value = null;
  document.head.innerHTML = '';
  applyDocumentMetadata({ document, page: HOME_METADATA, documentTitle: HOME_METADATA.title });
});

describe('unattended app startup metadata', () => {
  it.each([
    { path: '/', dismissed: false, existing: false, metadata: HOME_METADATA },
    { path: '/', dismissed: true, existing: false, metadata: HOME_METADATA },
    { path: '/', dismissed: true, existing: true, metadata: HOME_METADATA },
    { path: '/audio-generation', dismissed: true, existing: false, metadata: AUDIO_METADATA },
    { path: '/image-generation', dismissed: true, existing: false, metadata: IMAGE_METADATA },
    { path: '/image-generation/session/saved', dismissed: true, existing: false, metadata: APPLICATION_METADATA },
    { path: '/chat/ordinary', dismissed: true, existing: false, metadata: APPLICATION_METADATA },
  ])('keeps the settled metadata for $path (dismissed=$dismissed, existing=$existing)', async ({ path, dismissed, existing, metadata }) => {
    isOnboardingDismissed.value = dismissed;
    settings.value = { ...DEFAULT_SETTINGS, storageType: 'memory', endpoint: dismissed ? { type: 'llama_cpp_browser' } : { type: 'openai', url: '' }, defaultModelId: dismissed ? 'selected-model' : undefined };
    if (existing) {
      chats.value = [automaticChat];
    }
    const initializing = Promise.withResolvers<void>();
    const restoringChats = Promise.withResolvers<void>();
    init.mockImplementationOnce(async () => {
      await initializing.promise;
      initialized.value = true;
    });
    loadChats.mockReturnValueOnce(restoringChats.promise);
    const history = createMemoryHistory();
    history.replace(path);
    const page = { template: '<div data-testid="page" />' };
    const router = createRouter({ history, routes: ['/', '/chat/:id', '/audio-generation', '/image-generation', '/image-generation/session/:id'].map(path => ({ path, component: page })) });
    const navigationGate = createInitialNavigationGate({ router });
    const startupState = shallowRef<StartupState>({ kind: 'initializing-foundation' });
    const wrapper = mount(App, { props: { startupState }, global: { plugins: [router] } });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    expectMetadata({ metadata: HOME_METADATA });
    const startup = startApp({ startupState, settingsStore: settingsStore as unknown as ReturnType<typeof useSettings>, router, navigationGate, window });
    initializing.resolve();
    await vi.dynamicImportSettled();
    await flushPromises();
    expect(startupState.value.kind).toBe('starting-main');
    expectMetadata({ metadata: HOME_METADATA });
    restoringChats.resolve();
    const dispose = await startup;
    using _startupCleanup = { [Symbol.dispose]: dispose };
    await flushPromises();
    expect(startupState.value.kind).toBe('ready');
    expect(wrapper.findComponent(OnBoardingModalV2).exists()).toBe(path === '/' && !existing);
    expect(router.currentRoute.value.path).toBe(path);
    expect(createNewChat).not.toHaveBeenCalled();
    // All startup work and automatic navigation has settled without input or clicks.
    await flushPromises();
    expectMetadata({ metadata });
    if (path === '/' && dismissed && existing) {
      const creating = Promise.withResolvers<Chat>();
      using _manualCreationCleanup = {
        [Symbol.dispose]() {
          creating.resolve(automaticChat);
        },
      };
      createNewChat.mockReturnValueOnce(creating.promise);
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
      await flushPromises();
      // A deliberate new-chat action ends the introduction before storage completes.
      expect(createNewChat).toHaveBeenCalledTimes(1);
      expect(router.currentRoute.value.path).toBe('/');
      expectMetadata({ metadata: APPLICATION_METADATA });
      creating.resolve(automaticChat);
      await flushPromises();
    }
    if (path === '/' && !dismissed) {
      await router.push('/chat/ordinary');
      await flushPromises();
      expectMetadata({ metadata: APPLICATION_METADATA });
    }
  });
});
