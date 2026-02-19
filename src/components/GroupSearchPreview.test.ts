import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import GroupSearchPreview from './GroupSearchPreview.vue';
import { nextTick } from 'vue';
import { storageService } from '../services/storage';

// --- Mocks ---

vi.mock('../services/storage', () => ({
  storageService: {
    listChats: vi.fn(),
    loadChat: vi.fn(),
  },
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
vi.mock('../composables/useChat', () => ({
  useChat: () => ({
    openChat: mockOpenChat,
  }),
}));

// Mock Lucide icons
vi.mock('lucide-vue-next', () => ({
  Folder: { render: () => null },
  MessageSquare: { render: () => null },
  Loader2: { render: () => null },
  ChevronRight: { render: () => null },
}));

// Mock SearchPreview stub (since it's async and complex)
vi.mock('./SearchPreview.vue', () => ({
  default: { name: 'SearchPreview', props: ['chat', 'match'], template: '<div class="search-preview-stub"></div>' }
}));

// --- Tests ---

describe('GroupSearchPreview Component', () => {
  const mockGroupId = 'g1';
  const mockGroupName = 'Work';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(storageService.listChats).mockResolvedValue([
      { id: 'c1', title: 'Chat 1', groupId: 'g1', updatedAt: 100 },
      { id: 'c2', title: 'Chat 2', groupId: 'g1', updatedAt: 200 },
      { id: 'other', title: 'Other Chat', groupId: 'other', updatedAt: 300 },
    ] as any);
  });

  it('should load and filter chats by groupId', async () => {
    const wrapper = mount(GroupSearchPreview, {
      props: { groupId: mockGroupId, groupName: mockGroupName }
    });

    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 0)); // wait for loadChats

    // Should see Chat 1 and Chat 2, but not Other Chat
    expect(wrapper.text()).toContain('Chat 1');
    expect(wrapper.text()).toContain('Chat 2');
    expect(wrapper.text()).not.toContain('Other Chat');
  });

  it('should select the first chat by default', async () => {
    const wrapper = mount(GroupSearchPreview, {
      props: { groupId: mockGroupId, groupName: mockGroupName }
    });

    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    // Chat 2 is newer (updatedAt: 200) than Chat 1 (100)
    expect((wrapper.vm as any).selectedChatId).toBe('c2');
  });

  it('should navigate when "Open Chat" button is clicked', async () => {
    const wrapper = mount(GroupSearchPreview, {
      props: { groupId: mockGroupId, groupName: mockGroupName }
    });

    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    // Find the action button for the selected chat (c2)
    const openButton = wrapper.find('button[title="Open Chat"]');
    await openButton.trigger('click');

    expect(mockOpenChat).toHaveBeenCalledWith('c2');
    expect(mockPush).toHaveBeenCalledWith('/chat/c2');
    expect(mockCloseSearch).toHaveBeenCalled();
  });
});
