import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref, nextTick } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import Sidebar from './Sidebar.vue';
import { useChat } from '../composables/useChat';
import { useSettings } from '../composables/useSettings';
import { useLayout } from '../composables/useLayout';

vi.mock('../composables/useChat');
vi.mock('../composables/useSettings');
vi.mock('../composables/useLayout');
vi.mock('vuedraggable', () => ({
  default: {
    name: 'draggable',
    template: `
      <div class="draggable-stub">
        <div v-for="item in modelValue" :key="item.id || item.type">
          <slot name="item" :element="item"></slot>
        </div>
      </div>
    `,
    props: ['modelValue', 'itemKey', 'ghostClass', 'swapThreshold', 'invertSwap'],
  }
}));

const router = createRouter({
  history: createWebHistory(),
  routes: [{ path: '/', component: { template: '<div></div>' } }],
});

describe('Sidebar DND Improvements', () => {
  let mockChatStore: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockChatStore = {
      currentChat: ref(null),
      currentChatGroup: ref(null),
      sidebarItems: ref([
        { type: 'chat_group', id: 'g1', chatGroup: { id: 'g1', name: 'Group 1', items: [], isCollapsed: true } }
      ]),
      chatGroups: ref([{ id: 'g1', name: 'Group 1', items: [], isCollapsed: true }]),
      chats: ref([]),
      isProcessing: vi.fn().mockReturnValue(false),
      openChatGroup: vi.fn(),
      toggleChatGroupCollapse: vi.fn(),
      persistSidebarStructure: vi.fn(),
    };
    (useChat as any).mockReturnValue(mockChatStore);
    (useSettings as any).mockReturnValue({ settings: ref({}), isFetchingModels: ref(false) });
    (useLayout as any).mockReturnValue({ isSidebarOpen: ref(true), toggleSidebar: vi.fn() });
  });

  it('should use sortable-ghost class for drag visualization', async () => {
    const wrapper = mount(Sidebar, { global: { plugins: [router] } });
    await nextTick();
    const draggable = wrapper.findComponent({ name: 'draggable' });
    expect(draggable.props('ghostClass')).toBe('sortable-ghost');
  });

  it('should have correct swap settings for intuitive nesting', async () => {
    const wrapper = mount(Sidebar, { global: { plugins: [router] } });
    await nextTick();
    const draggable = wrapper.findComponent({ name: 'draggable' });
    expect(draggable.props('swapThreshold')).toBe(0.5);
    expect(draggable.props('invertSwap')).toBe(true);
  });

  it('should increase bottom padding during drag for easier end-of-list drops', async () => {
    const wrapper = mount(Sidebar, { global: { plugins: [router] } });
    await nextTick();
    const mainDraggable = wrapper.find('.draggable-stub');
    expect(mainDraggable.attributes('class')).toContain('pb-4');
    (wrapper.vm as any).isDragging = true;
    await nextTick();
    expect(mainDraggable.attributes('class')).toContain('pb-32');
  });

  it('should apply highlight class when dragging over a group', async () => {
    const wrapper = mount(Sidebar, { global: { plugins: [router] } });
    await nextTick();
    (wrapper.vm as any).isDragging = true;
    await nextTick();
    const groupItem = wrapper.find('[data-testid="chat-group-item"]');
    await groupItem.trigger('dragover');
    expect(groupItem.attributes('class')).toContain('ring-2');
    expect(groupItem.attributes('class')).toContain('ring-blue-500/50');
    await groupItem.trigger('dragleave');
    expect(groupItem.attributes('class')).not.toContain('ring-2');
  });

  it('should auto-expand collapsed group after hover delay', async () => {
    vi.useFakeTimers();
    const wrapper = mount(Sidebar, { global: { plugins: [router] } });
    await nextTick();
    (wrapper.vm as any).isDragging = true;
    await nextTick();
    const groupItem = wrapper.find('[data-testid="chat-group-item"]');
    await groupItem.trigger('dragover');
    expect(mockChatStore.toggleChatGroupCollapse).not.toHaveBeenCalled();
    vi.advanceTimersByTime(600);
    expect(mockChatStore.toggleChatGroupCollapse).toHaveBeenCalledWith('g1');
    vi.useRealTimers();
  });
});