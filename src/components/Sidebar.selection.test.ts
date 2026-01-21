import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import Sidebar from './Sidebar.vue';
import { createRouter, createWebHistory } from 'vue-router';
import { ref, computed, nextTick, reactive } from 'vue';
import type { ChatGroup, ChatSummary, SidebarItem } from '../models/types';

const mockChatGroups = ref<ChatGroup[]>([]);
const mockChats = ref<ChatSummary[]>([]);
const mockCurrentChat = ref<any>(null);
const mockCurrentChatGroup = ref<any>(null);

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
      mockChatGroups.value.forEach(g => items.push({ id: `chat_group:${g.id}`, type: 'chat_group', chatGroup: g }));
      mockChats.value.filter(c => !c.groupId).forEach(c => items.push({ id: `chat:${c.id}`, type: 'chat', chat: c }));
      return items;
    }),
    openChatGroup: vi.fn((id) => {
      if (id === null) mockCurrentChatGroup.value = null;
      else mockCurrentChatGroup.value = mockChatGroups.value.find(g => g.id === id);
    }),
    openChat: vi.fn((id) => {
      mockCurrentChatGroup.value = null;
      mockCurrentChat.value = mockChats.value.find(c => c.id === id);
    }),
    isTaskRunning: vi.fn().mockReturnValue(false),
    isProcessing: vi.fn().mockReturnValue(false),
    persistSidebarStructure: vi.fn(),
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

vi.mock('../composables/useConfirm', () => ({
  useConfirm: () => ({
    showConfirm: vi.fn(),
  }),
}));

vi.mock('../composables/useTheme', () => ({
  useTheme: () => ({
    themeMode: ref('dark'),
  }),
}));

vi.mock('vuedraggable', () => ({
  default: {
    name: 'draggable',
    template: '<div class="draggable-mock"><slot name="item" v-for="element in modelValue" :element="element"></slot></div>',
    props: ['modelValue'],
  },
}));

describe('Sidebar Selection State', () => {
  const router = createRouter({
    history: createWebHistory(),
    routes: [{ path: '/', component: { template: 'div' } }],
  });

  const globalStubs = {
    'lucide-vue-next': true,
    'Logo': true,
    'ThemeToggle': true,
    'ModelSelector': true,
  };

  beforeEach(() => {
    mockChatGroups.value = [
      { id: 'g1', name: 'Group 1', isCollapsed: false, updatedAt: 0, items: [] }
    ];
    mockChats.value = [
      { id: 'c1', title: 'Chat 1', updatedAt: 0 }
    ];
    mockCurrentChat.value = null;
    mockCurrentChatGroup.value = null;
    vi.clearAllMocks();
  });

  it('should not show chat as selected when a chat group is selected', async () => {
    const wrapper = mount(Sidebar, {
      global: { plugins: [router], stubs: globalStubs },
    });

    // 1. Select a chat
    mockCurrentChat.value = mockChats.value[0];
    await nextTick();
    
    let chatItem = wrapper.find('[data-testid="sidebar-chat-item-c1"]');
    expect(chatItem.classes()).toContain('bg-blue-50');

    // 2. Select a chat group
    mockCurrentChatGroup.value = mockChatGroups.value[0];
    await nextTick();

    const groupItem = wrapper.find('[data-testid="chat-group-item"]');
    expect(groupItem.classes()).toContain('bg-blue-50');

    // THE BUG: Both are currently selected
    chatItem = wrapper.find('[data-testid="sidebar-chat-item-c1"]');
    expect(chatItem.classes()).not.toContain('bg-blue-50'); 
  });
});
