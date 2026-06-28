import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import Sidebar from './Sidebar.vue';
import { createRouter, createWebHistory } from 'vue-router';
import { ref, computed, nextTick, reactive } from 'vue';
import type { ChatGroup, ChatSummary, SidebarItem } from '@/01-models/types';
import type { FocusArea } from '@/composables/useLayout';
import { idToRaw, toChatGroupId, toChatId } from '@/01-models/ids';

const mockChatGroups = ref<ChatGroup[]>([]);
const mockChats = ref<ChatSummary[]>([]);
const mockCurrentChat = ref<{ id: string, groupId?: string | null } | null>(null);
const mockCurrentChatGroup = ref<ChatGroup | { id: string } | null>(null);
const mockOpenChat = vi.fn();
const mockOpenChatGroup = vi.fn();
const mockSetChatGroupCollapsed = vi.fn();
const mockPersistSidebarStructure = vi.fn();

const mockActiveFocusArea = ref('chat');
const mockSetActiveFocusArea = vi.fn(({ area }: { area: FocusArea }) => {
  mockActiveFocusArea.value = area;
});

vi.mock('../composables/useChat', () => ({
  useChat: () => ({
    currentChat: mockCurrentChat,
    currentChatGroup: mockCurrentChatGroup,
    streaming: ref(false),
    activeGenerations: reactive(new Map()),
    chatGroups: mockChatGroups,
    chats: mockChats,
    sidebarItems: computed<SidebarItem[]>(() => {
      const items: SidebarItem[] = [];
      mockChatGroups.value.forEach(g => items.push({ id: idToRaw({ id: g.id }), type: 'chat_group', chatGroup: g }));
      mockChats.value.filter(c => !c.groupId).forEach(c => items.push({ id: idToRaw({ id: c.id }), type: 'chat', chat: c }));
      return items;
    }),
    openChat: mockOpenChat,
    openChatGroup: mockOpenChatGroup,
    setChatGroupCollapsed: mockSetChatGroupCollapsed,
    persistSidebarStructure: vi.fn(),
    isTaskRunning: vi.fn().mockReturnValue(false),
    isProcessing: vi.fn().mockReturnValue(false),
    getReasoningEffort: vi.fn(),
    updateReasoningEffort: vi.fn(),
    getLiveChat: vi.fn().mockImplementation((c) => c),
  }),
}));

vi.mock('../composables/chat/ui/useCurrentChatState', () => ({
  useCurrentChatState: () => ({
    currentChat: computed(() => mockCurrentChat.value),
    currentChatGroup: computed(() => mockCurrentChatGroup.value),
    currentChatId: computed(() => mockCurrentChat.value?.id),
    activeMessages: computed(() => []),
    allMessages: computed(() => []),
    resolvedSettings: computed(() => null),
    inheritedSettings: computed(() => null),
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

vi.mock('../composables/chat/ui/useChatNavigation', () => ({
  useChatNavigation: () => ({
    openChat: ({ chatId }: { chatId: string, leafId?: string }) => mockOpenChat({ id: chatId }),
    openChatAtMessage: vi.fn(),
    openChatGroup: ({ groupId }: { groupId: string | null }) => mockOpenChatGroup({ id: groupId }),
    TEST_ONLY: {},
  }),
}));

vi.mock('../composables/chat/ui/useSidebarStructure', () => ({
  useSidebarStructure: () => ({
    persistSidebarStructure: mockPersistSidebarStructure,
    setChatGroupCollapsed: ({ groupId, isCollapsed }: { groupId: string, isCollapsed: boolean }) =>
      mockSetChatGroupCollapsed({ groupId, isCollapsed }),
    TEST_ONLY: {},
  }),
}));

vi.mock('../composables/chat/ui/useChatLifecycle', () => ({
  useChatLifecycle: () => ({
    createNewChat: vi.fn(),
    deleteChat: vi.fn(),
    deleteAllChats: vi.fn(),
    TEST_ONLY: {},
  }),
}));

vi.mock('../composables/chat/ui/useChatOrganization', () => ({
  useChatOrganization: () => ({
    createChatGroup: vi.fn(),
    deleteChatGroup: vi.fn(),
    duplicateChatGroup: vi.fn(),
    renameChatGroup: vi.fn(),
    updateChatGroupMetadata: vi.fn(),
    moveChatToGroup: vi.fn(),
    reorderSidebarChatAfterSend: vi.fn(),
    TEST_ONLY: {},
  }),
}));

vi.mock('../composables/useSettings', () => ({
  useSettings: () => ({
    settings: ref({ endpoint: { type: 'openai', url: 'http://localhost' } }),
    availableModels: ref([]),
    isFetchingModels: ref(false),
    updateGlobalModel: vi.fn(),
  }),
}));

vi.mock('../composables/useLayout', () => ({
  useLayout: () => ({
    isSidebarOpen: ref(true),
    activeFocusArea: mockActiveFocusArea,
    setActiveFocusArea: mockSetActiveFocusArea,
    toggleSidebar: vi.fn(),
  }),
}));

// Mock draggable component
vi.mock('vuedraggable', () => ({
  default: {
    name: 'draggable',
    template: '<div class="draggable-mock"><slot name="item" v-for="element in modelValue" :element="element"></slot></div>',
    props: ['modelValue'],
  },
}));

describe('Sidebar Keyboard Navigation', () => {
  const router = createRouter({
    history: createWebHistory(),
    routes: [{ path: '/', component: { template: 'div' } }, { path: '/chat/:id', component: { template: 'div' } }, { path: '/chat-group/:id', component: { template: 'div' } }],
  });

  const globalStubs = {
    'lucide-vue-next': true,
    'Logo': true,
    'ThemeToggle': true,
    'ModelSelector': true,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    // Individually defined mocks for scrolling as requested
    HTMLElement.prototype.scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollTo = vi.fn().mockImplementation(function(this: HTMLElement, options: any) {
      if (typeof options.top === 'number') this.scrollTop = options.top;
    });
    HTMLElement.prototype.getBoundingClientRect = vi.fn().mockReturnValue({
      top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0,
    });

    mockActiveFocusArea.value = 'sidebar';
    mockChatGroups.value = [];
    mockChats.value = [
      { id: toChatId({ raw: '1' }), title: 'Chat 1', updatedAt: 0 },
      { id: toChatId({ raw: '2' }), title: 'Chat 2', updatedAt: 0 },
      { id: toChatId({ raw: '3' }), title: 'Chat 3', updatedAt: 0 },
    ];
    mockCurrentChat.value = { id: '1' };
    mockCurrentChatGroup.value = null;
    mockOpenChat.mockClear();
    mockOpenChatGroup.mockClear();
    mockSetChatGroupCollapsed.mockClear();
    mockSetActiveFocusArea.mockClear();
  });

  it('navigates down on ArrowDown only when area is sidebar', async () => {
    mount(Sidebar, { global: { plugins: [router], stubs: globalStubs } });
    await nextTick();

    // Switch to chat area
    mockActiveFocusArea.value = 'chat';
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(mockOpenChat).not.toHaveBeenCalled();

    // Switch back to sidebar
    mockActiveFocusArea.value = 'sidebar';
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(mockOpenChat).toHaveBeenCalledWith({ id: '2' });
  });

  it('sets focus area to sidebar when focused or clicked', async () => {
    const wrapper = mount(Sidebar, { global: { plugins: [router], stubs: globalStubs } });
    const nav = wrapper.get('[data-testid="sidebar-nav"]');

    await nav.trigger('focus');
    expect(mockSetActiveFocusArea).toHaveBeenCalledWith({ area: 'sidebar' });

    await nav.trigger('click');
    expect(mockSetActiveFocusArea).toHaveBeenCalledWith({ area: 'sidebar' });
  });

  it('includes chat groups in navigation', async () => {
    mockChatGroups.value = [{ id: toChatGroupId({ raw: 'g1' }), name: 'Group 1', isCollapsed: true, updatedAt: 0, items: [] }];
    mockChats.value = [{ id: toChatId({ raw: '1' }), title: 'Chat 1', updatedAt: 0 }];
    mockCurrentChatGroup.value = { id: 'g1' };
    mockCurrentChat.value = null;

    mount(Sidebar, { global: { plugins: [router], stubs: globalStubs } });
    await nextTick();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));

    expect(mockOpenChat).toHaveBeenCalledWith({ id: '1' });
  });

  it('selects a chat group when navigating to it', async () => {
    mockChatGroups.value = [{ id: toChatGroupId({ raw: 'g1' }), name: 'Group 1', isCollapsed: true, updatedAt: 0, items: [] }];
    mockChats.value = [{ id: toChatId({ raw: '1' }), title: 'Chat 1', updatedAt: 0 }];
    mockCurrentChat.value = { id: '1' };
    mockCurrentChatGroup.value = null;

    mount(Sidebar, { global: { plugins: [router], stubs: globalStubs } });
    await nextTick();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));

    expect(mockOpenChatGroup).toHaveBeenCalledWith({ id: 'g1' });
  });

  it('expands a collapsed group on ArrowRight', async () => {
    const group = { id: toChatGroupId({ raw: 'g1' }), name: 'Group 1', isCollapsed: true, updatedAt: 0, items: [] };
    mockChatGroups.value = [group];
    mockCurrentChatGroup.value = group;
    mockCurrentChat.value = null;

    mount(Sidebar, { global: { plugins: [router], stubs: globalStubs } });
    await nextTick();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));

    expect(mockSetChatGroupCollapsed).toHaveBeenCalledWith({ groupId: 'g1', isCollapsed: false });
  });

  it('collapses an expanded group on ArrowLeft', async () => {
    const group = { id: toChatGroupId({ raw: 'g1' }), name: 'Group 1', isCollapsed: false, updatedAt: 0, items: [] };
    mockChatGroups.value = [group];
    mockCurrentChatGroup.value = group;
    mockCurrentChat.value = null;

    mount(Sidebar, { global: { plugins: [router], stubs: globalStubs } });
    await nextTick();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));

    expect(mockSetChatGroupCollapsed).toHaveBeenCalledWith({ groupId: 'g1', isCollapsed: true });
  });

  it('jumps to parent group on ArrowLeft from a grouped chat', async () => {
    const group1: ChatGroup = {
      id: toChatGroupId({ raw: 'g1' }), name: 'Group 1', isCollapsed: false, updatedAt: 0,
      items: [{ id: 'chat:1', type: 'chat', chat: { id: toChatId({ raw: '1' }), title: 'Chat 1', updatedAt: 0, groupId: toChatGroupId({ raw: 'g1' }) } }],
    };
    mockChatGroups.value = [group1];
    mockChats.value = [{ id: toChatId({ raw: '1' }), title: 'Chat 1', updatedAt: 0, groupId: toChatGroupId({ raw: 'g1' }) }];
    mockCurrentChat.value = { id: '1', groupId: 'g1' };
    mockCurrentChatGroup.value = null;

    mount(Sidebar, { global: { plugins: [router], stubs: globalStubs } });
    await nextTick();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));

    expect(mockOpenChatGroup).toHaveBeenCalledWith({ id: 'g1' });
  });

  it('correctly navigates down through multiple groups and chats', async () => {
    const chat1: ChatSummary = { id: toChatId({ raw: 'c1' }), title: 'C1', updatedAt: 0 };
    mockChatGroups.value = [
      { id: toChatGroupId({ raw: 'g1' }), name: 'G1', isCollapsed: true, updatedAt: 0, items: [] },
      { id: toChatGroupId({ raw: 'g2' }), name: 'G2', isCollapsed: true, updatedAt: 0, items: [] },
    ];
    mockChats.value = [chat1];
    mockCurrentChatGroup.value = { id: 'g1' };
    mockCurrentChat.value = null;

    mount(Sidebar, { global: { plugins: [router], stubs: globalStubs } });
    await nextTick();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(mockOpenChatGroup).toHaveBeenCalledWith({ id: 'g2' });

    mockCurrentChatGroup.value = { id: 'g2' };
    await nextTick();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(mockOpenChat).toHaveBeenCalledWith({ id: 'c1' });
  });

  it('recovers navigation when current item is hidden (e.g. parent collapsed)', async () => {
    mockChatGroups.value = [
      {
        id: toChatGroupId({ raw: 'g1' }), name: 'G1', isCollapsed: true, updatedAt: 0,
        items: [{ id: 'chat:hidden', type: 'chat', chat: { id: toChatId({ raw: 'hidden' }), title: 'Hidden', updatedAt: 0, groupId: toChatGroupId({ raw: 'g1' }) } }],
      },
      { id: toChatGroupId({ raw: 'g2' }), name: 'G2', isCollapsed: true, updatedAt: 0, items: [] },
    ];
    mockCurrentChat.value = { id: 'hidden', groupId: 'g1' };
    mockCurrentChatGroup.value = null;

    mount(Sidebar, { global: { plugins: [router], stubs: globalStubs } });
    await nextTick();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(mockOpenChatGroup).toHaveBeenCalledWith({ id: 'g2' });
  });

  it('handles rapid navigation correctly despite store update lags', async () => {
    const group1: ChatGroup = { id: toChatGroupId({ raw: 'g1' }), name: 'G1', isCollapsed: false, updatedAt: 0, items: [] };
    const group2: ChatGroup = { id: toChatGroupId({ raw: 'g2' }), name: 'G2', isCollapsed: false, updatedAt: 0, items: [] };
    const chat1: ChatSummary = { id: toChatId({ raw: 'c1' }), title: 'C1', updatedAt: 0, groupId: toChatGroupId({ raw: 'g1' }) };
    const chat2: ChatSummary = { id: toChatId({ raw: 'c2' }), title: 'C2', updatedAt: 0, groupId: toChatGroupId({ raw: 'g2' }) };
    const chat3: ChatSummary = { id: toChatId({ raw: 'c3' }), title: 'C3', updatedAt: 0, groupId: toChatGroupId({ raw: 'g2' }) };

    group1.items = [{ id: 'chat:c1', type: 'chat', chat: chat1 }];
    group2.items = [{ id: 'chat:c2', type: 'chat', chat: chat2 }, { id: 'chat:c3', type: 'chat', chat: chat3 }];

    mockChatGroups.value = [group1, group2];
    mockChats.value = [chat1, chat2, chat3];
    mockCurrentChat.value = { id: 'c1', groupId: 'g1' };
    mockCurrentChatGroup.value = null;

    mount(Sidebar, { global: { plugins: [router], stubs: globalStubs } });
    await nextTick();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(mockOpenChatGroup).toHaveBeenCalledWith({ id: 'g2' });

    mockCurrentChatGroup.value = { id: 'g2' };
    await nextTick();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(mockOpenChat).toHaveBeenCalledWith({ id: 'c2' });

    mockCurrentChatGroup.value = null;
    await nextTick();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));

    expect(mockOpenChat).toHaveBeenCalledWith({ id: 'c3' });
    expect(mockOpenChatGroup).toHaveBeenCalledTimes(1);
  });

  it('triggers scrollIntoView when chat is selected', async () => {
    const scrollToSpy = vi.spyOn(HTMLElement.prototype, 'scrollTo');
    mockChats.value = [{ id: toChatId({ raw: '1' }), title: 'Chat 1', updatedAt: 0 }];

    mockCurrentChat.value = { id: '1' };
    mount(Sidebar, { global: { plugins: [router], stubs: globalStubs } });

    await nextTick();
    vi.advanceTimersByTime(150);

    // scrollIntoViewSafe calls container.scrollTo
    expect(scrollToSpy).toHaveBeenCalled();
    scrollToSpy.mockRestore();
  });

  it('triggers scrollIntoView when group is selected', async () => {
    const scrollToSpy = vi.spyOn(HTMLElement.prototype, 'scrollTo');
    mockChatGroups.value = [{ id: toChatGroupId({ raw: 'g1' }), name: 'Group 1', isCollapsed: false, updatedAt: 0, items: [] }];

    mockCurrentChatGroup.value = { id: 'g1' };
    mount(Sidebar, { global: { plugins: [router], stubs: globalStubs } });

    await nextTick();
    vi.advanceTimersByTime(150);

    expect(scrollToSpy).toHaveBeenCalled();
    scrollToSpy.mockRestore();
  });

  it('ignores arrow keys when focus area is NOT sidebar', async () => {
    mount(Sidebar, { global: { plugins: [router], stubs: globalStubs } });
    await nextTick();

    const nonSidebarAreas = ['chat', 'chat-group-settings', 'chat-settings', 'settings', 'onboarding', 'dialog', 'none'] as const;

    for (const area of nonSidebarAreas) {
      mockActiveFocusArea.value = area;
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
      expect(mockOpenChat, `Should ignore ArrowDown when area is ${area}`).not.toHaveBeenCalled();
    }
  });
});
