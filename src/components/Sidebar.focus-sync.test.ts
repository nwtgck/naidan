import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, ref, computed, reactive, nextTick } from 'vue';
import { createRouter, createWebHistory, type RouteLocationResolved } from 'vue-router';
import Sidebar from './Sidebar.vue';
import CurrentChatPane from './CurrentChatPane.vue';
import { useLayout } from '@/composables/useLayout';
import type { ChatGroup, ChatSummary, SidebarItem, MessageNode, Chat } from '@/01-models/types';
import { idToRaw, toChatGroupId, toChatId } from '@/01-models/ids';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

const mockEffectiveRoute = ref<RouteLocationResolved>();

// Focus synchronization needs the real pane click handler, not background
// initialization of dialogs, inspectors, or editor modules unrelated to it.
vi.mock('../utils/vue', async () => {
  const { defineComponent } = await import('vue');
  return {
    defineAsyncComponentAndLoadOnMounted: () => defineComponent({
      name: 'AsyncPanelOutsideFocusContract',
      inheritAttrs: false,
      render: () => undefined,
    }),
  };
});

vi.mock('../composables/useAppEntry', async importOriginal => {
  const actual = await importOriginal<typeof import('@/composables/useAppEntry')>();
  return { ...actual, useAppEntry: () => ({ ...actual.useAppEntry(), effectiveRoute: mockEffectiveRoute }) };
});

const mockCurrentChat = ref<Chat | { id: string, groupId?: string | null, title?: string } | null>(null);
const mockCurrentChatGroup = ref<ChatGroup | { id: string } | null>(null);
const mockChatGroups = ref<ChatGroup[]>([]);
const mockChats = ref<ChatSummary[]>([]);
const mockActiveMessages = ref<MessageNode[]>([]);

vi.mock('../composables/useChatWhichExistsOnlyForLegacyTestsThatMustNotBeRemovedAndMustNeverBeUsedInProduction.test-support', () => ({
  useChatWhichExistsOnlyForLegacyTestsThatMustNotBeRemovedAndMustNeverBeUsedInProduction: () => ({
    currentChat: mockCurrentChat,
    currentChatGroup: mockCurrentChatGroup,
    chatGroups: mockChatGroups,
    chats: mockChats,
    sidebarItems: computed<SidebarItem[]>(() => {
      const items: SidebarItem[] = [];
      mockChatGroups.value.forEach(g => items.push({ id: idToRaw({ id: g.id }), type: 'chat_group', chatGroup: g }));
      mockChats.value.filter(c => !c.groupId).forEach(c => items.push({ id: idToRaw({ id: c.id }), type: 'chat', chat: c }));
      return items;
    }),
    openChat: vi.fn(),
    openChatGroup: vi.fn(),
    setChatGroupCollapsed: vi.fn(),
    persistSidebarStructure: vi.fn(),
    streaming: ref(false),
    activeGenerations: reactive(new Map()),
    activeMessages: mockActiveMessages,
    generatingTitle: ref(false),
    allMessages: ref([]),
    availableModels: ref([]),
    resolvedSettings: ref({
      endpoint: { type: 'openai', url: '' },
      modelId: 'm1',
      sources: { modelId: 'global' },
    }),
    inheritedSettings: ref({ modelId: 'm1', sources: { modelId: 'global' } }),
    isProcessing: vi.fn().mockReturnValue(false),
    getReasoningEffort: vi.fn(),
    updateReasoningEffort: vi.fn(),
    getLiveChat: vi.fn().mockImplementation((c) => c),
    fetchAvailableModels: vi.fn(),
    getSiblings: vi.fn().mockReturnValue([]),
    abortChat: vi.fn(),
    updateChatModel: vi.fn(),
    isImageMode: vi.fn(() => false),
    toggleImageMode: vi.fn(),
    getResolution: vi.fn(() => ({ width: 512, height: 512 })),
    getCount: vi.fn(() => 1),
    updateCount: vi.fn(),
    getSteps: vi.fn(() => undefined),
    updateSteps: vi.fn(),
    getSeed: vi.fn(() => 'browser_random'),
    updateSeed: vi.fn(),
    getPersistAs: vi.fn(() => 'original'),
    updatePersistAs: vi.fn(),
    updateResolution: vi.fn(),
    setImageModel: vi.fn(),
    getSelectedImageModel: vi.fn(),
    getSortedImageModels: vi.fn(() => []),
    imageModeMap: ref({}),
    imageResolutionMap: ref({}),
    imageCountMap: ref({}),
    imagePersistAsMap: ref({}),
    imageModelOverrideMap: ref({}),
    updateChatSettings: vi.fn(),
    chatFlow: computed(() => []),
    isThinkingActive: vi.fn(() => false),
    isWaitingResponse: vi.fn(() => false),
    abortTitleGeneration: vi.fn(),
    generateChatTitle: vi.fn(),
  }),
}));

vi.mock('../composables/chat/ui/useCurrentChatState', () => ({
  useCurrentChatState: () => ({
    currentChat: computed(() => mockCurrentChat.value),
    currentChatGroup: computed(() => mockCurrentChatGroup.value),
    currentChatId: computed(() => mockCurrentChat.value?.id),
    activeMessages: mockActiveMessages,
    allMessages: ref([]),
    resolvedSettings: ref({
      endpoint: { type: 'openai', url: '' },
      modelId: 'm1',
      sources: { modelId: 'global' },
    }),
    inheritedSettings: ref({ modelId: 'm1', sources: { modelId: 'global' } }),
    chatGroups: computed(() => mockChatGroups.value),
    sidebarItems: computed<SidebarItem[]>(() => {
      const items: SidebarItem[] = [];
      mockChatGroups.value.forEach(g => items.push({ id: idToRaw({ id: g.id }), type: 'chat_group', chatGroup: g }));
      mockChats.value.filter(c => !c.groupId).forEach(c => items.push({ id: idToRaw({ id: c.id }), type: 'chat', chat: c }));
      return items;
    }),
    TEST_ONLY: {},
  }),
}));

vi.mock('../composables/useSettings', () => ({
  useSettings: () => ({
    settings: ref({ endpoint: { type: 'openai', url: '' } }),
    availableModels: ref([]),
    isFetchingModels: ref(false),
    updateGlobalModel: vi.fn(),
  }),
}));

vi.mock('vuedraggable', () => ({
  default: {
    name: 'draggable',
    template: '<div class="draggable-mock"><slot name="item" v-for="element in modelValue" :element="element"></slot></div>',
    props: ['modelValue'],
  },
}));

const TestHarness = defineComponent({
  components: { Sidebar, CurrentChatPane },
  template: `\
    <div>
      <Sidebar />
      <CurrentChatPane />
    </div>
  `,
});

describe('Sidebar Focus Sync', () => {
  const router = createRouter({
    history: createWebHistory(),
    routes: ['/', '/chat/:id', '/chat-group/:id'].map(path => ({ path, component: { template: 'div' } })),
  });

  let wrapper: VueWrapper<any> | null = null;
  const layout = useLayout();

  beforeEach(() => {
    vi.useFakeTimers();
    mockEffectiveRoute.value = undefined;
    layout.activeFocusArea.value = 'chat';
    layout.activeFocusAreaVersion.value = 0;
    layout.isSidebarOpen.value = true;
    mockCurrentChat.value = {
      id: 'chat-1',
      title: 'Chat 1',
      root: { items: [] },
      createdAt: 0,
      updatedAt: 0,
      currentLeafId: undefined,
      debugEnabled: false,
    };
    mockCurrentChatGroup.value = null;
    mockChats.value = [{ id: toChatId({ raw: 'chat-1' }), title: 'Chat 1', updatedAt: 0 }];
    mockChatGroups.value = [];
    mockActiveMessages.value = [];

    HTMLElement.prototype.scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollTo = vi.fn().mockImplementation(function(this: HTMLElement, options: ScrollToOptions) {
      if (typeof options.top === 'number') {
        this.scrollTop = options.top;
      }
    });
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(100);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(1000);
    HTMLElement.prototype.getBoundingClientRect = vi.fn().mockImplementation(function(this: HTMLElement) {
      if (this.dataset.testid === 'sidebar-nav') {
        return {
          top: 0,
          bottom: 100,
          left: 0,
          right: 100,
          width: 100,
          height: 100,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        };
      }

      if (this.dataset.sidebarChatId === 'chat-1' || this.dataset.sidebarGroupId === 'g1') {
        return {
          top: 180 - (this.closest<HTMLElement>('[data-testid=sidebar-nav]')?.scrollTop ?? 0),
          bottom: 220 - (this.closest<HTMLElement>('[data-testid=sidebar-nav]')?.scrollTop ?? 0),
          left: 0,
          right: 100,
          width: 100,
          height: 40,
          x: 0,
          y: 180,
          toJSON: () => ({}),
        };
      }

      return {
        top: 0,
        bottom: 40,
        left: 0,
        right: 100,
        width: 100,
        height: 40,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      };
    });
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('re-activates chat focus on CurrentChatPane click and can scroll a hidden selected chat', async () => {
    wrapper = mount(TestHarness, {
      global: {
        plugins: [router],
        stubs: {
          'lucide-vue-next': true,
          MessageItem: true,
          WelcomeScreen: true,
          ChatSettingsPanel: true,
          ChatInput: true,
          CspLmEndpointHint: true,
          Logo: true,
          ModelSelector: true,
        },
      },
    });
    await nextTick();
    await nextTick();
    vi.mocked(HTMLElement.prototype.scrollTo)?.mockClear();

    wrapper.get<HTMLElement>('[data-testid=sidebar-nav]').element.scrollTop = 0;
    await wrapper.getComponent(CurrentChatPane).trigger('click');
    await nextTick();
    await nextTick();

    expect(layout.activeFocusArea.value).toBe('chat');
    expect(layout.activeFocusAreaVersion.value).toBe(1);
    expect(HTMLElement.prototype.scrollTo).toHaveBeenCalledWith({ top: 132.5, behavior: 'smooth' });
  });

  it('can scroll a hidden selected group after chat focus is re-activated', async () => {
    mockCurrentChat.value = null;
    mockCurrentChatGroup.value = { id: 'g1' };
    mockChats.value = [];
    mockChatGroups.value = [{
      id: toChatGroupId({ raw: 'g1' }),
      name: 'Group 1',
      isCollapsed: false,
      updatedAt: 0,
      items: [],
    }];

    wrapper = mount(Sidebar, {
      global: {
        plugins: [router],
        stubs: {
          'lucide-vue-next': true,
          Logo: true,
          ThemeToggle: true,
          ModelSelector: true,
        },
      },
    });
    await nextTick();

    await vi.runAllTimersAsync();
    vi.mocked(HTMLElement.prototype.scrollTo)?.mockClear();

    wrapper.get<HTMLElement>('[data-testid=sidebar-nav]').element.scrollTop = 0;
    layout.setActiveFocusArea({ area: 'chat' });
    await nextTick();
    await vi.runAllTimersAsync();

    expect(layout.activeFocusAreaVersion.value).toBe(1);
    expect(HTMLElement.prototype.scrollTo).toHaveBeenCalledWith({ top: 132.5, behavior: 'smooth' });
  });

  it.each([
    { path: '/chat/chat-1', top: 180 },
    { path: '/chat-group/g1', top: 180 },
  ])('uses the initial URL $path before the selected body is loaded', async ({ path, top }) => {
    mockCurrentChat.value = null;
    mockCurrentChatGroup.value = null;
    mockChatGroups.value = [{ id: toChatGroupId({ raw: 'g1' }), name: 'Chat group', isCollapsed: false, updatedAt: 0, items: [] }];
    // This is the effective route while Vue Router is still at START_LOCATION.
    mockEffectiveRoute.value = router.resolve(path);
    wrapper = mount(Sidebar, { global: { plugins: [router], stubs: { ModelSelector: true } } });
    await nextTick();
    await nextTick();
    expect(HTMLElement.prototype.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: top - (100 - 40) / 3, behavior: 'auto' });
  });

  it.each(['/chat/chat-1', '/chat-group/g1'])('reveals the new URL %s during search before the selected body is loaded', async path => {
    mockCurrentChat.value = null;
    mockCurrentChatGroup.value = null;
    mockChatGroups.value = [{ id: toChatGroupId({ raw: 'g1' }), name: 'Chat group', isCollapsed: false, updatedAt: 0, items: [] }];
    mockEffectiveRoute.value = router.resolve('/');
    wrapper = mount(Sidebar, { global: { plugins: [router], stubs: { ModelSelector: true } } });
    await nextTick();
    await nextTick();
    expect(HTMLElement.prototype.scrollTo).not.toHaveBeenCalled();

    layout.setActiveFocusArea({ area: 'search' });
    mockEffectiveRoute.value = router.resolve(path);
    await nextTick();
    await nextTick();

    expect(HTMLElement.prototype.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 132.5, behavior: 'smooth' });
    expect(layout.activeFocusArea.value).toBe('search');
  });

  it('ignores stale selected state after leaving a chat route', async () => {
    mockEffectiveRoute.value = router.resolve('/');
    wrapper = mount(Sidebar, { global: { plugins: [router], stubs: { ModelSelector: true } } });
    await nextTick();
    layout.setActiveFocusArea({ area: 'chat' });
    await nextTick();
    await nextTick();
    expect(HTMLElement.prototype.scrollTo).not.toHaveBeenCalled();
  });

  it('uses the final row position when focus and metadata reordering happen together', async () => {
    mockChats.value = [
      { id: toChatId({ raw: 'chat-1' }), title: 'Chat 1', updatedAt: 0 },
      { id: toChatId({ raw: 'chat-2' }), title: 'Chat 2', updatedAt: 0 },
    ];
    HTMLElement.prototype.getBoundingClientRect = vi.fn().mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid === 'sidebar-nav') {
        return new DOMRect(0, 0, 100, 100);
      }
      const nav = this.closest<HTMLElement>('[data-testid=sidebar-nav]');
      if (this.hasAttribute('data-sidebar-chat-id') && nav !== null) {
        const index = Array.from(nav.querySelectorAll('[data-sidebar-chat-id]')).indexOf(this);
        const translated = /translate\([^,]+,\s*([-\d.]+)px\)/.exec(this.style.transform);
        const shift = translated === null ? 0 : Number(translated[1]);
        return new DOMRect(0, 200 + index * 400 - nav.scrollTop + shift, 100, 40);
      }
      return new DOMRect(0, 0, 100, 40);
    });
    wrapper = mount(Sidebar, { global: { plugins: [router], stubs: { ModelSelector: true } } });
    await nextTick();
    await nextTick();
    const nav = wrapper.get<HTMLElement>('[data-testid=sidebar-nav]').element;
    nav.scrollTop = 0;
    vi.mocked(HTMLElement.prototype.scrollTo).mockClear();
    mockChats.value = [mockChats.value[1]!, mockChats.value[0]!];
    layout.setActiveFocusArea({ area: 'chat' });
    await nextTick();
    await nextTick();
    expect(nav.scrollTo).not.toHaveBeenCalled();
    // The FLIP cleanup also completes requests when CSS emits no transitionend.
    await vi.advanceTimersByTimeAsync(221);
    expect(nav.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 552.5, behavior: 'smooth' });
  });
});
