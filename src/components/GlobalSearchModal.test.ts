import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import GlobalSearchModal from './GlobalSearchModal.vue';
import { ref, nextTick } from 'vue';

// --- Mocks ---

const mockIsSearchOpen = ref(false);
const mockChatGroupIds = ref<string[]>([]);
const mockChatId = ref<string | undefined>(undefined);
const mockCloseSearch = vi.fn();

const mockPush = vi.fn();
vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
}));

vi.mock('../composables/useGlobalSearch', () => ({
  useGlobalSearch: () => ({
    isSearchOpen: mockIsSearchOpen,
    chatGroupIds: mockChatGroupIds,
    chatId: mockChatId,
    closeSearch: mockCloseSearch,
  }),
}));

const mockQuery = ref('');
const mockIsSearching = ref(false);
const mockResults = ref([]);
const mockSearch = vi.fn();

vi.mock('../composables/useChatSearch', () => ({
  useChatSearch: () => ({
    query: mockQuery,
    isSearching: mockIsSearching,
    results: mockResults,
    search: mockSearch,
  }),
}));

const mockOpenChat = vi.fn();
vi.mock('../composables/useChat', () => ({
  useChat: () => ({
    openChat: mockOpenChat,
    chatGroups: ref([{ id: 'g1', name: 'Group 1' }]),
    currentChat: ref(null),
  }),
}));

vi.mock('../composables/useSettings', () => ({
  useSettings: () => ({
    searchPreviewEnabled: ref(true),
    searchContextSize: ref(2),
    setSearchPreviewEnabled: vi.fn(),
    setSearchContextSize: vi.fn(),
  }),
}));

// Mock Lucide icons
vi.mock('lucide-vue-next', () => ({
  Search: { render: () => null },
  X: { render: () => null },
  Loader2: { render: () => null },
  MessageSquare: { render: () => null },
  CornerDownRight: { render: () => null },
  Clock: { render: () => null },
  GitBranch: { render: () => null },
  Folder: { render: () => null },
  Filter: { render: () => null },
  Check: { render: () => null },
}));

// Mock scrollIntoView
window.HTMLElement.prototype.scrollIntoView = vi.fn();

// --- Tests ---

describe('GlobalSearchModal Component', () => {
  beforeEach(() => {
    mockIsSearchOpen.value = true;
    mockQuery.value = '';
    mockChatGroupIds.value = [];
    mockChatId.value = undefined;
    mockResults.value = [];
    vi.clearAllMocks();
  });

  it('should render when open', () => {
    const wrapper = mount(GlobalSearchModal);
    expect(wrapper.find('[data-testid="search-input"]').exists()).toBe(true);
  });

  it('should call search on input with debounce', async () => {
    const wrapper = mount(GlobalSearchModal);
    const input = wrapper.get('[data-testid="search-input"]');
    await input.setValue('test');
    
    // Wait for debounce (300ms + buffer)
    await new Promise(resolve => setTimeout(resolve, 400));
    
    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({
      searchQuery: 'test'
    }));
  });

  it('should toggle group filter when clicking in dropdown', async () => {
    const wrapper = mount(GlobalSearchModal);
    
    // Open group selector
    await wrapper.get('[data-testid="group-filter-button"]').trigger('click');
    
    // Find and click the group button in the dropdown
    const groupButton = wrapper.get('[data-testid="group-filter-item-g1"]');
    await groupButton.trigger('click');
    
    expect(mockChatGroupIds.value).toContain('g1');
  });

  it('should show group filter indicator when groupIds are present', () => {
    mockChatGroupIds.value = ['g1'];
    const wrapper = mount(GlobalSearchModal);
    expect(wrapper.text()).toContain('Group 1');
  });

  it('should show chat filter indicator when chatId is present', () => {
    mockChatId.value = 'c1';
    const wrapper = mount(GlobalSearchModal);
    // targetChatTitle will be 'Filtered Chat' if currentChat is not c1
    expect(wrapper.text()).toContain('Filtered Chat');
  });

  it('should re-trigger search when opening with a filter if query is present', async () => {
    mockQuery.value = 'stale query';
    mockIsSearchOpen.value = false;
    
    // Simulate opening with a chatId
    mockChatId.value = 'c1';
    mockIsSearchOpen.value = true;
    
    mount(GlobalSearchModal);
    
    // Wait for watch(isSearchOpen) nextTick and performSearch
    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));
    
    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({
      searchQuery: 'stale query',
      options: expect.objectContaining({ chatId: 'c1' })
    }));
  });

  it('should navigate and select results with keyboard', async () => {
    mockQuery.value = 'test';
    mockResults.value = [
      { chatId: 'chat1', title: 'Chat 1', updatedAt: 1, contentMatches: [] },
      { chatId: 'chat2', title: 'Chat 2', updatedAt: 2, contentMatches: [] },
    ] as any;
    
    const wrapper = mount(GlobalSearchModal);
    await nextTick();
    
    // Initial selection should be index 0
    expect((wrapper.vm as any).selectedIndex).toBe(0);
    
    // ArrowDown to select index 1
    await wrapper.get('[data-testid="search-input"]').trigger('keydown', { key: 'ArrowDown' });
    expect((wrapper.vm as any).selectedIndex).toBe(1);
    
    // Enter to select the item
    await wrapper.get('[data-testid="search-input"]').trigger('keydown', { key: 'Enter' });
    
    expect(mockOpenChat).toHaveBeenCalledWith('chat2');
    expect(mockCloseSearch).toHaveBeenCalled();
  });

  it('should select a result when clicked', async () => {
    mockQuery.value = 'test';
    mockResults.value = [
      { chatId: 'chat1', title: 'Chat 1', updatedAt: 1, contentMatches: [] },
    ] as any;
    
    const wrapper = mount(GlobalSearchModal);
    await nextTick();
    
    await wrapper.get('[data-testid="search-result-item-0"]').trigger('click');
    
    expect(mockOpenChat).toHaveBeenCalledWith('chat1');
    expect(mockCloseSearch).toHaveBeenCalled();
  });
});
