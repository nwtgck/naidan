import { enableAutoUnmount, flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';
import { createMemoryHistory, createRouter, useRouter } from 'vue-router';
import AppSidebar from './AppSidebar.vue';
import ChatSidebarActionsView from './ChatSidebarActionsView.vue';
import SidebarDebugControls from './SidebarDebugControls.vue';
import { toChatId } from '@/01-models/ids';
import { useImageGenerationWorkspaceNavigation } from '@/features/image-generation/session/navigation';
import { useLiveConversationNavigation } from '@/features/live-conversation/navigation';
import { registerTranslationNavigation, useTranslationNavigation } from '@/features/translation/navigation';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { ensureStrings } from '@/strings';

enableAutoUnmount(afterEach);
const loads = vi.hoisted(() => ({ chat: 0, chatActions: 0, modelControls: 0, workflow: 0 }));
const chatGate = vi.hoisted(() => Promise.withResolvers<void>());
const chatActionsGate = vi.hoisted(() => Promise.withResolvers<void>());
const entryKind = ref<'ordinary' | 'model-preview'>('ordinary');
const expanded = ref(true);
const storageType = ref<'memory' | 'local'>('local');
const defaultModelId = ref<string | undefined>('saved-default-model');
const mostRecentChat = ref<{ id: ReturnType<typeof toChatId> }>();
const errorCount = ref(0);
const debugOpen = ref(false);
const openSettings = vi.fn();
const openHome = vi.fn();
const openDiscovery = vi.fn();
const updateGlobalModel = vi.fn();
const toggleDebug = vi.fn(() => {
  debugOpen.value = !debugOpen.value;
});
const openFiles = vi.fn();
const openRecent = vi.fn();
const toggleWesh = vi.fn();

vi.mock('@/composables/useAppEntry', () => ({
  requestAppSettings: (...args: unknown[]) => openSettings(...args),
  useAppEntry: () => ({ effectiveRoute: useRouter().currentRoute, intent: computed(() => ({ kind: entryKind.value })), interaction: ref('ready'), openHome, openDiscovery }),
}));
vi.mock('@/composables/useSettings', () => ({ useSettings: () => ({ settings: computed(() => ({ storageType: storageType.value, defaultModelId: defaultModelId.value })), updateGlobalModel }) }));
vi.mock('@/composables/useAppPresentation', () => ({ useAppPresentation: () => ({ appInteraction: ref('ready') }), isAppInteractionEnabled: () => true }));
vi.mock('@/composables/useLayout', () => ({
  useLayout: () => ({
    isSidebarOpen: expanded,
    toggleSidebar: () => {
      expanded.value = !expanded.value;
    },
    isDebugOpen: debugOpen,
    toggleDebug,
    toggleWeshTerminal: toggleWesh,
  }),
}));
vi.mock('@/composables/useGlobalEvents', () => ({ useGlobalEvents: () => ({ errorCount }) }));
vi.mock('@/composables/useRecentChats', () => ({ useRecentChats: () => ({ mostRecentChat, openRecent }) }));
vi.mock('@/features/file-explorer/composables/useFileExplorerModal', () => ({ useFileExplorerModal: () => ({ openFileExplorer: openFiles }) }));
vi.mock('@/components/PWAUpdateNotification.vue', () => ({ __esModule: true, __isTeleport: false, default: { template: '<div />' } }));
vi.mock('@/components/ModelDownloads.vue', () => ({ __esModule: true, __isTeleport: false, default: { data: () => ({ open: false }), template: '<div><button data-testid="model-downloads-trigger" @click="open = !open">downloads</button><div v-if="open" data-testid="model-downloads-panel" /></div>' } }));
vi.mock('@/components/ChatSidebar.vue', async () => {
  loads.chat += 1;
  await chatGate.promise;
  return { __esModule: true, __isTeleport: false, default: { props: ['chatGroupCreation'], emits: ['update:chatGroupCreation'], template: '<section data-testid="chat-sidebar"><input v-if="chatGroupCreation === \'open\'" data-testid="group-draft" /><button @click="$emit(\'update:chatGroupCreation\', \'closed\')" data-testid="close-group">close</button></section>' } };
});
vi.mock('@/components/ChatSidebarActions.vue', async () => {
  loads.chatActions += 1;
  await chatActionsGate.promise;
  return {
    __esModule: true,
    __isTeleport: false,
    default: {
      props: ['expanded', 'contentReady'],
      emits: ['createChatGroup'],
      components: { ChatSidebarActionsView: (await import('./ChatSidebarActionsView.vue')).default },
      template: '<ChatSidebarActionsView :expanded="expanded" :content-ready="contentReady" interaction="ready" :group-context="undefined" @create-chat-group="$emit(\'createChatGroup\')" />',
    },
  };
});
vi.mock('@/components/ChatSidebarModelControls.vue', () => {
  loads.modelControls += 1;
  return { __esModule: true, __isTeleport: false, default: { props: ['expanded'], template: '<section data-testid="chat-model-controls-owner"><button v-if="expanded" data-testid="model-selector-stub">model</button></section>' } };
});
vi.mock('@/features/image-generation/components/ImageGenerationSidebar.vue', () => ({ __esModule: true, __isTeleport: false, default: { props: ['navigation'], template: '<section data-testid="image-sidebar"><input data-testid="image-draft" /><button @click="navigation.openModels" data-testid="image-models">models</button></section>' } }));
vi.mock('@/features/image-generation/components/ImageGenerationSidebarActions.vue', () => ({ __esModule: true, __isTeleport: false, default: { props: ['navigation', 'expanded'], template: '<button data-testid="image-action">new image</button>' } }));
vi.mock('@/features/live-conversation/components/LiveConversationSidebar.vue', () => ({ __esModule: true, __isTeleport: false, default: { props: ['navigation'], template: '<section data-testid="live-sidebar" />' } }));
vi.mock('@/features/live-conversation/components/LiveConversationSidebarActions.vue', () => ({ __esModule: true, __isTeleport: false, default: { props: ['navigation', 'expanded'], template: '<button data-testid="live-action">new conversation</button>' } }));
vi.mock('@/features/translation/components/TranslationSidebar.vue', () => ({ __esModule: true, __isTeleport: false, default: { props: ['navigation'], template: '<section data-testid="translation-sidebar" />' } }));
vi.mock('@/features/workflow/components/WorkflowSidebar.vue', () => {
  loads.workflow += 1;
  return { __esModule: true, __isTeleport: false, default: { template: '<section data-testid="workflow-sidebar" />' } };
});
vi.mock('@/features/workflow/components/WorkflowSidebarActions.vue', () => ({ __esModule: true, __isTeleport: false, default: { props: ['expanded'], template: '<button data-testid="workflow-action">new workflow</button>' } }));
vi.mock('@/features/audio-generation/components/AudioGenerationSidebar.vue', () => ({ __esModule: true, __isTeleport: false, default: { props: ['expanded'], template: '<section data-testid="audio-sidebar" />' } }));
vi.mock('@/features/audio-transcription/components/AudioTranscriptionSidebar.vue', () => ({ __esModule: true, __isTeleport: false, default: { props: ['expanded'], template: '<section data-testid="transcription-sidebar" />' } }));
vi.mock('@/components/DeveloperToolsSidebar.vue', () => ({ __esModule: true, __isTeleport: false, default: { props: ['expanded'], emits: ['openModelSupportInvestigation'], template: '<section data-testid="developer-sidebar"><button data-testid="investigate" @click="$emit(\'openModelSupportInvestigation\', $event.currentTarget)">investigate</button></section>' } }));

const imageNavigation = useImageGenerationWorkspaceNavigation().active;
const liveNavigation = useLiveConversationNavigation().active;
const translationNavigation = useTranslationNavigation().active;

beforeEach(async () => {
  vi.clearAllMocks();
  entryKind.value = 'ordinary';
  expanded.value = true;
  storageType.value = 'local';
  defaultModelId.value = 'saved-default-model';
  mostRecentChat.value = undefined;
  errorCount.value = 0;
  debugOpen.value = false;
  imageNavigation.value = undefined;
  liveNavigation.value = undefined;
  translationNavigation.value = undefined;
  await ensureAllStringsForTest({ locale: 'en' });
});

async function mountSidebar({ path, activation }: { path: string, activation: 'inactive' | 'active' }) {
  const page = { template: '<div />' };
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: page },
      { path: '/chat/:id', component: page },
      { path: '/image-generation/:rest(.*)*', component: page },
      { path: '/live-conversation/:rest(.*)*', component: page },
      { path: '/translation/:rest(.*)*', component: page },
      { path: '/workflows/:rest(.*)*', component: page },
      { path: '/audio-generation', component: page },
      { path: '/audio-transcription', component: page },
      { path: '/audio-transcription/files', component: page },
      { path: '/debug/:rest(.*)*', component: page },
      { path: '/settings/:tab', component: page },
      { path: '/:path(.*)*', component: page },
    ],
  });
  await router.push(path);
  const wrapper = mount(AppSidebar, { props: { postStartupFeatures: activation }, global: { plugins: [router], stubs: { MessageActionsMenu: { props: ['isOpen'], emits: ['close'], template: '<div data-testid="quick-access"><slot /></div>' } } } });
  return { wrapper, router };
}

function primaryPresentation({ wrapper }: { wrapper: VueWrapper }) {
  return wrapper.get('[data-testid="sidebar-primary"]').findAll('button').map(button => ({
    id: button.attributes('data-testid'),
    label: button.attributes('aria-label'),
    title: button.attributes('title'),
    text: button.text(),
  }));
}

it('paints common controls before starting the chat chunk and keeps them mounted while the chunk resolves', async () => {
  using pendingLoads = {
    [Symbol.dispose]() {
      chatActionsGate.resolve();
      chatGate.resolve();
    },
  };
  const { wrapper } = await mountSidebar({ path: '/chat/first', activation: 'inactive' });
  expect(wrapper.classes()).toContain('bg-white');
  expect(wrapper.get('h1').classes()).toContain('from-gray-800');
  const home = wrapper.get('[data-testid="sidebar-home"]').element;
  const launcher = wrapper.get('[data-testid="open-launcher"]').element;
  const settings = wrapper.get('[data-testid="sidebar-settings-button"]').element;
  const initialButtons = primaryPresentation({ wrapper });
  expect(initialButtons.map(button => button.id)).toEqual(['new-chat-button', 'search-button', 'create-chat-group-button']);
  expect(wrapper.findComponent(ChatSidebarActionsView).props('interaction')).toBe('preparing');
  expect(wrapper.get('[data-testid="chat-sidebar-actions"]').attributes('inert')).toBeDefined();
  expect(wrapper.get('[data-testid="sidebar-primary"]').findAll('p').map(item => item.text())).not.toContain(await ensureStrings.launcher__chat());
  expect(loads.chat).toBe(0);
  expect(loads.chatActions).toBe(0);
  expect(loads.modelControls).toBe(0);
  expect(wrapper.find('[data-testid="chat-model-controls-owner"]').exists()).toBe(false);
  expect(wrapper.find('[data-testid="chat-sidebar"]').exists()).toBe(false);
  expect(wrapper.find('[data-testid="sidebar-preparing"]').exists()).toBe(true);
  await wrapper.setProps({ postStartupFeatures: 'active' });
  await flushPromises();
  expect(loads.chat).toBe(1);
  expect(loads.chatActions).toBe(1);
  expect(primaryPresentation({ wrapper })).toEqual(initialButtons);
  expect(wrapper.findComponent(ChatSidebarActionsView).props('interaction')).toBe('preparing');
  expect(wrapper.get('[data-testid="create-chat-group-button"]').attributes('disabled')).toBeDefined();
  await wrapper.get('[data-testid="model-downloads-trigger"]').trigger('click');
  chatActionsGate.resolve();
  await flushPromises();
  expect(wrapper.findComponent(ChatSidebarActionsView).props('interaction')).toBe('ready');
  expect(wrapper.get('[data-testid="create-chat-group-button"]').attributes('disabled')).toBeDefined();
  chatGate.resolve();
  await flushPromises();
  expect(wrapper.find('[data-testid="chat-sidebar"]').exists()).toBe(true);
  expect(wrapper.find('[data-testid="sidebar-preparing"]').exists()).toBe(false);
  expect(wrapper.get('[data-testid="create-chat-group-button"]').attributes('disabled')).toBeUndefined();
  expect(wrapper.get('[data-testid="sidebar-home"]').element).toBe(home);
  expect(wrapper.get('[data-testid="open-launcher"]').element).toBe(launcher);
  expect(wrapper.get('[data-testid="sidebar-settings-button"]').element).toBe(settings);
  expect(wrapper.find('[data-testid="model-downloads-panel"]').exists()).toBe(true);
  void pendingLoads;
});

it('keeps chat model controls above the shared settings, catalog and debug row without changing the default model', async () => {
  const { wrapper } = await mountSidebar({ path: '/chat/first', activation: 'active' });
  await flushPromises();
  const footer = wrapper.get('[data-testid="sidebar-footer"]');
  const modelRow = footer.get('[data-testid="sidebar-model-controls"]');
  const actions = footer.get('[data-testid="sidebar-footer-actions"]');
  const controls = modelRow.get('[data-testid="chat-model-controls-owner"]').element;
  const settings = actions.get('[data-testid="sidebar-settings-button"]');
  const catalog = actions.get('[data-testid="sidebar-model-catalog-button"]');
  const debug = actions.findComponent(SidebarDebugControls);
  expect(Array.from(footer.element.children)).toEqual([modelRow.element, actions.element]);
  expect(Array.from(actions.element.children)).toEqual([settings.element, catalog.element, debug.element]);
  expect(modelRow.find('[data-testid="model-selector-stub"]').exists()).toBe(true);
  await catalog.trigger('click');
  expect(openDiscovery).toHaveBeenCalledExactlyOnceWith({ tab: undefined });
  expect(defaultModelId.value).toBe('saved-default-model');
  expect(updateGlobalModel).not.toHaveBeenCalled();
  expanded.value = false;
  await flushPromises();
  expect(wrapper.get('[data-testid="sidebar-model-controls"]').element).toBe(modelRow.element);
  expect(modelRow.attributes('hidden')).toBeDefined();
  expect(modelRow.get('[data-testid="chat-model-controls-owner"]').element).toBe(controls);
  expect(modelRow.find('[data-testid="model-selector-stub"]').exists()).toBe(false);
  expect(Array.from(actions.element.children)).toEqual([settings.element, catalog.element, debug.element]);
  expanded.value = true;
  await flushPromises();
  expect(modelRow.attributes('hidden')).toBeUndefined();
  expect(modelRow.get('[data-testid="chat-model-controls-owner"]').element).toBe(controls);
  expect(modelRow.find('[data-testid="model-selector-stub"]').exists()).toBe(true);
});

it('keeps the image target while workspace navigation is pending and never borrows another owner', async () => {
  const unregister = registerTranslationNavigation({ navigation: { openModels: vi.fn(), openWorkspace: vi.fn() } });
  using _registered = {
    [Symbol.dispose]() {
      unregister();
    },
  };
  const { wrapper } = await mountSidebar({ path: '/image-generation/models', activation: 'active' });
  await flushPromises();
  expect(wrapper.attributes('data-sidebar-target')).toBe('image_generation');
  expect(wrapper.find('[data-testid="sidebar-preparing"]').exists()).toBe(true);
  expect(wrapper.find('[data-testid="chat-sidebar"]').exists()).toBe(false);
  expect(wrapper.find('[data-testid="translation-sidebar"]').exists()).toBe(false);
  const launcher = wrapper.get('[data-testid="open-launcher"]').element;
  imageNavigation.value = { view: undefined, openGeneration: vi.fn(), openModels: vi.fn(), openDiagnostics: vi.fn() };
  await flushPromises();
  expect(wrapper.find('[data-testid="image-sidebar"]').exists()).toBe(true);
  expect(wrapper.find('[data-testid="sidebar-preparing"]').exists()).toBe(false);
  expect(wrapper.get('[data-testid="open-launcher"]').element).toBe(launcher);
  imageNavigation.value = undefined;
  await flushPromises();
  expect(wrapper.find('[data-testid="sidebar-preparing"]').exists()).toBe(true);
  expect(wrapper.find('[data-testid="chat-sidebar"]').exists()).toBe(false);
});

it('keeps the chat body and group draft across chat URLs and settings overlays', async () => {
  const { wrapper, router } = await mountSidebar({ path: '/chat/first', activation: 'active' });
  await flushPromises();
  await wrapper.get('[data-testid="create-chat-group-button"]').trigger('click');
  const input = wrapper.get<HTMLInputElement>('[data-testid="group-draft"]');
  await input.setValue('Unfinished group');
  await router.push('/chat/second?settings=connection');
  await flushPromises();
  expect(wrapper.get('[data-testid="group-draft"]').element).toBe(input.element);
  expect(input.element.value).toBe('Unfinished group');
  await wrapper.get('[data-testid="close-group"]').trigger('click');
  expect(wrapper.find('[data-testid="group-draft"]').exists()).toBe(false);
  await wrapper.get('[data-testid="create-chat-group-button"]').trigger('click');
  await router.push('/debug');
  await flushPromises();
  await router.push('/chat/first');
  await flushPromises();
  expect(wrapper.find('[data-testid="group-draft"]').exists()).toBe(false);
});

it('preserves image drafts and common menus across nested navigation and confirmed feature changes', async () => {
  imageNavigation.value = { view: undefined, openGeneration: vi.fn(), openModels: vi.fn(), openDiagnostics: vi.fn() };
  const { wrapper, router } = await mountSidebar({ path: '/image-generation/session/one', activation: 'active' });
  await flushPromises();
  const input = wrapper.get<HTMLInputElement>('[data-testid="image-draft"]');
  await input.setValue('Keep my draft');
  await wrapper.get('[data-testid="sidebar-opfs-menu-button"]').trigger('click');
  const launcher = wrapper.get('[data-testid="open-launcher"]').element;
  await router.push('/image-generation/diagnostics');
  await flushPromises();
  expect(wrapper.get('[data-testid="image-draft"]').element).toBe(input.element);
  expect(input.element.value).toBe('Keep my draft');
  const stopNavigation = router.beforeEach(() => false);
  await router.push('/audio-generation');
  expect(wrapper.attributes('data-sidebar-target')).toBe('image_generation');
  stopNavigation();
  await router.push('/audio-generation');
  await flushPromises();
  expect(wrapper.find('[data-testid="audio-sidebar"]').exists()).toBe(true);
  expect(wrapper.get('[data-testid="open-launcher"]').element).toBe(launcher);
  expect(wrapper.find('[data-testid="quick-access"]').exists()).toBe(true);
});

it.each([true, false])('returns to the most recent remaining chat with expanded=%s', async value => {
  expanded.value = value;
  mostRecentChat.value = { id: toChatId({ raw: 'recent-chat' }) };
  const { wrapper } = await mountSidebar({ path: '/live-conversation', activation: 'active' });
  expect(wrapper.get('[data-testid="sidebar-back"]').attributes('href')).toBe('/chat/recent-chat');
  mostRecentChat.value = undefined;
  await flushPromises();
  expect(wrapper.get('[data-testid="sidebar-back"]').attributes('href')).toBe('/');
  if (value) {
    expect(wrapper.get('[data-testid="sidebar-home"]').attributes('href')).toBe('/');
  } else {
    expect(wrapper.find('[data-testid="sidebar-home"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="sidebar-toggle"]').exists()).toBe(true);
  }
  expect(wrapper.get('[data-testid="sidebar-opfs-menu-button"]').attributes('aria-label')).toBeTruthy();
});

it.each([
  ['/audio-generation', 'audio-sidebar'],
  ['/debug/standalone', 'developer-sidebar'],
  ['/workflows/runs', 'workflow-sidebar'],
  ['/audio-transcription', 'transcription-sidebar'],
  ['/audio-transcription/files', 'transcription-sidebar'],
])('provides the feature with its own sidebar at %s', async (path, testId) => {
  const { wrapper } = await mountSidebar({ path, activation: 'active' });
  await flushPromises();
  expect(wrapper.find('[data-testid="chat-sidebar"]').exists()).toBe(false);
  expect(wrapper.find('[data-testid="sidebar-preparing"]').exists()).toBe(false);
  expect(wrapper.find(`[data-testid="${testId}"]`).exists()).toBe(true);
  expect(wrapper.find('[data-testid="sidebar-footer"]').exists()).toBe(true);
});

it('opens global settings with the same trigger and preserves error feedback and Quick Access', async () => {
  storageType.value = 'memory';
  errorCount.value = 2;
  const { wrapper } = await mountSidebar({ path: '/audio-generation', activation: 'active' });
  const settings = wrapper.get('[data-testid="sidebar-settings-button"]');
  await settings.trigger('click');
  expect(openSettings).toHaveBeenCalledExactlyOnceWith({ tab: 'connection', opener: settings.element });
  expect(wrapper.find('[data-testid="sidebar-ghost-icon"]').exists()).toBe(true);
  expect(wrapper.get('[data-testid="sidebar-error-badge"]').text()).toBe('2');
  await wrapper.get('[data-testid="sidebar-debug-button"]').trigger('click');
  expect(toggleDebug).toHaveBeenCalledOnce();
  await wrapper.get('[data-testid="sidebar-opfs-menu-button"]').trigger('click');
  await wrapper.get('[data-testid="sidebar-file-explorer-button"]').trigger('click');
  expect(openFiles).toHaveBeenCalledExactlyOnceWith({ options: { kind: 'opfs-root' } });
  storageType.value = 'local';
  await flushPromises();
  expect(wrapper.find('[data-testid="sidebar-ghost-icon"]').exists()).toBe(false);
});

it('uses the model entry and recovery context without mounting chat or destination controls', async () => {
  const { wrapper, router } = await mountSidebar({ path: '/image-generation/unknown', activation: 'active' });
  // This fixture route accepts image descendants. An explicit model entry must
  // still take priority, including while a feature owner is registered.
  entryKind.value = 'model-preview';
  imageNavigation.value = { view: undefined, openGeneration: vi.fn(), openModels: vi.fn(), openDiagnostics: vi.fn() };
  await flushPromises();
  expect(wrapper.attributes('data-sidebar-target')).toBe('model_preview');
  expect(wrapper.find('[data-testid="chat-sidebar"]').exists()).toBe(false);
  expect(wrapper.find('[data-testid="image-sidebar"]').exists()).toBe(false);
  entryKind.value = 'ordinary';
  await router.push('/unknown');
  await flushPromises();
  expect(wrapper.attributes('data-sidebar-target')).toBe('recovery');
  expect(wrapper.find('[data-testid="chat-sidebar"]').exists()).toBe(false);
});

it('relays the clicked investigation opener to the existing modal owner', async () => {
  const { wrapper } = await mountSidebar({ path: '/debug', activation: 'active' });
  await flushPromises();
  const trigger = wrapper.get('[data-testid="investigate"]');
  await trigger.trigger('click');
  expect(wrapper.emitted('openModelSupportInvestigation')).toEqual([[trigger.element]]);
});
