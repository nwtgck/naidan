import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import ChatGroupSearchPreview from './ChatGroupSearchPreview.vue';
import { nextTick, ref } from 'vue';
import { useChatNavigation } from '@/composables/chat/ui/useChatNavigation';

// --- Mocks ---

const mockSidebarItems = ref<any[]>([]);
vi.mock('../../../composables/chat/ui/useCurrentChatState', () => ({
  useCurrentChatState: () => ({ sidebarItems: mockSidebarItems }),
}));

const mockPush = vi.fn();
vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
}));

const mockCloseSearch = vi.fn();
vi.mock('../composables/useGlobalSearch', () => ({
  useGlobalSearch: () => ({
    closeSearch: mockCloseSearch,
  }),
}));

const mockOpenChat = vi.fn();
vi.mock('../../../composables/chat/ui/useChatNavigation', () => ({
  useChatNavigation: vi.fn(),
}));

// Mock Lucide icons
vi.mock('lucide-vue-next', () => ({
  FolderIcon: { render: () => null },
  MessageSquareIcon: { render: () => null },
  Loader2Icon: { render: () => null },
  ChevronRightIcon: { render: () => null },
}));

// Mock SearchPreview stub (since it's async and complex)
vi.mock('./SearchPreview.vue', () => ({
  default: { name: 'SearchPreview', props: ['chat', 'match'], template: '<div class="search-preview-stub"></div>' },
}));

// --- Tests ---

describe('ChatGroupSearchPreview Component', () => {
  const mockGroupId = 'g1';
  const mockGroupName = 'Work';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useChatNavigation).mockReturnValue({
      openChat: vi.fn().mockImplementation(async ({ chatId }) => {
        await mockOpenChat({ id: chatId });
      }),
      openChatAtMessage: vi.fn(),
      openChatGroup: vi.fn(),
      TEST_ONLY: {},
    });
    mockSidebarItems.value = [
      {
        id: 'g1',
        type: 'chat_group',
        chatGroup: {
          id: 'g1',
          name: 'Work',
          updatedAt: 200,
          items: [
            { id: 'c1', type: 'chat', chat: { id: 'c1', title: 'Chat 1', groupId: 'g1', updatedAt: 100 } },
            { id: 'c2', type: 'chat', chat: { id: 'c2', title: 'Chat 2', groupId: 'g1', updatedAt: 200 } },
          ],
        },
      },
      { id: 'other', type: 'chat', chat: { id: 'other', title: 'Other Chat', groupId: 'other', updatedAt: 300 } },
    ];
  });

  it('should load and filter chats by groupId', async () => {
    const wrapper = mount(ChatGroupSearchPreview, {
      props: { groupId: mockGroupId, groupName: mockGroupName },
    });

    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 0)); // wait for loadChats

    // Should see Chat 1 and Chat 2, but not Other Chat
    expect(wrapper.text()).toContain('Chat 1');
    expect(wrapper.text()).toContain('Chat 2');
    expect(wrapper.text()).not.toContain('Other Chat');
  });

  it('should select the first chat by default', async () => {
    const wrapper = mount(ChatGroupSearchPreview, {
      props: { groupId: mockGroupId, groupName: mockGroupName },
    });

    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    // Chat 2 is newer (updatedAt: 200) than Chat 1 (100)
    expect((wrapper.vm as any).TEST_ONLY.selectedChatId.value).toBe('c2');
  });

  it('should navigate when "Open Chat" button is clicked', async () => {
    const wrapper = mount(ChatGroupSearchPreview, {
      props: { groupId: mockGroupId, groupName: mockGroupName },
    });

    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    // Find the action button for the selected chat (c2)
    const openButton = wrapper.find('button[title="Open Chat"]');
    await openButton.trigger('click');

    expect(mockOpenChat).toHaveBeenCalledWith({ id: 'c2' });
    expect(mockPush).toHaveBeenCalledWith('/chat/c2');
    expect(mockCloseSearch).toHaveBeenCalled();
  });
});
