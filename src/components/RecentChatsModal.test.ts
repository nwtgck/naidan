import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import RecentChatsModal from './RecentChatsModal.vue';
import { computed, ref, nextTick } from 'vue';
import type { ChatSummary } from '@/models/types';
import { setupScrollToMock } from '@/utils/test-utils';
import { useChatNavigation } from '@/composables/chat/ui/useChatNavigation';
import { useCurrentChatState } from '@/composables/chat/ui/useCurrentChatState';
import { toChatId } from '@/models/ids';

// --- Mocks ---

const mockIsRecentOpen = ref(false);
const mockRecentChats = ref<(ChatSummary & { accessedAt: number })[]>([]);
const mockCloseRecent = vi.fn();

vi.mock('../composables/useRecentChats', () => ({
  useRecentChats: () => ({
    isRecentOpen: mockIsRecentOpen,
    recentChats: mockRecentChats,
    closeRecent: mockCloseRecent,
  }),
}));

const mockOpenChat = vi.fn();
vi.mock('../composables/chat/ui/useChatNavigation', () => ({
  useChatNavigation: vi.fn(),
}));

vi.mock('../composables/chat/ui/useCurrentChatState', () => ({
  useCurrentChatState: vi.fn(),
}));

vi.mock('../composables/useSettings', () => ({
  useSettings: () => ({
    searchPreviewMode: ref('always'),
    setSearchPreviewMode: vi.fn(),
  }),
}));

const mockSetActiveFocusArea = vi.fn();
const mockActiveFocusArea = ref('chat');
vi.mock('../composables/useLayout', () => ({
  useLayout: () => ({
    setActiveFocusArea: mockSetActiveFocusArea,
    activeFocusArea: mockActiveFocusArea,
  }),
}));

const mockPush = vi.fn();
vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
}));

// Mock Lucide icons
vi.mock('lucide-vue-next', () => ({
  SearchIcon: { render: () => null },
  XIcon: { render: () => null },
  EyeIcon: { render: () => null },
  HistoryIcon: { render: () => null },
  MessageSquareIcon: { render: () => null },
  FolderIcon: { render: () => null },
}));

// Mock components
vi.mock('./RecentChatListItem.vue', () => ({
  __esModule: true,
  default: {
    name: 'RecentChatListItem',
    props: ['chat', 'isSelected'],
    template: '<div class="recent-item" :data-selected="isSelected" @click="$emit(\'click\')">{{ chat ? chat.title : \'\' }}</div>',
  },
}));

vi.mock('./SearchPreview.vue', () => ({
  __esModule: true,
  default: {
    name: 'SearchPreview',
    template: '<div>Preview</div>',
  },
}));

// Mock scrollIntoView
window.HTMLElement.prototype.scrollIntoView = vi.fn();

describe('RecentChatsModal Component', () => {
  beforeEach(() => {
    setupScrollToMock();
    mockIsRecentOpen.value = true;
    mockRecentChats.value = [
      { id: toChatId({ raw: 'c1' }), title: 'Chat 1', accessedAt: Date.now(), updatedAt: Date.now() },
      { id: toChatId({ raw: 'c2' }), title: null, accessedAt: Date.now() - 1000, updatedAt: Date.now() - 1000 },
    ];
    vi.clearAllMocks();
    vi.mocked(useChatNavigation).mockReturnValue({
      openChat: vi.fn().mockImplementation(async ({ chatId }) => {
        await mockOpenChat({ id: chatId });
      }),
      openChatAtMessage: vi.fn(),
      openChatGroup: vi.fn(),
      TEST_ONLY: {},
    });
    vi.mocked(useCurrentChatState).mockReturnValue({
      currentChat: computed(() => null),
      currentChatGroup: computed(() => null),
      currentChatId: computed(() => undefined),
      activeMessages: computed(() => []),
      allMessages: computed(() => []),
      resolvedSettings: computed(() => null),
      inheritedSettings: computed(() => null),
      chatGroups: computed(() => [{ id: 'g1', name: 'Group 1' }]),
      sidebarItems: computed(() => []),
      TEST_ONLY: {},
    } as unknown as ReturnType<typeof useCurrentChatState>);
  });

  it('should render when open', () => {
    const wrapper = mount(RecentChatsModal);
    expect(wrapper.find('[data-testid="recent-filter-input"]').exists()).toBe(true);
  });

  it('should filter chats by title', async () => {
    const wrapper = mount(RecentChatsModal);
    const input = wrapper.get('[data-testid="recent-filter-input"]');

    await input.setValue('Chat 1');
    expect(wrapper.findAll('.recent-item').length).toBe(1);
    expect(wrapper.text()).toContain('Chat 1');

    // Should match "New Chat" for null titles
    await input.setValue('New Chat');
    expect(wrapper.findAll('.recent-item').length).toBe(1);
  });

  it('should navigate with keyboard', async () => {
    const wrapper = mount(RecentChatsModal);
    const input = wrapper.get('[data-testid="recent-filter-input"]');

    // Initial selection 0
    expect((wrapper.vm as any).selectedIndex).toBe(0);

    // ArrowDown
    await input.trigger('keydown', { key: 'ArrowDown' });
    expect((wrapper.vm as any).selectedIndex).toBe(1);

    // ArrowUp
    await input.trigger('keydown', { key: 'ArrowUp' });
    expect((wrapper.vm as any).selectedIndex).toBe(0);
  });

  it('should select chat on Enter', async () => {
    const wrapper = mount(RecentChatsModal);
    const input = wrapper.get('[data-testid="recent-filter-input"]');

    await input.trigger('keydown', { key: 'Enter' });

    expect(mockOpenChat).toHaveBeenCalledWith({ id: 'c1' });
    expect(mockPush).toHaveBeenCalledWith('/chat/c1');
    expect(mockCloseRecent).toHaveBeenCalled();
  });

  it('should select chat on click', async () => {
    const wrapper = mount(RecentChatsModal);
    const items = wrapper.findAll('.recent-item');
    const secondItem = items[1];
    if (!secondItem) throw new Error('Second item not found');

    await secondItem.trigger('click');

    expect(mockOpenChat).toHaveBeenCalledWith({ id: 'c2' });
    expect(mockPush).toHaveBeenCalledWith('/chat/c2');
    expect(mockCloseRecent).toHaveBeenCalled();
  });

  it('should handle preview pane navigation', async () => {
    const wrapper = mount(RecentChatsModal);
    const input = wrapper.get('[data-testid="recent-filter-input"]');

    // ArrowRight to enter preview
    await input.trigger('keydown', { key: 'ArrowRight' });
    expect((wrapper.vm as any).activePane).toBe('preview');

    // ArrowLeft to return to results
    await input.trigger('keydown', { key: 'ArrowLeft' });
    expect((wrapper.vm as any).activePane).toBe('results');
  });

  it('should manage FocusArea on lifecycle', async () => {
    mockIsRecentOpen.value = false;
    mount(RecentChatsModal);

    mockIsRecentOpen.value = true;
    await nextTick();
    expect(mockSetActiveFocusArea).toHaveBeenCalledWith({ area: 'search' });

    mockIsRecentOpen.value = false;
    await nextTick();
    expect(mockSetActiveFocusArea).toHaveBeenCalledWith({ area: 'chat' });
  });
});
