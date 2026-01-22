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
    props: [
      'modelValue', 'itemKey', 'ghostClass', 'swapThreshold', 'invertSwap',
      'scroll', 'scrollSensitivity', 'scrollSpeed', 'forceFallback', 'fallbackClass'
    ],
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
      setChatGroupCollapsed: vi.fn(),
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
      
  it('should have auto-scroll settings enabled on all draggables', async () => {
    const wrapper = mount(Sidebar, { global: { plugins: [router] } });
    await nextTick();
    const draggables = wrapper.findAllComponents({ name: 'draggable' });
    expect(draggables.length).toBeGreaterThan(0);
    draggables.forEach(d => {
      expect(d.props('scroll')).toBe(true);
      expect(d.props('scrollSensitivity')).toBe(100);
      expect(d.props('scrollSpeed')).toBe(20);
    });
  });
      
  it('should use force-fallback for consistent drag appearance on all draggables', async () => {
    const wrapper = mount(Sidebar, { global: { plugins: [router] } });
    await nextTick();
    const draggables = wrapper.findAllComponents({ name: 'draggable' });
    draggables.forEach(d => {
      expect(d.props('forceFallback')).toBe(true);
    });
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
    expect(mockChatStore.setChatGroupCollapsed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(600);
    expect(mockChatStore.setChatGroupCollapsed).toHaveBeenCalledWith({ groupId: 'g1', isCollapsed: false });
    vi.useRealTimers();
  });
      
  it('should NOT auto-expand collapsed groups when a chat inside them is selected', async () => {
    vi.useFakeTimers();
    mount(Sidebar, { global: { plugins: [router] } });
    const group = { id: 'g1', name: 'Group 1', items: [{ id: 'c1', type: 'chat', chat: { id: 'c1' } }], isCollapsed: true };
    mockChatStore.chatGroups.value = [group];
    mockChatStore.sidebarItems.value = [{ type: 'chat_group', id: 'g1', chatGroup: group }];
    mockChatStore.currentChat.value = { id: 'c1' };
    await nextTick();
    vi.advanceTimersByTime(150);
    expect(mockChatStore.setChatGroupCollapsed).not.toHaveBeenCalled();
    expect(mockChatStore.chatGroups.value[0].isCollapsed).toBe(true);
    vi.useRealTimers();
  });
      
  it('should allow toggling any group regardless of selection', async () => {
    const wrapper = mount(Sidebar, { global: { plugins: [router] } });
    await nextTick();
          
    // Find the toggle button for the first group
    const toggleButton = wrapper.find('[data-testid="chat-group-item"] button');
    await toggleButton.trigger('click');
          
    expect(mockChatStore.setChatGroupCollapsed).toHaveBeenCalledWith({ groupId: 'g1', isCollapsed: false });
  });
  it('should scroll to active chat item when selected', async () => {
    
    vi.useFakeTimers();
    const scrollSpy = vi.fn();
    const querySpy = vi.spyOn(document, 'querySelector').mockReturnValue({
      scrollIntoView: scrollSpy
    } as any);

    mount(Sidebar, { global: { plugins: [router] } });
    mockChatStore.currentChat.value = { id: 'chat-scroll-test' };
    
    await nextTick(); // watch triggered
    await nextTick(); // await nextTick() inside watcher
    vi.advanceTimersByTime(150); // setTimeout

    expect(querySpy).toHaveBeenCalledWith('[data-testid="sidebar-chat-item-chat-scroll-test"]');
    expect(scrollSpy).toHaveBeenCalledWith({ behavior: 'smooth', block: 'nearest' });
    
    querySpy.mockRestore();
    vi.useRealTimers();
  });
});
    