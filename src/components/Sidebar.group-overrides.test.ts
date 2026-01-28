import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import Sidebar from './Sidebar.vue';
import { createRouter, createWebHistory } from 'vue-router';
import { ref, computed, nextTick, reactive } from 'vue';
import type { ChatGroup, ChatSummary, SidebarItem } from '../models/types';

const mockChatGroups = ref<ChatGroup[]>([]);
const mockChats = ref<ChatSummary[]>([]);
const mockCurrentChatGroup = ref<ChatGroup | null>(null);
const mockOpenChatGroup = vi.fn((id: string | null) => {
  if (id === null) { mockCurrentChatGroup.value = null; return; }
  const group = mockChatGroups.value.find(g => g.id === id);
  if (group) mockCurrentChatGroup.value = group;
});
const mockSetChatGroupCollapsed = vi.fn();

vi.mock('../composables/useChat', () => ({
  useChat: () => ({
    currentChat: ref(null),
    currentChatGroup: mockCurrentChatGroup,
    streaming: ref(false),
    activeGenerations: reactive(new Map()),
    chatGroups: mockChatGroups,
    chats: mockChats,
    sidebarItems: computed<SidebarItem[]>(() => {
      const items: SidebarItem[] = [];
      mockChatGroups.value.forEach(g => items.push({ id: `chat_group:${g.id}`, type: 'chat_group', chatGroup: g }));
      mockChats.value.filter(c => !c.groupId).forEach(c => items.push({ id: `chat:${c.id}`, type: 'chat', chat: c }));
      return items;
    }),
    loadChats: vi.fn(),
    createChatGroup: vi.fn(),
    renameChatGroup: vi.fn(),
    openChat: vi.fn((_id) => {
      mockCurrentChatGroup.value = null;
    }),
    openChatGroup: mockOpenChatGroup,
    setChatGroupCollapsed: mockSetChatGroupCollapsed,
    persistSidebarStructure: vi.fn(),
    deleteAllChats: vi.fn(),
    isTaskRunning: vi.fn().mockReturnValue(false),
    isProcessing: vi.fn().mockReturnValue(false),
    abortChat: vi.fn(),
    __testOnlySetCurrentChatGroup: (val: any) => mockCurrentChatGroup.value = val,
  }),
}));

vi.mock('../composables/useSettings', () => ({
  useSettings: () => ({
    settings: ref({ endpointUrl: 'http://localhost' }),
    availableModels: ref([]),
    isFetchingModels: ref(false),
    save: vi.fn(),
  }),
}));

vi.mock('../composables/useLayout', () => ({
  useLayout: () => ({
    isSidebarOpen: ref(true),
    activeFocusArea: ref('chat'),
    setActiveFocusArea: vi.fn(),
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

describe('Sidebar Group Overrides', () => {
  const router = createRouter({
    history: createWebHistory(),
    routes: [{ path: '/', component: { template: 'div' } }, { path: '/chat-group/:id', component: { template: 'div' } }, { path: '/chat/:id', component: { template: 'div' } }],
  });

  const globalStubs = {
    'lucide-vue-next': true,
    'Logo': true,
    'ThemeToggle': true,
    'ModelSelector': true,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    mockChatGroups.value = [
      { id: 'g1', name: 'Group 1', isCollapsed: false, updatedAt: 0, items: [] }
    ];
    mockChats.value = [];
    mockCurrentChatGroup.value = null;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls handleOpenChatGroup when clicking the group title', async () => {
    const wrapper = mount(Sidebar, {
      global: { plugins: [router], stubs: globalStubs },
    });
    await nextTick();
    
    // Find the group item container
    const groupItem = wrapper.find('[data-sidebar-group-id="g1"]');
    expect(groupItem.exists()).toBe(true);
    await groupItem.trigger('click');

    expect(mockOpenChatGroup).toHaveBeenCalledWith('g1');
  });

  it('calls setChatGroupCollapsed when clicking the expansion icon', async () => {
    const wrapper = mount(Sidebar, {
      global: { plugins: [router], stubs: globalStubs },
    });
    await nextTick();
    
    // Expansion icon is inside a button
    const collapseButton = wrapper.find('button.p-1.-ml-1');
    expect(collapseButton.exists()).toBe(true);
    await collapseButton.trigger('click');

    expect(mockSetChatGroupCollapsed).toHaveBeenCalledWith({ groupId: 'g1', isCollapsed: true });
    // Ensure the parent click handler was not triggered (using .stop)
    expect(mockOpenChatGroup).not.toHaveBeenCalled();
  });

  it('applies active styling when group is selected', async () => {
    const wrapper = mount(Sidebar, {
      global: { plugins: [router], stubs: globalStubs },
    });
    
    mockCurrentChatGroup.value = mockChatGroups.value[0]!;
    await nextTick();

    const groupItem = wrapper.find('[data-sidebar-group-id="g1"]');
    expect(groupItem.classes()).toContain('bg-blue-50');
    expect(groupItem.classes()).toContain('text-blue-600');
  });

  it('clears currentChatGroup when a chat item is clicked', async () => {
    mockChats.value = [{ id: 'c1', title: 'Chat 1', updatedAt: 0 }];
    mockCurrentChatGroup.value = mockChatGroups.value[0]!;
    
    const wrapper = mount(Sidebar, {
      global: { plugins: [router], stubs: globalStubs },
    });
    await nextTick();

    const chatItem = wrapper.find('.sidebar-chat-item');
    expect(chatItem.exists()).toBe(true);
    await chatItem.trigger('click');

    expect(mockCurrentChatGroup.value).toBeNull();
  });
});
