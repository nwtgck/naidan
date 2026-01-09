import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import Sidebar from './Sidebar.vue';
import { createRouter, createWebHistory } from 'vue-router';
import { ref, computed, nextTick } from 'vue';
import type { ChatGroup, ChatSummary, SidebarItem } from '../models/types';

// Use refs that we can control
const mockGroups = ref<ChatGroup[]>([]);
const mockChats = ref<ChatSummary[]>([]);

// buildSidebarItems logic simplified for testing
const mockSidebarItems = computed<SidebarItem[]>(() => {
  const items: SidebarItem[] = [];
  mockGroups.value.forEach(g => items.push({ id: `group:${g.id}`, type: 'group', group: g }));
  mockChats.value.filter(c => !c.groupId).forEach(c => items.push({ id: `chat:${c.id}`, type: 'chat', chat: c }));
  return items;
});

vi.mock('../composables/useChat', () => ({
  useChat: () => ({
    groups: mockGroups,
    chats: mockChats,
    sidebarItems: mockSidebarItems,
    currentChat: ref(null),
    lastDeletedChat: ref(null),
    streaming: ref(false),
    loadChats: vi.fn().mockImplementation(() => {
        // Sync items when loaded
    }),
    persistSidebarStructure: vi.fn(),
    toggleGroupCollapse: vi.fn(),
  })
}));

vi.mock('../composables/useTheme', () => ({
  useTheme: () => ({
    themeMode: ref('dark'),
    setTheme: vi.fn(),
  })
}));

vi.mock('../composables/useGlobalEvents', () => ({
  useGlobalEvents: () => ({
    events: ref([]),
    eventCount: ref(0),
    errorCount: ref(0),
    addEvent: vi.fn(),
    addErrorEvent: vi.fn(),
    addInfoEvent: vi.fn(),
    clearEvents: vi.fn(),
  })
}));

// Mock draggable component
vi.mock('vuedraggable', () => ({
  default: {
    name: 'draggable',
    template: '<div class="draggable-mock"><slot name="item" v-for="element in modelValue" :element="element"></slot></div>',
    props: ['modelValue']
  }
}));

interface SidebarComponent {
  sidebarItemsLocal: SidebarItem[];
  isDragging: boolean;
  syncLocalItems: () => void;
}

describe('Sidebar Logic Stability', () => {
  const router = createRouter({
    history: createWebHistory(),
    routes: [{ path: '/', component: { template: 'div' } }],
  });

  beforeEach(() => {
    mockGroups.value = [];
    mockChats.value = [{ id: '1', title: 'Initial Chat', updatedAt: 0 }];
    vi.clearAllMocks();
  });

  it('should not update sidebarItemsLocal while dragging to prevent SortableJS crashes', async () => {
    const wrapper = mount(Sidebar, {
      global: {
        plugins: [router],
        stubs: {
          'lucide-vue-next': true,
          'Logo': true
        }
      }
    });

    const vm = wrapper.vm as unknown as SidebarComponent;

    // 1. Initial state
    await nextTick();
    vm.syncLocalItems(); // Manually sync for testing
    await nextTick();
    
    expect(vm.sidebarItemsLocal).toHaveLength(1);
    expect(vm.sidebarItemsLocal[0]?.type).toBe('chat');
    if (vm.sidebarItemsLocal[0]?.type === 'chat') {
      expect(vm.sidebarItemsLocal[0].chat.title).toBe('Initial Chat');
    }

    // 2. Simulate drag start
    vm.isDragging = true;

    // 3. Simulate an external data update (e.g. a new group added)
    mockGroups.value = [{ id: 'g1', name: 'New Group', isCollapsed: false, updatedAt: 0, items: [] }];
    await nextTick();

    // 4. Verification: sidebarItemsLocal should NOT have changed yet
    expect(vm.sidebarItemsLocal).toHaveLength(1);
    if (vm.sidebarItemsLocal[0]?.type === 'chat') {
      expect(vm.sidebarItemsLocal[0].chat.title).toBe('Initial Chat');
    }

    // 5. Simulate drag end
    vm.isDragging = false;
    vm.syncLocalItems();
    await nextTick();
    
    // Now it should finally reflect the change
    expect(vm.sidebarItemsLocal).toHaveLength(2);
  });

  it('should apply the .handle class to both groups and chats for drag-and-drop', async () => {
    mockGroups.value = [{ id: 'g1', name: 'Group', isCollapsed: false, updatedAt: 0, items: [] }];
    mockChats.value = [{ id: 'c1', title: 'Chat', updatedAt: 0 }];
    
    const wrapper = mount(Sidebar, {
      global: {
        plugins: [router],
        stubs: {
          'lucide-vue-next': true,
          'Logo': true
        }
      }
    });

    const vm = wrapper.vm as unknown as SidebarComponent;
    vm.syncLocalItems();
    await nextTick();

    // Verify group has handle
    const groupItem = wrapper.find('[data-testid="group-item"]');
    if (!groupItem.exists()) {
        console.log('DOM:', wrapper.html());
    }
    expect(groupItem.classes()).toContain('handle');

    // Verify chat has handle
    const chatItems = wrapper.findAll('[data-testid="sidebar-chat-item"]');
    expect(chatItems.length).toBeGreaterThan(0);
    chatItems.forEach(item => {
      expect(item.classes()).toContain('handle');
    });
  });
});
