import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref, nextTick } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import Sidebar from './Sidebar.vue';
import { useChat } from '@/composables/useChat';
import { useSettings } from '@/composables/useSettings';
import { useLayout } from '@/composables/useLayout';
import { useCurrentChatState } from '@/composables/chat/ui/useCurrentChatState';

vi.mock('../composables/useChat');
vi.mock('../composables/useSettings');
vi.mock('../composables/useLayout');
vi.mock('../composables/chat/ui/useCurrentChatState');
vi.mock('@/utils/dom', () => ({
  scrollIntoViewSafe: vi.fn(),
}));
vi.mock('vuedraggable', () => ({
  default: {
    name: 'draggable',
    template: `
      <div class="draggable-stub" :data-tag="tag" :data-animation="animation" :data-component-data="JSON.stringify(componentData)">
        <div v-for="item in modelValue" :key="item.id || item.type">
          <slot name="item" :element="item"></slot>
        </div>
      </div>
    `,
    props: [
      'modelValue', 'itemKey', 'ghostClass', 'swapThreshold', 'invertSwap',
      'scroll', 'scrollSensitivity', 'scrollSpeed', 'forceFallback', 'fallbackClass',
      'tag', 'animation', 'delay', 'delayOnTouchOnly', 'componentData', 'move',
    ],
  },
}));

const router = createRouter({
  history: createWebHistory(),
  routes: [{ path: '/', component: { template: '<div></div>' } }, { path: '/chat/:id', component: { template: '<div></div>' } }, { path: '/chat-group/:id', component: { template: '<div></div>' } }],
});

let mockChatStore: any;

vi.mock('../composables/chat/ui/useSidebarStructure', () => ({
  useSidebarStructure: () => ({
    persistSidebarStructure: mockChatStore.persistSidebarStructure,
    setChatGroupCollapsed: mockChatStore.setChatGroupCollapsed,
    TEST_ONLY: {},
  }),
}));

describe('Sidebar DND Improvements', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Individually defined mocks for scrolling as requested
    HTMLElement.prototype.scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollTo = vi.fn().mockImplementation(function(this: HTMLElement, options: any) {
      if (typeof options.top === 'number') this.scrollTop = options.top;
    });
    HTMLElement.prototype.getBoundingClientRect = vi.fn().mockReturnValue({
      top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0,
    });

    mockChatStore = {
      currentChat: ref(null),
      currentChatGroup: ref(null),
      sidebarItems: ref([
        { type: 'chat_group', id: 'g1', chatGroup: { id: 'g1', name: 'Group 1', items: [], isCollapsed: true } },
      ]),
      chatGroups: ref([{ id: 'g1', name: 'Group 1', items: [], isCollapsed: true }]),
      chats: ref([]),
      isProcessing: vi.fn().mockReturnValue(false),
      openChat: vi.fn(),
      openChatGroup: vi.fn(),
      setChatGroupCollapsed: vi.fn(),
      persistSidebarStructure: vi.fn(),
    };
    (useChat as any).mockReturnValue(mockChatStore);
    (useCurrentChatState as any).mockReturnValue({
      currentChat: mockChatStore.currentChat,
      currentChatGroup: mockChatStore.currentChatGroup,
      currentChatId: ref(undefined),
      activeMessages: ref([]),
      allMessages: ref([]),
      resolvedSettings: ref(null),
      inheritedSettings: ref(null),
      chatGroups: mockChatStore.chatGroups,
      sidebarItems: mockChatStore.sidebarItems,
      TEST_ONLY: {},
    });
    (useSettings as any).mockReturnValue({
      settings: ref({ endpoint: { type: 'openai', url: '' } }),
      isFetchingModels: ref(false),
    });
    (useLayout as any).mockReturnValue({
      isSidebarOpen: ref(true),
      activeFocusArea: ref('chat'),
      setActiveFocusArea: vi.fn(),
      toggleSidebar: vi.fn(),
    });
  });

  it('keeps sortable reordering instant during drag', async () => {
    const wrapper = mount(Sidebar, { global: { plugins: [router] } });
    await nextTick();
    const draggables = wrapper.findAllComponents({ name: 'draggable' });
    draggables.forEach(d => {
      expect(d.props('animation')).toBe(0);
    });
  });

  it('uses stable div roots so cross-list drag and drop keeps working', async () => {
    const wrapper = mount(Sidebar, { global: { plugins: [router] } });
    await nextTick();
    const draggables = wrapper.findAllComponents({ name: 'draggable' });
    draggables.forEach(d => {
      expect(d.props('tag')).toBe('div');
    });
  });

  it('allows chats to be dragged into chat groups', async () => {
    const wrapper = mount(Sidebar, { global: { plugins: [router] } });
    await nextTick();
    const nestedTarget = document.createElement('div');
    nestedTarget.classList.add('nested-draggable');

    const result = (wrapper.vm as any).checkMove({
      evt: {
        draggedContext: {
          element: { type: 'chat', id: 'c1', chat: { id: 'c1', title: 'Chat 1', updatedAt: 0 } },
        },
        to: nestedTarget,
      },
    });

    expect(result).toBe(true);
  });

  it('prevents chat groups from being dragged into other chat groups', async () => {
    const wrapper = mount(Sidebar, { global: { plugins: [router] } });
    await nextTick();
    const nestedTarget = document.createElement('div');
    nestedTarget.classList.add('nested-draggable');

    const result = (wrapper.vm as any).checkMove({
      evt: {
        draggedContext: {
          element: { type: 'chat_group', id: 'g2', chatGroup: { id: 'g2', name: 'Group 2', items: [], isCollapsed: false, updatedAt: 0 } },
        },
        to: nestedTarget,
      },
    });

    expect(result).toBe(false);
  });

  it('uses the draggable move callback with the raw Sortable event shape', async () => {
    const wrapper = mount(Sidebar, { global: { plugins: [router] } });
    await nextTick();
    const nestedTarget = document.createElement('div');
    nestedTarget.classList.add('nested-draggable');

    const draggable = wrapper.findComponent({ name: 'draggable' });
    const move = draggable.props('move') as (evt: unknown) => boolean;
    const result = move({
      draggedContext: {
        element: { type: 'chat', id: 'c1', chat: { id: 'c1', title: 'Chat 1', updatedAt: 0 } },
      },
      to: nestedTarget,
    });

    expect(result).toBe(true);
  });

  it('implements group expansion using CSS Grid for stability', async () => {
    const wrapper = mount(Sidebar, { global: { plugins: [router] } });
    await nextTick();

    // Find the expansion wrapper
    const expansionWrapper = wrapper.find('.grid.transition-all');
    expect(expansionWrapper.exists()).toBe(true);

    // Should have gridTemplateRows: 0fr when collapsed
    expect(expansionWrapper.attributes('style')).toContain('grid-template-rows: 0fr');

    // Expand group
    mockChatStore.chatGroups.value[0].isCollapsed = false;
    mockChatStore.sidebarItems.value[0].chatGroup.isCollapsed = false;
    await nextTick();
    expect(expansionWrapper.attributes('style')).toContain('grid-template-rows: 1fr');
  });

  it('implements Show more/less animation using max-height transition', async () => {
    const wrapper = mount(Sidebar, { global: { plugins: [router] } });
    await nextTick();

    const showMoreWrapper = wrapper.find('.transition-\\[max-height\\]');
    expect(showMoreWrapper.exists()).toBe(true);

    // Should have a default max-height when not expanded
    expect(showMoreWrapper.attributes('style')).toContain('max-height: 250px');

    // Simulate "Show more" expansion (internal state expandedGroupIds)
    // We can't easily trigger the function from outside without export or component access,
    // but we can verify the binding.
    (wrapper.vm as any).toggleGroupCompactExpansion({ groupId: 'g1' });
    await nextTick();
    expect(showMoreWrapper.attributes('style')).toContain('max-height: 2000px');
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

  it('should have touch delay settings enabled to prevent accidental drags on mobile', async () => {
    const wrapper = mount(Sidebar, { global: { plugins: [router] } });
    await nextTick();
    const draggables = wrapper.findAllComponents({ name: 'draggable' });
    draggables.forEach(d => {
      expect(d.props('delay')).toBe(200);
      expect(d.props('delayOnTouchOnly')).toBe(true);
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
    const groupItem = wrapper.find('[data-sidebar-group-id="g1"]');
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
    const groupItem = wrapper.find('[data-sidebar-group-id="g1"]');
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
    const toggleButton = wrapper.find('[data-sidebar-group-id="g1"] button');
    await toggleButton.trigger('click');

    expect(mockChatStore.setChatGroupCollapsed).toHaveBeenCalledWith({ groupId: 'g1', isCollapsed: false });
  });
  it('exposes sidebar scroll helper for selected chat handling', async () => {
    vi.useRealTimers();
    mockChatStore.chats.value = [{ id: 'chat-scroll-test', title: 'Test', updatedAt: Date.now() }];
    mockChatStore.sidebarItems.value = [{ type: 'chat', id: 'chat-scroll-test', chat: mockChatStore.chats.value[0] }];

    const wrapper = mount(Sidebar, { global: { plugins: [router] } });
    await nextTick();

    const nav = wrapper.get('[data-testid="sidebar-nav"]').element as HTMLElement;
    const item = wrapper.get('[data-sidebar-chat-id="chat-scroll-test"]').element as HTMLElement;
    vi.spyOn(nav, 'getBoundingClientRect').mockReturnValue({
      top: 0, bottom: 100, left: 0, right: 100, width: 100, height: 100,
      x: 0, y: 0, toJSON: () => ({}),
    });
    vi.spyOn(item, 'getBoundingClientRect').mockReturnValue({
      top: 180, bottom: 220, left: 0, right: 100, width: 100, height: 40,
      x: 0, y: 180, toJSON: () => ({}),
    });

    const scrollPromise = (wrapper.vm as any).TEST_ONLY.scheduleSidebarItemScroll({
      itemType: 'chat',
      id: 'chat-scroll-test',
      onlyWhenOutOfView: true,
    });
    await new Promise(resolve => setTimeout(resolve, 150));
    await scrollPromise;

    expect((wrapper.vm as any).TEST_ONLY.scheduleSidebarItemScroll).toBeTypeOf('function');
  });
});
