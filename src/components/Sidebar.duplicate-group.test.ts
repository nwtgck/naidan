import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import Sidebar from './Sidebar.vue';
import ChatGroupActions from './ChatGroupActions.vue';
import { createRouter, createWebHistory } from 'vue-router';
import { ref, computed, nextTick, reactive } from 'vue';
import type { ChatGroup, ChatSummary, SidebarItem } from '../models/types';

const mockChatGroups = ref<ChatGroup[]>([]);
const mockChats = ref<ChatSummary[]>([]);
const mockDuplicateChatGroup = vi.fn();

vi.mock('../composables/useLayout', () => ({
  useLayout: () => ({
    isSidebarOpen: ref(true),
    activeFocusArea: ref('chat'),
    setActiveFocusArea: vi.fn(),
    toggleSidebar: vi.fn(),
  }),
}));

vi.mock('../composables/useChat', () => ({
  useChat: () => ({
    currentChat: ref(null),
    currentChatGroup: ref(null),
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
    loadChats: vi.fn(),
    createChatGroup: vi.fn(),
    duplicateChatGroup: mockDuplicateChatGroup,
    deleteChatGroup: vi.fn(),
    openChat: vi.fn(),
    openChatGroup: vi.fn(),
    setChatGroupCollapsed: vi.fn(),
    persistSidebarStructure: vi.fn(),
    isTaskRunning: vi.fn().mockReturnValue(false),
    isProcessing: vi.fn().mockReturnValue(false),
    abortChat: vi.fn(),
  }),
}));

vi.mock('../composables/useSettings', () => ({
  useSettings: () => ({
    settings: ref({ endpointUrl: 'http://localhost', defaultModelId: 'm1' }),
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
    setTheme: vi.fn(),
  }),
}));

vi.mock('vuedraggable', () => ({
  default: {
    name: 'draggable',
    template: '<div class="draggable-mock"><slot name="item" v-for="element in modelValue" :element="element"></slot></div>',
    props: ['modelValue'],
  },
}));

describe('Sidebar Duplicate Group Feature', () => {
  const router = createRouter({
    history: createWebHistory(),
    routes: [{ path: '/', component: { template: 'div' } }],
  });

  beforeEach(() => {
    mockChatGroups.value = [{ id: 'g1', name: 'Original Group', isCollapsed: false, updatedAt: 0, items: [] }];
    mockChats.value = [];
    vi.clearAllMocks();
  });

  it('should call duplicateChatGroup when duplicate button is clicked', async () => {
    const wrapper = mount(Sidebar, {
      global: {
        plugins: [router],
        stubs: {
          'lucide-vue-next': true,
          'Logo': true,
          'ThemeToggle': true,
          'ModelSelector': true,
          'ChatGroupActions': ChatGroupActions
        },
      },
    });

    const vm = wrapper.vm as any;
    vm.syncLocalItems();
    await nextTick();

    // Click more actions first
    const moreBtn = wrapper.find('[data-testid="group-more-actions"]');
    expect(moreBtn.exists()).toBe(true);
    await moreBtn.trigger('click');

    // Need to trigger hover or something if it was hidden by opacity-0,
    // but in test-utils we can just find it.
    const duplicateBtn = wrapper.find('[data-testid="duplicate-group-button"]');
    expect(duplicateBtn.exists()).toBe(true);

    await duplicateBtn.trigger('click');
    expect(mockDuplicateChatGroup).toHaveBeenCalledWith('g1');
  });
});
