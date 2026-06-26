import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, ref, computed, reactive, nextTick } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import Sidebar from './Sidebar.vue';
import CurrentChatPane from './CurrentChatPane.vue';
import { useLayout } from '@/composables/useLayout';
import type { ChatGroup, ChatSummary, SidebarItem, MessageNode, Chat } from '@/models/types';
import { idToRaw, toChatGroupId, toChatId } from '@/models/ids';

const { mockScrollIntoViewSafe } = vi.hoisted(() => ({
  mockScrollIntoViewSafe: vi.fn(),
}));

const mockCurrentChat = ref<Chat | { id: string, groupId?: string | null, title?: string } | null>(null);
const mockCurrentChatGroup = ref<ChatGroup | { id: string } | null>(null);
const mockChatGroups = ref<ChatGroup[]>([]);
const mockChats = ref<ChatSummary[]>([]);
const mockActiveMessages = ref<MessageNode[]>([]);

vi.mock('../composables/useChat', () => ({
  useChat: () => ({
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
    resolvedSettings: ref({ modelId: 'm1', sources: { modelId: 'global' } }),
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
    resolvedSettings: ref({ modelId: 'm1', sources: { modelId: 'global' } }),
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
    settings: ref({}),
    availableModels: ref([]),
    isFetchingModels: ref(false),
    updateGlobalModel: vi.fn(),
  }),
}));

vi.mock('@/utils/dom', () => ({
  scrollIntoViewSafe: mockScrollIntoViewSafe,
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
    routes: [{ path: '/', component: { template: 'div' } }],
  });

  let wrapper: VueWrapper<any> | null = null;
  const layout = useLayout();

  beforeEach(() => {
    vi.useFakeTimers();
    layout.activeFocusArea.value = 'chat';
    layout.activeFocusAreaVersion.value = 0;
    layout.isSidebarOpen.value = true;
    mockScrollIntoViewSafe.mockClear();
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
      if (typeof options.top === 'number') this.scrollTop = options.top;
    });
    HTMLElement.prototype.getBoundingClientRect = vi.fn().mockImplementation(function(this: HTMLElement) {
      if (this.dataset.testid === 'sidebar-nav') {
        return {
          top: 0, bottom: 100, left: 0, right: 100, width: 100, height: 100,
          x: 0, y: 0, toJSON: () => ({}),
        };
      }

      if (this.dataset.sidebarChatId === 'chat-1' || this.dataset.sidebarGroupId === 'g1') {
        return {
          top: 180, bottom: 220, left: 0, right: 100, width: 100, height: 40,
          x: 0, y: 180, toJSON: () => ({}),
        };
      }

      return {
        top: 0, bottom: 40, left: 0, right: 100, width: 100, height: 40,
        x: 0, y: 0, toJSON: () => ({}),
      };
    });
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
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
          Logo: true,
          ModelSelector: true,
        },
      },
    });
    await nextTick();

    await vi.runAllTimersAsync();
    mockScrollIntoViewSafe.mockClear();

    await wrapper.getComponent(CurrentChatPane).trigger('click');
    await nextTick();
    await vi.runAllTimersAsync();

    expect(layout.activeFocusArea.value).toBe('chat');
    expect(layout.activeFocusAreaVersion.value).toBe(1);
    expect(mockScrollIntoViewSafe).toHaveBeenCalled();
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
    mockScrollIntoViewSafe.mockClear();

    layout.setActiveFocusArea({ area: 'chat' });
    await nextTick();
    await vi.runAllTimersAsync();

    expect(layout.activeFocusAreaVersion.value).toBe(1);
    expect(mockScrollIntoViewSafe).toHaveBeenCalled();
  });
});
