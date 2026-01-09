import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import Sidebar from './Sidebar.vue';
import { createRouter, createWebHistory } from 'vue-router';
import { ref, computed } from 'vue';

// Use refs that we can control
const mockGroups = ref<any[]>([]);
const mockChats = ref<any[]>([]);

// buildSidebarItems logic simplified for testing
const mockSidebarItems = computed(() => {
  const items: any[] = [];
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

// Mock draggable component
vi.mock('vuedraggable', () => ({
  default: {
    name: 'draggable',
    template: '<div><slot name="item" v-for="item in modelValue" :element="item"></slot></div>',
    props: ['modelValue']
  }
}));

describe('Sidebar Logic Stability', () => {
  const router = createRouter({
    history: createWebHistory(),
    routes: [{ path: '/', component: { template: 'div' } }],
  });

  beforeEach(() => {
    mockGroups.value = [];
    mockChats.value = [{ id: '1', title: 'Initial Chat' }];
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

    // 1. Initial state
    await wrapper.vm.$nextTick();
    expect((wrapper.vm as any).sidebarItemsLocal).toHaveLength(1);
    expect((wrapper.vm as any).sidebarItemsLocal[0].chat.title).toBe('Initial Chat');

    // 2. Simulate drag start
    (wrapper.vm as any).isDragging = true;

    // 3. Simulate an external data update (e.g. a new group added)
    mockGroups.value = [{ id: 'g1', name: 'New Group', items: [] }];
    await wrapper.vm.$nextTick();

    // 4. Verification: sidebarItemsLocal should NOT have changed yet
    // This stability is what prevents the SortableJS error
    expect((wrapper.vm as any).sidebarItemsLocal).toHaveLength(1);
    expect((wrapper.vm as any).sidebarItemsLocal[0].chat.title).toBe('Initial Chat');

    // 5. Simulate drag end
    (wrapper.vm as any).isDragging = false;
    (wrapper.vm as any).syncLocalItems();
    
    // Now it should finally reflect the change
    expect((wrapper.vm as any).sidebarItemsLocal).toHaveLength(2);
  });
});