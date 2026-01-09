import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import Sidebar from './Sidebar.vue';
import { createRouter, createWebHistory } from 'vue-router';
import { ref, computed } from 'vue';
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
    loadChats: vi.fn(),
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
    template: '<div><slot name="item" v-for="item in modelValue" :element="item"></slot></div>',
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
          'Logo': true,
          'draggable': true
        }
      }
    });

    const vm = wrapper.vm as unknown as SidebarComponent;

    // 1. Initial state
    await wrapper.vm.$nextTick();
    expect(vm.sidebarItemsLocal).toHaveLength(1);
    expect(vm.sidebarItemsLocal[0]?.type).toBe('chat');
    if (vm.sidebarItemsLocal[0]?.type === 'chat') {
      expect(vm.sidebarItemsLocal[0].chat.title).toBe('Initial Chat');
    }

    // 2. Simulate drag start
    vm.isDragging = true;

    // 3. Simulate an external data update (e.g. a new group added)
    mockGroups.value = [{ id: 'g1', name: 'New Group', isCollapsed: false, updatedAt: 0, items: [] }];
    await wrapper.vm.$nextTick();

    // 4. Verification: sidebarItemsLocal should NOT have changed yet
    expect(vm.sidebarItemsLocal).toHaveLength(1);
    if (vm.sidebarItemsLocal[0]?.type === 'chat') {
      expect(vm.sidebarItemsLocal[0].chat.title).toBe('Initial Chat');
    }

    // 5. Simulate drag end
    vm.isDragging = false;
    vm.syncLocalItems();
    
    // Now it should finally reflect the change
    expect(vm.sidebarItemsLocal).toHaveLength(2);
  });
});