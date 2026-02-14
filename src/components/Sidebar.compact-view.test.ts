import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import Sidebar from './Sidebar.vue';
import { createRouter, createWebHistory } from 'vue-router';
import { ref, computed, nextTick, reactive } from 'vue';
import type { ChatGroup, ChatSummary, SidebarItem } from '../models/types';

const mockChatGroups = ref<ChatGroup[]>([]);
const mockChats = ref<ChatSummary[]>([]);
const mockCurrentChat = ref<any>(null);
const mockSettings = reactive({
  endpointUrl: 'http://localhost:11434',
  defaultModelId: 'llama3',
});
const mockAvailableModels = ref(['llama3']);
const mockIsFetchingModels = ref(false);

const mockOpenChat = vi.fn();
const mockOpenChatGroup = vi.fn();
const mockSetChatGroupCollapsed = vi.fn();
const mockPersistSidebarStructure = vi.fn();

vi.mock('../composables/useLayout', () => ({
  useLayout: () => ({
    isSidebarOpen: ref(true),
    activeFocusArea: ref('sidebar'),
    setActiveFocusArea: vi.fn(),
    toggleSidebar: vi.fn(),
  }),
}));

vi.mock('../composables/useChat', () => ({
  useChat: () => ({
    currentChat: mockCurrentChat,
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
    renameChatGroup: vi.fn(),
    deleteChatGroup: vi.fn(),
    openChat: mockOpenChat,
    openChatGroup: mockOpenChatGroup,
    setChatGroupCollapsed: mockSetChatGroupCollapsed,
    persistSidebarStructure: mockPersistSidebarStructure,
    isTaskRunning: vi.fn().mockReturnValue(false),
    isProcessing: vi.fn().mockReturnValue(false),
    abortChat: vi.fn(),
  }),
}));

vi.mock('../composables/useSettings', () => ({
  useSettings: () => ({
    settings: ref(mockSettings),
    availableModels: mockAvailableModels,
    isFetchingModels: mockIsFetchingModels,
    save: vi.fn(),
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

// Better mock for draggable to test v-model / @update:model-value
vi.mock('vuedraggable', () => ({
  default: {
    name: 'draggable',
    template: '<div class="draggable-mock" v-bind="$attrs"><slot name="item" v-for="element in modelValue" :element="element"></slot></div>',
    props: ['modelValue'],
    emits: ['update:modelValue', 'start', 'end'],
    inheritAttrs: false
  },
}));

describe('Sidebar Compact View & DND Integrity', () => {
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
    mockChatGroups.value = [];
    mockChats.value = [];
    mockCurrentChat.value = null;
    vi.clearAllMocks();
  });

  it('initially shows only 5 items in a group with 7 items', async () => {
    const groupItems: SidebarItem[] = Array.from({ length: 7 }, (_, i) => ({
      id: `chat-${i}`,
      type: 'chat',
      chat: { id: `c${i}`, title: `Chat ${i}`, updatedAt: 0, groupId: 'g1' }
    }));

    mockChatGroups.value = [{
      id: 'g1',
      name: 'Big Group',
      isCollapsed: false,
      updatedAt: 0,
      items: groupItems
    }];

    const wrapper = mount(Sidebar, {
      global: { plugins: [router], stubs: globalStubs },
    });

    // @ts-expect-error - internal method
    wrapper.vm.syncLocalItems();
    await nextTick();

    const chatItems = wrapper.findAll('.sidebar-chat-item');
    expect(chatItems).toHaveLength(5);

    const showMoreBtn = wrapper.find('[data-testid="show-more-button"]');
    expect(showMoreBtn.exists()).toBe(true);
    expect(showMoreBtn.text()).toContain('Show 2 more');
  });

  it('shows all items when "Show more" is clicked', async () => {
    const groupItems: SidebarItem[] = Array.from({ length: 7 }, (_, i) => ({
      id: `chat-${i}`,
      type: 'chat',
      chat: { id: `c${i}`, title: `Chat ${i}`, updatedAt: 0, groupId: 'g1' }
    }));

    mockChatGroups.value = [{
      id: 'g1',
      name: 'Big Group',
      isCollapsed: false,
      updatedAt: 0,
      items: groupItems
    }];

    const wrapper = mount(Sidebar, {
      global: { plugins: [router], stubs: globalStubs },
    });

    // @ts-expect-error - internal method
    wrapper.vm.syncLocalItems();
    await nextTick();

    await wrapper.find('[data-testid="show-more-button"]').trigger('click');
    await nextTick();

    const chatItems = wrapper.findAll('.sidebar-chat-item');
    expect(chatItems).toHaveLength(7);
  });

  it('maintains full list integrity when reordering items in compact view', async () => {
    const groupItems: SidebarItem[] = Array.from({ length: 10 }, (_, i) => ({
      id: `chat-${i}`,
      type: 'chat',
      chat: { id: `c${i}`, title: `Chat ${i}`, updatedAt: 0, groupId: 'g1' }
    }));

    mockChatGroups.value = [{
      id: 'g1',
      name: 'Big Group',
      isCollapsed: false,
      updatedAt: 0,
      items: groupItems
    }];

    const wrapper = mount(Sidebar, {
      global: { plugins: [router], stubs: globalStubs },
    });

    // @ts-expect-error - internal method
    wrapper.vm.syncLocalItems();
    await nextTick();

    // In compact view, we see chats 0-4.
    // Let's simulate reversing them via DND: 4, 3, 2, 1, 0
    const visibleSubList = groupItems.slice(0, 5);
    const reversedSubList = [...visibleSubList].reverse();

    // Find the nested draggable for group g1
    const groupDraggable = wrapper.findComponent('[data-testid="nested-draggable"]');
    expect(groupDraggable.exists()).toBe(true);

    // Emit the update (simulating SortableJS change)
    await (groupDraggable as any).vm.$emit('update:modelValue', reversedSubList);

    // Verify the full list in sidebarItemsLocal
    // @ts-expect-error - accessing reactive state
    const localItems = wrapper.vm.sidebarItemsLocal;
    const group = localItems.find((i: any) => i.id === 'g1').chatGroup;

    // The first 5 should be reversed, the remaining 5 (5-9) should remain intact
    expect(group.items.slice(0, 5).map((i: any) => i.id)).toEqual(reversedSubList.map(i => i.id));
    expect(group.items.slice(5).map((i: any) => i.id)).toEqual(groupItems.slice(5).map(i => i.id));
    expect(group.items).toHaveLength(10);
  });

  it('resets expansion state when group is collapsed', async () => {
    const groupItems: SidebarItem[] = Array.from({ length: 7 }, (_, i) => ({
      id: `chat-${i}`,
      type: 'chat',
      chat: { id: `c${i}`, title: `Chat ${i}`, updatedAt: 0, groupId: 'g1' }
    }));

    const group = {
      id: 'g1',
      name: 'Big Group',
      isCollapsed: false,
      updatedAt: 0,
      items: groupItems
    };
    mockChatGroups.value = [group];

    const wrapper = mount(Sidebar, {
      global: { plugins: [router], stubs: globalStubs },
    });

    // @ts-expect-error - internal method
    wrapper.vm.syncLocalItems();
    await nextTick();

    // Expand
    await wrapper.find('[data-testid="show-more-button"]').trigger('click');
    expect(wrapper.findAll('.sidebar-chat-item')).toHaveLength(7);

    // Collapse group
    // @ts-expect-error - internal method
    wrapper.vm.handleToggleChatGroupCollapse(group);
    await nextTick();

    // Open group again
    // @ts-expect-error - internal method
    wrapper.vm.handleToggleChatGroupCollapse(group);
    await nextTick();

    // Should be back to compact view
    expect(wrapper.findAll('.sidebar-chat-item')).toHaveLength(5);
  });

  it('handles keyboard navigation: ArrowRight on expand button expands and selects 6th item', async () => {
    const groupItems: SidebarItem[] = Array.from({ length: 7 }, (_, i) => ({
      id: `chat-${i}`,
      type: 'chat',
      chat: { id: `c${i}`, title: `Chat ${i}`, updatedAt: 0, groupId: 'g1' }
    }));

    mockChatGroups.value = [{
      id: 'g1',
      name: 'Big Group',
      isCollapsed: false,
      updatedAt: 0,
      items: groupItems
    }];

    const wrapper = mount(Sidebar, {
      global: { plugins: [router], stubs: globalStubs },
    });

    // @ts-expect-error - internal method
    wrapper.vm.syncLocalItems();
    await nextTick();

    // Set focus area to sidebar
    // @ts-expect-error - internal method
    wrapper.vm.setActiveFocusArea('sidebar');

    // Simulate selecting the expand button via lastNavigatedId
    // @ts-expect-error - internal state
    wrapper.vm.lastNavigatedId = 'expand-g1';
    await nextTick();

    // Trigger ArrowRight
    const event = new KeyboardEvent('keydown', { key: 'ArrowRight' });
    window.dispatchEvent(event);

    await nextTick(); // wait for toggle
    await nextTick(); // wait for nextTick in onKeyStroke

    // Should be expanded
    expect(wrapper.findAll('.sidebar-chat-item')).toHaveLength(7);

    // Should have navigated to 6th item (c5)
    expect(mockOpenChat).toHaveBeenCalledWith('c5');
  });

  it('handles keyboard navigation: ArrowLeft on chat item jumps to group header', async () => {
    const groupItems: SidebarItem[] = [{
      id: 'chat-0',
      type: 'chat',
      chat: { id: 'c0', title: 'Chat 0', updatedAt: 0, groupId: 'g1' }
    }];

    mockChatGroups.value = [{
      id: 'g1',
      name: 'Group 1',
      isCollapsed: false,
      updatedAt: 0,
      items: groupItems
    }];

    // Set current chat to c0
    mockCurrentChat.value = { id: 'c0', groupId: 'g1' };

    const wrapper = mount(Sidebar, {
      global: { plugins: [router], stubs: globalStubs },
    });

    // @ts-expect-error - internal method
    wrapper.vm.syncLocalItems();
    await nextTick();

    // @ts-expect-error - internal method
    wrapper.vm.setActiveFocusArea('sidebar');

    // Trigger ArrowLeft
    const event = new KeyboardEvent('keydown', { key: 'ArrowLeft' });
    window.dispatchEvent(event);

    await nextTick();

    expect(mockOpenChatGroup).toHaveBeenCalledWith('g1');
  });
});