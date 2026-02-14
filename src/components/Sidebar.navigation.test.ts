import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import Sidebar from './Sidebar.vue';
import { createRouter, createWebHistory } from 'vue-router';
import { ref, computed, nextTick, reactive } from 'vue';
import type { ChatGroup, ChatSummary, SidebarItem } from '../models/types';

const mockChatGroups = ref<ChatGroup[]>([]);
const mockChats = ref<ChatSummary[]>([]);
const mockCurrentChat = ref<{ id: string; groupId?: string | null } | null>(null);
const mockCurrentChatGroup = ref<{ id: string } | null>(null);
const mockOpenChat = vi.fn();
const mockOpenChatGroup = vi.fn();
const mockSetChatGroupCollapsed = vi.fn();

const mockActiveFocusArea = ref('chat');
const mockSetActiveFocusArea = vi.fn((area) => {
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
      mockChatGroups.value.forEach(g => items.push({ id: g.id, type: 'chat_group', chatGroup: g }));
      mockChats.value.filter(c => !c.groupId).forEach(c => items.push({ id: c.id, type: 'chat', chat: c }));
      return items;
    }),
    openChat: mockOpenChat,
    openChatGroup: mockOpenChatGroup,
    setChatGroupCollapsed: mockSetChatGroupCollapsed,
    persistSidebarStructure: vi.fn(),
    isTaskRunning: vi.fn().mockReturnValue(false),
    isProcessing: vi.fn().mockReturnValue(false),
  }),
}));

vi.mock('../composables/useSettings', () => ({
  useSettings: () => ({
    settings: ref({ endpointUrl: 'http://localhost' }),
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
    mockActiveFocusArea.value = 'sidebar';
    mockChatGroups.value = [];
    mockChats.value = [
      { id: '1', title: 'Chat 1', updatedAt: 0 },
      { id: '2', title: 'Chat 2', updatedAt: 0 },
      { id: '3', title: 'Chat 3', updatedAt: 0 },
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
    expect(mockOpenChat).toHaveBeenCalledWith('2');
  });

  it('sets focus area to sidebar when focused or clicked', async () => {
    const wrapper = mount(Sidebar, { global: { plugins: [router], stubs: globalStubs } });
    const nav = wrapper.get('[data-testid="sidebar-nav"]');

    await nav.trigger('focus');
    expect(mockSetActiveFocusArea).toHaveBeenCalledWith('sidebar');

    await nav.trigger('click');
    expect(mockSetActiveFocusArea).toHaveBeenCalledWith('sidebar');
  });

  it('includes chat groups in navigation', async () => {
    mockChatGroups.value = [{ id: 'g1', name: 'Group 1', isCollapsed: true, updatedAt: 0, items: [] }];
    mockChats.value = [{ id: '1', title: 'Chat 1', updatedAt: 0 }];
    mockCurrentChatGroup.value = { id: 'g1' };
    mockCurrentChat.value = null;

    mount(Sidebar, { global: { plugins: [router], stubs: globalStubs } });
    await nextTick();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));

    expect(mockOpenChat).toHaveBeenCalledWith('1');
  });

  it('selects a chat group when navigating to it', async () => {
    mockChatGroups.value = [{ id: 'g1', name: 'Group 1', isCollapsed: true, updatedAt: 0, items: [] }];
    mockChats.value = [{ id: '1', title: 'Chat 1', updatedAt: 0 }];
    mockCurrentChat.value = { id: '1' };
    mockCurrentChatGroup.value = null;

    mount(Sidebar, { global: { plugins: [router], stubs: globalStubs } });
    await nextTick();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));

    expect(mockOpenChatGroup).toHaveBeenCalledWith('g1');
  });

  it('expands a collapsed group on ArrowRight', async () => {
    const group = { id: 'g1', name: 'Group 1', isCollapsed: true, updatedAt: 0, items: [] };
    mockChatGroups.value = [group];
    mockCurrentChatGroup.value = group;
    mockCurrentChat.value = null;

    mount(Sidebar, { global: { plugins: [router], stubs: globalStubs } });
    await nextTick();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));

    expect(mockSetChatGroupCollapsed).toHaveBeenCalledWith({ groupId: 'g1', isCollapsed: false });
  });

  it('collapses an expanded group on ArrowLeft', async () => {
    const group = { id: 'g1', name: 'Group 1', isCollapsed: false, updatedAt: 0, items: [] };
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
      id: 'g1', name: 'Group 1', isCollapsed: false, updatedAt: 0,
      items: [{ id: 'chat:1', type: 'chat', chat: { id: '1', title: 'Chat 1', updatedAt: 0, groupId: 'g1' } }]
    };
    mockChatGroups.value = [group1];
    mockChats.value = [{ id: '1', title: 'Chat 1', updatedAt: 0, groupId: 'g1' }];
    mockCurrentChat.value = { id: '1', groupId: 'g1' };
    mockCurrentChatGroup.value = null;

    mount(Sidebar, { global: { plugins: [router], stubs: globalStubs } });
    await nextTick();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));

    expect(mockOpenChatGroup).toHaveBeenCalledWith('g1');
  });

  it('correctly navigates down through multiple groups and chats', async () => {
    const chat1: ChatSummary = { id: 'c1', title: 'C1', updatedAt: 0 };
    mockChatGroups.value = [
      { id: 'g1', name: 'G1', isCollapsed: true, updatedAt: 0, items: [] },
      { id: 'g2', name: 'G2', isCollapsed: true, updatedAt: 0, items: [] }
    ];
    mockChats.value = [chat1];
    mockCurrentChatGroup.value = { id: 'g1' };
    mockCurrentChat.value = null;

    mount(Sidebar, { global: { plugins: [router], stubs: globalStubs } });
    await nextTick();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(mockOpenChatGroup).toHaveBeenCalledWith('g2');

    mockCurrentChatGroup.value = { id: 'g2' };
    await nextTick();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(mockOpenChat).toHaveBeenCalledWith('c1');
  });

  it('recovers navigation when current item is hidden (e.g. parent collapsed)', async () => {
    mockChatGroups.value = [
      {
        id: 'g1', name: 'G1', isCollapsed: true, updatedAt: 0,
        items: [{ id: 'chat:hidden', type: 'chat', chat: { id: 'hidden', title: 'Hidden', updatedAt: 0, groupId: 'g1' } }]
      },
      { id: 'g2', name: 'G2', isCollapsed: true, updatedAt: 0, items: [] }
    ];
    mockCurrentChat.value = { id: 'hidden', groupId: 'g1' };
    mockCurrentChatGroup.value = null;

    mount(Sidebar, { global: { plugins: [router], stubs: globalStubs } });
    await nextTick();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(mockOpenChatGroup).toHaveBeenCalledWith('g2');
  });

  it('handles rapid navigation correctly despite store update lags', async () => {
    const group1: ChatGroup = { id: 'g1', name: 'G1', isCollapsed: false, updatedAt: 0, items: [] };
    const group2: ChatGroup = { id: 'g2', name: 'G2', isCollapsed: false, updatedAt: 0, items: [] };
    const chat1: ChatSummary = { id: 'c1', title: 'C1', updatedAt: 0, groupId: 'g1' };
    const chat2: ChatSummary = { id: 'c2', title: 'C2', updatedAt: 0, groupId: 'g2' };
    const chat3: ChatSummary = { id: 'c3', title: 'C3', updatedAt: 0, groupId: 'g2' };

    group1.items = [{ id: 'chat:c1', type: 'chat', chat: chat1 }];
    group2.items = [{ id: 'chat:c2', type: 'chat', chat: chat2 }, { id: 'chat:c3', type: 'chat', chat: chat3 }];

    mockChatGroups.value = [group1, group2];
    mockChats.value = [chat1, chat2, chat3];
    mockCurrentChat.value = { id: 'c1', groupId: 'g1' };
    mockCurrentChatGroup.value = null;

    mount(Sidebar, { global: { plugins: [router], stubs: globalStubs } });
    await nextTick();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(mockOpenChatGroup).toHaveBeenCalledWith('g2');

    mockCurrentChatGroup.value = { id: 'g2' };
    await nextTick();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(mockOpenChat).toHaveBeenCalledWith('c2');

    mockCurrentChatGroup.value = null;
    await nextTick();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));

    expect(mockOpenChat).toHaveBeenCalledWith('c3');
    expect(mockOpenChatGroup).toHaveBeenCalledTimes(1);
  });

  it('triggers scrollIntoView when chat is selected', async () => {
    const scrollMock = vi.fn();
    const elementMock = { scrollIntoView: scrollMock };
    vi.spyOn(document, 'querySelector').mockReturnValue(elementMock as any);

    mockCurrentChat.value = { id: '1' };
    mount(Sidebar, { global: { plugins: [router], stubs: globalStubs } });

    await nextTick();
    vi.advanceTimersByTime(150);

    expect(scrollMock).toHaveBeenCalledWith({ behavior: 'smooth', block: 'nearest' });
    vi.restoreAllMocks();
  });

  it('triggers scrollIntoView when group is selected', async () => {
    const scrollMock = vi.fn();
    const elementMock = { scrollIntoView: scrollMock };
    vi.spyOn(document, 'querySelector').mockReturnValue(elementMock as any);

    mockCurrentChatGroup.value = { id: 'g1' };
    mount(Sidebar, { global: { plugins: [router], stubs: globalStubs } });

    await nextTick();
    vi.advanceTimersByTime(150);

    expect(scrollMock).toHaveBeenCalledWith({ behavior: 'smooth', block: 'nearest' });
    vi.restoreAllMocks();
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
